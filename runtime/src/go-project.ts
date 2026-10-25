import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep,isAbsolute,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';
import {visitGoInputs as batches} from './go-input-work.js';

export const goHash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export const goBackendRoot=fileURLToPath(new URL('../scripts/go-analysis/',import.meta.url));
const excluded=new Set(['.git','.hg','.svn','node_modules','.venv','venv','__pycache__','.cache']);
export interface GoPin {file:string;sha256:string;bytes:number}
export interface GoTree {root:string;destination:string;files:GoPin[];directories:string[];excluded:string[];filter?:'metadata'}
export interface GoProject {
  root:string; snapshot:string; sources:Map<string,string>; trees:GoTree[];
  selected:string[]; toolchain_version:string; module_cache:string;node_executable:string;
  environment:{fingerprint:string;pins:{path:string;sha256:string;bytes:number}[]};
}

async function regular(path:string,limit:number,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const expected=resolve(path).toLowerCase();
  if((await realpath(path)).toLowerCase()!==expected)throw new Error('Go capture refuses linked or aliased input paths');
  const before=await lstat(path);
  if(before.isSymbolicLink()||!before.isFile())throw new Error('Go capture requires regular unlinked files');
  if(before.size>limit)throw new Error('Go file exceeds capture bound: '+path);
  const bytes=await readFile(path),after=await lstat(path);
  if((await realpath(path)).toLowerCase()!==expected)throw new Error('Go input path changed during capture');
  signal?.throwIfAborted();
  if(bytes.length>limit||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Go input changed during capture');
  return bytes;
}
export const readGoInput=regular;
export async function assertGoPath(path:string,root:string) {
  const absolute=resolve(root,path);
  if(!isPathInsideRoot(absolute,root))throw new Error('Go path is outside its capture root');
  let current=root;
  if((await lstat(root)).isSymbolicLink())throw new Error('Go capture refuses linked roots');
  for(const part of relative(root,absolute).split(sep).filter(Boolean)) {
    current=join(current,part);
    if((await lstat(current)).isSymbolicLink())throw new Error('Go capture refuses linked paths');
  }
  return absolute;
}
function accepted(file:string,filter?:'metadata') {return filter!=='metadata'||/\.(mod|info|ziphash)$/.test(file)||file.endsWith('/list');}
async function inventory(root:string,excludes:string[],filter:'metadata'|undefined,signal?:AbortSignal) {
  const files:string[]=[],directories:string[]=[],pending=[''];let entries=0;
  const skip=new Set(excludes);
  await assertGoPath(root,root);
  while(pending.length) {
    signal?.throwIfAborted();
    const folder=pending.pop()!;
    for(const item of await readdir(join(root,folder),{withFileTypes:true})) {
      if(++entries>50000)throw new Error('Go directory inventory exceeds 50,000 entries');
      if(skip.has(item.name.toLowerCase()))continue;
      const file=folder?folder+'/'+item.name:item.name;
      if(item.isSymbolicLink())throw new Error('Go capture refuses links: '+file);
      if(item.isDirectory()){directories.push(file);pending.push(file);}
      else if(item.isFile()){if(accepted(file,filter))files.push(file);}
      else throw new Error('Unexpected Go capture entry: '+file);
    }
  }
  return {files:files.sort(),directories:directories.sort()};
}
export async function captureGoTree(root:string,destination:string,options:{maxFiles:number;maxBytes:number;maxFileBytes:number;excluded?:string[];filter?:'metadata';signal?:AbortSignal;onFile?:(file:string,bytes:Buffer)=>void}):Promise<GoTree> {
  const excludes=options.excluded??[],list=await inventory(root,excludes,options.filter,options.signal);
  if(list.files.length>options.maxFiles)throw new Error('Go capture exceeds file count bound');
  const files:GoPin[]=new Array(list.files.length);let total=0;
  await mkdir(destination,{recursive:true});
  await batches(list.directories,path=>mkdir(join(destination,path),{recursive:true}).then(()=>{}),options.signal);
  await batches(list.files,async(file,index)=>{
    const bytes=await regular(join(root,file),options.maxFileBytes,options.signal);
    total+=bytes.length;if(total>options.maxBytes)throw new Error('Go capture exceeds total byte bound');
    const target=join(destination,file);await writeFile(target,bytes);
    files[index]={file,sha256:goHash(bytes),bytes:bytes.length};options.onFile?.(file,bytes);
  },options.signal);
  const after=await inventory(root,excludes,options.filter,options.signal);
  if(JSON.stringify(after)!==JSON.stringify(list))throw new Error('Go input inventory changed during capture');
  return {root,destination,files,directories:list.directories,excluded:excludes,...(options.filter?{filter:options.filter}:{})};
}
export async function verifyGoTree(tree:GoTree,signal?:AbortSignal) {
  const list=await inventory(tree.root,tree.excluded,tree.filter,signal);
  if(JSON.stringify(list.files)!==JSON.stringify(tree.files.map(file=>file.file))||JSON.stringify(list.directories)!==JSON.stringify(tree.directories))throw new Error('Go input inventory changed; inspect again');
  await batches(tree.files,async pin=>{
    const bytes=await regular(join(tree.root,pin.file),Math.max(pin.bytes,1),signal);
    if(goHash(bytes)!==pin.sha256)throw new Error('Go analysis input changed; inspect again: '+pin.file);
  },signal);
}
export async function verifyGoEnvironment(project:GoProject,signal?:AbortSignal) {
  for(const tree of project.trees)await verifyGoTree(tree,signal);
  for(const pin of project.environment.pins) {
    if(goHash(await regular(pin.path,Math.max(pin.bytes,1),signal))!==pin.sha256)throw new Error('Go analysis backend changed; inspect again');
  }
}
async function installedGo(projectRoot:string) {
  for(const folder of (process.env.PATH??'').split(delimiter)) {
    if(!isAbsolute(folder))continue;
    const path=join(folder,process.platform==='win32'?'go.exe':'go');
    let stat;try{stat=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||isPathInsideRoot(path,projectRoot))continue;
    const root=dirname(dirname(await realpath(path))),version=(await regular(join(root,'VERSION'),1024)).toString('utf8').split(/\r?\n/)[0]!;
    if(!/^go1\.(2[6-9]|[3-9]\d)\.\d+$/.test(version))throw new Error('Go 1.26 or newer with the standard bin/VERSION layout is required');
    await assertGoPath(path,root);
    return {root,version};
  }
  throw new Error('An installed Go 1.26+ toolchain on PATH is required');
}
async function backendPins(signal?:AbortSignal) {
  const path=join(goBackendRoot,'backend-lock.json'),bytes=await regular(path,1024*1024,signal);
  const lock=JSON.parse(bytes.toString('utf8')) as {gopls_version:string;files:GoPin[]};
  if(lock.gopls_version!=='v0.23.0'||!Array.isArray(lock.files)||lock.files.length>128)throw new Error('Invalid Go backend manifest');
  const list=await inventory(goBackendRoot,[],undefined,signal);
  const expected=[...lock.files.map(file=>file.file),'backend-lock.json','lsp-client.mjs','analyze.mjs'].sort();
  if(JSON.stringify(list.files)!==JSON.stringify(expected))throw new Error('Go backend inventory differs from its pinned manifest');
  const pins=[{path,sha256:goHash(bytes),bytes:bytes.length}];
  for(const file of lock.files) {
    const target=await assertGoPath(file.file,goBackendRoot),content=await regular(target,64*1024*1024,signal);
    if(goHash(content)!==file.sha256||content.length!==file.bytes)throw new Error('Pinned Go backend changed: '+file.file);
    pins.push({path:target,sha256:file.sha256,bytes:file.bytes});
  }
  for(const file of ['lsp-client.mjs','analyze.mjs']){const bytes=await regular(join(goBackendRoot,file),1024*1024,signal);pins.push({path:join(goBackendRoot,file),sha256:goHash(bytes),bytes:bytes.length});}
  return pins;
}
export async function usesGoNavigation(input:{path:string;file?:string;files?:string[]},roots:string[]) {
  if(input.file)return /\.go$/i.test(input.file);
  if(input.files?.some(file=>/\.go$/i.test(file))) {
    if(input.files.some(file=>!/\.go$/i.test(file)))throw new Error('Explicit files must use one language');
    return true;
  }
  if(input.files)return false;
  const root=await resolveCanonicalAllowedPath(input.path,input.path,roots);
  const names=new Set((await readdir(root)).map(name=>name.toLowerCase()));
  if(names.has('tsconfig.json')||names.has('jsconfig.json')||names.has('pyproject.toml')||names.has('pyrightconfig.json')||names.has('setup.py')||names.has('setup.cfg'))return false;
  return names.has('go.mod')||names.has('go.work');
}
export type GoToolchainCapture=(root:string,version:string,signal?:AbortSignal)=>Promise<GoTree>;
export type GoProjectPhase='source_capture'|'toolchain_acquire'|'module_metadata_capture'|'backend_capture';
export async function loadGoProject(input:{path:string;file?:string;files?:string[]},roots:string[],owned:string,signal?:AbortSignal,toolchainCapture?:GoToolchainCapture,onPhase?:(phase:GoProjectPhase)=>void):Promise<GoProject> {
  onPhase?.('source_capture');
  const root=await resolveCanonicalAllowedPath(input.path,input.path,roots);
  await assertGoPath(root,root);
  if(input.files?.some(file=>!/\.go$/i.test(file)))throw new Error('Explicit files must use one language');
  const selected:string[]=[];
  for(const file of [...(input.files??[]),...(input.file?[input.file]:[])]) {
    const path=await assertGoPath(file,root);
    if(!/\.go$/i.test(path)||relative(root,path).split(sep).some(part=>excluded.has(part.toLowerCase())))throw new Error('Go target must be a captured Go source');
    selected.push(relative(root,await realpath(path)).replaceAll('\\','/'));
  }
  const sources=new Map<string,string>(),snapshot=join(owned,'source'),trees:GoTree[]=[];
  trees.push(await captureGoTree(root,snapshot,{maxFiles:4096,maxBytes:64*1024*1024,maxFileBytes:8*1024*1024,excluded:[...excluded],signal,onFile(file,bytes){
    if(/\.go$/i.test(file)) {
      if(sources.size>=2048)throw new Error('Go project exceeds 2,048 sources');
      const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw new Error('Go source requires UTF-8: '+file);
      sources.set(file,text);
    }
  }}));
  if(!sources.size)throw new Error('No captured Go sources');
  for(const file of selected)if(!sources.has(file))throw new Error('Go target is outside captured sources');
  if(!trees[0]!.files.some(file=>file.file==='go.mod'||file.file==='go.work'))throw new Error('Go project mode requires a root go.mod or go.work');
  onPhase?.('toolchain_acquire');
  const toolchain=await installedGo(root);
  trees.push(toolchainCapture?await toolchainCapture(toolchain.root,toolchain.version,signal):await captureGoTree(toolchain.root,join(owned,'goroot'),{maxFiles:20000,maxBytes:512*1024*1024,maxFileBytes:64*1024*1024,signal}));
  const module_cache=process.env.GOMODCACHE??join((process.env.GOPATH??join(process.env.USERPROFILE??process.env.HOME??'', 'go')).split(delimiter)[0]!,'pkg','mod');
  if(!isAbsolute(module_cache)||isPathInsideRoot(module_cache,root))throw new Error('Go module cache must be an absolute external installed cache');
  onPhase?.('module_metadata_capture');
  const metadata=join(module_cache,'cache','download');
  try {
    trees.push(await captureGoTree(metadata,join(owned,'gomodcache','cache','download'),{maxFiles:4096,maxBytes:8*1024*1024,maxFileBytes:1024*1024,filter:'metadata',signal}));
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  onPhase?.('backend_capture');
  const pins=await backendPins(signal);
  const node_executable=await realpath(process.execPath);
  const nodeBytes=await regular(node_executable,128*1024*1024,signal);
  pins.push({path:node_executable,sha256:goHash(nodeBytes),bytes:nodeBytes.length});
  const project:GoProject={root,snapshot,sources:new Map([...sources].sort(([a],[b])=>a.localeCompare(b))),trees,selected:[...new Set(selected)],toolchain_version:toolchain.version,module_cache,node_executable,
    environment:{fingerprint:'',pins}};
  refreshGoFingerprint(project);
  return project;
}
export function refreshGoFingerprint(project:GoProject) {
  project.environment.fingerprint=goHash(JSON.stringify({trees:project.trees.map(tree=>({root:tree.root,files:tree.files,directories:tree.directories})),pins:project.environment.pins}));
}
