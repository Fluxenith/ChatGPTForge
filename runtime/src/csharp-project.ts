import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';
import type {CodeNavigationInput} from './code-navigation.js';
import {importCSharpBuild,type ImportedBuild} from './csharp-msbuild-static.js';

export const csharpHash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export interface CSharpOptions {language_version:string;nullable:'enable'|'disable'|'warnings'|'annotations';output_kind:'library'|'exe'|'winexe';allow_unsafe:boolean;defines:string[]}
export interface CSharpProject {
 root:string;sources:Map<string,string>;snapshots:{file:string;sha256:string;bytes:number}[];
 skipped_links:string[];selection?:string[];allowed_roots:string[];model_present:boolean;
 inputs:{path:string;sha256:string;bytes:number}[];references:Map<string,Buffer>;
 include_framework:boolean;options:CSharpOptions;helper_inputs?:{path:string;sha256:string}[];
 import?:ImportedBuild;
}
const excluded=new Set(['.git','node_modules','bin','obj','.vs','.idea','.cache','dist','build']);
export async function captureCSharpFile(root:string,file:string,roots:string[],limit:number,signal?:AbortSignal){
 signal?.throwIfAborted();const path=resolve(root,file);
 const boundaries=await Promise.all(roots.map(r=>realpath(r)));
 await resolveCanonicalAllowedPath(path,root,boundaries);
 const boundary=boundaries.filter(r=>isPathInsideRoot(path,r)).sort((a,b)=>b.length-a.length)[0];
 if(!boundary)throw Error('C# input is outside approved roots');
 let current=boundary;if((await lstat(current)).isSymbolicLink())throw Error('C# root is a link');
 for(const part of relative(boundary,path).split(sep).filter(Boolean)){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('C# input path contains a link');}
 if((await realpath(path)).toLowerCase()!==path.toLowerCase())throw Error('C# input path redirects');
 const first=await lstat(path);if(!first.isFile()||first.size>limit)throw Error('C# input must be a bounded regular file');
 const raw=await readFile(path),last=await lstat(path);
 if(raw.length>limit||first.size!==raw.length||first.size!==last.size||first.mtimeMs!==last.mtimeMs||first.ctimeMs!==last.ctimeMs)throw Error('C# input changed during capture');
 signal?.throwIfAborted();return {path,raw,sha256:csharpHash(raw),bytes:raw.length};
}
function utf8(raw:Buffer){const text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw Error('C# sources and model must be UTF-8');return text;}
function relativeFile(file:unknown):file is string {return typeof file==='string'&&file.length>0&&file.length<=4096&&!isAbsolute(file)&&!file.includes('\0')&&!file.split(/[\\/]/).some(p=>!p||p==='..'||p==='.');}
export async function usesCSharpNavigation(input:Pick<CodeNavigationInput,'path'|'file'|'files'>,roots:string[]){
 if(input.file)return input.file.toLowerCase().endsWith('.cs');
 if(input.files?.some(file=>file.toLowerCase().endsWith('.cs')))return true;
 const root=await resolveCanonicalAllowedPath(input.path,input.path,roots),names=await readdir(root);
 if(names.some(n=>n.toLowerCase()==='forge.csharp.json'))return true;
 if(names.some(n=>['tsconfig.json','jsconfig.json','pyproject.toml','go.mod','pom.xml','build.gradle'].includes(n.toLowerCase())))return false;
 return names.some(n=>/\.(?:cs|csproj|sln|slnx)$/i.test(n));
}
export async function loadCSharpProject(input:Pick<CodeNavigationInput,'path'|'files'>,roots:string[],signal?:AbortSignal):Promise<CSharpProject>{
 const root=await realpath(await resolveCanonicalAllowedPath(input.path,input.path,roots));
 if(!(await lstat(root)).isDirectory())throw Error('Expected a C# project directory');
 const project:CSharpProject={root,sources:new Map(),snapshots:[],skipped_links:[],allowed_roots:[...roots],model_present:false,inputs:[],references:new Map(),include_framework:true,options:{language_version:'14',nullable:'enable',output_kind:'library',allow_unsafe:false,defines:[]},...(input.files?{selection:[...input.files]}:{})};
 let configuredSources:string[]|undefined;
 const modelStat=await lstat(join(root,'forge.csharp.json')).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;});
 if(modelStat){
  const captured=await captureCSharpFile(root,'forge.csharp.json',[root],256*1024,signal);
  const model=JSON.parse(utf8(captured.raw).replace(/^\uFEFF/,''));
  if(!model||model.version!==1||Object.keys(model).some(k=>!['version','sources','references','build_inputs','include_framework','options'].includes(k))||!Array.isArray(model.references)||model.references.length>256)throw Error('Invalid C# project model');
  project.model_present=true;project.inputs.push({path:captured.path,sha256:captured.sha256,bytes:captured.bytes});
  if(model.sources!==undefined){if(!Array.isArray(model.sources)||model.sources.length>2048||model.sources.some((f:unknown)=>!relativeFile(f)||extname(f).toLowerCase()!=='.cs'))throw Error('Invalid C# source model');configuredSources=model.sources;}
  if(model.include_framework!==undefined){if(typeof model.include_framework!=='boolean')throw Error('Invalid C# framework option');project.include_framework=model.include_framework;}
  if(model.options!==undefined){
   const o=model.options;if(!o||Object.keys(o).some(k=>!['language_version','nullable','output_kind','allow_unsafe','defines'].includes(k)))throw Error('Invalid C# compiler options');
   if(o.language_version!==undefined){if(typeof o.language_version!=='string'||! /^(?:[1-9]|1[0-4])(?:\.0)?$/.test(o.language_version))throw Error('Unsupported C# language version');project.options.language_version=o.language_version;}
   if(o.nullable!==undefined){if(!['enable','disable','warnings','annotations'].includes(o.nullable))throw Error('Invalid C# nullable option');project.options.nullable=o.nullable;}
   if(o.output_kind!==undefined){if(!['library','exe','winexe'].includes(o.output_kind))throw Error('Invalid C# output option');project.options.output_kind=o.output_kind;}
   if(o.allow_unsafe!==undefined){if(typeof o.allow_unsafe!=='boolean')throw Error('Invalid C# unsafe option');project.options.allow_unsafe=o.allow_unsafe;}
   if(o.defines!==undefined){if(!Array.isArray(o.defines)||o.defines.length>128||o.defines.some((d:unknown)=>typeof d!=='string'||! /^(?:\p{L}|_)[\p{L}\p{N}_]{0,127}$/u.test(d))||new Set(o.defines).size!==o.defines.length)throw Error('Invalid C# preprocessor symbols');project.options.defines=o.defines;}
  }
  if(model.build_inputs!==undefined){
   if(!Array.isArray(model.build_inputs)||model.build_inputs.length>256)throw Error('Invalid C# build input pins');
   for(const pin of model.build_inputs){if(!pin||!relativeFile(pin.path)||typeof pin.sha256!=='string'||! /^[a-f0-9]{64}$/.test(pin.sha256))throw Error('Invalid C# build input pin');
    const data=await captureCSharpFile(root,pin.path,[root],4*1024*1024,signal);if(data.sha256!==pin.sha256)throw Error('C# build input changed since export');project.inputs.push({path:data.path,sha256:data.sha256,bytes:data.bytes});
   }
  }
  let referenceBytes=0;const seen=new Set<string>();
  for(const ref of model.references){if(typeof ref!=='string'||!ref||ref.length>4096||ref.includes('\0')||extname(ref).toLowerCase()!=='.dll')throw Error('C# references must be DLL paths');
   const data=await captureCSharpFile(root,ref,roots,32*1024*1024,signal),key=data.path.toLowerCase();
   if(seen.has(key))throw Error('Duplicate C# reference');seen.add(key);if((referenceBytes+=data.bytes)>128*1024*1024)throw Error('C# references exceed 128 MiB');
   project.inputs.push({path:data.path,sha256:data.sha256,bytes:data.bytes});project.references.set(data.path,data.raw);
  }
 }
 let total=0,visited=0;const seen=new Set<string>();
 const add=async(file:string)=>{
  if(!relativeFile(file)||extname(file).toLowerCase()!=='.cs')throw Error('C# selection accepts only relative .cs sources');
  const data=await captureCSharpFile(root,file,[root],512*1024,signal),name=relative(root,data.path).replaceAll('\\','/'),key=name.toLowerCase();
  if(seen.has(key))throw Error('Duplicate C# source');seen.add(key);
  if(project.snapshots.length>=(input.files?64:2048)||(total+=data.bytes)>(input.files?2:32)*1024*1024)throw Error('C# source capture exceeds bounds');
  project.sources.set(name,utf8(data.raw));project.snapshots.push({file:name,sha256:data.sha256,bytes:data.bytes});
 };
 if(input.files||configuredSources){const files=input.files??configuredSources!;if(input.files&&input.files.length>64)throw Error('C# explicit file list exceeds 64');for(const file of files)await add(file);}
 else if(!project.model_present&&(project.import=await importCSharpBuild(root,signal))){
  // Static SDK-style import: exactly the evaluated Compile items of each project.
  project.inputs.push(...project.import.inputs);
  for(const p of project.import.projects)for(const file of p.sources)await add(file);
 }
 else{
  const pending=[root];while(pending.length){signal?.throwIfAborted();const directory=pending.pop()!;
   for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(++visited>20000)throw Error('C# discovery exceeds entry limit');const path=join(directory,entry.name),file=relative(root,path).replaceAll('\\','/');
    if(entry.isSymbolicLink()){project.skipped_links.push(file);continue;}
    if(entry.isDirectory()&&!excluded.has(entry.name.toLowerCase()))pending.push(path);
    else if(entry.isFile()&&/\.(?:csproj|sln|slnx)$/i.test(entry.name)&&!project.model_present)throw Error('C# build project below the root needs a root .sln/.slnx or .csproj for static import, or an exported forge.csharp.json; navigation does not execute MSBuild');
    else if(entry.isFile()&&extname(entry.name).toLowerCase()==='.cs')await add(file);
   }
  }
 }
 if(!project.sources.size)throw Error('No C# sources selected or discovered');
 project.snapshots.sort((a,b)=>a.file.localeCompare(b.file));project.skipped_links.sort();
 return project;
}
export function csharpProjectPins(project:CSharpProject){return {sources:project.snapshots,skipped_links:project.skipped_links,inputs:project.inputs,include_framework:project.include_framework,options:project.options,...(project.import?{import:project.import.projects}:{})};}
export async function verifyCSharpEnvironment(project:CSharpProject,signal?:AbortSignal){
 const fresh=await loadCSharpProject({path:project.root,files:project.selection},project.allowed_roots,signal);
 if(JSON.stringify(csharpProjectPins(fresh))!==JSON.stringify(csharpProjectPins(project)))throw Error('C# source inventory or compiler environment changed since capture');
 for(const pin of project.helper_inputs??[]){signal?.throwIfAborted();if(csharpHash(await readFile(pin.path))!==pin.sha256)throw Error('C# toolchain or helper changed since capture');}
}
