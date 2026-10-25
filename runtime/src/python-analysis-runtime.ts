import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWindowsJob} from './durable-windows-job.js';
import {isPathInsideRoot} from './roots.js';
import {loadPythonProject,pythonSourcePath,pythonHash,verifyPythonEnvironment,type PythonProject} from './python-project.js';
import {pythonDependencyPath} from './python-dependencies.js';
import {runPythonTypeDiagnostics} from './python-type-diagnostics.js';
import type {CodeNavigationInput} from './code-navigation.js';

export interface PythonReply {
  ok:boolean; error?:string; error_type?:string;
  results:Record<string,unknown>[]; changed:Record<string,string>;
  edits:{file:string;line:number;column:number;end_line:number;end_column:number;old_text:string;new_text:string}[];
  rename?:{can_rename:boolean}; python_version:string; jedi_version:string; parso_version:string;
  import_settings:{default_roots:string[];package_roots:string[];stub_path:string|null;execution_environments:{root:string;import_roots:string[];python_version?:string;python_platform?:string}[];ignored_options:string[];config_source:string|null;checker_options:Record<string,string|boolean>;stub_packages:{file:string;name:string;kind:'complete'|'partial'|'namespace'}[];stub_packages_total:number;stub_packages_truncated:boolean};
  source_selection:{applied:boolean;root_files:string[];analysis_files:string[];excluded_files:string[];read_only_files:string[];include:{file:string;pattern:string}[];exclude:{file:string;pattern:string}[];default_exclude_hidden:boolean};
  type_checker?:{name:'pyright';version:string;source_files:number};
}
type Options={signal?:AbortSignal;timeoutMs?:number;onCaptured?:(project:PythonProject)=>void;onLaunched?:(pid:number,creationTime:string)=>void};
type Reply={project:PythonProject;reply:PythonReply};
// .pth roots inside the environment are read-only dependency roots; roots
// elsewhere in the project behave like extraPaths over editable sources.
const pthRoots=(dependencies:PythonProject['dependencies'],inside:boolean)=>dependencies.path_roots.map(item=>item.root)
  .filter(root=>root.toLowerCase().startsWith(String(dependencies.root).toLowerCase()+'/')===inside);
interface Work {input:CodeNavigationInput;roots:string[];options:Options;controller:AbortController;reason?:Error;resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>;abort?:()=>void}
const pending:Work[]=[];let active:Work|undefined;
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
function check(work:Work){if(work.controller.signal.aborted)throw work.reason??new Error('Python analysis cancelled');}

async function interpreter(signal:AbortSignal):Promise<string> {
  return new Promise((resolve,reject)=>execFile('python',['-I','-S','-B','-c','import sys; print(sys.executable)'],
    {cwd:tmpdir(),windowsHide:true,timeout:5000,maxBuffer:8192,signal},(error,out)=>error?reject(new Error('A working Python 3 interpreter on PATH is required: '+error.message)):resolve(out.trim())));
}
function pythonColumn(text:string,line:number,column:number) {
  const lines=text.split(/\r\n|\r|\n/),value=lines[line-1];
  if(value===undefined)throw new Error('Line outside file');
  const offset=column-1;
  if(offset<0||offset>=value.length)throw new Error('Column outside line');
  if(offset>0&&/[\uDC00-\uDFFF]/.test(value[offset]!)&&/[\uD800-\uDBFF]/.test(value[offset-1]!))throw new Error('Column splits a UTF-16 surrogate pair');
  return [...value.slice(0,offset)].length-(line===1&&text.startsWith('\uFEFF')?1:0);
}
async function perform(work:Work):Promise<Reply> {
  let owned:string|undefined,job:ReturnType<typeof startWindowsJob>|undefined;
  const parent=await realpath(tmpdir());
  try {
    check(work);
    const project=await loadPythonProject(work.input,work.roots,work.controller.signal);check(work);
    let file:string|undefined;
    if(work.input.file) {
      const candidate=relative(project.root,resolve(project.root,work.input.file)).replaceAll('\\','/');
      const dependency=project.dependencies.snapshots.find(item=>item.file.toLowerCase()===candidate.toLowerCase());
      const name=dependency?await pythonDependencyPath(dependency.file,project.root):await pythonSourcePath(work.input.file,project.root);
      file=relative(project.root,name).replaceAll('\\','/');
      if(project.opaque_sources.has(file)||project.dependencies.opaque_sources.has(file))throw new Error('Python analysis requires UTF-8 for the target source');
      if(!project.sources.has(file)&&!project.dependencies.sources.has(file))throw new Error('Target file must be included in captured Python sources');
    }
    const executable=await interpreter(work.controller.signal);check(work);
    const executableHash=pythonHash(await readFile(executable));
    project.environment.pins.push({path:executable,sha256:executableHash});
    project.environment.fingerprint=pythonHash(project.environment.fingerprint+executableHash);
    work.options.onCaptured?.(project);check(work);
    owned=await mkdtemp(join(parent,'forge-python-analysis-'));
    const snapshot=join(owned,'source');await mkdir(snapshot);
    for(const [name,text] of [...project.sources,...project.opaque_sources,...project.dependencies.sources,...project.dependencies.opaque_sources]) {
      check(work);const target=join(snapshot,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,text,'utf8');
    }
    const query={...work.input,file,...(file&&work.input.line&&work.input.column?{python_column:pythonColumn((project.sources.get(file)??project.dependencies.sources.get(file))!,work.input.line,work.input.column)}:{})};
    const input=join(owned,'input.json');await writeFile(input,JSON.stringify({snapshot_root:snapshot,sources:Object.fromEntries([...project.sources,...project.dependencies.sources]),project_sources:project.snapshots.map(item=>item.file),opaque_sources:[...project.opaque_sources.keys(),...project.dependencies.opaque_sources.keys()],dependency_files:project.dependencies.snapshots.map(item=>item.file),dependency_roots:[...project.dependencies.site_packages,...pthRoots(project.dependencies,true)],project_path_roots:pthRoots(project.dependencies,false),typed_markers:project.dependencies.typed_markers,configuration_texts:project.configuration_texts,pyright_chain:project.pyright_chain,directories:project.directories,skipped_links:project.skipped_links,query}),'utf8');
    check(work);
    verifyPythonEnvironment(project);check(work);
    if(process.platform!=='win32')throw new Error('The owned Python analysis backend currently requires Windows');
    const helper=fileURLToPath(new URL('../scripts/python-analysis/analyze.py',import.meta.url));
    const output=join(owned,'output.json');
    job=startWindowsJob('& '+[executable,'-I','-S','-B','-X','utf8',helper,input].map(quote).join(' '),snapshot,output,'ForgePython-'+randomUUID(),{memoryLimitMiB:1024});
    await job.input('',true);
    work.options.onLaunched?.(job.pid,job.creation_time);
    let code:number|null=null;
    while(code===null) {
      check(work);
      if((await lstat(output)).size>16*1024*1024)throw new Error('Python analysis output exceeds 16 MiB; no partial result is returned');
      code=job.poll();if(code===null)await new Promise(resolve=>setTimeout(resolve,30));
    }
    check(work);job.close();job=undefined;
    if(code!==0)throw new Error('Python analysis process exited before a valid result ('+code+')');
    if((await lstat(output)).size>16*1024*1024)throw new Error('Python analysis output exceeds 16 MiB');
    const reply=JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,'')) as PythonReply;
    if(!reply.ok)throw new Error('Python analysis failed: '+reply.error_type+': '+reply.error);
    if(!Array.isArray(reply.results)||typeof reply.changed!=='object'||reply.changed===null||!/^3\./.test(reply.python_version))throw new Error('Invalid Python analysis result');
    if(work.input.action==='diagnostics') {
      verifyPythonEnvironment(project);check(work);
      const typecheck=await runPythonTypeDiagnostics(snapshot,owned,reply,work.controller.signal,{root:project.dependencies.root,site_packages:project.dependencies.site_packages,path_roots:project.dependencies.path_roots.map(item=>item.root)});
      check(work);
      for(const entry of typecheck.results)if(!file||entry.file.toLowerCase()===file.toLowerCase())reply.results.push({...entry});
      reply.type_checker={name:'pyright',version:typecheck.version,source_files:reply.source_selection.root_files.length};
    }
    return {project,reply};
  } catch(error) {check(work);throw error;}
  finally {
    // Closing our own non-breakaway job kills Python and its inference helpers.
    if(job)job.close();
    if(owned) {
      const item=await lstat(owned),canonical=await realpath(owned);
      if(item.isSymbolicLink()||!isPathInsideRoot(canonical,parent)||canonical!==owned)throw new Error('Refusing cleanup of a changed analysis directory');
      await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    }
  }
}
function release(work:Work) {
  clearTimeout(work.timer);if(work.abort)work.options.signal?.removeEventListener('abort',work.abort);
}
function cancel(work:Work,error:Error) {
  if(work.controller.signal.aborted)return;
  work.reason=error;work.controller.abort();
  const index=pending.indexOf(work);
  if(index!==-1){pending.splice(index,1);release(work);work.reject(error);}
}
function pump() {
  if(active||!pending.length)return;
  const work=pending.shift()!;active=work;
  void perform(work).then(value=>{release(work);active=undefined;work.resolve(value);pump();},error=>{release(work);active=undefined;work.reject(error instanceof Error?error:new Error(String(error)));pump();});
}
// A separate Python queue bounds interpreter load; its deadline includes capture and queue wait.
export function runPythonAnalysis(input:CodeNavigationInput,roots:string[],options:Options={}):Promise<Reply> {
  if(options.signal?.aborted)return Promise.reject(new Error('Python analysis cancelled'));
  if(pending.length>=8)return Promise.reject(new Error('Python analysis queue is full; wait before trying again'));
  return new Promise((resolve,reject)=>{
    const work:Work={input,roots,options,controller:new AbortController(),resolve,reject};
    work.abort=()=>cancel(work,new Error('Python analysis cancelled'));
    options.signal?.addEventListener('abort',work.abort,{once:true});
    work.timer=setTimeout(()=>cancel(work,new Error('Python analysis timed out; no partial result is returned')),options.timeoutMs??120000);
    pending.push(work);pump();
  });
}
