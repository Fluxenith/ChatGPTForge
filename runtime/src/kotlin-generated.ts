import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute,sep,resolve} from 'node:path';
import {kotlinInputHash} from './kotlin-model-inputs.js';
import {readFileSync} from 'node:fs';

export async function captureKotlinRoots(project:string,sourceRoots:string[],generatedRoots:string[],initial:Map<string,Buffer>,prefix:string){
 const additions=new Map<string,Buffer>(),hashes:Record<string,string>={},origins:Record<string,string>={},roots:string[]=[];let bytes=0,entries=0;
 const within=(p:string)=>{const r=relative(project,p);if(!r||isAbsolute(r)||r==='..'||r.startsWith('..'+sep))throw Error('Generated source root must be inside captured project');return r.split(sep).join('/');};
 const declared=new Set(generatedRoots.map(p=>resolve(p).toLowerCase()));
 for(const [index,input]of sourceRoots.entries()){
  const full=resolve(input),rel=within(full);if((await realpath(full)).toLowerCase()!==full.toLowerCase())throw Error('Linked source root is not supported');
  const generated=declared.has(full.toLowerCase());let originalCount=0,generatedCount=0;
  const cacheRoot=prefix+'/generated/'+index;
  const walk=async(dir:string)=>{for(const name of (await readdir(dir)).sort()){
   if(++entries>10000)throw Error('Generated source tree exceeds 10000 entries');
   const file=join(dir,name),info=await lstat(file);if(info.isSymbolicLink())throw Error('Generated source contains a link');
   if(info.isDirectory()){await walk(file);continue;}if(!/\.(java|kt)$/.test(name))continue;
   if(!info.isFile()||info.size>4*1024*1024)throw Error('Invalid generated source file');
   const path=within(file),data=await readFile(file),before=initial.get(path);
   if(!generated&&before){if(!before.equals(data))throw Error('Build changed authored source: '+path);originalCount++;continue;}
   bytes+=data.length;if(bytes>32*1024*1024||additions.size>=4000)throw Error('Generated sources exceed 4000 files / 32 MiB');
   const text=data.toString('utf8');if(!Buffer.from(text).equals(data))throw Error('Generated sources must be UTF-8');
   const dest=cacheRoot+'/'+relative(full,file).split(sep).join('/');additions.set(dest,data);hashes[dest]=kotlinInputHash(data);origins[dest]=path;generatedCount++;
  }};
  await walk(full);if(originalCount)roots.push(rel);if(generatedCount)roots.push(cacheRoot);
 }
 return {roots,additions,hashes,origins};
}

export function kotlinModelFiles(files:Map<string,Buffer>){
 const raw=files.get('.forge/kotlin-workspace.json');const spec=raw?JSON.parse(raw.toString()):{};
 const generated=new Set<string>(Object.keys(spec.generated_hashes??{}));
 const origins=new Set<string>(Object.values(spec.generated_origins??{}) as string[]);
 const active=new Set([...generated,...Object.keys(spec.library_hashes??{}),...(spec.modules??[]).flatMap((m:any)=>m.libraries??[])]);
 return {generated,origins,copied:(p:string)=>!origins.has(p)&&(!p.startsWith('.forge/kotlin-import/')||active.has(p))};
}
export function assertKotlinWritable(files:Map<string,Buffer>,paths:string[]){
 const {origins}=kotlinModelFiles(files);
 const generated=new Set([...origins].map(p=>p.toLowerCase()));
 if(paths.some(p=>p.toLowerCase().startsWith('.forge/kotlin-import/')||generated.has(p.toLowerCase())))throw Error('Generated Kotlin/JVM sources are read-only; change their generator and re-import; nothing applied');
}
// Fence every semantic transaction, including Java and caller-supplied planners.
// Generic explicit file editing remains available; invalidated snapshots then fail hashes.
export function assertKotlinTaskWritable(root:string,paths:string[]){
 const files=new Map<string,Buffer>();
 try{files.set('.forge/kotlin-workspace.json',readFileSync(join(root,'.forge/kotlin-workspace.json')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 assertKotlinWritable(files,paths.map(p=>relative(root,resolve(root,p)).split(sep).join('/')));
}
