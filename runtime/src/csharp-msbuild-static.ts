import {lstat,readdir} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,parse as parsePath} from 'node:path';
import {captureCSharpFile} from './csharp-project.js';
import {isPathInsideRoot} from './roots.js';

// Static import of a strict subset of SDK-style .NET 10 projects. MSBuild is never
// evaluated or executed: anything whose meaning depends on MSBuild logic (imports,
// conditions, targets, packages, Directory.Build.* files, unknown properties) is
// refused instead of approximated. Values were checked against the pinned SDK's
// own csc command line (artifacts/csharp-project-import-v1/sdk-oracle.json).
export const SDK_DEFINES=['TRACE','DEBUG','NET','NET10_0','NETCOREAPP',...[5,6,7,8,9,10].map(v=>`NET${v}_0_OR_GREATER`),...['1_0','1_1','2_0','2_1','2_2','3_0','3_1'].map(v=>`NETCOREAPP${v}_OR_GREATER`)];
export const IMPLICIT_USINGS=['System','System.Collections.Generic','System.IO','System.Linq','System.Net.Http','System.Threading','System.Threading.Tasks'];
export interface ImportedOptions {language_version:string;nullable:'enable'|'disable'|'warnings'|'annotations';output_kind:'library'|'exe'|'winexe';allow_unsafe:boolean;defines:string[]}
export interface ImportedProject {name:string;assembly_name:string;file:string;sources:string[];options:ImportedOptions;project_references:string[];global_usings:string[]}
export interface ImportedBuild {kind:'sdk_static';solution?:string;projects:ImportedProject[];inputs:{path:string;sha256:string;bytes:number}[]}

interface XmlNode {name:string;attrs:Record<string,string>;children:XmlNode[];text:string}
const ENTITIES:Record<string,string>={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};
const decode=(s:string)=>s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi,(_,e:string)=>{
 if(e[0]==='#')return String.fromCodePoint(e[1]?.toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10));
 const v=ENTITIES[e];if(v===undefined)throw Error('Unsupported XML entity in C# project');return v;});
// Minimal well-formed XML subset: elements, attributes, text, comments and an
// optional declaration. DOCTYPE, CDATA and processing instructions are refused.
export function parseXml(text:string):XmlNode {
 let i=0;const s=text.replace(/^\uFEFF/,'');
 const ws=()=>{while(i<s.length&&/\s/.test(s[i]!))i++;};
 const skip=()=>{for(;;){ws();if(s.startsWith('<!--',i)){const end=s.indexOf('-->',i+4);if(end<0)throw Error('Unterminated XML comment');i=end+3;}else if(s.startsWith('<?xml',i)&&i<=1){const end=s.indexOf('?>',i);if(end<0)throw Error('Bad XML declaration');i=end+2;}else return;}};
 const name=()=>{const m=/^[A-Za-z_][\w.-]*/.exec(s.slice(i));if(!m)throw Error('Invalid XML name in C# project');i+=m[0].length;return m[0];};
 const element=():XmlNode=>{
  if(s[i]!=='<')throw Error('Expected XML element');i++;const node:XmlNode={name:name(),attrs:{},children:[],text:''};
  for(;;){ws();if(s.startsWith('/>',i)){i+=2;return node;}if(s[i]==='>'){i++;break;}
   const key=name();ws();if(s[i]!=='=')throw Error('Invalid XML attribute');i++;ws();const q=s[i];if(q!=='"'&&q!=="'")throw Error('Invalid XML attribute quote');
   const end=s.indexOf(q,i+1);if(end<0)throw Error('Unterminated XML attribute');if(key in node.attrs)throw Error('Duplicate XML attribute');node.attrs[key]=decode(s.slice(i+1,end));i=end+1;}
  for(;;){
   if(s.startsWith('<!--',i)){const end=s.indexOf('-->',i+4);if(end<0)throw Error('Unterminated XML comment');i=end+3;continue;}
   if(s.startsWith('<![CDATA[',i)||s.startsWith('<!',i)||s.startsWith('<?',i))throw Error('Unsupported XML construct in C# project');
   if(s.startsWith('</',i)){i+=2;if(name()!==node.name)throw Error('Mismatched XML end tag');ws();if(s[i]!=='>')throw Error('Bad XML end tag');i++;return node;}
   if(s[i]==='<'){node.children.push(element());continue;}
   const next=s.indexOf('<',i);if(next<0)throw Error('Unterminated XML element');node.text+=decode(s.slice(i,next));i=next;
  }
 };
 skip();const root=element();skip();if(i!==s.length)throw Error('Trailing content after XML root');return root;
}

const IGNORED=new Set(['RootNamespace','Version','VersionPrefix','VersionSuffix','Authors','Company','Product','Description','Copyright','IsPackable','GenerateDocumentationFile','TreatWarningsAsErrors','NoWarn','WarningLevel','InvariantGlobalization','Deterministic','EnableDefaultCompileItems']);
const SUPPORTED=new Set(['TargetFramework','OutputType','LangVersion','Nullable','AllowUnsafeBlocks','DefineConstants','ImplicitUsings','AssemblyName',...IGNORED]);
const IGNORED_ITEMS=new Set(['None','Content','EmbeddedResource']);
const pattern=(value:string)=>{if(!value||value.length>1024||/[$@%;]|\0/.test(value)||isAbsolute(value)||/^[a-z]:/i.test(value))throw Error('Unsupported C# project item path: '+value);return value.replaceAll('\\','/');};
const segment=(p:string)=>new RegExp('^'+p.split('').map(c=>c==='*'?'[^/]*':c==='?'?'[^/]':c.replace(/[.+^${}()|[\]\\]/g,'\\$&')).join('')+'$','i');
// MSBuild-style glob over project-relative paths: **, * and ? (case-insensitive).
export function globMatch(glob:string,path:string):boolean {
 const g=glob.split('/'),p=path.split('/');
 const go=(a:number,b:number):boolean=>{if(a===g.length)return b===p.length;if(g[a]==='**'){for(let k=b;k<=p.length;k++)if(go(a+1,k))return true;return false;}return b<p.length&&segment(g[a]!).test(p[b]!)&&go(a+1,b+1);};
 return go(0,0);
}

async function walkCs(dir:string,signal?:AbortSignal){
 const out:string[]=[];let visited=0;const pending=[''];
 while(pending.length){signal?.throwIfAborted();const rel=pending.pop()!;
  for(const e of await readdir(join(dir,rel),{withFileTypes:true})){if(++visited>20000)throw Error('C# project discovery exceeds entry limit');
   const child=rel?rel+'/'+e.name:e.name;
   if(e.isSymbolicLink())throw Error('C# project contains a link: '+child);
   if(e.isDirectory()){if(!rel&&/^(bin|obj)$/i.test(e.name))continue;if(e.name.startsWith('.'))continue;pending.push(child);}
   else if(e.isFile()&&extname(e.name).toLowerCase()==='.cs')out.push(child);
  }}
 return out.sort();
}

async function refuseDirectoryBuildFiles(dir:string){
 // MSBuild implicitly imports these from the project directory or any ancestor.
 for(let current=dir;;){
  for(const name of ['Directory.Build.props','Directory.Build.targets','Directory.Build.rsp','Directory.Packages.props'])
   if(await lstat(join(current,name)).then(()=>true,()=>false))throw Error(`C# project import refuses ${join(current,name)}; MSBuild imports it implicitly. Export forge.csharp.json instead.`);
  const parent=dirname(current);if(parent===current||current===parsePath(current).root)return;current=parent;
 }
}

async function importProject(root:string,file:string,inputs:ImportedBuild['inputs'],signal?:AbortSignal):Promise<ImportedProject>{
 const captured=await captureCSharpFile(root,file,[root],1024*1024,signal);inputs.push({path:captured.path,sha256:captured.sha256,bytes:captured.bytes});
 const text=captured.raw.toString('utf8');if(!Buffer.from(text).equals(captured.raw))throw Error('C# project file must be UTF-8');
 const xml=parseXml(text),dir=dirname(captured.path),projectRel=relative(root,dir).replaceAll('\\','/');
 if(xml.name!=='Project'||Object.keys(xml.attrs).join()!=='Sdk'||xml.attrs.Sdk!=='Microsoft.NET.Sdk')throw Error(`${file}: only <Project Sdk="Microsoft.NET.Sdk"> is supported by static import`);
 await refuseDirectoryBuildFiles(dir);
 const props=new Map<string,string>(),items:{kind:string;op:'Include'|'Remove';value:string}[]=[];
 for(const group of xml.children){
  if(!['PropertyGroup','ItemGroup'].includes(group.name))throw Error(`${file}: <${group.name}> needs MSBuild evaluation; export forge.csharp.json`);
  if(Object.keys(group.attrs).length)throw Error(`${file}: conditional or labelled groups need MSBuild evaluation; export forge.csharp.json`);
  if(group.name==='PropertyGroup'){for(const p of group.children){
   if(Object.keys(p.attrs).length||p.children.length||!SUPPORTED.has(p.name))throw Error(`${file}: unsupported property ${p.name}; export forge.csharp.json`);
   const value=p.text.trim();if(p.name!=='DefineConstants'&&value.includes('$('))throw Error(`${file}: property ${p.name} uses MSBuild expansion`);props.set(p.name,value);}}
  else if(group.name==='ItemGroup'){for(const it of group.children){
   if(it.children.length)throw Error(`${file}: item metadata is not supported for ${it.name}`);
   if(IGNORED_ITEMS.has(it.name))continue;
   const keys=Object.keys(it.attrs);
   if(it.name==='Using'){if(keys.join()!=='Include'||!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(it.attrs.Include!))throw Error(`${file}: only plain <Using Include="Namespace"/> is supported`);items.push({kind:'Using',op:'Include',value:it.attrs.Include!});continue;}
   if(!['Compile','ProjectReference'].includes(it.name))throw Error(`${file}: ${it.name} items need restore/MSBuild (packages, references, analyzers); export forge.csharp.json`);
   if(keys.length!==1||!['Include','Remove'].includes(keys[0]!)||(it.name==='ProjectReference'&&keys[0]!=='Include'))throw Error(`${file}: unsupported ${it.name} item form`);
   items.push({kind:it.name,op:keys[0] as 'Include'|'Remove',value:pattern(it.attrs[keys[0]!]!)});}}
  else throw Error(`${file}: <${group.name}> needs MSBuild evaluation; export forge.csharp.json`);
 }
 if(props.get('TargetFramework')!=='net10.0')throw Error(`${file}: static import supports TargetFramework net10.0 only (pinned reference pack)`);
 const lang=(props.get('LangVersion')??'').toLowerCase();
 const language_version=!lang||['default','latest','latestmajor'].includes(lang)?'14':/^(?:[1-9]|1[0-4])(?:\.0)?$/.test(lang)?lang:(()=>{throw Error(`${file}: unsupported LangVersion ${lang}`);})();
 const nullable=(props.get('Nullable')??'disable').toLowerCase();if(!['enable','disable','warnings','annotations'].includes(nullable))throw Error(`${file}: invalid Nullable`);
 const output=(props.get('OutputType')??'Library').toLowerCase();const output_kind=({library:'library',exe:'exe',winexe:'winexe'} as Record<string,ImportedOptions['output_kind']>)[output];if(!output_kind)throw Error(`${file}: unsupported OutputType`);
 const unsafe=(props.get('AllowUnsafeBlocks')??'false').toLowerCase();if(!['true','false'].includes(unsafe))throw Error(`${file}: invalid AllowUnsafeBlocks`);
 let extra:string[]=[];const defines=props.get('DefineConstants');
 if(defines!==undefined){const m=/^\$\(DefineConstants\)((?:;[A-Za-z_]\w{0,127})*);?$/.exec(defines.replace(/\s/g,''));if(!m)throw Error(`${file}: DefineConstants must extend $(DefineConstants) with plain symbols`);extra=m[1]!.split(';').filter(Boolean);}
 const definesOut=[...new Set(['TRACE',...extra,...SDK_DEFINES.slice(1)])];
 const implicit=(props.get('ImplicitUsings')??'disable').toLowerCase();if(!['enable','true','disable','false',''].includes(implicit))throw Error(`${file}: invalid ImplicitUsings`);
 const assembly=props.get('AssemblyName')??basename(file,extname(file));if(!/^[A-Za-z_][\w.]{0,127}$/.test(assembly))throw Error(`${file}: invalid AssemblyName`);
 let sources:string[]=props.get('EnableDefaultCompileItems')?.toLowerCase()==='false'?[]:await walkCs(dir,signal);
 const all=await walkCs(dir,signal),references:string[]=[],usings=['enable','true'].includes(implicit)?[...IMPLICIT_USINGS]:[];
 for(const item of items){
  if(item.kind==='Using'){usings.push(item.value);continue;}
  if(item.kind==='ProjectReference'){const target=resolve(dir,item.value);if(!isPathInsideRoot(target,root)||extname(target).toLowerCase()!=='.csproj')throw Error(`${file}: ProjectReference must name a .csproj inside the approved project`);references.push(relative(root,target).replaceAll('\\','/'));continue;}
  if(item.op==='Remove')sources=sources.filter(s=>!globMatch(item.value,s));
  else{if(item.value.startsWith('../'))throw Error(`${file}: linked Compile items outside the project directory are not supported`);const matched=/[*?]/.test(item.value)?all.filter(s=>globMatch(item.value,s)):[item.value];
   for(const m of matched){if(sources.some(s=>s.toLowerCase()===m.toLowerCase()))throw Error(`${file}: duplicate Compile item ${m}`);sources.push(m);}}
 }
 return {name:basename(file,extname(file)),assembly_name:assembly,file:relative(root,captured.path).replaceAll('\\','/'),
  sources:sources.map(s=>(projectRel?projectRel+'/':'')+s),options:{language_version,nullable:nullable as ImportedOptions['nullable'],output_kind,allow_unsafe:unsafe==='true',defines:definesOut},
  project_references:references,global_usings:[...new Set(usings)]};
}

function solutionProjects(file:string,text:string):string[]{
 if(file.toLowerCase().endsWith('.slnx')){const xml=parseXml(text);if(xml.name!=='Solution')throw Error('Invalid .slnx');const out:string[]=[];
  const visit=(n:XmlNode)=>{for(const c of n.children){if(c.name==='Project'){if(!c.attrs.Path)throw Error('Invalid .slnx project');out.push(c.attrs.Path);}else if(c.name==='Folder')visit(c);else if(!['Configurations','Properties','BuildType','Platform','File'].includes(c.name))throw Error(`.slnx element ${c.name} is not supported`);}};visit(xml);return out;}
 const out:string[]=[];for(const m of text.matchAll(/^Project\("\{([0-9A-F-]+)\}"\)\s*=\s*"[^"]*",\s*"([^"]+)",\s*"\{[0-9A-F-]+\}"/gim)){
  if(m[1]!.toUpperCase()==='2150E333-8FDC-42A3-9474-1A3956D46DE8')continue; // solution folder
  out.push(m[2]!);}
 return out;
}

// Returns undefined when the root has no build files (plain source discovery).
export async function importCSharpBuild(root:string,signal?:AbortSignal):Promise<ImportedBuild|undefined>{
 const names=(await readdir(root)).filter(n=>/\.(?:sln|slnx|csproj)$/i.test(n)).sort(),inputs:ImportedBuild['inputs']=[];
 const solutions=names.filter(n=>/\.slnx?$/i.test(n)),projects=names.filter(n=>/\.csproj$/i.test(n));
 if(!names.length)return undefined;
 if(solutions.length>1||(!solutions.length&&projects.length>1))throw Error('Multiple C# solutions or projects at the root; export forge.csharp.json or keep one');
 let files:string[],solution:string|undefined;
 if(solutions.length){solution=solutions[0]!;const captured=await captureCSharpFile(root,solution,[root],1024*1024,signal);inputs.push({path:captured.path,sha256:captured.sha256,bytes:captured.bytes});
  files=solutionProjects(solution,captured.raw.toString('utf8').replace(/^\uFEFF/,'')).map(p=>pattern(p));
  if(!files.length||files.length>32)throw Error('C# solution must list 1..32 projects');
  if(files.some(f=>extname(f).toLowerCase()!=='.csproj'))throw Error('C# solution contains a non-C# project; static import supports .csproj only');}
 else files=[projects[0]!];
 const out:ImportedProject[]=[],owner=new Map<string,string>();
 for(const f of files){const p=await importProject(root,f,inputs,signal);
  if(out.some(o=>o.file.toLowerCase()===p.file.toLowerCase()))throw Error('Duplicate C# project in solution');
  for(const s of p.sources){const k=s.toLowerCase();if(owner.has(k))throw Error(`C# source ${s} belongs to both ${owner.get(k)} and ${p.file}; nested or shared sources are not supported`);owner.set(k,p.file);}
  out.push(p);}
 const known=new Set(out.map(p=>p.file.toLowerCase()));
 for(const p of out)for(const r of p.project_references)if(!known.has(r.toLowerCase()))throw Error(`${p.file}: ProjectReference ${r} is not part of the imported ${solution?'solution':'project set'}`);
 // Reject cycles: Roslyn and MSBuild both require an acyclic graph.
 const state=new Map<string,number>(),byFile=new Map(out.map(p=>[p.file.toLowerCase(),p]));
 const visit=(f:string)=>{const s=state.get(f);if(s===1)throw Error('C# project references form a cycle');if(s===2)return;state.set(f,1);for(const r of byFile.get(f)!.project_references)visit(r.toLowerCase());state.set(f,2);};
 for(const f of byFile.keys())visit(f);
 // Any other project file under the root would be silently ignored by this import.
 const stray=(await walkAll(root,signal)).filter(f=>/\.csproj$/i.test(f)&&!known.has(f.toLowerCase()));
 if(stray.length)throw Error(`C# project files not in the imported ${solution?'solution':'project'}: ${stray.slice(0,5).join(', ')}`);
 return {kind:'sdk_static',...(solution?{solution}:{}),projects:out,inputs};
}
async function walkAll(root:string,signal?:AbortSignal){
 const out:string[]=[];let visited=0;const pending=[''];
 while(pending.length){signal?.throwIfAborted();const rel=pending.pop()!;
  for(const e of await readdir(join(root,rel),{withFileTypes:true})){if(++visited>20000)throw Error('C# discovery exceeds entry limit');const child=rel?rel+'/'+e.name:e.name;
   if(e.isDirectory()&&!e.isSymbolicLink()&&!/^(\.git|node_modules|bin|obj|\.vs)$/i.test(e.name))pending.push(child);else if(e.isFile())out.push(child);}}
 return out;
}
