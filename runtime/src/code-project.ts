import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, posix, relative, resolve } from 'node:path';
import ts from 'typescript';
import { isPathInsideRoot, resolveCanonicalAllowedPath } from './roots.js';
import { captureCodeEnvironment, readProjectSource, type CodeEnvironment } from './code-environment.js';
import {loadCodeConfigGraph} from './code-config-graph.js';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache']);
const MAX_FILES = 2048;
const MAX_BYTES = 32 * 1024 * 1024;
export const sourceFileLimit = (path:string) => /\.d\.[cm]?ts$/i.test(path) ? 4 * 1024 * 1024 : 512 * 1024;

export const sourceKey = (path: string) => {
  const value = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function boundedText(path: string, limit: number) {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular file');
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > limit) throw new Error(`File exceeds ${limit / 1024} KiB analysis limit`);
    const data = buffer.subarray(0, count);
    const text = data.toString('utf8');
    if (!Buffer.from(text).equals(data)) throw new Error('Code analysis requires valid UTF-8');
    return { text, bytes: count };
  } finally { await handle.close(); }
}

export interface CodeProject {
  root: string;
  texts: Map<string, string>;
  names: Map<string, string>;
  rootNames: string[];
  options: ts.CompilerOptions;
  environment: CodeEnvironment;
  configs: Map<string,{name:string;text:string}>;
  projects: {config:string|null;rootNames:string[];options:ts.CompilerOptions;references?:ts.ProjectReference[];environment:CodeEnvironment}[];
  metadata: {
    config: string | null;
    config_snapshots: { file: string; sha256: string }[];
    excluded_directories: string[];
    skipped_links: string[];
    libraries_loaded: boolean;
    dependencies_loaded: boolean;
    projects: {config:string|null;source_files:number;references:string[];source_redirects:boolean}[];
  };
}

// TypeScript requests globs during config parsing. Evaluate them only against
// already captured paths, never against ts.sys or an unrestricted disk host.
export function configMatches(path: string, directory: string, pattern: string) {
  let glob = relative(directory, resolve(directory, pattern)).replaceAll('\\', '/');
  let name = relative(directory, path).replaceAll('\\', '/');
  if (process.platform === 'win32') { glob = glob.toLowerCase(); name = name.toLowerCase(); }
  if (!/[?*[{]/.test(glob) && !extname(glob)) glob = `${glob.replace(/\/$/, '')}/**/*`;
  if (!glob || glob === '.') glob = '**/*';
  if (posix.matchesGlob(name, glob)) return true;
  // Excluding a matching directory also excludes everything below it.
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) if (posix.matchesGlob(parts.slice(0, i).join('/'), glob)) return true;
  return false;
}

export async function loadCodeProject(input: { path: string; files?: string[] }, roots: string[]): Promise<CodeProject> {
  const root = await realpath(await resolveCanonicalAllowedPath(input.path, input.path, roots));
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected a project directory');
  const texts = new Map<string, string>();
  const names = new Map<string, string>();
  const candidates = new Map<string,string>();
  const skippedLinks: string[] = [];
  let bytes = 0;
  const add = async (file: string) => {
    const name = await resolveCanonicalAllowedPath(file, root, [root]);
    if (!SOURCE_EXTENSION.test(extname(name))) throw new Error('Only TypeScript/JavaScript files are supported');
    const key = sourceKey(name);
    if (texts.has(key)) return;
    if (texts.size === MAX_FILES) throw new Error(`Project exceeds ${MAX_FILES} source files; select a smaller project or explicit files`);
    const data = await boundedText(name, sourceFileLimit(name));
    bytes += data.bytes;
    const limit = input.files ? 2 * 1024 * 1024 : MAX_BYTES;
    if (bytes > limit) throw new Error(`Selected files exceed ${limit / 1024 / 1024} MiB analysis limit`);
    texts.set(key, data.text);
    names.set(key, name);
  };
  if (input.files) {
    for (const file of input.files) await add(file);
  } else {
    let entries = 0;
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop()!;
      await resolveCanonicalAllowedPath(directory, root, [root]);
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of children) {
        if (++entries > 20000) throw new Error('Project exceeds 20,000 directory entries; select a smaller project');
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) { skippedLinks.push(relative(root, path)); continue; }
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(path);
        } else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) candidates.set(sourceKey(path),path);
      }
    }
  }

  const defaults: ts.CompilerOptions = { allowJs: true, noLib: !!input.files, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve };
  let configs = new Map<string, { name: string; text: string }>();
  const metadata: CodeProject['metadata'] = {
    config: null, config_snapshots: [], excluded_directories: input.files ? [] : [...EXCLUDED_DIRECTORIES],
    skipped_links: skippedLinks.sort(), libraries_loaded: false, dependencies_loaded: false,projects:[],
  };
  let options = defaults;
  let configuredNames=[...candidates.values()];
  let nodes:{config:string|null;rootNames:string[];options:ts.CompilerOptions;references?:ts.ProjectReference[]}[]=[];
  if (!input.files) {
    let configPath: string | undefined;
    for (const filename of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = join(root, filename);
      try { await lstat(candidate); configPath = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (configPath) {
      const graph=await loadCodeConfigGraph(root,candidates,configPath,defaults);
      configs=graph.configs;nodes=graph.nodes;
      configuredNames=[...new Set(nodes.flatMap(node=>node.rootNames))];
      options=nodes.find(node=>sourceKey(node.config!)===sourceKey(configPath))!.options;
      metadata.config = relative(root, configPath);
      metadata.config_snapshots = [...configs.values()].map(c => ({ file: relative(root, c.name), sha256: sourceHash(c.text) }));
    }
  }
  if(!input.files)for(const file of configuredNames) {
    if(!isPathInsideRoot(file,root))throw new Error('Configured source is outside the project');
    if(!candidates.has(sourceKey(file)))throw new Error(`Configured source is missing, linked or excluded: ${relative(root,file)}`);
    await add(file);
  }
  const rootNames=[...names.values()];
  if(!nodes.length)nodes=[{config:null,rootNames,options}];
  const loadSource=(file:string)=>{
    const key=sourceKey(file),name=candidates.get(key);if(!name)return false;
    if(texts.has(key))return true;
    if(texts.size===MAX_FILES)throw new Error(`Project exceeds ${MAX_FILES} source files; select a smaller project or explicit files`);
    const data=readProjectSource(name,root);bytes+=data.bytes;
    if(bytes>MAX_BYTES)throw new Error(`Project sources exceed ${MAX_BYTES/1024/1024} MiB analysis limit`);
    texts.set(key,data.text);names.set(key,name);return true;
  };
  const redirects=new Map<string,string[]>(),outputs=new Set<string>();
  for(const node of nodes)if(node.config&&node.options.composite) {
    for(const file of node.rootNames) {
      if(/\.d\.[cm]?ts$/i.test(file))continue;
      const commandLine={options:node.options,fileNames:node.rootNames.map(name=>name.replaceAll('\\','/')),errors:[]};
      for(const output of ts.getOutputFileNames(commandLine,file.replaceAll('\\','/'),process.platform==='win32'))if(/\.d\.[cm]?ts$/i.test(output)) {
        if(!isPathInsideRoot(output,root))throw new Error('Referenced declaration output is outside the project');
        const key=sourceKey(output);outputs.add(key);
        redirects.set(key,[...redirects.get(key)??[],file]);
      }
    }
  }
  const cachedCaptures:CodeEnvironment['captures']=new Map();
  const projects=nodes.map(node=>({...node,environment:input.files
    ? {captures:new Map(),defaultLib:'',unresolvedNames:[],metadata:{typescript_version:ts.version,fingerprint:sourceHash('[]'),files:0,bytes:0,snapshots:[],snapshots_truncated:false,unresolved:[],unresolved_total:0}}
    : captureCodeEnvironment(root,texts,names,node.options,loadSource,{cachedCaptures,rootNames:node.rootNames,redirects:node.options.disableSourceOfProjectReferenceRedirect?undefined:redirects,outputs})}));
  const captures=new Map(projects.flatMap(node=>[...node.environment.captures]));
  const unresolved=[...new Set(projects.flatMap(node=>node.environment.unresolvedNames??node.environment.metadata.unresolved))].sort();
  const snapshots=[...captures.values()].map(item=>({file:item.kind==='library'?`typescript:${item.path.split(/[\\/]/).at(-1)}`:relative(root,item.path).replaceAll('\\','/'),kind:item.kind,sha256:sourceHash(item.text)})).sort((a,b)=>a.file.localeCompare(b.file));
  const environment:CodeEnvironment={captures,defaultLib:projects[0]!.environment.defaultLib,unresolvedNames:unresolved,metadata:{typescript_version:ts.version,fingerprint:sourceHash(JSON.stringify(snapshots)),files:captures.size,bytes:[...captures.values()].reduce((sum,item)=>sum+item.bytes,0),snapshots:snapshots.slice(0,100),snapshots_truncated:snapshots.length>100,unresolved:unresolved.slice(0,100),unresolved_total:unresolved.length}};
  metadata.projects=projects.map(node=>({config:node.config?relative(root,node.config):null,source_files:node.rootNames.length,references:(node.references??[]).map(ref=>relative(root,ts.resolveProjectReferencePath(ref))),source_redirects:!node.options.disableSourceOfProjectReferenceRedirect}));
  metadata.libraries_loaded=[...environment.captures.values()].some(item=>item.kind==='library');
  metadata.dependencies_loaded=[...environment.captures.values()].some(item=>item.kind==='dependency');
  return { root, texts, names, rootNames, options, metadata, environment,projects,configs };
}
