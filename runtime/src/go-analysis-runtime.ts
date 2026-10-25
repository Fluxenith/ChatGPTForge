import {randomUUID} from 'node:crypto';
import {lstat,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {startWindowsJob} from './durable-windows-job.js';
import {isPathInsideRoot} from './roots.js';
import {goBackendRoot,loadGoProject,verifyGoEnvironment,captureGoTree,refreshGoFingerprint,type GoProject,type GoProjectPhase} from './go-project.js';
import {GoToolchainCache,type GoToolchainLease,type GoToolchainPhase} from './go-toolchain-cache.js';
import type {CodeNavigationInput} from './code-navigation.js';

export interface GoReply {
  ok:boolean;error?:string;raw:unknown;language_server:{name:string;version:string};
  diagnostics_complete:boolean;analysis_files:string[];package_errors:{directory:string;message:string}[];
  build_flags:string[];goos:string;goarch:string;cgo_enabled:boolean;
}
export type GoAnalysisPhase='queued'|GoProjectPhase|GoToolchainPhase|'module_prepare'|'dependency_capture'|'input_verify'|'cache_recheck'|'analysis';
type Options={signal?:AbortSignal;timeoutMs?:number;onCaptured?:(project:GoProject)=>void;onLaunched?:(pid:number,creation:string)=>void;onPhase?:(phase:GoAnalysisPhase,elapsedMs:number)=>void};
type Reply={project:GoProject;reply:GoReply};
interface Work {input:CodeNavigationInput;roots:string[];options:Options;controller:AbortController;started:number;phase:GoAnalysisPhase;phaseStarted:number;reason?:Error;resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer?:ReturnType<typeof setTimeout>;abort?:()=>void}
const pending:Work[]=[];let active:Work|undefined;
let toolchainCache:GoToolchainCache|undefined;
export async function closeGoAnalysisCache() {
  const cache=toolchainCache;
  await cache?.close();
  if(toolchainCache===cache)toolchainCache=undefined;
}
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const escaped=(value:string)=>value.replace(/[A-Z]/g,letter=>'!'+letter.toLowerCase());
function check(work:Work){if(work.controller.signal.aborted)throw work.reason??new Error('Go analysis cancelled');}
function phase(work:Work,value:GoAnalysisPhase) {
  check(work);work.phase=value;work.phaseStarted=Date.now();
  work.options.onPhase?.(value,work.phaseStarted-work.started);check(work);
}
async function perform(work:Work):Promise<Reply> {
  const parent=await realpath(tmpdir());let owned:string|undefined,job:ReturnType<typeof startWindowsJob>|undefined,toolchain:GoToolchainLease|undefined;
  try {
    check(work);
    if(process.platform!=='win32')throw new Error('The owned Go analysis backend currently requires Windows');
    owned=await mkdtemp(join(parent,'forge-go-analysis-'));
    const project=await loadGoProject(work.input,work.roots,owned,work.controller.signal,async(root,version,signal)=>{
      toolchain=await (toolchainCache??=new GoToolchainCache()).acquire(root,version,signal,value=>phase(work,value));
      return toolchain.tree;
    },value=>phase(work,value));check(work);
    const files=project.trees[0]!.files.map(file=>file.file);
    const normalized=(file:string)=>project.selected.find(name=>name.toLowerCase()===relative(project.root,resolve(project.root,file)).replaceAll('\\','/').toLowerCase())!;
    const target=work.input.file?normalized(work.input.file):undefined;
    if(target&&['definition','references','rename_preview'].includes(work.input.action)) {
      const value=project.sources.get(target)!.split(/\r\n|\r|\n/)[(work.input.line??0)-1],offset=(work.input.column??0)-1;
      if(value===undefined||offset<0||offset>=value.length)throw new Error('Go query position is outside its source line');
      if(offset>0&&/[\uDC00-\uDFFF]/.test(value[offset]!)&&/[\uD800-\uDBFF]/.test(value[offset-1]!))throw new Error('Go query splits a UTF-16 surrogate pair');
    }
    const payload={owned,goroot:project.trees[1]!.destination,snapshot:project.snapshot,original_root:project.root,source_files:[...project.sources.keys()],project_files:files,
      gopls:join(goBackendRoot,'gopls.exe'),query:{...work.input,...(target?{file:target}:{}),...(work.input.files?{files:work.input.files.map(normalized)}:{})}};
    async function helper(mode:string,prepared?:unknown) {
      check(work);
      const input=join(owned!,mode+'-input.json'),output=join(owned!,mode+'-output.json');
      await writeFile(input,JSON.stringify({...payload,mode,prepared}));
      const command="$env:NODE_OPTIONS=$null; $env:NODE_PATH=$null; & "+[project.node_executable,join(goBackendRoot,'analyze.mjs'),input].map(quote).join(' ');
      job=startWindowsJob(command,project.snapshot,output,'ForgeGo-'+randomUUID(),{memoryLimitMiB:2048});
      await job.input('',true);work.options.onLaunched?.(job.pid,job.creation_time);
      let code:number|null=null;
      while(code===null) {
        check(work);
        if((await lstat(output)).size>16*1024*1024)throw new Error('Go analysis output exceeds 16 MiB');
        code=job.poll();if(code===null)await new Promise(resolve=>setTimeout(resolve,30));
      }
      check(work);job.close();job=undefined;
      if((await lstat(output)).size>16*1024*1024)throw new Error('Go analysis output exceeds 16 MiB');
      let reply;try{reply=JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,''));}catch{throw new Error('Go helper exited without a valid response ('+code+')');}
      if(code!==0||!reply.ok)throw new Error('Go analysis failed: '+String(reply.error??code));
      return reply;
    }
    phase(work,'module_prepare');
    const prepared=await helper('prepare') as {modules:{path:string;version:string}[];main_roots:string[];local_roots:string[];vendored:boolean};
    if(!Array.isArray(prepared.modules)||prepared.modules.length>128||!Array.isArray(prepared.local_roots))throw new Error('Invalid Go module preparation response');
    phase(work,'dependency_capture');
    let dependencyFiles=0,dependencyBytes=0,dependencySources=0;
    for(const module of prepared.modules) {
      check(work);
      if(!/^[a-zA-Z0-9][a-zA-Z0-9.!_~\-/]*$/.test(module.path)||module.path.split('/').some(part=>part==='.'||part==='..')||!/^v[0-9][a-zA-Z0-9.\-+]*$/.test(module.version))throw new Error('Invalid Go module cache path');
      const name=escaped(module.path)+'@'+escaped(module.version),source=join(project.module_cache,name),destination=join(owned,'gomodcache',name);
      if(!isPathInsideRoot(source,project.module_cache))throw new Error('Go dependency escapes its module cache');
      const tree=await captureGoTree(source,destination,{maxFiles:8192-dependencyFiles,maxBytes:128*1024*1024-dependencyBytes,maxFileBytes:8*1024*1024,signal:work.controller.signal,
        onFile(file){if(/\.go$/i.test(file)&&++dependencySources>4096)throw new Error('Go dependencies exceed 4,096 sources');}});
      dependencyFiles+=tree.files.length;dependencyBytes+=tree.files.reduce((sum,file)=>sum+file.bytes,0);project.trees.push(tree);
    }
    refreshGoFingerprint(project);check(work);
    phase(work,'input_verify');
    await verifyGoEnvironment(project,work.controller.signal);check(work);
    phase(work,'cache_recheck');
    await toolchain!.verifyCached(work.controller.signal);check(work);
    work.options.onCaptured?.(project);check(work);
    phase(work,'analysis');
    const reply=await helper('analyze',prepared) as GoReply;
    if(!Array.isArray(reply.analysis_files)||reply.analysis_files.some(file=>!project.sources.has(file))||!Array.isArray(reply.package_errors)||reply.language_server?.name!=='gopls')throw new Error('Invalid Go analysis response');
    if(work.input.action==='diagnostics'&&!reply.diagnostics_complete)throw new Error('Go diagnostics did not complete');
    return {project,reply};
  } catch(error){check(work);throw error;}
  finally {
    if(job)job.close();
    try {
      if(owned) {
        const stat=await lstat(owned),canonical=await realpath(owned);
        if(stat.isSymbolicLink()||canonical!==owned||!isPathInsideRoot(canonical,parent))throw new Error('Refusing cleanup of a changed Go analysis directory');
        await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:50});
      }
    } finally {await toolchain?.release();}
  }
}
function release(work:Work){clearTimeout(work.timer);if(work.abort)work.options.signal?.removeEventListener('abort',work.abort);}
function cancel(work:Work,error:Error) {
  if(work.controller.signal.aborted)return;
  work.reason=error;work.controller.abort();
  const index=pending.indexOf(work);if(index!==-1){pending.splice(index,1);release(work);work.reject(error);}
}
function pump() {
  if(active||!pending.length)return;
  const work=pending.shift()!;active=work;
  void perform(work).then(value=>{release(work);active=undefined;work.resolve(value);pump();},error=>{release(work);active=undefined;work.reject(error instanceof Error?error:new Error(String(error)));pump();});
}
export function runGoAnalysis(input:CodeNavigationInput,roots:string[],options:Options={}):Promise<Reply> {
  if(options.signal?.aborted)return Promise.reject(new Error('Go analysis cancelled'));
  if(pending.length>=8)return Promise.reject(new Error('Go analysis queue is full; wait before trying again'));
  return new Promise((resolve,reject)=>{
    const started=Date.now();
    const work:Work={input,roots,options,controller:new AbortController(),started,phase:'queued',phaseStarted:started,resolve,reject};
    work.abort=()=>cancel(work,new Error('Go analysis cancelled'));options.signal?.addEventListener('abort',work.abort,{once:true});
    work.timer=setTimeout(()=>cancel(work,new Error('Go analysis timed out in '+work.phase+' after '+(Date.now()-work.phaseStarted)+' ms ('+(Date.now()-work.started)+' ms total); no partial result is returned')),options.timeoutMs??180000);
    pending.push(work);pump();
  });
}
