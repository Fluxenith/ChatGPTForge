import {lstat,readFile,readdir} from 'node:fs/promises';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';

const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const source=/\.pyi?$/i;
const ignoredDirectories=new Set(['__pycache__','.git','.pytest_cache','.mypy_cache','.ruff_cache']);
export interface PythonDependencies {
  root:string|null;
  selection:'configured'|'auto'|'none';
  site_packages:string[];
  sources:Map<string,string>;
  opaque_sources:Map<string,Buffer>;
  snapshots:{file:string;sha256:string;bytes:number}[];
  pins:{path:string;sha256:string}[];
  inventory:string[];
  ignored_files:string[];
  typed_markers:{file:string;sha256:string;partial:boolean}[];
  marker_checks:{file:string;present:boolean}[];
  layout:{directory:string;entries:string[]}[];
  path_roots:{root:string;pth:string}[];
  path_ignored:{pth:string;line:number;reason:string}[];
}
export async function pythonDependencyPath(file:string,root:string) {
  const path=resolve(root,file);
  if(!isPathInsideRoot(path,root)||relative(root,path).split(sep).some(part=>['.git','node_modules'].includes(part.toLowerCase())))throw new Error('Python dependency path is outside the project boundary');
  let current=root;
  if((await lstat(current)).isSymbolicLink())throw new Error('Python dependencies refuse linked paths');
  for(const part of relative(root,path).split(sep).filter(Boolean)){
    current=join(current,part);
    if((await lstat(current)).isSymbolicLink())throw new Error('Python dependencies refuse linked paths');
  }
  return resolveCanonicalAllowedPath(path,root,[root]);
}
async function captured(path:string,limit:number){
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||before.size>limit)throw new Error('Python dependency file exceeds its capture boundary or is linked');
  const data=await readFile(path),after=await lstat(path);
  if(data.length>limit||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Python dependency changed during capture');
  return data;
}
export async function capturePythonDependencies(root:string,request:{explicit:boolean;root:string|null;enabled?:boolean},signal?:AbortSignal):Promise<PythonDependencies>{
  const result:PythonDependencies={root:null,selection:'none',site_packages:[],sources:new Map(),opaque_sources:new Map(),snapshots:[],pins:[],inventory:[],ignored_files:[],typed_markers:[],marker_checks:[],layout:[],path_roots:[],path_ignored:[]};
  if(request.enabled===false)return result;
  const candidates=request.explicit?[request.root!]:['.venv','venv'];
  for(const candidate of candidates){
    try{await lstat(join(root,candidate,'pyvenv.cfg'));result.marker_checks.push({file:candidate+'/pyvenv.cfg',present:true});}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&!request.explicit){result.marker_checks.push({file:candidate+'/pyvenv.cfg',present:false});continue;}throw new Error('Python virtual environment is missing pyvenv.cfg');}
    const environment=await pythonDependencyPath(candidate,root);
    if(!(await lstat(environment)).isDirectory())throw new Error('Python virtual environment requires a directory');
    const cfg=await pythonDependencyPath(join(candidate,'pyvenv.cfg'),root),data=await captured(cfg,64*1024);
    if(!Buffer.from(data.toString('utf8')).equals(data))throw new Error('Python virtual environment configuration requires UTF-8');
    result.root=relative(root,environment).replaceAll('\\','/');result.selection=request.explicit?'configured':'auto';
    result.pins.push({path:cfg,sha256:hash(data)});
    break;
  }
  if(result.root===null)return result;
  for(const directory of [result.root,join(result.root,'lib')]){
    try{
      const path=await pythonDependencyPath(directory,root);
      result.layout.push({directory:relative(root,path).replaceAll('\\','/'),entries:(await readdir(path,{withFileTypes:true})).map(entry=>entry.name+(entry.isDirectory()?'/':entry.isFile()?'':'@')).sort()});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  // Windows environments use Lib/site-packages. POSIX layouts are also readable
  // without running their interpreter or following their usual bin/python link.
  for(const folder of [join(result.root,'Lib','site-packages'),join(result.root,'lib','site-packages')]){
    try{const path=await pythonDependencyPath(folder,root);if((await lstat(path)).isDirectory())result.site_packages.push(relative(root,path).replaceAll('\\','/'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const lib=join(root,result.root,'lib');
  try{
    for(const entry of await readdir(lib,{withFileTypes:true}))if(/^python3\.\d+$/i.test(entry.name)){
      try{
        const folder=await pythonDependencyPath(join(result.root,'lib',entry.name,'site-packages'),root);
        if((await lstat(folder)).isDirectory())result.site_packages.push(relative(root,folder).replaceAll('\\','/'));
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  result.site_packages=[...new Set(result.site_packages.map(folder=>folder.toLowerCase()))].map(key=>result.site_packages.find(folder=>folder.toLowerCase()===key)!).sort();
  if(!result.site_packages.length)throw new Error('Python virtual environment has no supported site-packages directory');
  if(result.site_packages.length>8)throw new Error('Python virtual environment exceeds eight site-packages directories');
  const pthFiles:{name:string;directory:string;data:Buffer}[]=[];
  const pending=result.site_packages.map(folder=>join(root,folder));let entries=0,bytes=0,metadataBytes=0,metadataFiles=0;
  while(pending.length){
    signal?.throwIfAborted();
    const directory=pending.pop()!;await pythonDependencyPath(directory,root);
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>30000)throw new Error('Python dependency discovery exceeds 30,000 entries');
      const path=join(directory,entry.name),name=relative(root,path).replaceAll('\\','/');
      if(entry.isSymbolicLink())throw new Error('Python dependencies refuse linked paths');
      if(entry.isDirectory()){
        if(!ignoredDirectories.has(entry.name.toLowerCase())){result.inventory.push(name+'/');pending.push(path);}
      }else if(entry.isFile()){
        result.inventory.push(name);
        if(source.test(name)){
          if(result.snapshots.length>=4096)throw new Error('Python dependencies exceed 4,096 source files');
          const data=await captured(path,/\.pyi$/i.test(name)?4*1024*1024:512*1024);
          bytes+=data.length;if(bytes>64*1024*1024)throw new Error('Python dependency capture exceeds 64 MiB');
          const text=data.toString('utf8');if(Buffer.from(text).equals(data))result.sources.set(name,text);else result.opaque_sources.set(name,data);
          result.snapshots.push({file:name,sha256:hash(data),bytes:data.length});result.pins.push({path,sha256:hash(data)});
        }else if(/(?:\.pth|\.egg-link)$/i.test(name)||entry.name==='py.typed'){
          if(++metadataFiles>256)throw new Error('Python dependency metadata exceeds 256 files');
          const data=await captured(path,64*1024);metadataBytes+=data.length;
          if(metadataBytes>2*1024*1024)throw new Error('Python dependency metadata exceeds 2 MiB');
          result.pins.push({path,sha256:hash(data)});
          if(entry.name==='py.typed'){
            const text=data.toString('utf8');
            if(!Buffer.from(text).equals(data))throw new Error('Python typing marker requires UTF-8');
            result.typed_markers.push({file:name,sha256:hash(data),partial:text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/).includes('partial')});
          }
          if(/\.pth$/i.test(name))pthFiles.push({name,directory,data});
          else if(entry.name!=='py.typed')result.ignored_files.push(name);
        }else if(/\.(pyd|so|dll)$/i.test(name))result.ignored_files.push(name);
      }else throw new Error('Python dependencies contain an unsupported filesystem entry');
    }
  }
  // site.addpackage semantics without executing anything: only .pth files
  // directly in a site-packages directory count, in name order. Path lines are
  // resolved against that directory and kept when they name an existing
  // directory inside the project; import lines are code and are never run.
  for(const item of pthFiles.filter(item=>result.site_packages.some(folder=>join(root,folder).toLowerCase()===item.directory.toLowerCase())).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const text=item.data.toString('utf8');
    if(!Buffer.from(text).equals(item.data)){result.path_ignored.push({pth:item.name,line:0,reason:'not UTF-8'});continue;}
    text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/).forEach((raw,index)=>{
      const line=raw.trimEnd();
      if(!line||line.startsWith('#'))return;
      const ignore=(reason:string)=>{if(result.path_ignored.length<256)result.path_ignored.push({pth:item.name,line:index+1,reason});};
      if(/^import[ \t]/.test(line))return ignore('import line is code and is never executed');
      // Installers write absolute lines; compare canonical spellings (8.3 names).
      let target=resolve(item.directory,line);
      try{target=realpathSync.native(target);}catch(error){if(!['ENOENT','ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))throw error;}
      if(!isPathInsideRoot(target,root))return ignore('path is outside the project');
      const name=relative(root,target).replaceAll('\\','/')||'.';
      if(name.split('/').some(part=>['.git','node_modules'].includes(part.toLowerCase())))return ignore('path is inside an excluded directory');
      let present=false;
      try{const stat=lstatSync(target);if(stat.isSymbolicLink())return ignore('path is linked');if(!stat.isDirectory())return ignore('path is not a directory');present=true;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      // Presence is rechecked before durable writes, like the environment markers.
      result.marker_checks.push({file:name,present});
      if(!present)return ignore('path does not name an existing directory');
      if(result.path_roots.some(entry=>entry.root.toLowerCase()===name.toLowerCase())||result.site_packages.some(folder=>folder.toLowerCase()===name.toLowerCase()))return;
      if(result.path_roots.length>=32)throw new Error('Python .pth files add more than 32 import roots');
      result.path_roots.push({root:name,pth:item.name});
    });
  }
  result.inventory.sort();result.snapshots.sort((a,b)=>a.file.localeCompare(b.file));result.ignored_files.sort();
  result.typed_markers.sort((a,b)=>a.file.localeCompare(b.file));
  return result;
}
export function verifyPythonDependencyInventory(root:string,dependencies:PythonDependencies){
  for(const marker of dependencies.marker_checks){
    let present=false;
    try{lstatSync(join(root,marker.file));present=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(present!==marker.present)throw new Error('Python dependency environment selection changed; inspect again before rename');
  }
  for(const item of dependencies.layout){
    const path=join(root,item.directory);
    if(lstatSync(path).isSymbolicLink()||JSON.stringify(readdirSync(path,{withFileTypes:true}).map(entry=>entry.name+(entry.isDirectory()?'/':entry.isFile()?'':'@')).sort())!==JSON.stringify(item.entries))throw new Error('Python dependency environment layout changed; inspect again before rename');
  }
  const inventory:string[]=[],pending=dependencies.site_packages.map(folder=>join(root,folder));let entries=0;
  while(pending.length){
    const directory=pending.pop()!;
    if(lstatSync(directory).isSymbolicLink())throw new Error('Python dependency inventory changed to a linked directory');
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      if(++entries>30000||entry.isSymbolicLink())throw new Error('Python dependency inventory changed');
      const path=join(directory,entry.name),name=relative(root,path).replaceAll('\\','/');
      if(entry.isDirectory()){
        if(!ignoredDirectories.has(entry.name.toLowerCase())){inventory.push(name+'/');pending.push(path);}
      }else if(entry.isFile())inventory.push(name);
      else throw new Error('Python dependency inventory changed');
    }
  }
  if(JSON.stringify(inventory.sort())!==JSON.stringify(dependencies.inventory))throw new Error('Python dependency inventory changed; inspect again before rename');
}
