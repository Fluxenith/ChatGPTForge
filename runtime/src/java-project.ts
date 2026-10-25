import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {extname,join,relative,resolve,sep} from 'node:path';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';
import type {CodeNavigationInput} from './code-navigation.js';
import {loadJavaClasspath,javaClasspathPins,type JavaClasspath} from './java-classpath.js';

export const javaHash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const excluded=new Set(['.git','.gradle','.m2','.idea','.settings','node_modules','target','build',
  'out','dist','.venv','venv','.cache']);
export interface JavaProject {
  root:string;
  sources:Map<string,string>;
  snapshots:{file:string;sha256:string;bytes:number}[];
  skipped_links:string[];
  selection?:string[];
  helper_inputs?:{path:string,sha256:string}[];
  classpath:JavaClasspath;
  allowed_roots:string[];
}

async function safePath(root:string,file:string) {
  const path=resolve(root,file);
  if(!isPathInsideRoot(path,root))throw new Error('Java source is outside allowed roots');
  let current=root;
  if((await lstat(root)).isSymbolicLink())throw new Error('Java source root is a link');
  for(const part of relative(root,path).split(sep).filter(Boolean)){
    current=join(current,part);
    if((await lstat(current)).isSymbolicLink())throw new Error('Java source path contains a link');
  }
  const canonical=await realpath(path);
  if(canonical.toLowerCase()!==path.toLowerCase())throw new Error('Java source path changed or redirects');
  return path;
}

async function safeSource(root:string,file:string,signal?:AbortSignal) {
  signal?.throwIfAborted();
  if(extname(file).toLowerCase()!=='.java')throw new Error('Java selection accepts only .java sources');
  const path=await safePath(root,file);
  const first=await lstat(path);
  if(!first.isFile()||first.size>512*1024)throw new Error('Java source must be a regular file of at most 512 KiB');
  const raw=await readFile(path),last=await lstat(path);
  if(raw.length>512*1024||first.mtimeMs!==last.mtimeMs||first.ctimeMs!==last.ctimeMs||
     first.size!==last.size)throw new Error('Java source changed during capture');
  const value=raw.toString('utf8');
  if(!Buffer.from(value).equals(raw))throw new Error('Java sources must be valid UTF-8');
  signal?.throwIfAborted();
  return {value,bytes:raw.length,sha256:javaHash(raw)};
}

export async function usesJavaNavigation(input:Pick<CodeNavigationInput,'path'|'file'|'files'>,
                                         roots:string[]) {
  if(input.file)return input.file.toLowerCase().endsWith('.java');
  if(input.files?.some(file=>file.toLowerCase().endsWith('.java')))return true;
  const root=await resolveCanonicalAllowedPath(input.path,input.path,roots);
  const names=new Set((await readdir(root)).map(item=>item.toLowerCase()));
  if(['tsconfig.json','jsconfig.json','pyproject.toml','setup.py','setup.cfg',
      'pyrightconfig.json','go.mod','go.work'].some(name=>names.has(name)))return false;
  return ['pom.xml','build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts']
    .some(name=>names.has(name)) || [...names].some(name=>name.endsWith('.java'));
}

export async function loadJavaProject(input:Pick<CodeNavigationInput,'path'|'files'>,
                                      roots:string[],signal?:AbortSignal):Promise<JavaProject> {
  const root=await realpath(await resolveCanonicalAllowedPath(input.path,input.path,roots));
  if(!(await lstat(root)).isDirectory())throw new Error('Expected a Java project directory');
  const sources=new Map<string,string>(),snapshots:JavaProject['snapshots']=[],skipped_links:string[]=[];
  let total=0,visited=0;
  const add=async(file:string)=>{
    signal?.throwIfAborted();
    const {value,bytes,sha256}=await safeSource(root,file,signal);
    const path=relative(root,resolve(root,file)).replaceAll('\\','/');
    if(sources.has(path))return;
    if(snapshots.length>=(input.files?64:2048))throw new Error('Java source capture exceeds file count limit');
    total+=bytes;
    if(total>(input.files?2:32)*1024*1024)throw new Error('Java source capture exceeds byte limit');
    sources.set(path,value);snapshots.push({file:path,sha256,bytes});
  };
  if(input.files){
    if(input.files.length>64)throw new Error('Java explicit file list exceeds 64');
    for(const file of input.files)await add(file);
  }else{
    const pending=[root];
    while(pending.length){
      signal?.throwIfAborted();
      const directory=pending.pop()!;
      const entries=await readdir(directory,{withFileTypes:true});
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of entries){
        if(++visited>20000)throw new Error('Java project discovery exceeds entry limit');
        const path=join(directory,entry.name),file=relative(root,path).replaceAll('\\','/');
        if(entry.isSymbolicLink()){skipped_links.push(file);continue;}
        if(entry.isDirectory()){
          if(!excluded.has(entry.name.toLowerCase()))pending.push(path);
        }else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.java')){
          await add(file);
        }
      }
    }
  }
  if(!sources.size)throw new Error('No Java sources selected or discovered');
  snapshots.sort((a,b)=>a.file.localeCompare(b.file));
  skipped_links.sort();
  const classpath=await loadJavaClasspath(root,roots,signal);
  return {root,sources,snapshots,skipped_links,classpath,allowed_roots:[...roots],...(input.files?{selection:[...input.files]}:{})};
}

export async function verifyJavaEnvironment(project:JavaProject,signal?:AbortSignal){
  signal?.throwIfAborted();
  const fresh=await loadJavaProject({path:project.root,files:project.selection},project.allowed_roots,signal);
  if(JSON.stringify(fresh.snapshots)!==JSON.stringify(project.snapshots)||JSON.stringify(fresh.skipped_links)!==JSON.stringify(project.skipped_links))throw Error('Java source inventory or contents changed since analysis');
  if(JSON.stringify(javaClasspathPins(fresh.classpath))!==JSON.stringify(javaClasspathPins(project.classpath)))throw Error('Java classpath environment changed since analysis');
  for(const input of project.helper_inputs??[]){signal?.throwIfAborted();if(javaHash(await readFile(input.path))!==input.sha256)throw Error('Java analysis helper changed since capture');}
}
