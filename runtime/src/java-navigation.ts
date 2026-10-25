import {randomUUID} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWindowsJob} from './durable-windows-job.js';
import {isPathInsideRoot} from './roots.js';
import {javaHash,loadJavaProject,verifyJavaEnvironment,type JavaProject} from './java-project.js';
import {javaClasspathPins} from './java-classpath.js';
import {verifyJdkDefinition,type JavaJdkOrigin} from './java-jdk-source.js';
import type {CodeNavigationInput} from './code-navigation.js';

interface JavaRecord {
  file:string;start:number;end:number;name:string;kind:string;declaration:boolean;
  code:string;severity:string;message:string;
  new_text?:string;
  source_index?:number;source_entry?:string;symbol_key?:string;
  source_jdk?:JavaJdkOrigin;
}
interface JavaReply {java_version:string;total:number;results:JavaRecord[];file_moves?:{from:string,to:string}[]}
const helper=fileURLToPath(new URL('../scripts/java-analysis/ForgeJavaAnalyze.java',import.meta.url));
const renameHelper=fileURLToPath(new URL('../scripts/java-analysis/ForgeJavaRename.java',import.meta.url));
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
// Windows PowerShell legacy native invocation drops empty arguments. Prefix a
// base64url payload so even the empty Java target/query is passed unambiguously.
const javaArgument=(value:string)=>'v'+Buffer.from(value,'utf8').toString('base64url');
const MAX_OUTPUT=16*1024*1024;
let active=0;
const pending:(()=>void)[]=[];

async function slot(signal:AbortSignal) {
  if(active<2){active++;return;}
  if(pending.length>=4)throw new Error('Java analysis queue is full');
  await new Promise<void>((accept,reject)=>{
    const wait=()=>{signal.removeEventListener('abort',abort);accept();};
    const abort=()=>{const at=pending.indexOf(wait);if(at>=0)pending.splice(at,1);
      reject(new Error('Java analysis cancelled'));};
    pending.push(wait);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
  // A woken waiter owns the transferred slot, even if it is aborted meanwhile.
  // The caller records acquisition before checking cancellation and releases it.
}
function release(){
  const next=pending.shift();
  if(next)next();else active--;
}
function location(text:string,offset:number){
  if(!Number.isSafeInteger(offset)||offset<0||offset>text.length)
    throw new Error('Java compiler returned an invalid source offset');
  if(offset>0 && offset<text.length && /[\uDC00-\uDFFF]/.test(text[offset]!)
     && /[\uD800-\uDBFF]/.test(text[offset-1]!))
    throw new Error('Java compiler returned an offset inside a surrogate pair');
  let line=1,begin=0;
  for(const match of text.matchAll(/\r\n|\r|\n/g)){
    if(match.index>=offset)break;
    line++;begin=match.index+match[0].length;
  }
  return {line,column:offset-begin+1};
}
async function runBackend(snapshot:string,action:string,target:string,
                          line:number,column:number,query:string,signal:AbortSignal,
                          owned:string,privateHelper:string,classpathFile:string,sourceFile?:string):Promise<JavaReply>{
  if(process.platform!=='win32')throw new Error('Java navigation currently requires Windows');
  const stdout=join(owned,'java-output.json');
  const command="$env:JAVA_TOOL_OPTIONS='';$env:_JAVA_OPTIONS='';$env:JDK_JAVA_OPTIONS='';"+
    "$env:CLASSPATH=''; & "+['java','-Xms32m','-Xmx512m','-XX:ReservedCodeCacheSize=64m',
      '--source','21',privateHelper,snapshot,action,javaArgument(target),
      String(line),String(column),javaArgument(query),classpathFile,...(sourceFile?[sourceFile,'jdk-sources-v1']:[])].map(quote).join(' ');
  let job:ReturnType<typeof startWindowsJob>|undefined;
  let exit:number|null=null;
  try{
    signal.throwIfAborted();
    job=startWindowsJob(command,snapshot,stdout,'ForgeJava-'+randomUUID(),{memoryLimitMiB:1536});
    await job.input('',true);
    while(exit===null){
      signal.throwIfAborted();
      if((await lstat(stdout)).size>MAX_OUTPUT)throw new Error('Java navigation output exceeds 16 MiB');
      exit=job.poll();
      if(exit===null)await new Promise(done=>setTimeout(done,30));
    }
  }finally{job?.close();}
  signal.throwIfAborted();
  const bytes=await readFile(stdout);
  if(exit!==0)throw new Error('Java compiler analysis exited '+exit+': '+
    bytes.toString('utf8').slice(0,1400));
  if(bytes.length>MAX_OUTPUT)throw new Error('Java navigation output exceeds 16 MiB');
  let value:unknown;
  try{value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}
  catch{throw new Error('Java compiler emitted invalid diagnostic JSON');}
  const reply=value as JavaReply;
  if(!reply||typeof reply.java_version!=='string'||!Number.isSafeInteger(reply.total)||
     reply.total<0||!Array.isArray(reply.results)||reply.results.length>300)
    throw new Error('Java compiler emitted invalid result metadata');
  return reply;
}

export async function navigateJava(input:CodeNavigationInput,roots:string[],signal?:AbortSignal,onCapture?:(project:JavaProject)=>void){
  if(!['outline','definition','references','symbols','diagnostics','rename_preview'].includes(input.action))throw Error('Unsupported Java action');
  if(['outline','definition','references','rename_preview'].includes(input.action)&&!input.file)
    throw new Error('Java target file is required for this action');
  if(['definition','references','rename_preview'].includes(input.action)&&(!input.line||!input.column))
    throw new Error('Java definition/references require a 1-based line and column');
  if(input.action==='symbols'&&!input.query)throw new Error('Java symbols require a query');
  if(input.action==='rename_preview'&&!input.new_name)throw Error('Java rename preview requires new_name');
  const abort=new AbortController();
  const controller=()=>abort.abort();
  if(signal?.aborted)abort.abort();
  else signal?.addEventListener('abort',controller,{once:true});
  const timer=setTimeout(controller,120000);
  let owned:string|undefined,acquired=false;
  try{
    abort.signal.throwIfAborted();
    await slot(abort.signal);acquired=true;
    abort.signal.throwIfAborted();
    const project=await loadJavaProject(input,roots,abort.signal);
    const target=input.file?relative(project.root,resolve(project.root,input.file))
      .replaceAll('\\','/'):'';
    if(target&&!project.sources.has(target))
      throw new Error('Java target must be among the captured sources');
    const selectedHelper=input.action==='rename_preview'?renameHelper:helper;
    const helperBytes=await readFile(selectedHelper),helperHash=javaHash(helperBytes);
    project.helper_inputs=[{path:selectedHelper,sha256:helperHash}];onCapture?.(project);
    owned=await mkdtemp(join(await realpath(tmpdir()),'forge-java-analysis-'));
    const snapshot=join(owned,'source');
    await mkdir(snapshot);
    for(const [file,source] of project.sources){
      abort.signal.throwIfAborted();
      const path=join(snapshot,file);
      await mkdir(dirname(path),{recursive:true});await writeFile(path,source,'utf8');
    }
    const privateHelper=join(owned,input.action==='rename_preview'?'ForgeJavaRename.java':'ForgeJavaAnalyze.java');
    await writeFile(privateHelper,helperBytes);
    const classpath:string[]=[],privatePins:{path:string;sha256:string}[]=[];
    for(const [index,entry] of project.classpath.entries.entries()){
      const destination=join(owned,'classpath',String(index)+(entry.kind==='jar'?'.jar':''));
      if(entry.kind==='classes')await mkdir(destination,{recursive:true});
      for(const file of entry.files){
        abort.signal.throwIfAborted();const original=entry.kind==='jar'?entry.path:join(entry.path,file.path),path=entry.kind==='jar'?destination:join(destination,file.path),raw=project.classpath.contents.get(original)!;
        if(!raw||javaHash(raw)!==file.sha256)throw Error('Java captured classpath bytes changed');
        await mkdir(dirname(path),{recursive:true});await writeFile(path,raw);privatePins.push({path,sha256:file.sha256});
      }
      classpath.push(destination);
    }
    const classpathFile=join(owned,'classpath.txt');await writeFile(classpathFile,classpath.join('\n'),'utf8');
    const attachments:string[]=classpath.map(()=>'');
    for(const archive of project.classpath.source_archives){
      abort.signal.throwIfAborted();
      const raw=project.classpath.source_contents.get(archive.path),destination=join(owned,'sources',archive.classpath_index+'.jar');
      if(!raw||javaHash(raw)!==archive.sha256)throw Error('Java captured source archive bytes changed');
      await mkdir(dirname(destination),{recursive:true});await writeFile(destination,raw);
      attachments[archive.classpath_index]=destination;privatePins.push({path:destination,sha256:archive.sha256});
    }
    const sourceFile=join(owned,'sources.txt');
    // A newline after every item preserves an empty last association when Java
    // reads the ordered list. Rename retains its seven-argument contract.
    await writeFile(sourceFile,attachments.map(path=>path+'\n').join(''),'utf8');
    privatePins.push({path:classpathFile,sha256:javaHash(classpath.join('\n'))},{path:sourceFile,sha256:javaHash(attachments.map(path=>path+'\n').join(''))});
    const reply=await runBackend(snapshot,input.action,target,input.line??0,
      input.column??0,input.action==='rename_preview'?input.new_name!:input.query??'',abort.signal,owned,privateHelper,classpathFile,
      input.action==='rename_preview'?undefined:sourceFile);
    if(!/^21(?:\.|\+|$)/.test(reply.java_version))
      throw new Error('Java 21 runtime is required for pinned Java navigation');
    if(javaHash(await readFile(selectedHelper))!==helperHash)
      throw new Error('Java analysis helper changed during analysis');
    for(const pin of [...privatePins,{path:privateHelper,sha256:helperHash}]){abort.signal.throwIfAborted();if(javaHash(await readFile(pin.path))!==pin.sha256)throw Error('Java private analysis input changed');}
    await verifyJavaEnvironment(project,abort.signal);
    const results:Record<string,unknown>[]=[];
    const jdkInputs:{path:string;sha256:string;bytes:number}[]=[];
    for(const entry of reply.results){
      if(entry.source_jdk!==undefined){
        if(input.action!=='definition'||entry.source_index!==undefined||typeof entry.source_entry!=='string'||typeof entry.symbol_key!=='string'||typeof entry.name!=='string'||typeof entry.kind!=='string'||entry.declaration!==true)throw Error('Java compiler returned malformed JDK source metadata');
        const verified=await verifyJdkDefinition(entry.source_jdk,entry.source_entry,reply.java_version,abort.signal),source=verified.source;
        const start=location(source.content,entry.start),end=location(source.content,entry.end);
        if(entry.end<=entry.start||source.content.slice(entry.start,entry.end)!==entry.name)throw Error('Java compiler returned an invalid JDK source range');
        jdkInputs.push(verified.archive,...verified.inputs);
        results.push({file:`java-jdk-source:${entry.source_jdk.module}:${source.entry}`,...start,end_line:end.line,end_column:end.column,
          name:entry.name,kind:entry.kind,declaration:true,read_only:true,origin:'java_jdk_source',
          source:{archive:verified.archive.path,archive_sha256:verified.archive.sha256,entry:source.entry,sha256:source.sha256,bytes:source.bytes,content:source.content,symbol_key:entry.symbol_key,
            module:entry.source_jdk.module,java_version:reply.java_version,binary:`jrt:/${entry.source_jdk.module}/${entry.source_jdk.binary_name.replaceAll('.','/')}.class`,binary_sha256:entry.source_jdk.binary_sha256,runtime_inputs:verified.inputs}});
        continue;
      }
      if(entry.source_index!==undefined){
        if(input.action!=='definition'||!Number.isSafeInteger(entry.source_index)||typeof entry.source_entry!=='string'||typeof entry.symbol_key!=='string'||typeof entry.name!=='string'||typeof entry.kind!=='string'||entry.declaration!==true)
          throw Error('Java compiler returned malformed external source metadata');
        const archive=project.classpath.source_archives.find(item=>item.classpath_index===entry.source_index),source=archive?.sources.find(item=>item.entry===entry.source_entry);
        if(!archive||!source)throw Error('Java compiler returned an uncaptured source archive entry');
        const start=location(source.content,entry.start),end=location(source.content,entry.end);
        if(entry.end<=entry.start||source.content.slice(entry.start,entry.end)!==entry.name)throw Error('Java compiler returned an invalid attached source range');
        results.push({file:`java-source:${entry.source_index}:${source.entry}`,...start,end_line:end.line,end_column:end.column,
          name:entry.name,kind:entry.kind,declaration:true,read_only:true,origin:'java_source_archive',
          source:{archive:archive.path,archive_sha256:archive.sha256,classpath_index:archive.classpath_index,entry:source.entry,sha256:source.sha256,bytes:source.bytes,content:source.content,symbol_key:entry.symbol_key}});
        continue;
      }
      if(typeof entry.file!=='string'||!project.sources.has(entry.file)||
         typeof entry.name!=='string'||typeof entry.kind!=='string'||
         typeof entry.message!=='string'||typeof entry.code!=='string')
        throw new Error('Java compiler returned an uncaptured source or malformed result');
      const source=project.sources.get(entry.file)!;
      const start=location(source,entry.start),end=location(source,entry.end);
      if(entry.end<=entry.start)throw new Error('Java compiler returned an invalid source range');
      results.push({file:entry.file,...start,end_line:end.line,end_column:end.column,
        ...(entry.name?{name:entry.name}:{}),
        ...(entry.kind?{kind:entry.kind}:{}),
        ...(entry.declaration?{declaration:true}:{}),
        ...(entry.code?{code:entry.code}:{}),
        ...(entry.severity?{severity:entry.severity}:{}),
        ...(entry.message?{message:entry.message}:{})});
    }
    const edits: {file:string,sha256:string,replacements:{start:number,length:number,old_text:string,new_text:string,line:number,column:number,end_line:number,end_column:number}[]}[]=[];
    const moves: {from:string,to:string,sha256:string}[]=[];
    if(input.action==='rename_preview'){
      if(reply.total>300||reply.results.length!==reply.total)throw Error('Java rename exceeds 300 edits or is incomplete; no partial plan returned');
      for(const file of new Set(reply.results.map(r=>r.file))){const source=project.sources.get(file)!,ranges=reply.results.filter(r=>r.file===file).sort((a,b)=>b.start-a.start);let previous=source.length;
        const replacements=ranges.map(r=>{if(r.end>previous||r.new_text!==undefined&&typeof r.new_text!=='string')throw Error('Invalid or overlapping Java rename ranges');previous=r.start;return {start:r.start,length:r.end-r.start,old_text:source.slice(r.start,r.end),new_text:r.new_text??input.new_name!,...location(source,r.start),end_line:location(source,r.end).line,end_column:location(source,r.end).column};});
        edits.push({file,sha256:javaHash(source),replacements});
      }
      for(const move of reply.file_moves??[]){if(!project.sources.has(move.from)||typeof move.to!=='string'||move.to.split(/[\\/]/).some(p=>!p||p==='..'||p==='.')||!move.to.endsWith('.java')||resolve(project.root,move.to)!==join(project.root,move.to)||!edits.some(e=>e.file===move.from))throw Error('Invalid Java type filename move');
        const destination=await lstat(join(project.root,move.to)).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
        if(destination){const source=await lstat(join(project.root,move.from));if(move.from.toLowerCase()!==move.to.toLowerCase()||destination.isSymbolicLink()||!destination.isFile()||source.dev!==destination.dev||source.ino!==destination.ino)throw Error('Java rename destination already exists');}moves.push({...move,sha256:javaHash(project.sources.get(move.from)!)});
      }
    }
    return {
      scope:input.files?'selected_files_only' as const:'project_files' as const,
      project:{
        language:'java',source_files:project.snapshots.length,
        source_bytes:project.snapshots.reduce((sum,item)=>sum+item.bytes,0),
        skipped_links:project.skipped_links,diagnostics_kind:'syntax_and_type',
        environment:{java_version:reply.java_version,helper_sha256:helperHash,
          classpath_model:project.classpath.model_present,classpath_entries:project.classpath.entries.length,...(project.classpath.maven?{maven_import:project.classpath.maven}:{}),
          source_archives:project.classpath.source_archives.length,
          jdk_source_inputs:jdkInputs,
          classpath_files:project.classpath.entries.reduce((n,e)=>n+e.files.length,0),classpath_bytes:project.classpath.entries.reduce((n,e)=>n+e.files.reduce((sum,f)=>sum+f.bytes,0),0),
          fingerprint:javaHash(JSON.stringify(project.snapshots)+JSON.stringify(javaClasspathPins(project.classpath))+helperHash+reply.java_version+JSON.stringify(jdkInputs))},
      },
      limitations:'JDK 21 compiler analysis on bounded private source and explicit forge.java.json classpath snapshots. Without a model, a root single-module pom.xml is imported statically from a local Maven repository inside an approved root (parents, properties, dependencyManagement/BOMs, scopes, optional, exclusions, nearest-wins; Maven is never run and nothing is downloaded); if that is impossible, environment.maven_import gives the reason and only sources are analysed. Gradle and multi-module builds need an exported classpath; navigation does not execute build scripts or annotation processors. Optional source_archives associate approved source JARs with classpath_index; external definitions contain verified original source contents and archive/source hashes, remain read-only and use java-source identifiers rather than editable file paths. Sources are attributed separately and do not influence primary project diagnostics. JDK definitions use the running Java 21 installation: a separately attributed source from its lib/src.zip must match the selected jrt module binary and declaration; original source/archive, binary and runtime image/release hashes are returned read-only. The JDK ZIP is limited to 64 MiB/40,000 entries and only the selected source (2 MiB maximum) is expanded; missing installed sources return no definition. Project module graphs and automatic build import are not included. Rename requires error-free captured sources and rechecks resolved bindings after candidate compilation; external symbols and override contracts are read-only. Public top-level type rename includes its Java filename move. Case-only filename moves are journaled with exact directory-entry names and reversible metadata changes. Explicit files limit semantic coverage. Reflection, string references and uncaptured callers are not renamed. Results use 1-based UTF-16 positions; run actual acceptance after edits.',
      snapshots:project.snapshots.map(({file,sha256})=>({file,sha256})),
      total:reply.total,truncated:reply.total>results.length,results,
      ...(input.action==='rename_preview'?{rename:{can_rename:true,display_name:reply.results[0]?.name},edits,file_moves:moves}:{}),
    };
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',controller);
    try {
      if(owned){
        const parent=await realpath(tmpdir()),path=await realpath(owned);
        if(!isPathInsideRoot(path,parent)||path!==owned||(await lstat(owned)).isSymbolicLink())
          throw new Error('Refusing cleanup of changed Java analysis directory');
        await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:50});
      }
    } finally { if(acquired)release(); }
  }
}
