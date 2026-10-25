import { existsSync,readdirSync,readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import {DeferredReads} from './deferred-reads.js';
import {memoryName} from './task-memory.js';
import {managedRelease} from './managed-component-state.js';
import {fileURLToPath} from 'node:url';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { McpRegistrationTarget } from './mcp-modern-server.js';
import { isPathInsideRoot, resolveCanonicalAllowedPath } from './roots.js';
import { SERENA_RENAME_LANGUAGES, SERENA_VERSION, planSerenaRename,queryKotlin,serenaLanguagesHome,captureSerenaProject, type SerenaRenameInput } from './serena-workspace-edit.js';
import {compareSymbolProjects,parseComparedSymbols,type ComparedProject} from './serena-symbol-compare.js';
import {compareDiagnosticProjects,parseGroupedDiagnostics,type ProjectDiagnostics} from './serena-diagnostics-compare.js';
import {scanMemoryGraph,publicMemoryGraph,compareMemoryGraphs} from './serena-memory-graph.js';
import {snapshot} from './durable-tasks.js';

// Serena is an independent, established LSP-backed MCP server. Keep it on one
// project per process: its active project is mutable global state. Only expose
// symbolic read tools; Forge's journaled task tools own all source mutations
// (task_serena_edit runs Serena's editor on a private copy, never this process).
const BACKEND_TOOLS = [
  'list_memories',
  'read_memory',
  'get_symbols_overview',
  'find_symbol',
  'find_referencing_symbols',
  'search_for_pattern',
  'find_file',
  'list_dir',
  'find_implementations',
  'find_declaration',
  'get_diagnostics_for_file',
  'get_diagnostics_for_symbol',
] as const;
type BackendTool = (typeof BACKEND_TOOLS)[number];

type SerenaSession = {
  client: Client;
  transport: StdioClientTransport;
  tools: Set<string>;
  lastUsed: number;
};

const MAX_SESSIONS = 3;
const IDLE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 90_000;
const STARTUP_TIMEOUT_MS = 75_000;
const MAX_OUTPUT_CHARS = 26_000;
const relativePath = z.string().max(800).describe('Path relative to project root; no parent traversal');
const maxChars = z.number().int().min(100).max(20_000).optional();

// These schemas are shared by the single-project tools and the cross-project
// batch. A batch must not provide a way around a single tool's argument bounds.
const SERENA_READ_SCHEMAS = {
  list_memories:z.object({}).strict(),
  read_memory:z.object({memory_file_name:z.string().min(1).max(203)}).strict(),
  get_symbols_overview:z.object({relative_path:relativePath,depth:z.number().int().min(-1).max(5).optional(),max_answer_chars:maxChars}).strict(),
  find_symbol:z.object({
    name_path_pattern:z.string().min(1).max(300),relative_path:relativePath.optional(),depth:z.number().int().min(0).max(5).optional(),
    include_body:z.boolean().optional(),include_info:z.boolean().optional(),substring_matching:z.boolean().optional(),
    max_matches:z.number().int().min(1).max(100).optional(),max_answer_chars:maxChars,
  }).strict(),
  find_referencing_symbols:z.object({name_path:z.string().min(1).max(300),relative_path:relativePath,max_answer_chars:maxChars}).strict(),
  search_for_pattern:z.object({substring_pattern:z.string().min(1).max(400),relative_path:relativePath.optional(),restrict_search_to_code_files:z.boolean().optional(),max_answer_chars:maxChars}).strict(),
  find_file:z.object({file_mask:z.string().min(1).max(150),relative_path:relativePath}).strict(),
  list_dir:z.object({relative_path:relativePath,recursive:z.boolean(),skip_ignored_files:z.boolean().optional(),max_answer_chars:maxChars}).strict(),
  find_implementations:z.object({name_path:z.string().min(1).max(300),relative_path:relativePath,include_info:z.boolean().optional(),max_answer_chars:maxChars}).strict(),
  find_declaration:z.object({relative_path:relativePath,regex:z.string().min(1).max(400),containing_symbol_name_path:z.string().min(1).max(300).optional(),include_body:z.boolean().optional(),include_info:z.boolean().optional()}).strict(),
  get_diagnostics_for_file:z.object({relative_path:relativePath,start_line:z.number().int().min(0).optional(),end_line:z.number().int().min(-1).optional(),min_severity:z.number().int().min(1).max(4).optional(),max_answer_chars:maxChars}).strict(),
  get_diagnostics_for_symbol:z.object({
    name_path:z.string().min(1).max(300),
    reference_file:relativePath.optional(),
    check_symbol_references:z.boolean().optional(),
    min_severity:z.number().int().min(1).max(4).optional(),
    max_answer_chars:maxChars,
  }).strict(),
} satisfies Record<BackendTool,z.ZodObject<z.ZodRawShape>>;

export const serenaProjectBatchSchema=z.object({
  queries:z.array(z.object({
    path:z.string().min(1).max(1200),
    tool:z.enum(BACKEND_TOOLS),
    args:z.record(z.string(),z.unknown()),
  }).strict()).min(2).max(MAX_SESSIONS).describe('Two or three distinct approved projects; each may use a different read-only Serena operation.'),
  max_result_chars:z.number().int().min(100).max(12_000).default(6000).describe('Maximum backend response characters per project; larger outputs are marked incomplete.'),
}).strict();
export type SerenaProjectBatch=z.input<typeof serenaProjectBatchSchema>;

export const serenaDiagnosticsCompareSchema=z.object({
  paths:z.array(z.string().min(1).max(1200)).min(2).max(MAX_SESSIONS),
  scope:z.enum(['file','symbol']),
  relative_path:relativePath.min(1).optional(),
  name_path:z.string().min(1).max(300).optional(),
  reference_file:relativePath.min(1).optional(),
  check_symbol_references:z.boolean().optional(),
  min_severity:z.number().int().min(1).max(4).default(2),
  max_details:z.number().int().min(1).max(50).default(20),
}).strict().superRefine((data,ctx)=>{
  if(data.scope==='file'&&(!data.relative_path||data.relative_path==='.'||data.name_path!==undefined||data.reference_file!==undefined||data.check_symbol_references!==undefined))
    ctx.addIssue({code:'custom',message:'File comparison requires only relative_path (plus severity and detail bounds)'});
  if(data.scope==='symbol'&&(!data.name_path||data.relative_path!==undefined))
    ctx.addIssue({code:'custom',message:'Symbol comparison requires name_path; use reference_file to disambiguate'});
});
export type SerenaDiagnosticsCompare=z.input<typeof serenaDiagnosticsCompareSchema>;

export function serenaExecutable(): string {
  const configured = process.env.FORGE_SERENA_EXECUTABLE?.trim();
  if (configured) return configured;
  const managed=managedRelease('serena');if(managed)return managed.command;
  const installed = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'serena.exe' : 'serena');
  return existsSync(installed) ? installed : 'serena';
}

export function serenaRelativePath(input: string, root: string): string {
  if (input === '' || input === '.') return input;
  if (input.includes('\0') || isAbsolute(input) || /^[a-z]:/i.test(input) || input.startsWith('\\\\')) {
    throw new Error('Serena file path must be project-relative');
  }
  const components = input.replaceAll('\\', '/').split('/');
  if (components.some(component => component === '..' || component === '')) {
    throw new Error('Serena path traversal is not permitted');
  }
  const resolved = resolve(root, input);
  if (!isPathInsideRoot(resolved, root)) throw new Error('Serena path leaves the approved project');
  return relative(root, resolved).split(sep).join('/');
}

export class SerenaBridge {
  private readonly sessions = new Map<string, Promise<SerenaSession>>();
  // Count requests before session acquisition. A project being initialized or
  // queried must never be evicted to make room for another language server.
  private readonly activeRequests = new Map<string, number>();
  private closing = false;
  private readonly privateReads = new DeferredReads();

  constructor(private readonly allowedRoots: string[], private readonly executable = serenaExecutable()) {}

  private async project(path: string): Promise<string> {
    const canonical = await resolveCanonicalAllowedPath(path, process.cwd(), this.allowedRoots);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Serena project path must be a directory');
    return canonical;
  }

  private async start(project: string): Promise<SerenaSession> {
    const managed=managedRelease('serena');
    const usePinnedReader=managed?.command===this.executable&&!!managed.python;
    const transport = new StdioClientTransport({
      command: usePinnedReader?managed!.python!:this.executable,
      args: [
        ...(usePinnedReader?['-I','-B',fileURLToPath(new URL('../scripts/serena-analysis/forge_serena_read.py',import.meta.url)),serenaLanguagesHome(),fileURLToPath(new URL('../scripts/serena-analysis/languages-lock.json',import.meta.url))]:[]),
        'start-mcp-server', '--transport', 'stdio', '--context', 'desktop-app', '--project', project,
        '--add-mode', fileURLToPath(new URL('../scripts/serena-analysis/forge-serena-diagnostics.yml',import.meta.url)),
        '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false',
        '--enable-gui-log-window', 'false',
      ],
      cwd: project,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'chatgptforge-serena', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: STARTUP_TIMEOUT_MS });
      const catalog = await client.listTools(undefined, { timeout: STARTUP_TIMEOUT_MS });
      return { client, transport, tools: new Set(catalog.tools.map(item => item.name)), lastUsed: Date.now() };
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private async closeSession(session: SerenaSession): Promise<void> {
    await Promise.allSettled([session.client.close(), session.transport.close()]);
  }

  private async session(project: string): Promise<SerenaSession> {
    if (this.closing) throw new Error('Serena bridge is shutting down');
    const existing = this.sessions.get(project);
    if (existing) return existing;

    const unused: { path: string; promise: Promise<SerenaSession>; state: SerenaSession }[] = [];
    for (const [path, value] of this.sessions) {
      if (this.activeRequests.has(path)) continue;
      const state = await value.catch(() => undefined);
      if (this.sessions.get(path) !== value || this.activeRequests.has(path)) continue;
      if (!state) {
        this.sessions.delete(path);
        continue;
      }
      unused.push({ path, promise: value, state });
    }

    const shutdowns: Promise<void>[] = [];
    for (const item of unused) {
      if (this.sessions.get(item.path) === item.promise
          && !this.activeRequests.has(item.path)
          && Date.now() - item.state.lastUsed > IDLE_MS) {
        this.sessions.delete(item.path);
        shutdowns.push(this.closeSession(item.state));
      }
    }
    // Concurrent requests may already have initialized this same project.
    const raced = this.sessions.get(project);
    if (raced) return raced;
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = unused
        .filter(item => this.sessions.get(item.path) === item.promise && !this.activeRequests.has(item.path))
        .sort((a, b) => a.state.lastUsed - b.state.lastUsed)[0];
      if (!oldest) throw new Error('Serena project limit reached: all project sessions are busy');
      this.sessions.delete(oldest.path);
      shutdowns.push(this.closeSession(oldest.state));
    }
    // Reserve the slot before waiting for a child process to close; otherwise
    // simultaneous project switches can each pass the limit check.
    const initializing = (async () => {
      await Promise.all(shutdowns);
      if (this.closing) throw new Error('Serena bridge is shutting down');
      return this.start(project);
    })();
    this.sessions.set(project, initializing);
    try { return await initializing; }
    catch (error) { if (this.sessions.get(project) === initializing) this.sessions.delete(project); throw error; }
  }

  private async prepareReadArgs(project:string,tool:BackendTool,args:Record<string,unknown>):Promise<Record<string,unknown>>{
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue;
      filtered[key] = (key === 'relative_path' || key === 'reference_file') && typeof value === 'string'
        ? serenaRelativePath(value, project) : value;
    }
    for (const path of [filtered.relative_path, filtered.reference_file]) {
      if (typeof path === 'string' && path !== '') {
        // LSP tools accept source paths directly; reject existing symlinks to
        // unapproved directories before passing any user-supplied path to Serena.
        await resolveCanonicalAllowedPath(path, project, [project]);
      }
    }
    if(tool==='read_memory'){
      const name=String(filtered.memory_file_name??'');
      if(name.includes('/'))memoryName(name.replace(/\.md$/,''));
      else if(!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(name)||name.includes('..'))throw new Error('Memory name must be a safe project memory filename');
      await resolveCanonicalAllowedPath(join('.serena','memories',name.endsWith('.md')?name:name+'.md'),project,[project]);
    }
    return filtered;
  }

  async invoke(path: string, tool: BackendTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if(this.closing)throw new Error('Serena bridge is shutting down');
    if (signal?.aborted) throw new Error('Serena call was cancelled');
    const project = await this.project(path);
    const filtered=await this.prepareReadArgs(project,tool,args);
    const symbolic=['get_symbols_overview','find_symbol','find_referencing_symbols','find_implementations','find_declaration','get_diagnostics_for_file','get_diagnostics_for_symbol'].includes(tool);
    const relativePath=String(filtered.relative_path??filtered.reference_file??'');
    const kotlinProject=relativePath.endsWith('.kt')||existsSync(join(project,'.forge','kotlin-workspace.json'))||readdirSync(project,{withFileTypes:true}).some(p=>p.isFile()&&p.name.endsWith('.kt')||p.isDirectory()&&existsSync(join(project,p.name,'src','main','kotlin')))||existsSync(join(project,'src','main','kotlin'))||existsSync(join(project,'src','test','kotlin'));
    if(symbolic&&kotlinProject&&(relativePath.endsWith('.kt')||!relativePath||!relativePath.includes('.')||existsSync(join(project,relativePath))&&(await stat(join(project,relativePath))).isDirectory())){
      if(this.closing)throw new Error('Serena bridge is shutting down');
      const hash=createHash('sha256').update(captureSerenaProject(project).fingerprint);
      for(const file of ['languages-lock.json','forge_serena_read.py','forge_serena_query.py','forge-serena-diagnostics.yml'])hash.update(readFileSync(fileURLToPath(new URL('../scripts/serena-analysis/'+file,import.meta.url))));
      const key=JSON.stringify([project,tool,Object.entries(filtered).sort(([a],[b])=>a.localeCompare(b))]);
      return this.privateReads.invoke(key,hash.digest('hex'),abort=>queryKotlin(project,tool,filtered,abort,{timeoutMs:600000}),signal);
    }
    this.activeRequests.set(project, (this.activeRequests.get(project) ?? 0) + 1);
    try {
    const session = await this.session(project);
    if (!session.tools.has(tool)) throw new Error(`Serena server does not expose ${tool} in desktop-app context`);
    session.lastUsed = Date.now();
    let transportSucceeded = false;
    try {
      const result = await session.client.callTool(
        { name: tool, arguments: filtered }, undefined,
        { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      transportSucceeded = true;
      const blocks = Array.isArray(result.content) ? result.content : [];
      const content = blocks
        .filter((item): item is { type: 'text'; text: string } => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text).join('\n');
      const response = content || JSON.stringify(result.structuredContent ?? {});
      if (result.isError) throw new Error(`Serena ${tool}: ${response.slice(0, 2000)}`);
      return response.length <= MAX_OUTPUT_CHARS
        ? response
        : `${response.slice(0, MAX_OUTPUT_CHARS)}\n[Serena output truncated; narrow the query]`;
    } catch (error) {
      // A failed MCP transport request leaves Serena's long-running language
      // server in an unknown state. Evict that project session before a retry,
      // while preserving healthy sessions and ordinary tool-level errors.
      if (!transportSucceeded) {
        const active = this.sessions.get(project);
        if (active && await active.catch(() => undefined) === session) this.sessions.delete(project);
        await Promise.allSettled([session.client.close(), session.transport.close()]);
        const detail = error instanceof Error ? error.message : String(error);
        if (/timed?\s*out|timeout|deadline exceeded/i.test(detail)) {
          throw new Error(
            `Serena ${tool} timed out after ${REQUEST_TIMEOUT_MS / 1000}s; its language server may still be initializing or downloading prerequisites. The failed project session was closed.`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      session.lastUsed = Date.now();
    }
    } finally {
      const remaining = (this.activeRequests.get(project) ?? 1) - 1;
      if (remaining) this.activeRequests.set(project, remaining);
      else this.activeRequests.delete(project);
    }
  }

  // Query distinct approved projects concurrently with any of the same twelve
  // read-only operations offered as single-project MCP tools. Preflight every
  // grant, path and tool schema before contacting *any* language server.
  async queryProjects(input:SerenaProjectBatch,signal?:AbortSignal){
    if(this.closing||signal?.aborted)throw Error('Serena batch was cancelled or bridge is shutting down');
    const batch=serenaProjectBatchSchema.parse(input);
    const projects=await Promise.all(batch.queries.map(query=>this.project(query.path)));
    const identities=projects.map(path=>process.platform==='win32'?path.toLowerCase():path);
    if(new Set(identities).size!==projects.length)throw Error('Each batch project must be a different approved directory');
    for(const [index,query] of batch.queries.entries()){
      const schema=SERENA_READ_SCHEMAS[query.tool];
      const parsed=schema.safeParse(query.args);
      if(!parsed.success)throw Error(`Invalid Serena ${query.tool} arguments at project ${index+1}: `+
        parsed.error.issues.map(issue=>issue.message).join('; ').slice(0,300));
      await this.prepareReadArgs(projects[index]!,query.tool,parsed.data);
    }
    const results=await Promise.all(batch.queries.map(async (query,index)=>{
      const project=projects[index]!;
      try{
        const raw=await this.invoke(query.path,query.tool,query.args,signal);
        if(signal?.aborted)throw Error('Serena batch was cancelled');
        const truncated=raw.length>batch.max_result_chars||raw.includes('[Serena output truncated; narrow the query]');
        let indexing=false;
        try{const parsed=JSON.parse(raw) as {status?:unknown};indexing=parsed?.status==='indexing';}catch{/* Ordinary text result. */}
        return {path:project,tool:query.tool,status:truncated?'truncated' as const:indexing?'indexing' as const:'ok' as const,
          text:raw.slice(0,batch.max_result_chars),original_chars:raw.length};
      }catch(error){
        if(signal?.aborted)throw Error('Serena batch was cancelled');
        return {path:project,tool:query.tool,status:'error' as const,error:(error instanceof Error?error.message:String(error)).slice(0,500)};
      }
    }));
    return {status:results.every(result=>result.status==='ok')?'completed' as const:'incomplete' as const,
      projects:results,queried:results.length,complete:results.filter(result=>result.status==='ok').length};
  }

  // This performs one real LSP read in each independent approved project.
  // Query authorization, including optional file paths, is checked for all
  // projects *before* launching any backend. We cannot compare partial or
  // truncated results as if the implementation were identical.
  async compareSymbols(
    paths:string[],
    input:{name_path_pattern:string;relative_path?:string;max_matches?:number},
    signal?:AbortSignal,
  ){
    if(this.closing||signal?.aborted)throw Error('Serena comparison was cancelled or bridge is shutting down');
    if(paths.length<2||paths.length>MAX_SESSIONS)throw Error('Compare 2 or 3 approved Serena projects');
    if(!input.name_path_pattern||input.name_path_pattern.length>300)throw Error('Invalid symbol name path pattern');
    const limit=input.max_matches??15;
    if(!Number.isInteger(limit)||limit<1||limit>30)throw Error('Compare at most 30 symbols per project');
    const projects=await Promise.all(paths.map(path=>this.project(path)));
    const identities=projects.map(path=>process.platform==='win32'?path.toLowerCase():path);
    if(new Set(identities).size!==projects.length)throw Error('Each comparison project must be a different approved directory');
    if(input.relative_path!==undefined){
      for(const project of projects){
        const relativePath=serenaRelativePath(input.relative_path,project);
        if(relativePath&&relativePath!=='.')await resolveCanonicalAllowedPath(relativePath,project,[project]);
      }
    }
    // Keep the caller's approved logical path for invoke(): Windows realpath
    // expands 8.3 path aliases (ADMINI~1 -> Administrator), which may not be
    // textually inside the configured logical root on a second validation.
    const found=await Promise.all(paths.map(async (path,index):Promise<ComparedProject>=>{
      const project=projects[index]!;
      try{
        const raw=await this.invoke(path,'find_symbol',{
          name_path_pattern:input.name_path_pattern,relative_path:input.relative_path??'',
          include_body:true,max_matches:limit,max_answer_chars:20000,
        },signal);
        return {path:project,status:'ok',symbols:parseComparedSymbols(raw,limit)};
      }catch(error){
        if(signal?.aborted)throw Error('Serena comparison was cancelled');
        const detail=(error instanceof Error?error.message:String(error)).slice(0,400);
        return {path:project,status:/truncated|more symbols|incomplete|indexing|not return a complete JSON|missing or too large/i.test(detail)?'incomplete':'error',symbols:[],error:detail};
      }
    }));
    return compareSymbolProjects(found);
  }

  // Compare actual grouped LSP diagnostics across approved revisions. Probe
  // *every* project and optional file path before contacting any Serena child.
  // The first project is the baseline; candidates are compared independently.
  async compareDiagnostics(input:SerenaDiagnosticsCompare,signal?:AbortSignal){
    if(this.closing||signal?.aborted)throw Error('Serena diagnostic comparison was cancelled or bridge is shutting down');
    const parsed=serenaDiagnosticsCompareSchema.parse(input);
    const projects=await Promise.all(parsed.paths.map(path=>this.project(path)));
    const identities=projects.map(path=>process.platform==='win32'?path.toLowerCase():path);
    if(new Set(identities).size!==projects.length)throw Error('Each comparison project must be a different approved directory');
    const backend=parsed.scope==='file'?'get_diagnostics_for_file':'get_diagnostics_for_symbol';
    const args:Record<string,unknown>=parsed.scope==='file'
      ?{relative_path:parsed.relative_path,min_severity:parsed.min_severity,max_answer_chars:20000}
      :{name_path:parsed.name_path,...(parsed.reference_file?{reference_file:parsed.reference_file}:{}),
        check_symbol_references:parsed.check_symbol_references??false,min_severity:parsed.min_severity,max_answer_chars:20000};
    const contract=SERENA_READ_SCHEMAS[backend].parse(args);
    for(const project of projects)await this.prepareReadArgs(project,backend,contract);
    const results=await Promise.all(parsed.paths.map(async(path,index):Promise<ProjectDiagnostics>=>{
      const project=projects[index]!;
      try{
        const output=await this.invoke(path,backend,contract,signal);
        if(signal?.aborted)throw Error('Serena diagnostic comparison was cancelled');
        return {path:project,status:'ok',diagnostics:parseGroupedDiagnostics(output)};
      }catch(error){
        if(signal?.aborted)throw Error('Serena diagnostic comparison was cancelled');
        const detail=(error instanceof Error?error.message:String(error)).slice(0,400);
        return {path:project,status:/truncated|too long|exceeds|indexing|incomplete|complete grouped|invalid diagnostic|must be grouped/i.test(detail)?'incomplete':'error',
          diagnostics:[],error:detail};
      }
    }));
    return {scope:parsed.scope,query:parsed.scope==='file'?{relative_path:parsed.relative_path}
      :{name_path:parsed.name_path,reference_file:parsed.reference_file??null,check_symbol_references:parsed.check_symbol_references??false},
    min_severity:parsed.min_severity,...compareDiagnosticProjects(results,parsed.max_details)};
  }

  async memoryGraph(path:string,maxDetails=40,signal?:AbortSignal){
    if(this.closing||signal?.aborted)throw Error('Serena memory scan was cancelled or bridge is shutting down');
    if(!Number.isInteger(maxDetails)||maxDetails<1||maxDetails>100)throw Error('Memory graph details must be 1–100');
    const project=await this.project(path);
    if(this.closing||signal?.aborted)throw Error('Serena memory scan was cancelled');
    return publicMemoryGraph(scanMemoryGraph(project),maxDetails);
  }

  async memoryLinkPreview(path:string,maxDetails=40,signal?:AbortSignal){
    if(this.closing||signal?.aborted)throw Error('Serena memory link preview was cancelled');
    if(!Number.isInteger(maxDetails)||maxDetails<1||maxDetails>100)throw Error('Memory link preview details must be 1–100');
    const project=await this.project(path);
    if(this.closing||signal?.aborted)throw Error('Serena memory link preview was cancelled');
    const graph=scanMemoryGraph(project);
    const captured=snapshot(project);
    if(this.closing||signal?.aborted)throw Error('Serena memory link preview was cancelled');
    return {path:project,status:graph.status==='complete'&&graph.unmarked_omitted===0?'reviewable':'incomplete',
      expected_fingerprint:captured.fingerprint,expected_memory_fingerprint:graph.fingerprint,
      counts:{memory_files:graph.memories.length,unmarked_candidates:graph.unmarked.length+graph.unmarked_omitted,
        writable_candidates:graph.unmarked.filter(c=>!c.read_only).length,stale_references:graph.stale.length,
        ignored_memories:graph.excluded_count,omitted_candidates:graph.unmarked_omitted},
      fixes:{items:graph.unmarked.slice(0,maxDetails).map(({from,to,occurrences,read_only})=>({
        source:from,target:to,expected_occurrences:occurrences,read_only})),
        total:graph.unmarked.length+graph.unmarked_omitted,
        omitted:Math.max(0,graph.unmarked.length-maxDetails)+graph.unmarked_omitted},
      note:'Every fix is an exact unprefixed match of an existing local memory name (topic path or long distinctive flat name). These may still be normal prose or paths: select only confirmed intended references. Already marked mem: links are untouched. Use task_memory_autolink with the selected source/target/count pairs and both fingerprints under the same approved task lease. Read-only, ignored, global, ambiguous, over-limit and unapproved content is never silently rewritten. The plan does not reserve the workspace; application revalidates the complete graph and file hashes before journaling.'};
  }

  async compareMemories(paths:string[],maxDetails=40,signal?:AbortSignal){
    if(this.closing||signal?.aborted)throw Error('Serena memory comparison was cancelled or bridge is shutting down');
    if(paths.length<2||paths.length>MAX_SESSIONS||!Number.isInteger(maxDetails)||maxDetails<1||maxDetails>100)
      throw Error('Compare 2–3 projects with 1–100 details');
    // Resolve every project grant before touching a single memory file.
    const projects=await Promise.all(paths.map(path=>this.project(path)));
    const identities=projects.map(path=>process.platform==='win32'?path.toLowerCase():path);
    if(new Set(identities).size!==projects.length)throw Error('Each memory comparison project must be a different approved directory');
    if(this.closing||signal?.aborted)throw Error('Serena memory comparison was cancelled');
    const graphs=projects.map(project=>{
      if(this.closing||signal?.aborted)throw Error('Serena memory comparison was cancelled');
      return scanMemoryGraph(project);
    });
    return compareMemoryGraphs(graphs,maxDetails);
  }

  // Read-only shared rename plan on a private snapshot; never touches the project.
  async renamePreview(path: string, input: Omit<SerenaRenameInput, 'root'>, signal?: AbortSignal) {
    const root = await this.project(path);
    const { changes: _contents, ...plan } = await planSerenaRename({ ...input, root }, signal);
    return plan;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.privateReads.close();
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async pending => this.closeSession(await pending)));
  }
}

const projectPath = z.string().min(1).describe('Existing approved local project directory (absolute path)');

export function registerSerenaTools(target: McpRegistrationTarget, bridge: SerenaBridge): void {
  const read = (name: string, description: string, backend: BackendTool) => {
    target.registerTool(name, {
      description: `${description} Uses the installed Serena language server on the approved project. Cold Kotlin indexing can return status=indexing with an operation_id; repeat the identical call to retrieve that analysis until complete. Source changes invalidate pending results. Source changes must use Forge task_write/task_edit with recorded verification. Serena may create project indexing metadata.`,
      inputSchema: { path: projectPath, ...SERENA_READ_SCHEMAS[backend].shape },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (input: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
      try {
        const { path, ...args } = input as { path: string; [key: string]: unknown };
        const text = await bridge.invoke(path, backend, args, extra.signal);
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: String(error) }] };
      }
    });
  };

  target.registerTool('serena_rename_preview', {
    description: `Preview a semantic rename from the installed Serena ${SERENA_VERSION} language server without changing files. Plans run on a private copy inside an owned job, wait for cross-file references and require two identical WorkspaceEdits covering every reported reference. Returns 1-based reference locations, the captured fingerprint, exact per-file replacements and file_moves when the language server renames a source file. Moves use the same journal and rollback as edits; existing destinations and directory moves are refused. Apply with task_serena_rename using that fingerprint. For PHP cross-file rename select language php_phpantom after its install/probe; php remains the Intelephense edit-only route. Languages: ${SERENA_RENAME_LANGUAGES.join(', ')}, plus installed backends with registered cross-file rename acceptance (components language-list).`,
    inputSchema: {
      path: projectPath, language: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), file: relativePath.min(1),
      line: z.number().int().positive(), column: z.number().int().positive(), new_name: z.string().min(1).max(200),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input, extra) => {
    try {
      const { path, ...args } = input as { path: string } & Omit<SerenaRenameInput, 'root'>;
      return { content: [{ type: 'text' as const, text: JSON.stringify(await bridge.renamePreview(path, args, extra.signal)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  read('serena_list_memories','List the current project Serena memories.','list_memories');
  read('serena_read_memory','Read a named project Serena memory, including a relative topic path.','read_memory');
  target.registerTool('serena_memory_graph',{
    description:'Inspect the complete bounded project-local Serena memory reference graph without starting an LSP or changing files. Returns content hashes, incoming/outgoing mem: links, unresolved references, cycles, read-only policy flags and unreferenced memories; does not reveal file contents. Honors ignored/read-only Serena memory patterns, omits global memories, and marks results partial when ignored files prevent complete integrity validation. Scan limit 512 files / 16 MiB; symlink paths are refused.',
    inputSchema:{path:projectPath,max_details:z.number().int().min(1).max(100).default(40)},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async(input,extra)=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await bridge.memoryGraph(input.path,input.max_details,extra.signal))}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}
  });
  target.registerTool('serena_memory_link_preview',{
    description:'Preview exact missing mem: prefixes in existing topic or long-name Serena memories in one owner-approved project. Returns bounded source/target/count suggestions, per-source read-only status, missing-link and policy evidence, plus workspace/memory fingerprints for transactionally selected task_memory_autolink repairs. Does not modify memory text; a path or prose match is only a candidate. Scans up to 512 files/16 MiB without starting an LSP. Global and ignored memory content is excluded.',
    inputSchema:{path:projectPath,max_details:z.number().int().min(1).max(100).default(40)},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async(input,extra)=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await bridge.memoryLinkPreview(input.path,input.max_details,extra.signal))}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}
  });
  target.registerTool('serena_compare_memories',{
    description:'Compare memory graph snapshots from 2–3 distinct approved project roots before changing or moving Serena knowledge. The FIRST project is baseline. Shows added, removed, changed and byte-identical memory files, introduced/resolved mem: links and dangling references with per-project completeness evidence. All project grants are checked first; ignored memory policies or partial graphs make overall equivalence unknown. Project-local read only, no LSP, no memory content disclosure, no global-memory claims.',
    inputSchema:{paths:z.array(projectPath).min(2).max(MAX_SESSIONS),max_details:z.number().int().min(1).max(100).default(40)},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async(input,extra)=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await bridge.compareMemories(input.paths,input.max_details,extra.signal))}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}
  });
  read('serena_symbols_overview','LSP symbol outline of a file across Serena-supported languages.','get_symbols_overview');
  read('serena_find_symbol','Find classes, functions and methods by symbol name or qualified path.','find_symbol');
  read('serena_find_references','Locate cross-file references to a symbol by qualified name and defining file.','find_referencing_symbols');
  read('serena_search_pattern','Search project code with Serena bounded pattern search.','search_for_pattern');
  read('serena_find_file','Find project files by filename pattern using Serena.','find_file');
  read('serena_list_dir','Inspect project directories using Serena.','list_dir');
  read('serena_find_implementations','Find implementations of an interface, abstract or overridden symbol through the language server.','find_implementations');
  read('serena_find_declaration','Go to the declaration of the first regex match in a file (use a capture group or the whole match for the referencing identifier).','find_declaration');
  read('serena_file_diagnostics','Language-server diagnostics for one file, optionally limited to a line range (0-based start, -1 for end) and minimum severity (1 error .. 4 hint).','get_diagnostics_for_file');
  read('serena_symbol_diagnostics','Language-server diagnostics grouped by file, severity and qualified symbol. Optionally include diagnostics of symbols referencing name_path. reference_file disambiguates the symbol. Serena optional read capability is enabled in the dedicated Forge child process; a project/backend excluding it returns a clear error.','get_diagnostics_for_symbol');
  target.registerTool('serena_query_projects',{
    description:'Run a different or identical existing read-only Serena operation in each of 2–3 distinct approved projects concurrently. Supports all 12 listed Serena read backends, including symbol/reference/implementation lookup, file or symbol/reference-impact diagnostics, bounded code search, directory/file discovery and memories. Validates every project and relative path before any RPC. Returns ordered per-project bounded text and explicit error/indexing/truncation status; no source edits. A batch may be incomplete even when some projects returned results.',
    inputSchema:serenaProjectBatchSchema.shape,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async(input,extra)=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await bridge.queryProjects(input,extra.signal))}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}
  });
  target.registerTool('serena_compare_symbols',{
    description:'Compare the same named symbol in 2–3 distinct approved projects using their actual Serena language servers. Returns per-project file/name/kind identities, SHA-256 of normalized source bodies, and groups of unchanged/changed/missing symbols. A project error, incomplete index, duplicate symbol or truncated backend answer explicitly makes the comparison inconclusive. Never modifies source files and never claims semantic or runtime equivalence. This compares exact symbol source text, ignoring locations/line numbers. For full code, use serena_find_symbol on the individual project.',
    inputSchema:{
      paths:z.array(projectPath).min(2).max(MAX_SESSIONS).describe('Two or three different approved project roots; all grants checked before any language server call.'),
      name_path_pattern:z.string().min(1).max(300),
      relative_path:relativePath.optional().describe('Optional same project-relative file or directory to search in each project.'),
      max_matches:z.number().int().min(1).max(30).default(15),
    },
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async(input,extra)=>{
    try{
      const result=await bridge.compareSymbols(input.paths,input,extra.signal);
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    }catch(error){
      return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};
    }
  });
  target.registerTool('serena_compare_diagnostics',{
    description:'Compare actual Serena LSP diagnostics between two or three different approved project versions, with the FIRST project as baseline. Supports file-wide diagnostics or a named symbol plus optional diagnostics of its referencing symbols. Reports introduced, resolved and unchanged diagnostics, including counts for repeated occurrences, and ignores incidental line/column movement. Incomplete indexing, malformed/truncated responses and backend failures never produce conclusive deltas. Read-only, project-scoped; this is not a complete build or whole-repository diagnostic scan.',
    inputSchema:serenaDiagnosticsCompareSchema.shape,
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async(input,extra)=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify(await bridge.compareDiagnostics(input,extra.signal))}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}
  });
}
