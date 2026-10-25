import {randomUUID} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWindowsJob} from './durable-windows-job.js';
import {isPathInsideRoot} from './roots.js';
import {csharpHash,csharpProjectPins,loadCSharpProject,verifyCSharpEnvironment,type CSharpProject} from './csharp-project.js';
import {CSHARP_COMPILER,CSHARP_RUNTIME,loadCSharpToolchain,verifyCSharpToolchain} from './csharp-toolchain.js';
import type {CodeNavigationInput} from './code-navigation.js';
const helper=fileURLToPath(new URL('../scripts/csharp-analysis/ForgeCSharpAnalyze.cs',import.meta.url));
const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
let active=0;const waiting:(()=>void)[]=[];
async function slot(signal:AbortSignal){if(active<2){active++;return;}if(waiting.length>=4)throw Error('C# analysis queue is full');
 await new Promise<void>((resolve,reject)=>{const ready=()=>{signal.removeEventListener('abort',abort);resolve();};const abort=()=>{const at=waiting.indexOf(ready);if(at>=0)waiting.splice(at,1);reject(Error('C# analysis cancelled'));};waiting.push(ready);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
}
function release(){const next=waiting.shift();if(next)next();else active--;}
function location(text:string,offset:number){if(!Number.isSafeInteger(offset)||offset<0||offset>text.length||offset>0&&offset<text.length&&/[\uDC00-\uDFFF]/.test(text[offset]!)&&/[\uD800-\uDBFF]/.test(text[offset-1]!))throw Error('Invalid C# source offset');
 let line=1,start=0;for(const m of text.matchAll(/\r\n|\r|\n/g)){if(m.index>=offset)break;line++;start=m.index+m[0].length;}return {line,column:offset-start+1};
}
interface CSharpReply {protocol:string;compiler_version:string;runtime_version:string;language_version:string;total:number;results:{file:string;start:number;end:number;name:string;kind:string;declaration:boolean;code:string;message:string;severity:string;read_only:boolean;assembly:string}[];rename?:{can_rename:boolean;display_name?:string;reason?:string};edits:{file:string;replacements:{start:number;length:number;old_text:string;new_text:string}[]}[]}
export async function navigateCSharp(input:CodeNavigationInput,roots:string[],signal?:AbortSignal,onCapture?:(project:CSharpProject)=>void,options:{timeoutMs?:number;onLaunched?:(pid:number,creation:string)=>void}={}){
 if(process.platform!=='win32')throw Error('C# navigation currently requires Windows');
 if(!['outline','definition','references','symbols','diagnostics','rename_preview'].includes(input.action))throw Error('Unsupported C# action');
 if(!['symbols','diagnostics'].includes(input.action)&&!input.file)throw Error('C# target file is required');
 if(['definition','references','rename_preview'].includes(input.action)&&(!input.line||!input.column))throw Error('C# query requires 1-based line and column');
 if(input.action==='symbols'&&!input.query)throw Error('C# symbol query is required');
 if(input.action==='rename_preview'&&!input.new_name)throw Error('C# new name is required');
 const abort=new AbortController(),cancel=()=>abort.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,options.timeoutMs??120000);
 let owned:string|undefined,acquired=false,job:ReturnType<typeof startWindowsJob>|undefined;
 try{
  abort.signal.throwIfAborted();await slot(abort.signal);acquired=true;abort.signal.throwIfAborted();
  const project=await loadCSharpProject(input,roots,abort.signal),toolchain=await loadCSharpToolchain(abort.signal);
  const target=input.file?relative(project.root,resolve(project.root,input.file)).replaceAll('\\','/'):'';
  if(target&&!project.sources.has(target))throw Error('C# target is not among captured sources');
  const helperBytes=await readFile(helper),helperHash=csharpHash(helperBytes);project.helper_inputs=[{path:helper,sha256:helperHash},...toolchain.pins];onCapture?.(project);
  owned=await mkdtemp(join(await realpath(tmpdir()),'forge-csharp-analysis-'));
  const privatePins:{path:string;sha256:string}[]=[];
  const save=async(path:string,bytes:Buffer|string)=>{abort.signal.throwIfAborted();await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);privatePins.push({path,sha256:csharpHash(bytes)});return path;};
  const framework:string[]=[],libraries:string[]=[],compiler=new Map<string,string>();
  for(const f of toolchain.framework)framework.push(await save(join(owned,'framework',basename(f)),toolchain.files.get(f)!));
  for(const f of toolchain.libraries)libraries.push(await save(join(owned,'worker',basename(f)),toolchain.files.get(f)!));
  for(const f of toolchain.compiler)compiler.set(basename(f),await save(join(owned,'compiler',basename(f)),toolchain.files.get(f)!));
  const references=project.include_framework?[...framework]:[];
  for(const [index,[path,raw]] of [...project.references].entries())references.push(await save(join(owned,'references',String(index),basename(path)),raw));
  const privateHelper=await save(join(owned,'worker','ForgeCSharpAnalyze.cs'),helperBytes),output=join(owned,'worker','ForgeCSharpAnalyze.dll');
  await save(join(owned,'worker','ForgeCSharpAnalyze.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0',framework:{name:'Microsoft.NETCore.App',version:CSHARP_RUNTIME},rollForward:'Disable'}}));
  const response=await save(join(owned,'compile.rsp'),['/nologo','/target:exe','/nullable:enable','/langversion:14','/out:'+output,privateHelper,...framework.map(f=>'/reference:'+f),...libraries.filter(f=>['Microsoft.CodeAnalysis.dll','Microsoft.CodeAnalysis.CSharp.dll','Microsoft.CodeAnalysis.Workspaces.dll'].includes(basename(f))).map(f=>'/reference:'+f)].map(s=>'"'+s.replaceAll('"','\\"')+'"').join('\n'));
  const request=await save(join(owned,'request.json'),JSON.stringify({protocol:project.import?'csharp-workspaces-v2':'csharp-workspaces-v1',action:input.action,file:target,line:input.line??0,column:input.column??0,query:input.query??'',new_name:input.new_name??'',references,sources:[...project.sources].map(([file,content])=>({file,content})),options:project.options,...(project.import?{projects:project.import.projects.map(p=>({name:p.file,assembly_name:p.assembly_name,files:p.sources,options:p.options,project_references:p.project_references,global_usings:p.global_usings}))}:{})}));
  const stdout=join(owned,'output.json');
  const environment="$env:DOTNET_ROOT="+quote(toolchain.root)+";$env:DOTNET_CLI_TELEMETRY_OPTOUT='1';$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1';$env:DOTNET_MULTILEVEL_LOOKUP='0';$env:DOTNET_ROLL_FORWARD='Disable';"+
   "foreach($forgeVariable in @('DOTNET_STARTUP_HOOKS','DOTNET_ADDITIONAL_DEPS','DOTNET_SHARED_STORE','CORECLR_ENABLE_PROFILING','CORECLR_PROFILER','CORECLR_PROFILER_PATH','COR_ENABLE_PROFILING','COR_PROFILER','COR_PROFILER_PATH','DOTNET_ENABLE_PROFILING','DOTNET_PROFILER','DOTNET_PROFILER_PATH')){[Environment]::SetEnvironmentVariable($forgeVariable,$null,'Process')};";
  const command=environment+' & '+[toolchain.dotnet,compiler.get('csc.dll')!,'/noconfig','@'+response].map(quote).join(' ')+'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; & '+[toolchain.dotnet,output,request].map(quote).join(' ');
  abort.signal.throwIfAborted();job=startWindowsJob(command,owned,stdout,'ForgeCSharp-'+randomUUID(),{memoryLimitMiB:1536});options.onLaunched?.(job.pid,job.creation_time);await job.input('',true);
  let exit:number|null=null;while(exit===null){abort.signal.throwIfAborted();if((await lstat(stdout)).size>16*1024*1024)throw Error('C# analysis output exceeds 16 MiB');exit=job.poll();if(exit===null)await new Promise(done=>setTimeout(done,30));}
  job.close();job=undefined;abort.signal.throwIfAborted();const raw=await readFile(stdout);
  if(exit!==0)throw Error('C# compiler analysis exited '+exit+': '+raw.toString('utf8').slice(0,1600));
  if(raw.length>16*1024*1024)throw Error('C# analysis output exceeds 16 MiB');
  let reply:CSharpReply;try{reply=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));}catch{throw Error('C# compiler emitted invalid JSON');}
  if(reply.protocol!==(project.import?'csharp-workspaces-v2':'csharp-workspaces-v1')||reply.compiler_version!==CSHARP_COMPILER||reply.runtime_version!==CSHARP_RUNTIME||!Number.isSafeInteger(reply.total)||reply.total<0||!Array.isArray(reply.results)||reply.results.length>300||!Array.isArray(reply.edits))throw Error('Invalid C# compiler response');
  for(const pin of privatePins){abort.signal.throwIfAborted();if(csharpHash(await readFile(pin.path))!==pin.sha256)throw Error('C# private analysis input changed');}
  await verifyCSharpEnvironment(project,abort.signal);await verifyCSharpToolchain(toolchain,abort.signal);
  const results:Record<string,unknown>[]=reply.results.map(r=>{
   if(typeof r.file!=='string'||typeof r.name!=='string'||typeof r.kind!=='string'||typeof r.code!=='string'||typeof r.message!=='string'||typeof r.severity!=='string')throw Error('Malformed C# result');
   if(r.read_only){if(!r.file.startsWith('csharp-metadata:')||input.action!=='definition'||typeof r.assembly!=='string')throw Error('Invalid read-only C# metadata');return {file:r.file,name:r.name,kind:r.kind,read_only:true,origin:'csharp_metadata',assembly:r.assembly};}
   const text=project.sources.get(r.file);if(text===undefined){if(input.action!=='diagnostics'||r.file!==''||r.start!==0||r.end!==0)throw Error('C# returned an uncaptured file');return {code:r.code,message:r.message,severity:r.severity};}
   const start=location(text,r.start),end=location(text,r.end);if(r.end<r.start)throw Error('Invalid C# source range');
   return {file:r.file,...start,end_line:end.line,end_column:end.column,...(r.name?{name:r.name}:{}),...(r.kind?{kind:r.kind}:{}),...(r.declaration?{declaration:true}:{}),...(r.code?{code:r.code}:{}),...(r.message?{message:r.message}:{}),...(r.severity?{severity:r.severity}:{})};
  });
  const editFiles=new Set<string>();let replacementsCount=0;
  const edits=reply.edits.map(e=>{const text=project.sources.get(e.file);if(text===undefined||editFiles.has(e.file)||!Array.isArray(e.replacements))throw Error('Invalid C# edit file');editFiles.add(e.file);let previous=text.length;
   const replacements=e.replacements.map(r=>{if(!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.length)||r.start<0||r.length<0||r.start+r.length>previous||typeof r.old_text!=='string'||typeof r.new_text!=='string'||text.slice(r.start,r.start+r.length)!==r.old_text||++replacementsCount>300)throw Error('Invalid C# rename replacement');previous=r.start;return {...r,...location(text,r.start),end_line:location(text,r.start+r.length).line,end_column:location(text,r.start+r.length).column};});
   return {file:e.file,sha256:csharpHash(text),replacements};
  });
  if(input.action!=='rename_preview'&&(edits.length||reply.rename))throw Error('Unexpected C# mutation plan');
  if(input.action==='rename_preview'&&(!reply.rename||typeof reply.rename.can_rename!=='boolean'||reply.rename.can_rename!==(edits.length>0)))throw Error('Invalid C# rename response');
  return {scope:input.files?'selected_files_only' as const:'project_files' as const,project:{language:'csharp',source_files:project.snapshots.length,source_bytes:project.snapshots.reduce((n,s)=>n+s.bytes,0),skipped_links:project.skipped_links,diagnostics_kind:'syntax_and_type',environment:{sdk_version:'10.0.402',compiler_version:reply.compiler_version,runtime_version:reply.runtime_version,language_version:reply.language_version,project_model:project.model_present,...(project.import?{project_import:{kind:project.import.kind,...(project.import.solution?{solution:project.import.solution}:{}),projects:project.import.projects.map(p=>({file:p.file,assembly_name:p.assembly_name,sources:p.sources.length,project_references:p.project_references,options:p.options,implicit_usings:p.global_usings.length}))}}:{}),reference_files:references.length,options:project.options,fingerprint:csharpHash(JSON.stringify(csharpProjectPins(project))+toolchain.fingerprint+helperHash)}},snapshots:project.snapshots.map(({file,sha256})=>({file,sha256})),total:reply.total,truncated:reply.total>results.length,results,...(input.action==='rename_preview'?{rename:reply.rename,edits}:{}),limitations:'C# compiler/AdhocWorkspace on bounded private UTF-8 sources and explicit forge.csharp.json compiler/reference/build-input model. SDK 10.0.402, Roslyn 5.9 and runtime/reference pack 10.0.13 are pinned. Navigation never runs MSBuild, analyzers, source generators or project code. Build project discovery requires an exported model. Selected files constrain semantic coverage; uncaptured callers, reflection and strings are not renamed. Rename follows captured interface/override/partial families, uses Roslyn binding-preserving edits and requires error-free original and candidate compilation; external contracts are read-only. Type rename updates constructors and uses but preserves filenames. External definitions identify read-only metadata, not original source. Without a model, a root .sln/.slnx/.csproj is imported statically for a strict SDK-style net10.0 subset (default/explicit Compile items, ProjectReference graph, implicit/explicit global usings, LangVersion/Nullable/OutputType/unsafe/DefineConstants); MSBuild is never evaluated, and conditions, imports, packages, Directory.Build.* files or other properties are refused instead of approximated. Run actual project acceptance after edits. Positions are 1-based UTF-16.'};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);job?.close();try{if(owned){const parent=await realpath(tmpdir()),canonical=await realpath(owned);if(!isPathInsideRoot(canonical,parent)||canonical!==owned||(await lstat(owned)).isSymbolicLink())throw Error('Refusing cleanup of changed C# analysis directory');await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}finally{if(acquired)release();}}
}
