import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';
import {validateJavaJar} from './java-archive.js';
export {validateJavaJar} from './java-archive.js';
import {captureJavaSourceArchive,type JavaArchiveSource} from './java-source-archive.js';
import {importMaven} from './java-maven-static.js';
import {importGradle} from './java-gradle-static.js';

const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export interface JavaClasspath {
  model_present:boolean;
  inputs:{path:string;sha256:string;bytes:number}[];
  entries:{path:string;kind:'jar'|'classes';files:{path:string;sha256:string;bytes:number}[]}[];
  contents:Map<string,Buffer>;
  source_archives:{classpath_index:number;path:string;sha256:string;bytes:number;sources:JavaArchiveSource[]}[];
  source_contents:Map<string,Buffer>;
  maven?:{state:'imported';build:'maven'|'gradle';repository:string;release?:string;projects?:string[];artifacts:{group:string;artifact:string;version:string;scope:string;depth:number}[]}|{state:'skipped';reason:string};
}
const MAX_BYTES=128*1024*1024,MAX_FILES=10000;

async function checkedPath(root:string,file:string,roots:string[]){
  const candidate=resolve(root,file),allowed=await Promise.all(roots.map(r=>realpath(r)));
  await resolveCanonicalAllowedPath(candidate,root,allowed);
  const boundary=allowed.filter(r=>isPathInsideRoot(candidate,r)).sort((a,b)=>b.length-a.length)[0];
  if(!boundary)throw Error('Java classpath is outside approved roots');
  let current=boundary;
  if((await lstat(current)).isSymbolicLink())throw Error('Java classpath root is a link');
  for(const part of relative(boundary,candidate).split(sep).filter(Boolean)){
    current=join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('Java classpath path contains a link');
  }
  if((await realpath(candidate)).toLowerCase()!==candidate.toLowerCase())throw Error('Java classpath path changed or redirects');
  return candidate;
}
async function capture(root:string,file:string,roots:string[],limit:number,signal?:AbortSignal){
  signal?.throwIfAborted();const path=await checkedPath(root,file,roots),first=await lstat(path);
  if(!first.isFile()||first.size>limit)throw Error('Java classpath input must be a bounded regular file');
  const raw=await readFile(path),last=await lstat(path);await checkedPath(root,file,roots);
  if(raw.length>limit||raw.length!==first.size||first.size!==last.size||first.mtimeMs!==last.mtimeMs||first.ctimeMs!==last.ctimeMs)throw Error('Java classpath input changed during capture');
  signal?.throwIfAborted();return {path,raw,sha256:hash(raw),bytes:raw.length};
}

// Explicit build output is the authority for dependency order. Do not infer a
// Gradle program or execute build logic inside a read-only navigation request.
export async function loadJavaClasspath(root:string,roots:string[],signal?:AbortSignal):Promise<JavaClasspath>{
  const result:JavaClasspath={model_present:false,inputs:[],entries:[],contents:new Map(),source_archives:[],source_contents:new Map()};
  const model='forge.java.json',stat=await lstat(join(root,model)).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
  if(!stat){
    // Without an exported model, a root pom.xml is imported statically when its
    // whole dependency graph resolves from an approved local repository.
    // Otherwise behavior stays as before (sources only) with the reason reported.
    const exists=(name:string)=>lstat(join(root,name)).then(()=>true,()=>false);
    const gradle=!(await exists('pom.xml'))&&(await Promise.all(['settings.gradle','settings.gradle.kts','build.gradle','build.gradle.kts'].map(exists))).some(Boolean);
    if(!(await exists('pom.xml'))&&!gradle)return result;
    const pom=gradle?undefined:await capture(root,'pom.xml',[root],1024*1024,signal);if(pom)result.inputs.push({path:pom.path,sha256:pom.sha256,bytes:pom.bytes});
    try{
      const imported=gradle?await importGradle(root,roots,signal):await importMaven(root,pom!.raw,roots,signal);
      result.inputs.push(...imported.inputs.filter(i=>!imported.jars.has(i.path)));
      for(const a of imported.artifacts){const raw=imported.jars.get(a.path)!;result.entries.push({path:a.path,kind:'jar',files:[{path:'',sha256:hash(raw),bytes:raw.length}]});result.contents.set(a.path,raw);}
      result.maven={state:'imported',build:gradle?'gradle':'maven',repository:imported.repository,...(imported.release?{release:imported.release}:{}),...('projects' in imported?{projects:(imported as {projects:string[]}).projects}:{}),artifacts:imported.artifacts.map(({group,artifact,version,scope,depth})=>({group,artifact,version,scope,depth}))};
    }catch(error){
      if(signal?.aborted)throw error;
      result.maven={state:'skipped',reason:error instanceof Error?error.message:String(error)};
    }
    return result;
  }
  const config=await capture(root,model,[root],256*1024,signal);result.model_present=true;
  if(!Buffer.from(config.raw.toString('utf8')).equals(config.raw))throw Error('Java classpath model must be UTF-8');
  const value=JSON.parse(config.raw.toString('utf8').replace(/^\uFEFF/,''));
  if(!value||value.version!==1||Object.keys(value).some(k=>!['version','classpath','build_inputs','source_archives'].includes(k))||!Array.isArray(value.classpath)||value.classpath.length>256||value.classpath.some((p:unknown)=>typeof p!=='string'||!p||p.length>4096||p.includes('\0')))throw Error('Invalid Java classpath model');
  result.inputs.push({path:config.path,sha256:config.sha256,bytes:config.bytes});
  if(value.build_inputs!==undefined){
    if(!Array.isArray(value.build_inputs)||value.build_inputs.length>256)throw Error('Invalid Java build input pins');
    const seen=new Set<string>();
    for(const pin of value.build_inputs){
      if(!pin||typeof pin.path!=='string'||isAbsolute(pin.path)||pin.path.split(/[\\/]/).some((p:string)=>!p||p==='..'||p==='.')||typeof pin.sha256!=='string'||!/^[a-f0-9]{64}$/.test(pin.sha256)||seen.has(pin.path))throw Error('Invalid Java build input pin');
      seen.add(pin.path);const data=await capture(root,pin.path,[root],4*1024*1024,signal);
      if(data.sha256!==pin.sha256)throw Error('Java build inputs changed since classpath export; rebuild and export the environment again');
      result.inputs.push({path:data.path,sha256:data.sha256,bytes:data.bytes});
    }
  }
  let bytes=0,count=0,visited=0;const paths=new Set<string>();
  for(const entry of value.classpath){
    signal?.throwIfAborted();const path=await checkedPath(root,entry,roots),key=process.platform==='win32'?path.toLowerCase():path;
    if(paths.has(key))throw Error('Duplicate Java classpath entry');paths.add(key);
    const stat=await lstat(path),kind=stat.isDirectory()?'classes':'jar';
    if(kind==='jar'&&extname(path).toLowerCase()!=='.jar')throw Error('Java classpath accepts JAR files or class directories');
    const files:JavaClasspath['entries'][number]['files']=[];
    const add=async(file:string)=>{
      if(++count>MAX_FILES)throw Error('Java classpath exceeds 10000 files');
      const data=await capture(root,file,roots,kind==='jar'?32*1024*1024:4*1024*1024,signal);
      if(kind==='jar')validateJavaJar(data.raw);
      if((bytes+=data.bytes)>MAX_BYTES)throw Error('Java classpath exceeds 128 MiB');
      const child=kind==='jar'?'':relative(path,data.path).replaceAll('\\','/');
      files.push({path:child,sha256:data.sha256,bytes:data.bytes});result.contents.set(data.path,data.raw);
    };
    if(kind==='jar')await add(path);
    else{
      const pending=[path];
      while(pending.length){
        signal?.throwIfAborted();const directory=pending.pop()!;await checkedPath(root,directory,roots);
        const children=await readdir(directory,{withFileTypes:true});children.sort((a,b)=>a.name.localeCompare(b.name));
        for(const child of children){
          if(++visited>20000)throw Error('Java classpath directory exceeds entry limit');
          const file=join(directory,child.name);
          if(child.isSymbolicLink())throw Error('Java classpath directory contains a link');
          if(child.isDirectory())pending.push(file);
          else if(child.isFile()&&child.name.endsWith('.class'))await add(file);
          else if(!child.isFile())throw Error('Java classpath directory contains a special file');
        }
      }
      files.sort((a,b)=>a.path.localeCompare(b.path));
    }
    result.entries.push({path,kind,files});
  }
  if(value.source_archives!==undefined){
    if(!Array.isArray(value.source_archives)||value.source_archives.length>256)throw Error('Invalid Java source archive associations');
    const indices=new Set<number>();let rawBytes=0,sourceBytes=0,sourceCount=0;
    const captured=new Map<string,Awaited<ReturnType<typeof captureJavaSourceArchive>>>();
    for(const item of value.source_archives){
      signal?.throwIfAborted();
      if(!item||Object.keys(item).some(k=>!['classpath_index','path'].includes(k))||!Number.isSafeInteger(item.classpath_index)||item.classpath_index<0||item.classpath_index>=result.entries.length||indices.has(item.classpath_index)||typeof item.path!=='string'||!item.path||item.path.length>4096||item.path.includes('\0')||extname(item.path).toLowerCase()!=='.jar')throw Error('Invalid Java source archive association');
      indices.add(item.classpath_index);
      const path=await checkedPath(root,item.path,roots),key=process.platform==='win32'?path.toLowerCase():path;
      let archive=captured.get(key);
      if(!archive){
        archive=await captureJavaSourceArchive(root,item.path,roots,signal);captured.set(key,archive);
        rawBytes+=archive.bytes;sourceBytes+=archive.sources.reduce((n,s)=>n+s.bytes,0);sourceCount+=archive.sources.length;
        if(rawBytes>128*1024*1024||sourceBytes>64*1024*1024||sourceCount>4096)throw Error('Java attached source archives exceed aggregate bounds');
        result.source_contents.set(archive.path,archive.raw);
      }
      result.source_archives.push({classpath_index:item.classpath_index,path:archive.path,sha256:archive.sha256,bytes:archive.bytes,sources:archive.sources});
    }
    result.source_archives.sort((a,b)=>a.classpath_index-b.classpath_index);
  }
  return result;
}
export function javaClasspathPins(value:JavaClasspath){return {model_present:value.model_present,...(value.maven?{maven:value.maven}:{}),inputs:value.inputs,entries:value.entries,source_archives:value.source_archives.map(({sources,...archive})=>({...archive,sources:sources.map(({content,...pin})=>pin)}))};}
