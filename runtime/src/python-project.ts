import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {parse as parseJsonc,type ParseError} from 'jsonc-parser';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';
import {capturePythonDependencies,verifyPythonDependencyInventory,type PythonDependencies} from './python-dependencies.js';

export const pythonHash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
const skipped=new Set(['.git','node_modules','.venv','venv','__pycache__','dist','build','coverage','.pytest_cache','.mypy_cache','.ruff_cache','site-packages']);
const sourcePattern=/\.pyi?$/i;
const backendRoot=fileURLToPath(new URL('../scripts/python-analysis/',import.meta.url));
const vendorRoot=join(backendRoot,'vendor');
export async function pythonSourcePath(file:string,root:string) {
  const path=resolve(root,file);
  if(!isPathInsideRoot(path,root))throw new Error('Python path is outside allowed roots');
  const pieces=relative(root,path).split(sep).filter(Boolean);
  if(pieces.slice(0,-1).some(piece=>['.git','node_modules','.venv','venv','site-packages'].includes(piece.toLowerCase())))throw new Error('Python source selection refuses VCS and installed dependency directories');
  let current=root;
  for(const piece of pieces) {
    current=join(current,piece);
    if((await lstat(current)).isSymbolicLink())throw new Error('Python analysis refuses links in source paths');
  }
  return await resolveCanonicalAllowedPath(path,root,[root]);
}
function vendorInventory() {
  const files:string[]=[],pending=[vendorRoot];let count=0;
  while(pending.length) {
    const directory=pending.pop()!;
    if(lstatSync(directory).isSymbolicLink())throw new Error('Python backend contains a linked directory');
    for(const child of readdirSync(directory,{withFileTypes:true})) {
      if(++count>8192||child.isSymbolicLink())throw new Error('Python backend inventory is invalid');
      const path=join(directory,child.name);
      if(child.isDirectory()){if(child.name!=='__pycache__')pending.push(path);}
      else if(child.isFile())files.push(relative(vendorRoot,path).replaceAll('\\','/'));
      else throw new Error('Python backend contains an unexpected entry');
    }
  }
  return files.sort();
}
export interface PythonProject {
  root:string;
  sources:Map<string,string>;
  opaque_sources:Map<string,Buffer>;
  snapshots:{file:string;sha256:string;bytes:number}[];
  configs:{file:string;sha256:string}[];
  configuration_texts:Record<string,string>;
  pyright_chain:{file:string;value:Record<string,unknown>}[];
  directories:string[];
  skipped_links:string[];
  dependencies:PythonDependencies;
  environment:{fingerprint:string;pins:{path:string;sha256:string}[]};
}
async function textFile(path:string,limit:number,allowOpaque=false) {
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink())throw new Error('Python capture requires regular unlinked files');
  if(before.size>limit)throw new Error('Python file exceeds '+limit/1024+' KiB capture limit');
  const data=await readFile(path),after=await lstat(path);
  if(data.length>limit||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Python source changed during capture');
  const text=data.toString('utf8');
  const opaque=!Buffer.from(text).equals(data);
  if(opaque&&!allowOpaque)throw new Error('Python analysis requires UTF-8');
  return {text:opaque?'':text,bytes:data.length,raw:opaque?data:undefined};
}
async function backendEnvironment(signal?:AbortSignal) {
  const lockPath=join(backendRoot,'vendor-lock.json'),data=await textFile(lockPath,1024*1024);
  const lock=JSON.parse(data.text) as {files:{file:string;sha256:string}[]};
  if(!Array.isArray(lock.files)||lock.files.length>4096)throw new Error('Invalid Python backend manifest');
  if(JSON.stringify(vendorInventory())!==JSON.stringify(lock.files.map(item=>item.file).sort()))throw new Error('Python backend inventory changed');
  const pins=[{path:lockPath,sha256:pythonHash(data.text)},{path:join(backendRoot,'analyze.py'),sha256:pythonHash((await textFile(join(backendRoot,'analyze.py'),1024*1024)).text)}];
  pins.push({path:join(backendRoot,'venv_config.py'),sha256:pythonHash((await textFile(join(backendRoot,'venv_config.py'),64*1024)).text)});
  pins.push({path:join(backendRoot,'typing_views.py'),sha256:pythonHash((await textFile(join(backendRoot,'typing_views.py'),64*1024)).text)});
  const vendor=join(backendRoot,'vendor');
  for(const item of lock.files) {
    signal?.throwIfAborted();
    const path=resolve(vendor,item.file);
    if(!isPathInsideRoot(path,vendor))throw new Error('Python backend manifest escapes its bundle');
    const canonical=await resolveCanonicalAllowedPath(path,vendor,[vendor]);
    const bytes=await readFile(canonical);
    if(pythonHash(bytes)!==item.sha256)throw new Error('Python backend dependency changed: '+item.file);
    pins.push({path:canonical,sha256:item.sha256});
  }
  return {fingerprint:pythonHash(JSON.stringify(pins.map(item=>({file:relative(backendRoot,item.path).replaceAll('\\','/'),sha256:item.sha256})))),pins};
}
export function verifyPythonEnvironment(project:PythonProject) {
  verifyPythonDependencyInventory(project.root,project.dependencies);
  if(JSON.stringify(vendorInventory())!==JSON.stringify(project.environment.pins.filter(pin=>isPathInsideRoot(pin.path,vendorRoot)).map(pin=>relative(vendorRoot,pin.path).replaceAll('\\','/')).sort()))throw new Error('Python analysis environment inventory changed');
  for(const pin of project.environment.pins) {
    if(isPathInsideRoot(pin.path,project.root)) {
      let current=project.root;
      if(lstatSync(current).isSymbolicLink())throw new Error('Python analysis environment changed to a linked project path');
      for(const piece of relative(project.root,pin.path).split(sep).filter(Boolean)) {
        current=join(current,piece);
        if(lstatSync(current).isSymbolicLink())throw new Error('Python analysis environment changed to a linked project path');
      }
    }
    const item=lstatSync(pin.path);
    if(!item.isFile()||item.isSymbolicLink()||pythonHash(readFileSync(pin.path))!==pin.sha256)throw new Error('Python analysis environment changed; inspect again before rename');
  }
}
export async function usesPythonNavigation(input:{path:string;file?:string;files?:string[]},roots:string[]) {
  if(input.file)return sourcePattern.test(input.file);
  if(input.files?.some(file=>sourcePattern.test(file)))return true;
  const root=await resolveCanonicalAllowedPath(input.path,input.path,roots);
  const exists=async(file:string)=>{try{await lstat(join(root,file));return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
  if(await exists('tsconfig.json')||await exists('jsconfig.json'))return false;
  return await exists('pyproject.toml')||await exists('setup.py')||await exists('setup.cfg')||await exists('pyrightconfig.json');
}
export async function loadPythonProject(input:{path:string;files?:string[]},roots:string[],signal?:AbortSignal):Promise<PythonProject> {
  const root=await realpath(await resolveCanonicalAllowedPath(input.path,input.path,roots));
  if(!(await lstat(root)).isDirectory())throw new Error('Expected a Python project directory');
  const sources=new Map<string,string>(),opaque_sources=new Map<string,Buffer>(),snapshots:PythonProject['snapshots']=[],skipped_links:string[]=[],configs:PythonProject['configs']=[],configuration_texts:Record<string,string>={},pyright_chain:PythonProject['pyright_chain']=[],directories=[''];
  if(!input.files){
    const capture=async(file:string)=>{
      const path=await pythonSourcePath(file,root),name=relative(root,path).replaceAll('\\','/');
      const text=(await textFile(path,64*1024)).text;
      configuration_texts[name]=text;configs.push({file:name,sha256:pythonHash(text)});return {name,text};
    };
    for(const file of ['pyproject.toml','setup.cfg']) {
      try {await lstat(join(root,file));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      await capture(file);
    }
    const chain=async(file:string,seen=new Set<string>())=>{
      const {name,text}=await capture(file),key=name.toLowerCase();
      if(seen.has(key)||seen.size>=8)throw new Error('Python configuration inheritance cycle or eight-file limit exceeded');
      const errors:ParseError[]=[],value:unknown=parseJsonc(text.replace(/^\uFEFF/,''),errors,{allowTrailingComma:true});
      if(errors.length||!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Python configuration JSON: '+name);
      const settings=value as Record<string,unknown>;
      if(settings.extends!==undefined){
        if(typeof settings.extends!=='string'||!/\.json$/i.test(settings.extends))throw new Error('Python configuration extends must name an internal JSON file');
        const next=new Set(seen);next.add(key);
        await chain(relative(root,resolve(root,name,'..',settings.extends)),next);
      }
      pyright_chain.push({file:name,value:settings});
    };
    try {await lstat(join(root,'pyrightconfig.json'));await chain('pyrightconfig.json');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&!configuration_texts['pyrightconfig.json']){/* no root config */}else throw error;}
  }
  const environment=await backendEnvironment(signal);
  const selection=input.files?{explicit:false,root:null}:await new Promise<{explicit:boolean;root:string|null}>((done,reject)=>{
    // Only our pinned stdlib configuration reader runs here. Project interpreters,
    // site initialization, .pth files and package modules are never executed.
    const process=execFile('python',['-I','-S','-B','-X','utf8',join(backendRoot,'venv_config.py')],
      {cwd:backendRoot,windowsHide:true,timeout:5000,maxBuffer:16384,signal},(error,out)=>{
        if(error){reject(new Error('Python virtual environment configuration reader failed: '+error.message));return;}
        try{const value=JSON.parse(out) as {ok:boolean;error?:string;explicit:boolean;root:string|null};if(!value.ok)throw new Error(value.error);done(value);}catch(error){reject(error);}
      });
    process.stdin?.on('error',()=>{});process.stdin?.end(JSON.stringify({configuration_texts,pyright_chain}));
  });
  const dependencies=await capturePythonDependencies(root,{...selection,enabled:!input.files},signal);
  let bytes=0,entries=0;
  const add=async(file:string)=>{
    signal?.throwIfAborted();
    if(!sourcePattern.test(file))throw new Error('Python selection only supports .py and .pyi files');
    const path=await pythonSourcePath(file,root),name=relative(root,path).replaceAll('\\','/');
    if(sources.has(name)||opaque_sources.has(name))return;
    if(snapshots.length>=(input.files?64:2048))throw new Error('Python project exceeds '+(input.files?64:2048)+' source files');
    const data=await textFile(path,/\.pyi$/i.test(path)?4*1024*1024:512*1024,!input.files);
    bytes+=data.bytes;
    if(bytes>(input.files?2:32)*1024*1024)throw new Error('Python source capture exceeds '+(input.files?2:32)+' MiB');
    snapshots.push({file:name,sha256:pythonHash(data.raw??data.text),bytes:data.bytes});
    if(data.raw)opaque_sources.set(name,data.raw);else sources.set(name,data.text);
  };
  if(input.files)for(const file of input.files)await add(file);
  else {
    const pending=[root];
    while(pending.length) {
      signal?.throwIfAborted();
      const directory=pending.pop()!;
      await resolveCanonicalAllowedPath(directory,root,[root]);
      const children=await readdir(directory,{withFileTypes:true});
      children.sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of children) {
        if(++entries>20000)throw new Error('Python discovery exceeds 20,000 entries');
        const path=join(directory,entry.name);
        if(entry.isSymbolicLink()){skipped_links.push(relative(root,path).replaceAll('\\','/'));continue;}
        if(entry.isDirectory()){if(!skipped.has(entry.name.toLowerCase())&&relative(root,path).replaceAll('\\','/').toLowerCase()!==dependencies.root?.toLowerCase()){directories.push(relative(root,path).replaceAll('\\','/'));pending.push(path);}}
        else if(entry.isFile()&&sourcePattern.test(entry.name))await add(path);
      }
    }
  }
  if(!snapshots.length)throw new Error('No captured Python sources');
  environment.pins.push(...configs.map(item=>({path:join(root,item.file),sha256:item.sha256})));
  environment.pins.push(...snapshots.filter(item=>opaque_sources.has(item.file)).map(item=>({path:join(root,item.file),sha256:item.sha256})));
  environment.pins.push(...dependencies.pins);
  environment.fingerprint=pythonHash(environment.fingerprint+JSON.stringify(configs)+JSON.stringify(snapshots.filter(item=>opaque_sources.has(item.file)))+JSON.stringify({root:dependencies.root,selection:dependencies.selection,site_packages:dependencies.site_packages,snapshots:dependencies.snapshots,pins:dependencies.pins,typed_markers:dependencies.typed_markers,inventory:dependencies.inventory,marker_checks:dependencies.marker_checks,layout:dependencies.layout,path_roots:dependencies.path_roots,path_ignored:dependencies.path_ignored}));
  return {root,sources,opaque_sources,snapshots,configs,configuration_texts,pyright_chain,directories,skipped_links:skipped_links.sort(),dependencies,environment};
}
export const pythonExcludedDirectories=[...skipped];
