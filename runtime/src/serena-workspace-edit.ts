import {randomUUID} from 'node:crypto';
import {managedRelease} from './managed-component-state.js';
import {existsSync,lstatSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {digest} from './durable-tasks.js';
import {startWindowsJob} from './durable-windows-job.js';
import type {BatchChange} from './task-file-batches.js';
import {serenaRelativePath} from './serena-bridge.js';
import {goBackendRoot} from './go-project.js';
import {eclipseJavaProject,javaBuildFile,javaSourceRoots,serenaJavaDigest,verifiedSerenaJava} from './serena-java.js';
import {loadJavaClasspath,javaClasspathPins} from './java-classpath.js';
import {kotlinWorkspace,kotlinBuildFile} from './serena-kotlin.js';
import {kotlinModelFiles,assertKotlinWritable} from './kotlin-generated.js';
import {privateCppCommands} from './serena-cpp.js';

export const SERENA_VERSION='1.7.0';
// Only languages whose LSP prerequisites and full rename transaction were
// actually verified are enabled. Others need their own evidence first.
// Languages whose servers Forge installed into its owned directory with
// Serena's own pinned installers (scripts/serena-analysis/install-languages.py);
// each run verifies the installed tree against languages-lock.json.
export const SERENA_OWNED_LANGUAGES=['cpp','php','bash','lua'] as const;
// Rename and safe_delete depend on complete cross-file references; they are
// offered only where a real cross-file run passed (C/C++ clangd reported no
// cross-file references and PHP intelephense has no free rename). Additional
// backends, including php_phpantom, are enabled by their pinned cross-file probe.
export const SERENA_RENAME_LANGUAGES=['python','typescript','go','java','lua','bash'] as const;
export const SERENA_EDIT_LANGUAGES=[...SERENA_RENAME_LANGUAGES,'cpp','php'] as const;
const LANGUAGES_LOCK=fileURLToPath(new URL('../scripts/serena-analysis/languages-lock.json',import.meta.url));
export function serenaLanguagesHome(){return process.env.FORGE_SERENA_LANGUAGES_HOME?.trim()||join(homedir(),'.chatgptforge','serena-languages');}
async function ownedSerenaLanguage(language:string){
  if(['python','typescript','go','java'].includes(language))return undefined;
  const lock=JSON.parse(await readFile(LANGUAGES_LOCK,'utf8')) as {languages:Record<string,{state:string;version?:string;resource_dirs?:Record<string,unknown>}>};
  const entry=lock.languages[language];
  if(entry?.state!=='installed'||!entry.resource_dirs)throw Error(`Serena ${language} language server is not installed for Forge`);
  const home=serenaLanguagesHome();if(!existsSync(home))throw Error(`Forge Serena language directory missing: ${home}`);
  return {home,resource_dirs:entry.resource_dirs,version:entry.version};
}
export function assertSerenaCapability(language:string,capability:'edit'|'rename'){
  const verified=capability==='rename'?SERENA_RENAME_LANGUAGES:SERENA_EDIT_LANGUAGES;
  if((verified as readonly string[]).includes(language))return;
  if(!/^[a-z][a-z0-9_]{0,39}$/.test(language))throw Error('Invalid Serena language');
  const lock=JSON.parse(readFileSync(LANGUAGES_LOCK,'utf8')) as {languages:Record<string,{state:string;capabilities?:string[]}>};
  if(lock.languages[language]?.state!=='installed'||!lock.languages[language]?.capabilities?.includes(capability))throw Error(`Serena ${language} ${capability} backend is not pinned; install it with components language-install ${language} --from PROJECT --file SOURCE`);
}
export type SerenaRenameLanguage=string;
export function serenaLanguageCapabilities(){
  const lock=JSON.parse(readFileSync(LANGUAGES_LOCK,'utf8')) as {languages:Record<string,{state:string;capabilities?:string[]}>};
  const names=new Set<string>(SERENA_EDIT_LANGUAGES);
  for(const [name,entry] of Object.entries(lock.languages))if(entry.state==='installed')names.add(name);
  return [...names].sort().map(language=>({language,
    edit:(SERENA_EDIT_LANGUAGES as readonly string[]).includes(language)||lock.languages[language]?.capabilities?.includes('edit')===true,
    rename:(SERENA_RENAME_LANGUAGES as readonly string[]).includes(language)||lock.languages[language]?.capabilities?.includes('rename')===true,
  }));
}
const PROTOCOL='forge-serena-rename-v1';
const HELPER=fileURLToPath(new URL('../scripts/serena-analysis/forge_serena_rename.py',import.meta.url));
const EDIT_PROTOCOL='forge-serena-edit-v1';
const EDIT_HELPER=fileURLToPath(new URL('../scripts/serena-analysis/forge_serena_edit.py',import.meta.url));
const MAX_FILES=10_000,MAX_BYTES=128*1024*1024,MAX_EDIT_FILES=64,MAX_REPLACEMENTS=1_000,MAX_FILE=1024*1024;

export function serenaPython():string {
  const configured=process.env.FORGE_SERENA_PYTHON?.trim();
  if(configured)return configured;
  const managed=managedRelease('serena');if(managed?.python)return managed.python;
  const base=process.env.APPDATA??join(homedir(),'AppData','Roaming');
  return join(base,'uv','tools','serena-agent',process.platform==='win32'?'Scripts/python.exe':'bin/python');
}

export interface SerenaRenameInput {root:string;language:string;file:string;line:number;column:number;new_name:string}
interface Capture {fingerprint:string;files:Map<string,Buffer>;hashes:Record<string,string>}
interface Position {line:number;character:number}
interface Range {start:Position;end:Position}
interface TextEdit {range:Range;newText:string;annotationId?:string}
interface WorkspaceEdit {changes?:Record<string,TextEdit[]>;documentChanges?:unknown[];changeAnnotations?:Record<string,{needsConfirmation?:boolean}>}
interface HelperReply {protocol:string;serena_version:string;language:string;references:{uri:string;range:Range}[];plans:(WorkspaceEdit|null)[];prerequisites_unchanged:boolean;helper_sha256:string}

// Same walk, ordering and exclusions as the task fingerprint, so the private
// copy is provably the inspected workspace and not a later observation.
export function captureSerenaProject(root:string):Capture {
  const files=new Map<string,Buffer>(),hashes:Record<string,string>={};let bytes=0;
  const walk=(dir:string,prefix:string)=>{
    for(const entry of readdirSync(dir).sort()){
      if(entry==='.git'||entry==='node_modules')continue;
      const path=join(dir,entry),name=prefix+entry,info=lstatSync(path);
      if(info.isSymbolicLink())throw Error(`Serena capture refuses symbolic link: ${name}`);
      if(info.isDirectory()){walk(path,name+'/');continue;}
      if(!info.isFile())throw Error(`Serena capture refuses special file: ${name}`);
      bytes+=info.size;
      if(files.size>=MAX_FILES||bytes>MAX_BYTES)throw Error('Serena rename capture exceeds 10,000 files / 128 MiB');
      const data=readFileSync(path),after=statSync(path);
      if(info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs)throw Error('Workspace changed while capturing Serena input');
      files.set(name,data);hashes[name]=digest(data);
    }
  };
  walk(root,'');
  return {fingerprint:digest(JSON.stringify(hashes)),files,hashes};
}

// Parallel Serena slots: each run has its own private copy, owned job and
// language-server process, so runs never share Serena's active-project state.
// FORGE_SERENA_SLOTS bounds concurrency (1..4, default 2) for memory.
export const SERENA_SLOTS=Math.min(4,Math.max(1,Number.parseInt(process.env.FORGE_SERENA_SLOTS??'2',10)||2));
const SERENA_QUEUE=4;
let active=0;const waiting:(()=>void)[]=[];
export const serenaSlotStatus=()=>({slots:SERENA_SLOTS,active,waiting:waiting.length,queue_limit:SERENA_QUEUE});
async function slot(signal:AbortSignal){
  if(active<SERENA_SLOTS){active++;return;}
  if(waiting.length>=SERENA_QUEUE)throw Error('Serena rename queue is full; wait for a running plan');
  await new Promise<void>((resolve,reject)=>{
    const ready=()=>{signal.removeEventListener('abort',abort);resolve();};
    const abort=()=>{const at=waiting.indexOf(ready);if(at>=0)waiting.splice(at,1);reject(Error('Serena rename cancelled'));};
    waiting.push(ready);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}
function release(){const next=waiting.shift();if(next)next();else active--;}

function lineStarts(text:string){const starts=[0];for(const m of text.matchAll(/\r\n|\r|\n/g))starts.push(m.index+m[0].length);return starts;}
function offset(text:string,starts:number[],point:Position){
  if(!point||!Number.isSafeInteger(point.line)||!Number.isSafeInteger(point.character)||point.line<0||point.character<0||point.line>=starts.length)throw Error('Serena edit position is outside the captured file');
  const start=starts[point.line]!,next=point.line+1<starts.length?starts[point.line+1]!:text.length;
  const body=text.slice(start,next).replace(/(?:\r\n|\r|\n)$/,'');
  if(point.character>body.length)throw Error('Serena edit column is outside the captured line');
  const at=start+point.character;
  if(at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1]!)&&/[\uDC00-\uDFFF]/.test(text[at]!))throw Error('Serena edit splits a UTF-16 surrogate pair');
  return at;
}
function location(starts:number[],at:number){let line=0;while(line+1<starts.length&&starts[line+1]!<=at)line++;return {line:line+1,column:at-starts[line]!+1};}

export interface SerenaRenamePlan {
  backend:'serena';serena_version:string;language:SerenaRenameLanguage;fingerprint:string;
  readiness:{references:number;stable_plans:2;prerequisites_unchanged:true};
  references?:{file:string;line:number;column:number;end_line:number;end_column:number}[];
  files:{file:string;sha256:string;replacements:{line:number;column:number;end_line:number;end_column:number;old_text:string;new_text:string}[]}[];
  file_moves?:{from:string;to:string;sha256:string}[];
  java_environment?:{classpath_entries:number;model_present:boolean;static_import?:unknown};
  changes:BatchChange[];
}

// Convert one LSP WorkspaceEdit computed on the private copy into exact
// content changes keyed by captured project-relative paths.
export async function convertSerenaWorkspaceEdit(privateRoot:string,capture:Capture,target:string,edit:WorkspaceEdit,references:{uri:string;range:Range}[],newName?:string){
  if(!edit||typeof edit!=='object')throw Error('Serena returned no rename plan');
  // Some servers (Eclipse JDT LS) send both forms. LSP prefers documentChanges;
  // accept that only when both describe exactly the same text edits.
  if(edit.changes&&edit.documentChanges&&!Object.keys(edit.changes).length)edit={...edit,changes:undefined};
  if(edit.changes&&edit.documentChanges){
    const form=(docs:{textDocument?:{uri?:unknown};edits?:unknown;kind?:unknown}[])=>JSON.stringify(docs.map(d=>({uri:String(d.textDocument?.uri??''),kind:d.kind??'',edits:JSON.stringify([...((Array.isArray(d.edits)?d.edits:[]) as TextEdit[])].map(e=>[e.range?.start?.line,e.range?.start?.character,e.range?.end?.line,e.range?.end?.character,e.newText]).sort())})).sort((x,y)=>x.uri<y.uri?-1:x.uri>y.uri?1:0));
    const fromChanges=Object.entries(edit.changes).map(([uri,edits])=>({textDocument:{uri},edits}));
    if(form(edit.documentChanges as never)!==form(fromChanges))throw Error('Ambiguous Serena WorkspaceEdit');
    edit={...edit,changes:undefined};
  }
  const docs=(edit.documentChanges??Object.entries(edit.changes??{}).map(([uri,edits])=>({textDocument:{uri},edits}))) as {textDocument?:{uri?:unknown};edits?:unknown;kind?:unknown;oldUri?:unknown;newUri?:unknown;options?:{overwrite?:boolean;ignoreIfExists?:boolean};annotationId?:string}[];
  if(!Array.isArray(docs))throw Error('Malformed Serena WorkspaceEdit');
  const map=async(uri:unknown)=>{
    if(typeof uri!=='string')throw Error('Malformed Serena file URI');
    const url=new URL(uri);if(url.protocol!=='file:'||url.host!=='')throw Error('Serena edit is not a local file');
    let actual:string;try{actual=await realpath(fileURLToPath(url));}catch{throw Error('Serena edit targets a missing file');}
    const path=relative(privateRoot,actual).replaceAll('\\','/');
    if(!path||path==='..'||path.startsWith('../')||isAbsolute(path)||!capture.files.has(path))throw Error('Serena edit or reference leaves the captured project');
    return path;
  };
  const files=new Map<string,{text:string;starts:number[];ranges:{start:number;end:number;value:string}[]}>();
  const moves=new Map<string,string>();
  const needsConfirmation=(id:string|undefined)=>id!==undefined&&edit.changeAnnotations?.[id]?.needsConfirmation;
  let total=0;
  for(const doc of docs){
    if(doc?.kind==='rename'){
      if(needsConfirmation(doc.annotationId))throw Error('Serena edit requires user confirmation; refused');
      if(doc.options?.overwrite||doc.options?.ignoreIfExists)throw Error('Serena filename move cannot overwrite or ignore an existing destination');
      const from=await map(doc.oldUri);
      // A rename may follow edits to the original file. Chained moves and
      // text edits after a move need sequential LSP document-version handling.
      if(!files.has(from)||moves.has(from))throw Error('Serena filename move requires preceding source edits and cannot be chained');
      if(typeof doc.newUri!=='string')throw Error('Malformed Serena destination URI');
      const url=new URL(doc.newUri);
      if(url.protocol!=='file:'||url.host!==''||url.search||url.hash)throw Error('Serena destination is not a local file');
      const destination=fileURLToPath(url),parent=await realpath(dirname(destination));
      const to=relative(privateRoot,join(parent,basename(destination))).replaceAll('\\','/');
      if(!to||isAbsolute(to)||to.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(\.git|node_modules)$/i.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Serena filename destination leaves the captured project or is invalid');
      const sameCase=to.toLowerCase()===from.toLowerCase();
      if(to===from||[...moves.values()].some(p=>p.toLowerCase()===to.toLowerCase()))throw Error('Duplicate Serena filename destination');
      if(!sameCase&&([...capture.files.keys()].some(p=>p.toLowerCase()===to.toLowerCase())||existsSync(destination)))throw Error('Serena filename destination already exists');
      if(sameCase&&dirname(to)!==dirname(from))throw Error('Serena case-only move cannot rename directories');
      moves.set(from,to);continue;
    }
    if(!doc||typeof doc!=='object'||doc.kind!==undefined||!doc.textDocument||!Array.isArray(doc.edits))throw Error('Serena file create/rename/delete operations are not supported by this transaction');
    const path=await map(doc.textDocument.uri);
    if(moves.has(path))throw Error('Serena text edits after a filename move are not supported');
    if([...files.keys()].some(seen=>seen.toLowerCase()===path.toLowerCase()))throw Error('Duplicate Serena edit target');
    const raw=capture.files.get(path)!,text=raw.toString('utf8');
    if(!Buffer.from(text).equals(raw))throw Error('Serena rename requires UTF-8 source files');
    const starts=lineStarts(text),ranges=[];
    for(const item of doc.edits as TextEdit[]){
      if(!item||typeof item.newText!=='string'||!item.range)throw Error('Malformed Serena text edit');
      if(needsConfirmation(item.annotationId))throw Error('Serena edit requires user confirmation; refused');
      const start=offset(text,starts,item.range.start),end=offset(text,starts,item.range.end);
      if(end<start)throw Error('Invalid Serena edit range');
      if(++total>MAX_REPLACEMENTS)throw Error('Serena rename exceeds 1,000 replacements');
      ranges.push({start,end,value:item.newText});
    }
    ranges.sort((a,b)=>b.start-a.start||b.end-a.end);
    for(let i=1;i<ranges.length;i++)if(ranges[i]!.end>ranges[i-1]!.start||ranges[i]!.start===ranges[i-1]!.start)throw Error('Overlapping Serena edits');
    files.set(path,{text,starts,ranges});
  }
  if(!files.size)throw Error('Serena returned an empty rename plan');
  if(files.size>MAX_EDIT_FILES)throw Error('Serena rename exceeds 64 files');
  if(!files.has(target))throw Error('Serena rename plan does not edit the requested file');
  // Readiness: every project reference reported after indexing must be renamed.
  for(const reference of references){
    const path=await map(reference.uri),file=files.get(path);
    if(!file)throw Error(`Serena rename plan omits referenced file ${path}; index not ready or plan incomplete`);
    const at=offset(file.text,file.starts,reference.range.start),end=offset(file.text,file.starts,reference.range.end);
    if(end<at)throw Error('Invalid Serena reference range');
    // JDT LS reports a whole qualified import as the reference, while its edit
    // starts at the type name (and may coalesce edits across following lines).
    // Require real interval overlap, not just inclusion of the reference start.
    // Kotlin LSP can emit only an inserted prefix/suffix for a rename. Such an
    // insertion touches (but does not overlap) the reference. Accept it only
    // when reconstructing the complete identifier proves the requested name.
    const identifier=file.text.slice(at,end);
    let reconstructed=identifier;
    for(const r of file.ranges)if(r.start>=at&&r.end<=end)reconstructed=reconstructed.slice(0,r.start-at)+r.value+reconstructed.slice(r.end-at);
    const boundaryRename=!!newName&&/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(identifier)&&identifier!==newName&&reconstructed===newName;
    if(!boundaryRename&&!file.ranges.some(r=>end===at?r.start<=at&&at<r.end:r.start<end&&r.end>at))throw Error(`Serena rename plan omits a reference in ${path}; index not ready or plan incomplete`);
  }
  const changes:BatchChange[]=[],out:SerenaRenamePlan['files']=[],file_moves:NonNullable<SerenaRenamePlan['file_moves']>=[];
  for(const [path,{text,starts,ranges}] of [...files].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    let content=text;
    for(const r of ranges)content=content.slice(0,r.start)+r.value+content.slice(r.end);
    if(Buffer.byteLength(content)>MAX_FILE)throw Error('Serena rename output exceeds 1 MiB per file');
    const to=moves.get(path);
    if(to){
      file_moves.push({from:path,to,sha256:capture.hashes[path]!});
      if(to.toLowerCase()===path.toLowerCase())changes.push({path,content,expected_hash:capture.hashes[path]!,rename_to:to});
      else changes.push({path,content:null,expected_hash:capture.hashes[path]!},{path:to,content,expected_hash:null});
    }else changes.push({path,content,expected_hash:capture.hashes[path]!});
    out.push({file:path,sha256:capture.hashes[path]!,replacements:[...ranges].reverse().map(r=>{const a=location(starts,r.start),b=location(starts,r.end);return {line:a.line,column:a.column,end_line:b.line,end_column:b.column,old_text:text.slice(r.start,r.end),new_text:r.value};})});
  }
  if(changes.reduce((n,c)=>n+(c.rename_to?2:1),0)>MAX_EDIT_FILES)throw Error('Serena rename exceeds 64 file paths including moves');
  return {changes,files:out,file_moves};
}

const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
interface PrivateRun {project:string;capture:Capture;copied:(path:string)=>boolean;reply:Record<string,unknown>;classpath?:Awaited<ReturnType<typeof loadJavaClasspath>>}
interface PrivateRunOptions {root:string;language:string;target:string;label:string;helper:string;protocol:string;request:Record<string,unknown>;timeoutMs?:number;python?:string;onLaunched?:(pid:number,creation:string)=>void;signal?:AbortSignal}

// One owned private Serena run: capture, private copy (Java without build
// files plus a generated Eclipse project), pinned language servers, an owned
// Windows job, and prerequisite rechecks. Callers interpret the helper reply.
async function runSerenaPrivate<T>(o:PrivateRunOptions,after:(run:PrivateRun)=>Promise<T>):Promise<T>{
  const python=o.python??serenaPython();if(!existsSync(python))throw Error(`Serena ${SERENA_VERSION} Python environment not found: ${python}`);
  const abort=new AbortController(),cancel=()=>abort.abort(Error(`Serena ${o.label} cancelled; nothing applied`));
  if(o.signal?.aborted)cancel();else o.signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>abort.abort(Error(`Serena ${o.label} timed out; owned analysis stopped and nothing applied`)),o.timeoutMs??240_000);
  let owned:string|undefined,acquired=false,job:ReturnType<typeof startWindowsJob>|undefined;
  try{
    abort.signal.throwIfAborted();await slot(abort.signal);acquired=true;abort.signal.throwIfAborted();
    const capture=captureSerenaProject(o.root);
    if(!capture.files.has(o.target))throw Error(`Serena ${o.label} target is not a captured project file`);
    const helperBytes=await readFile(o.helper),helperHash=digest(helperBytes);
    // Go uses Forge's pinned gopls (scripts/go-analysis) with downloads disabled.
    const gopls=o.language==='go'?join(goBackendRoot,'gopls.exe'):undefined,goplsHash=gopls?digest(await readFile(gopls)):undefined;
    // Java uses Forge's private pinned JDT LS; build files stay out of the copy.
    const java=o.language==='java'?await verifiedSerenaJava():undefined;
    const ownedLanguage=await ownedSerenaLanguage(o.language);
    const javaRoot=java?await realpath(o.root):undefined;
    const classpath=javaRoot?await loadJavaClasspath(javaRoot,[javaRoot],abort.signal):undefined;
    const kotlin=o.language==='kotlin'?kotlinWorkspace(capture.files,o.target):undefined;
    const kotlinFiles=kotlin?kotlinModelFiles(capture.files):undefined;
    if(o.label!=='query')assertKotlinWritable(capture.files,[o.target]);
    const cpp=o.language==='cpp'?capture.files.get('compile_commands.json'):undefined;
    const copied=(path:string)=>(!java||!javaBuildFile(path))&&(!kotlin||path!=='workspace.json'&&!kotlinBuildFile(path)&&kotlinFiles!.copied(path))&&(!cpp||path!=='compile_commands.json');
    if(java&&!copied(o.target))throw Error(`Serena Java ${o.label} target must be a source file`);
    owned=await mkdtemp(join(await realpath(tmpdir()),'forge-serena-rename-'));
    const project=join(owned,'project');await mkdir(project);
    for(const [path,data] of capture.files){if(!copied(path))continue;abort.signal.throwIfAborted();const file=join(project,...path.split('/'));await mkdir(dirname(file),{recursive:true});await writeFile(file,data,{flag:'wx'});}
    const libraries:string[]=[];
    if(classpath)for(const [index,entry] of classpath.entries.entries()){
      const location=join(owned,'dependencies',String(index)+(entry.kind==='jar'?'.jar':''));
      if(entry.kind==='classes')await mkdir(location,{recursive:true});
      for(const file of entry.files){
        const data=classpath.contents.get(entry.kind==='jar'?entry.path:join(entry.path,...file.path.split('/')));
        if(!data||digest(data)!==file.sha256)throw Error('Captured Serena Java dependency mismatch');
        const destination=entry.kind==='jar'?location:join(location,...file.path.split('/'));
        await mkdir(dirname(destination),{recursive:true});await writeFile(destination,data,{flag:'wx'});
      }
      libraries.push(location);
    }
    if(java)for(const [name,text] of Object.entries(eclipseJavaProject(javaSourceRoots([...capture.files].filter(([path])=>copied(path))),libraries)))await writeFile(join(project,name),text,{flag:'wx'});
    if(kotlin)await writeFile(join(project,'workspace.json'),kotlin,{flag:'wx'});
    const cppModel=cpp?privateCppCommands(cpp,await realpath(o.root),project,capture.files):undefined;
    if(cppModel){
      for(const entry of JSON.parse(cppModel))await mkdir(entry.directory,{recursive:true});
      await writeFile(join(project,'compile_commands.json'),cppModel,{flag:'wx'});
    }
    const privateHelper=join(owned,basename(o.helper));await writeFile(privateHelper,helperBytes,{flag:'wx'});
    const result=join(owned,'result.json'),log=join(owned,'helper.log'),request=join(owned,'request.json');
    await writeFile(request,JSON.stringify({protocol:o.protocol,project,owned,result,language:o.language,file:o.target,...o.request,...(java?{java:{...java.settings,jdtls_xmx:'1G'}}:{}),...(ownedLanguage?{owned_language:ownedLanguage}:{}),request_timeout:Math.max(30,Math.floor((o.timeoutMs??240_000)/1000)-10)}),{flag:'wx'});
    // npm offline: an LSP prerequisite install must fail instead of fetching.
    const goEnv=gopls?"$env:PATH="+quote(dirname(gopls))+"+';'+$env:PATH;$env:GOPROXY='off';$env:GOTOOLCHAIN='local';$env:GOFLAGS='-mod=readonly';$env:GOWORK='off';":'';
    const command="$env:npm_config_offline='true';$env:PYTHONUTF8='1';$env:PYTHONDONTWRITEBYTECODE='1';$env:SERENA_HOME="+quote(join(owned,'serena-home'))+";"+goEnv+"& "+[python,'-I','-B',privateHelper,request].map(quote).join(' ');
    abort.signal.throwIfAborted();
    job=startWindowsJob(command,owned,log,'ForgeSerena-'+randomUUID(),{memoryLimitMiB:3072});o.onLaunched?.(job.pid,job.creation_time);await job.input('',true);
    let exit:number|null=null;
    while(exit===null){abort.signal.throwIfAborted();if((await lstat(log)).size>4*1024*1024)throw Error('Serena helper log exceeds 4 MiB');exit=job.poll();if(exit===null)await new Promise(done=>setTimeout(done,50));}
    job.close();job=undefined;abort.signal.throwIfAborted();
    if(exit!==0)throw Error(`Serena ${o.label} helper exited `+exit+': '+(await readFile(log,'utf8')).slice(-1600));
    if((await lstat(result)).size>16*1024*1024)throw Error(`Serena ${o.label} result exceeds 16 MiB`);
    let reply:Record<string,unknown>;try{reply=JSON.parse(await readFile(result,'utf8'));}catch{throw Error('Serena helper emitted invalid JSON');}
    if(reply.protocol!==o.protocol||reply.serena_version!==SERENA_VERSION||reply.language!==o.language||reply.helper_sha256!==helperHash)throw Error('Invalid Serena helper response');
    if(digest(await readFile(privateHelper))!==helperHash)throw Error('Serena private helper changed during analysis');
    if(kotlin&&await readFile(join(project,'workspace.json'),'utf8')!==kotlin)throw Error('Private Kotlin build model changed during analysis');
    if(cppModel&&await readFile(join(project,'compile_commands.json'),'utf8')!==cppModel)throw Error('Private C++ compilation database changed during analysis');
    if(gopls&&digest(await readFile(gopls))!==goplsHash)throw Error('Pinned gopls changed during analysis');
    if(java&&(await serenaJavaDigest(java.root)).sha256!==java.tree.sha256)throw Error('Private JDT LS changed during analysis');
    if(classpath){
      const fresh=await loadJavaClasspath(javaRoot!,[javaRoot!],abort.signal);
      if(JSON.stringify(javaClasspathPins(fresh))!==JSON.stringify(javaClasspathPins(classpath)))throw Error('Serena Java classpath changed during analysis');
      for(const [index,entry] of classpath.entries.entries())for(const file of entry.files){
        const location=entry.kind==='jar'?libraries[index]!:join(libraries[index]!,...file.path.split('/'));
        if(digest(await readFile(location))!==file.sha256)throw Error('Private Serena Java dependency changed during analysis');
      }
    }
    if(reply.prerequisites_unchanged!==true)throw Error('Serena language-server prerequisites changed during analysis; inspect them and plan again: '+JSON.stringify(reply.changed_prerequisites??[]));
    abort.signal.throwIfAborted();
    return await after({project,capture,copied,reply,...(classpath?{classpath}:{})});
  }finally{
    clearTimeout(timer);o.signal?.removeEventListener('abort',cancel);
    if(job){try{job.stop();}catch{/* Job close below still kills members. */}job.close();}
    if(owned)await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
    if(acquired)release();
  }
}

// Kotlin symbolic reads and writes share capture, import, model validation and
// process ownership. Each read is fresh; cached language-server state cannot
// outlive a build/dependency change or disagree with the next rename preview.
export async function queryKotlin(root:string,tool:string,args:Record<string,unknown>,signal?:AbortSignal,options:{timeoutMs?:number}={}):Promise<string>{
  const allowed=['get_symbols_overview','find_symbol','find_referencing_symbols','find_implementations','find_declaration','get_diagnostics_for_file','get_diagnostics_for_symbol'];
  if(!allowed.includes(tool))throw Error('Not a private Kotlin read tool');
  const capture=captureSerenaProject(root),within=String(args.relative_path??'').replace(/^\.\/?/,'');
  const inputs=kotlinModelFiles(capture.files);
  const target=[...capture.files.keys()].find(p=>inputs.copied(p)&&p.endsWith('.kt')&&(!within||p===within||p.startsWith(within+'/')));
  if(!target)throw Error('No captured Kotlin source for this query');
  const reader=fileURLToPath(new URL('../scripts/serena-analysis/forge_serena_read.py',import.meta.url));
  const readerHash=digest(await readFile(reader));
  return runSerenaPrivate({root,language:'kotlin',target,label:'query',helper:fileURLToPath(new URL('../scripts/serena-analysis/forge_serena_query.py',import.meta.url)),protocol:'forge-serena-query-v1',signal,timeoutMs:options.timeoutMs,
    request:{tool,args,reader_path:reader,reader_sha256:readerHash}},async run=>{
      for(const [p,h]of Object.entries(run.capture.hashes))if(run.copied(p)&&!p.startsWith('.serena/')&&digest(await readFile(join(run.project,...p.split('/'))))!==h)throw Error('Kotlin query modified private source');
      if(captureSerenaProject(root).fingerprint!==run.capture.fingerprint)throw Error('Kotlin project changed during read; query again');
      if(digest(await readFile(reader))!==readerHash)throw Error('Kotlin reader changed during query');
      let content=String(run.reply.content??'');
      for(const [from,to]of [[pathToFileURL(run.project).href,pathToFileURL(root).href],[run.project.replaceAll('\\','/'),root.replaceAll('\\','/')],[run.project,root],[JSON.stringify(run.project).slice(1,-1),JSON.stringify(root).slice(1,-1)]])content=content.replaceAll(from!,to!);
      return content.length<=26_000?content:content.slice(0,26_000)+'\n[Serena output truncated; narrow the query]';
    });
}

export async function planSerenaRename(input:SerenaRenameInput,signal?:AbortSignal,options:{timeoutMs?:number;python?:string;helper?:string;onLaunched?:(pid:number,creation:string)=>void;probeInstalled?:boolean}={}):Promise<SerenaRenamePlan>{
  if(process.platform!=='win32')throw Error('Serena rename transactions currently require Windows owned jobs');
  assertSerenaCapability(input.language,options.probeInstalled?'edit':'rename');
  if(!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(input.new_name))throw Error('Serena new_name must be one identifier');
  if(!Number.isSafeInteger(input.line)||!Number.isSafeInteger(input.column)||input.line<1||input.column<1)throw Error('Serena rename requires 1-based line and column');
  const target=serenaRelativePath(input.file,input.root);
  return runSerenaPrivate({root:input.root,language:input.language,target,label:'rename',helper:options.helper??HELPER,protocol:PROTOCOL,
    request:{line:input.line,column:input.column,new_name:input.new_name},timeoutMs:options.timeoutMs,python:options.python,onLaunched:options.onLaunched,signal},async run=>{
    const reply=run.reply as unknown as HelperReply,{project,capture,copied,classpath}=run;
    if(!Array.isArray(reply.plans)||reply.plans.length!==2||!Array.isArray(reply.references))throw Error('Invalid Serena helper response');
    for(const [path,hash] of Object.entries(capture.hashes))if(copied(path)&&digest(await readFile(join(project,...path.split('/'))))!==hash)throw Error(`Serena analysis changed private source ${path}`);
    if(!reply.plans[0])throw Error('Serena returned no rename plan for this position');
    // gopls bumps the LSP document version counter and lists files in map order
    // between requests; the per-file edits themselves must be identical.
    const comparable=(plan:WorkspaceEdit|null)=>{
      const docs=(plan?.documentChanges??Object.entries(plan?.changes??{}).map(([uri,edits])=>({textDocument:{uri},edits}))) as {textDocument?:{uri?:string};edits?:TextEdit[];kind?:string}[];
      const pos=(e:TextEdit)=>[e.range.start.line,e.range.start.character,e.range.end.line,e.range.end.character];
      return JSON.stringify(docs.map(d=>({kind:d.kind??'',uri:d.textDocument?.uri??JSON.stringify(d),edits:[...(d.edits??[])].map(e=>({p:pos(e),t:e.newText})).sort((a,b)=>String(a.p).localeCompare(String(b.p)))})).sort((a,b)=>a.uri<b.uri?-1:a.uri>b.uri?1:0));
    };
    if(comparable(reply.plans[0])!==comparable(reply.plans[1]))throw Error('Serena rename plans differ between requests; index not ready, nothing applied');
    const {changes,files,file_moves}=await convertSerenaWorkspaceEdit(await realpath(project),capture,target,reply.plans[0],reply.references,input.new_name);
    assertKotlinWritable(capture.files,changes.flatMap(c=>[c.path,...(c.rename_to?[c.rename_to]:[])]));
    if(options.probeInstalled&&(files.length<2||reply.references.length<1))throw Error('Registration requires a real cross-file rename and reported references');
    const references=reply.references.map(ref=>({file:relative(project,fileURLToPath(ref.uri)).replaceAll('\\','/'),line:ref.range.start.line+1,column:ref.range.start.character+1,end_line:ref.range.end.line+1,end_column:ref.range.end.character+1}));
    return {backend:'serena',serena_version:SERENA_VERSION,language:input.language as SerenaRenameLanguage,fingerprint:capture.fingerprint,references,
      readiness:{references:reply.references.length,stable_plans:2,prerequisites_unchanged:true},files,changes,file_moves,...(classpath?{java_environment:{classpath_entries:classpath.entries.length,model_present:classpath.model_present,static_import:classpath.maven}}:{})};
  });
}

export const SERENA_SYMBOL_EDITS=['replace_body','insert_before','insert_after','safe_delete'] as const;
export type SerenaSymbolEditOperation=(typeof SERENA_SYMBOL_EDITS)[number];
export interface SerenaSymbolEditInput {root:string;language:string;file:string;operation:SerenaSymbolEditOperation;name_path:string;body?:string}
export interface SerenaSymbolEditPlan {backend:'serena';serena_version:string;language:string;operation:SerenaSymbolEditOperation;name_path:string;fingerprint:string;files:{file:string;before_sha256:string;after_sha256:string}[];changes:BatchChange[]}
// Files Serena or the generated Java project may create in the private copy.
const privateGenerated=(path:string)=>/^(\.serena|forge-serena-bin)(\/|$)/.test(path)||path==='.project'||path==='.classpath';

// Serena 1.7.0's own LanguageServerCodeEditor edits the private copy; Forge
// turns the resulting captured-file differences into one journaled batch.
export async function planSerenaSymbolEdit(input:SerenaSymbolEditInput,signal?:AbortSignal,options:{timeoutMs?:number;python?:string;helper?:string;onLaunched?:(pid:number,creation:string)=>void}={}):Promise<SerenaSymbolEditPlan>{
  if(process.platform!=='win32')throw Error('Serena symbol edits currently require Windows owned jobs');
  assertSerenaCapability(input.language,input.operation==='safe_delete'?'rename':'edit');
  if(!(SERENA_SYMBOL_EDITS as readonly string[]).includes(input.operation))throw Error('Unknown Serena symbol edit operation');
  if(!input.name_path||input.name_path.length>512||/[\0\r\n]/.test(input.name_path))throw Error('Serena name_path must be one bounded symbol path');
  if(input.operation==='safe_delete'){if(input.body!==undefined)throw Error('safe_delete takes no body');}
  else if(typeof input.body!=='string'||!input.body.trim()||Buffer.byteLength(input.body)>512*1024)throw Error('Serena symbol edit body must be non-empty and at most 512 KiB');
  const target=serenaRelativePath(input.file,input.root);
  return runSerenaPrivate({root:input.root,language:input.language,target,label:'symbol edit',helper:options.helper??EDIT_HELPER,protocol:EDIT_PROTOCOL,
    request:{operation:input.operation,name_path:input.name_path,...(input.body!==undefined?{body:input.body}:{})},timeoutMs:options.timeoutMs,python:options.python,onLaunched:options.onLaunched,signal},async run=>{
    const {project,capture,copied,reply}=run;
    if(reply.status==='refused')throw Error('Serena refused the symbol edit; nothing applied: '+String(reply.message??'').slice(0,4000));
    if(reply.status!=='applied')throw Error('Invalid Serena helper response');
    // Every private file must be a captured file or a known generated file.
    const seen=new Set<string>();
    const walk=(dir:string,prefix:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
      const name=prefix+entry.name;
      if(privateGenerated(name)||input.language==='kotlin'&&name==='workspace.json'||input.language==='cpp'&&name==='compile_commands.json')continue;
      if(entry.isSymbolicLink())throw Error('Serena created a link in the private copy; nothing applied');
      if(entry.isDirectory())walk(join(dir,entry.name),name+'/');
      else{if(!capture.files.has(name)||!copied(name))throw Error(`Serena created ${name}; symbol edits may only change existing files, nothing applied`);seen.add(name);}
    }};
    walk(project,'');
    const changes:BatchChange[]=[],files:SerenaSymbolEditPlan['files']=[];
    for(const [path,data] of capture.files){
      // Serena's own project state is never journaled as a source change.
      if(!copied(path)||privateGenerated(path))continue;
      if(!seen.has(path))throw Error(`Serena removed ${path}; symbol edits may not delete files, nothing applied`);
      const after=readFileSync(join(project,...path.split('/')));
      if(after.equals(data))continue;
      const text=after.toString('utf8');
      if(!Buffer.from(text,'utf8').equals(after))throw Error(`Serena wrote non-UTF-8 content to ${path}; nothing applied`);
      changes.push({path,content:text,expected_hash:capture.hashes[path]!});
      files.push({file:path,before_sha256:capture.hashes[path]!,after_sha256:digest(after)});
    }
    if(!changes.length)throw Error('Serena symbol edit changed nothing; nothing applied');
    assertKotlinWritable(capture.files,changes.map(c=>c.path));
    if(!changes.some(change=>change.path===target))throw Error('Serena symbol edit did not change the requested file; nothing applied');
    if(changes.length>MAX_EDIT_FILES)throw Error('Serena symbol edit exceeds 64 files');
    return {backend:'serena',serena_version:SERENA_VERSION,language:input.language,operation:input.operation,name_path:input.name_path,fingerprint:capture.fingerprint,files,changes};
  });
}
