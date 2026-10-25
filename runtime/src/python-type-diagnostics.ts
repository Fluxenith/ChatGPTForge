import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,posix,relative,resolve} from 'node:path';
import {startWindowsJob} from './durable-windows-job.js';
import {isPathInsideRoot} from './roots.js';
import type {PythonReply} from './python-analysis-runtime.js';

// Resolve through Node's dependency graph: npm may hoist pyright into the
// consumer application's node_modules instead of nesting it in our package.
const require=createRequire(import.meta.url);
const pyrightEntrypoint=require.resolve('pyright');
const pyrightManifest=require.resolve('pyright/package.json');
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const maxOutput=16*1024*1024;

interface Diagnostic {
  file:string;line:number;column:number;end_line:number;end_column:number;
  code:string;severity:string;message:string;read_only?:boolean;position_encoding:'utf16';
}

// The captured environment, as the checker should see it inside the snapshot.
export interface PythonCheckerEnvironment {root:string|null;site_packages:string[];path_roots:string[]}

function configFor(reply:PythonReply,environment:PythonCheckerEnvironment) {
  const settings=reply.import_settings;
  // Environment roots are presented to Pyright as a virtual environment, not
  // extraPaths, so installed and .pth-added modules are third-party imports.
  const external=new Set(environment.root===null?[]:[...environment.site_packages,...environment.path_roots].map(item=>item.toLowerCase()));
  // Only source files selected by the existing Jedi capture are entrypoints.
  // Imported sources and dependency stubs remain available in the snapshot.
  const roots=(items:string[])=>[...new Set(items.filter(item=>Boolean(item)&&!external.has(item.toLowerCase())))];
  return {
    include:reply.source_selection.root_files,
    exclude:[],
    typeCheckingMode:'basic',
    // Pyright's documented default; captured library sources are read, never run.
    useLibraryCodeForTypes:true,
    ...(settings.stub_path!==null?{stubPath:settings.stub_path||'.'}:{}),
    ...(environment.root!==null?{venvPath:posix.dirname(environment.root),venv:posix.basename(environment.root)}:{}),
    extraPaths:roots(settings.default_roots),
    executionEnvironments:settings.execution_environments.map(item=>({
      root:item.root||'.',extraPaths:roots(item.import_roots),
      ...(item.python_version?{pythonVersion:item.python_version}:{}),
      ...(item.python_platform?{pythonPlatform:item.python_platform}:{}),
    })),
    ...settings.checker_options,
  };
}

export async function pythonTypeCheckerIdentity() {
  const metadata=JSON.parse(await readFile(pyrightManifest,'utf8')) as {version:string};
  if(metadata.version!=='1.1.414')throw new Error('Pinned Pyright 1.1.414 is required for Python type diagnostics');
  return {version:metadata.version};
}

export async function runPythonTypeDiagnostics(
  snapshot:string,
  owned:string,
  reply:PythonReply,
  signal:AbortSignal,
  environment:PythonCheckerEnvironment={root:null,site_packages:[],path_roots:[]},
):Promise<{version:string;results:Diagnostic[]}> {
  const {version}=await pythonTypeCheckerIdentity();
  signal.throwIfAborted();
  const config=join(snapshot,'pyrightconfig.json');
  await writeFile(config,JSON.stringify(configFor(reply,environment)),'utf8');
  if(environment.root!==null&&environment.site_packages.length) {
    // Captured .pth path lines, rewritten relative to the snapshot copy so
    // the checker never reads the original project or an absolute path.
    const site=environment.site_packages[0]!;
    for(const folder of environment.site_packages)await mkdir(join(snapshot,folder),{recursive:true});
    if(environment.path_roots.length)
      await writeFile(join(snapshot,site,'forge-captured-paths.pth'),environment.path_roots.map(root=>posix.relative(site,root)||'.').join('\n')+'\n','utf8');
  }
  const output=join(owned,'pyright-output.json');
  const command='& '+[process.execPath,pyrightEntrypoint,'--project',snapshot,'--outputjson'].map(quote).join(' ');
  let job:ReturnType<typeof startWindowsJob>|undefined;
  let exit:number|null=null;
  try {
    job=startWindowsJob(command,snapshot,output,'ForgePyright-'+randomUUID(),{memoryLimitMiB:1536});
    await job.input('',true);
    while(exit===null) {
      signal.throwIfAborted();
      if((await lstat(output)).size>maxOutput)throw new Error('Pyright diagnostics exceed 16 MiB');
      exit=job.poll();
      if(exit===null)await new Promise(done=>setTimeout(done,30));
    }
  }finally {if(job)job.close();}
  signal.throwIfAborted();
  if(exit!==0&&exit!==1)throw new Error('Pyright failed before producing type diagnostics (exit '+exit+')');
  if((await lstat(output)).size>maxOutput)throw new Error('Pyright diagnostics exceed 16 MiB');
  let parsed:unknown;
  try {parsed=JSON.parse(await readFile(output,'utf8'));}
  catch {throw new Error('Pyright returned invalid JSON diagnostics');}
  const body=parsed as {version?:unknown;generalDiagnostics?:unknown;summary?:unknown};
  if(body?.version!==version||!Array.isArray(body.generalDiagnostics)||!body.summary)
    throw new Error('Pyright returned invalid diagnostic metadata');
  const snapshotRoot=await realpath(snapshot);
  const files=new Map(reply.source_selection.analysis_files.map(file=>[file.toLowerCase(),file]));
  const readOnly=new Set(reply.source_selection.read_only_files.map(file=>file.toLowerCase()));
  const results:Diagnostic[]=[];
  for(const value of body.generalDiagnostics) {
    const item=value as {file?:unknown;severity?:unknown;message?:unknown;rule?:unknown;range?:{
      start?:{line?:unknown;character?:unknown};end?:{line?:unknown;character?:unknown};
    }};
    if(typeof item.file!=='string'||typeof item.message!=='string'||typeof item.severity!=='string'||
       typeof item.rule!=='string'||!item.range?.start||!item.range.end)
      continue; // Preserve the existing Python AST syntax diagnostics.
    const path=resolve(item.file);
    if(!isPathInsideRoot(path,snapshotRoot)) {
      // Windows can report 8.3 path spellings for the same captured source.
      const canonical=await realpath(path).catch(()=>null);
      if(!canonical||!isPathInsideRoot(canonical,snapshotRoot))continue;
    }
    const canonical=await realpath(path);
    if(!isPathInsideRoot(canonical,snapshotRoot))continue;
    const file=files.get(relative(snapshotRoot,canonical).replaceAll('\\','/').toLowerCase());
    if(!file)continue;
    const {start,end}=item.range;
    if(![start.line,start.character,end.line,end.character].every(value=>Number.isSafeInteger(value)&&Number(value)>=0))
      throw new Error('Pyright returned an invalid diagnostic position');
    results.push({file,line:Number(start.line)+1,column:Number(start.character),
      end_line:Number(end.line)+1,end_column:Number(end.character),
      code:item.rule,severity:item.severity,message:item.message,
      ...(readOnly.has(file.toLowerCase())?{read_only:true}:{}),position_encoding:'utf16'});
  }
  return {version,results};
}
