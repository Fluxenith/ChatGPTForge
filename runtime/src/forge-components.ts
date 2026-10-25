import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {lstat,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {serenaJavaDigest,serenaJavaDir,serenaJavaLock} from './serena-java.js';
import {serenaLanguagesHome,serenaPython} from './serena-workspace-edit.js';
import {readFileSync} from 'node:fs';

// Inventory and digest verification of the external components Forge pins.
// Verification only reads; installation is offline from a local source that
// must match the pin. Nothing here downloads: fetching a new release needs the
// owner's explicit approval and a reviewed lock change.
const run=promisify(execFile);
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
export type ComponentState='verified'|'mismatch'|'missing'|'unavailable';
export interface ComponentReport {id:string;pinned:string;state:ComponentState;detail:string;checked:number}

async function fileSet(root:string,files:{file:string;sha256:string;bytes?:number}[]):Promise<{state:ComponentState;detail:string;checked:number}>{
  let checked=0;
  for(const entry of files){
    const path=join(root,...entry.file.split('/'));
    let data:Buffer;
    try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())return {state:'mismatch',detail:'not a regular file: '+entry.file,checked};data=await readFile(path);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'missing',detail:'missing '+entry.file,checked};throw error;}
    if(sha(data)!==entry.sha256||(entry.bytes!==undefined&&data.length!==entry.bytes))return {state:'mismatch',detail:'hash differs: '+entry.file,checked};
    checked++;
  }
  return {state:'verified',detail:`${checked} files match`,checked};
}

export async function verifyComponents():Promise<{ok:boolean;components:ComponentReport[]}>{
  const out:ComponentReport[]=[];
  const add=(id:string,pinned:string,r:{state:ComponentState;detail:string;checked?:number})=>out.push({id,pinned,state:r.state,detail:r.detail,checked:r.checked??0});
  // Go backend: pinned gopls build and its licenses.
  {const lock=JSON.parse(await readFile(join(scripts,'go-analysis','backend-lock.json'),'utf8')) as {gopls_version:string;files:{file:string;sha256:string;bytes:number}[]};
   add('gopls',lock.gopls_version,await fileSet(join(scripts,'go-analysis'),lock.files));}
  // Python analysis vendor tree (Jedi/Parso).
  {const lock=JSON.parse(await readFile(join(scripts,'python-analysis','vendor-lock.json'),'utf8')) as {jedi:string;parso:string;files:{file:string;sha256:string}[]};
   add('python-vendor',`jedi ${lock.jedi} / parso ${lock.parso}`,await fileSet(join(scripts,'python-analysis','vendor'),lock.files));}
  // Private Eclipse JDT LS for Serena Java.
  {const lock=serenaJavaLock(),dir=serenaJavaDir(lock);
   if(!existsSync(dir))add('serena-jdtls',lock.extension,{state:'missing',detail:'not installed; use components install serena-jdtls --from <extension dir>'});
   else{const tree=await serenaJavaDigest(dir);add('serena-jdtls',lock.extension,tree.sha256===lock.tree.sha256&&tree.files===lock.tree.files&&tree.bytes===lock.tree.bytes?{state:'verified',detail:`${tree.files} files match tree digest`,checked:tree.files}:{state:'mismatch',detail:'tree digest differs'});}}
  // Pyright: npm installs it from package-lock.json integrity; check the resolved version.
  {const require=createRequire(import.meta.url),pinned=(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {dependencies:Record<string,string>}).dependencies.pyright!;
   try{const version=(JSON.parse(await readFile(require.resolve('pyright/package.json'),'utf8')) as {version:string}).version;add('pyright',pinned,version===pinned?{state:'verified',detail:'installed '+version}:{state:'mismatch',detail:'installed '+version});}
   catch{add('pyright',pinned,{state:'missing',detail:'npm dependency not installed'});}}
  // Serena tool environment (uv tool install serena-agent==1.7.0).
  {const python=serenaPython();
   if(!existsSync(python))add('serena','1.7.0',{state:'missing',detail:'Serena Python environment not found'});
   else try{const {stdout}=await run(python,['-I','-c','import importlib.metadata as m;print(m.version("serena-agent"))'],{timeout:20000,windowsHide:true});const version=stdout.trim();add('serena','1.7.0',version==='1.7.0'?{state:'verified',detail:'installed '+version}:{state:'mismatch',detail:'installed '+version});}
   catch(error){add('serena','1.7.0',{state:'unavailable',detail:String(error).slice(0,300)});}}
  // Serena language servers Forge installed with Serena's pinned installers.
  {const lock=JSON.parse(readFileSync(join(scripts,'serena-analysis','languages-lock.json'),'utf8')) as {languages:Record<string,{state:string}>};
   const pinned=Object.entries(lock.languages).filter(([,v])=>v.state==='installed').map(([k])=>k).join(', ');
   if(!existsSync(serenaLanguagesHome()))add('serena-languages',pinned,{state:'missing',detail:'not installed'});
   else try{add('serena-languages',pinned,await verifyLanguagesTree());}catch(error){add('serena-languages',pinned,{state:'unavailable',detail:String(error).slice(0,300)});}}
  // Skills Manager source pinned by git commit (optional component).
  {const profile=join(homedir(),'.chatgptforge','skills-manager','profile.json');
   if(!existsSync(profile))add('skills-manager','not configured',{state:'unavailable',detail:'no profile'});
   else{const p=JSON.parse(await readFile(profile,'utf8')) as {source_dir:string;source_head:string};
     try{const head=(await run('git',['-C',p.source_dir,'rev-parse','HEAD'],{timeout:20000,windowsHide:true})).stdout.trim();
       const dirty=(await run('git',['-C',p.source_dir,'status','--porcelain','--untracked-files=no'],{timeout:20000,windowsHide:true})).stdout.trim();
       add('skills-manager',p.source_head,head===p.source_head&&!dirty?{state:'verified',detail:'clean checkout at pinned commit'}:{state:'mismatch',detail:head!==p.source_head?'HEAD '+head:'tracked files modified'});}
     catch(error){add('skills-manager',p.source_head,{state:'unavailable',detail:String(error).slice(0,300)});}}}
  const {verifyManaged}=await import('./managed-components.js');
  for(const entry of await verifyManaged())add('managed:'+entry.id,entry.version,{state:entry.state as ComponentState,detail:'detail' in entry?entry.detail??'':'Managed release file tree matches its pin; '+entry.tools+' MCP tools recorded'});
  return {ok:out.every(c=>c.state==='verified'||(c.id==='skills-manager'&&c.state==='unavailable')),components:out};
}

// Serena language servers are verified per run against languages-lock.json; a
// repair reinstall is accepted only if that check passes afterwards.
export async function verifyLanguagesTree(){
  const python=serenaPython();
  const lock=JSON.parse(readFileSync(join(scripts,'serena-analysis','languages-lock.json'),'utf8')) as {languages:Record<string,{state:string;resource_dirs?:Record<string,{sha256:string}>}>};
  const code='import json,sys,hashlib,pathlib\nroot=pathlib.Path(sys.argv[1])/"language_servers"/"static"\nout={}\nfor name in sys.argv[2:]:\n  h=hashlib.sha256();d=root/name\n  if not d.is_dir():\n    out[name]=None;continue\n  for p in sorted(x for x in d.rglob("*") if x.is_file()):\n    h.update(p.relative_to(d).as_posix().encode()+b"\\0"+hashlib.sha256(p.read_bytes()).digest())\n  out[name]=h.hexdigest()\nprint(json.dumps(out))';
  const pins=Object.values(lock.languages).flatMap(l=>l.state==='installed'?Object.entries(l.resource_dirs??{}):[]);
  const {stdout}=await run(python,['-I','-c',code,serenaLanguagesHome(),...pins.map(([n])=>n)],{timeout:300_000,windowsHide:true});
  const found=JSON.parse(stdout) as Record<string,string|null>;
  const bad=pins.filter(([n,p])=>found[n]!==p.sha256).map(([n])=>n);
  return {state:(bad.length?(Object.values(found).every(v=>v===null)?'missing':'mismatch'):'verified') as ComponentState,detail:bad.length?'differs: '+bad.join(', '):`${pins.length} language server trees match`};
}

// Offline installation from a local source that must match the pin.
export async function installComponent(id:string,from:string){
  if(id!=='serena-jdtls')throw Error('Offline install is supported for serena-jdtls; other components are installed by their package managers from pinned lock files (npm ci, uv tool install serena-agent==1.7.0) or are part of this repository');
  const {stdout}=await run(process.execPath,[join(scripts,'serena-analysis','install-java.mjs'),from],{timeout:600000,windowsHide:true});
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as unknown;
}
