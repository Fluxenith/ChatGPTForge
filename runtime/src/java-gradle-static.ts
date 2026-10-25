import {lstat,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {isPathInsideRoot} from './roots.js';
import {validateJavaJar} from './java-archive.js';
import {MavenResolver,mavenRepository,type Dep,type MavenArtifact,type MavenImport,type Model} from './java-maven-static.js';
import {createHash} from 'node:crypto';

// Static Gradle import. Build scripts are programs, so only a strict declarative
// subset of settings.gradle(.kts)/build.gradle(.kts) is accepted; anything else
// (variables, conditionals, apply/allprojects/subprojects, buildscript, platforms,
// interpolation, unknown blocks) is refused instead of evaluated. Gradle is never
// run and nothing is downloaded: modules come from the same approved local Maven
// repository used for Maven import, with Gradle's own semantics: highest version
// wins, compileOnly is not transitive, only POM compile-scope dependencies reach
// the compile classpath. Checked against Gradle 8.14.3 (artifacts/java-gradle-import-v1).
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const CONFIGS=new Set(['implementation','api','compileOnly','runtimeOnly','testImplementation','testCompileOnly','testRuntimeOnly']);
const COMPILE=new Set(['implementation','api','compileOnly','testImplementation','testCompileOnly']);
export interface GradleProject {path:string;dir:string;plugins:string[];deps:{config:string;module?:{group:string;artifact:string;version:string};project?:string}[]}

// Comments removed; braces moved onto their own lines so one-line blocks such as
// `plugins { id 'java' }` parse like their multi-line form.
function strip(text:string){return text.replace(/\/\*[\s\S]*?\*\//g,'').split(/\r?\n/).map(l=>l.replace(/\/\/.*$/,'')).join('\n').replace(/\{/g,'{\n').replace(/\}/g,'\n}\n').split('\n').map(l=>l.trim()).filter(Boolean);}
const lit=(s:string)=>{const m=/^\(?\s*(['"])([^'"$\\]*)\1\s*\)?$/.exec(s.trim());return m?m[2]!:undefined;};

export function parseSettings(text:string,where:string){
 const includes:string[]=[];let name:string|undefined;
 for(const line of strip(text)){
  let m;
  if((m=/^rootProject\.name\s*=\s*(.+)$/.exec(line))){name=lit(m[1]!);if(!name)throw Error(`${where}: rootProject.name must be a literal`);continue;}
  if((m=/^include\s*\(?(.+?)\)?$/.exec(line))){for(const part of m[1]!.split(',')){const v=lit(part);if(!v||!/^:?[A-Za-z0-9_.-]+$/.test(v))throw Error(`${where}: include must list literal flat project names`);includes.push(v.replace(/^:/,''));}continue;}
  throw Error(`${where}: unsupported settings statement "${line.slice(0,80)}"; Gradle evaluation is required`);
 }
 return {name,includes};
}

export function parseBuild(text:string,where:string):Omit<GradleProject,'path'|'dir'>{
 const plugins:string[]=[],deps:GradleProject['deps']=[];let block:string|undefined,depth=0;
 for(const line of strip(text)){
  const opens=(line.match(/\{/g)??[]).length,closes=(line.match(/\}/g)??[]).length;
  if(depth===0){
   const m=/^(plugins|repositories|dependencies|java|application|tasks\.withType\(JavaCompile\)|tasks\.named\(['"]test['"]\))\s*\{$/.exec(line);
   if(m){block=m[1];depth=1;continue;}
   if(/^(group|version|description)\s*=\s*(['"])[^'"$]*\2$/.test(line)||/^(sourceCompatibility|targetCompatibility)\s*=\s*(JavaVersion\.VERSION_\d+|['"]?\d+['"]?)$/.test(line))continue;
   throw Error(`${where}: unsupported build statement "${line.slice(0,80)}"; Gradle evaluation is required`);
  }
  if(closes&&!opens&&line==='}'&&depth===1){block=undefined;depth=0;continue;}
  if(block==='plugins'){
   const m=/^(?:id\s*\(?\s*['"]([\w.-]+)['"]\s*\)?|`?([\w-]+)`?)$/.exec(line);const id=m?.[1]??m?.[2];
   if(!id||!['java','java-library','application'].includes(id))throw Error(`${where}: plugin ${line} may change sources or classpath; export forge.java.json`);
   plugins.push(id);continue;
  }
  if(block==='repositories'){if(!/^(mavenLocal|mavenCentral)\(\)$/.test(line))throw Error(`${where}: repository ${line} is not supported; only mavenLocal()/mavenCentral() resolved from the local repository`);continue;}
  if(block==='dependencies'){
   const m=/^(\w+)\s*(.+)$/.exec(line);if(!m||!CONFIGS.has(m[1]!))throw Error(`${where}: unsupported dependency declaration "${line.slice(0,80)}"`);
   // Kotlin `implementation(...)` wraps the argument once; Groovy omits it.
   let arg=m[2]!.trim();if(/^\(.*\)$/.test(arg))arg=arg.slice(1,-1).trim();
   const p=/^project\s*\(\s*['"]:?([A-Za-z0-9_.-]+)['"]\s*\)$/.exec(arg);
   if(p){deps.push({config:m[1]!,project:p[1]!});continue;}
   const coord=lit(arg);const parts=coord?.split(':');
   if(!parts||parts.length!==3||parts.some(x=>!/^[A-Za-z0-9_.-]+$/.test(x)))throw Error(`${where}: dependency ${arg} must be a literal group:artifact:version`);
   deps.push({config:m[1]!,module:{group:parts[0]!,artifact:parts[1]!,version:parts[2]!}});continue;
  }
  if(block==='java'||block==='application'||block?.startsWith('tasks')){
   // Toolchain/compatibility, main class and encoding settings do not change the
   // classpath or source set; anything else inside these blocks is refused.
   depth+=opens-closes;if(depth<=0){block=undefined;depth=0;continue;}
   if(/^(toolchain\s*\{|languageVersion\s*(=|\.set\().*JavaLanguageVersion\.of\(\d+\)\)?|\}|mainClass\s*(=|\.set\().*['"][\w.$]+['"]\)?|options\.encoding\s*=\s*['"][\w-]+['"]|useJUnit(Platform)?\(\)|sourceCompatibility\s*=.*|targetCompatibility\s*=.*)$/.test(line))continue;
   throw Error(`${where}: unsupported setting "${line.slice(0,80)}" in ${block}`);
  }
  throw Error(`${where}: unsupported nested block`);
 }
 if(depth!==0)throw Error(`${where}: unbalanced build script`);
 if(!plugins.some(p=>p==='java'||p==='java-library'||p==='application'))throw Error(`${where}: no Java plugin`);
 return {plugins,deps};
}

// Maven-style version ordering (numeric segments, then qualifiers).
export function compareVersions(a:string,b:string){
 const tok=(v:string)=>v.toLowerCase().split(/[.-]/).map(x=>/^\d+$/.test(x)?Number(x):x);
 const rank:Record<string,number>={alpha:-5,a:-5,beta:-4,b:-4,milestone:-3,m:-3,rc:-2,cr:-2,snapshot:-1,'':0,ga:0,final:0,release:0,sp:1};
 const x=tok(a),y=tok(b);for(let i=0;i<Math.max(x.length,y.length);i++){
  const p=x[i]??0,q=y[i]??0;if(p===q)continue;
  if(typeof p==='number'&&typeof q==='number')return p-q;
  if(typeof p==='number')return 1;if(typeof q==='number')return -1;
  const rp=rank[p]??2,rq=rank[q]??2;if(rp!==rq)return rp-rq;return p<q?-1:1;
 }
 return 0;
}

// Gradle conflict resolution: iterate to a fixed point where each module's
// selected version is the highest requested along edges of selected versions.
async function resolveGradle(resolver:MavenResolver,direct:{dep:Dep;transitive:boolean}[]):Promise<MavenArtifact[]>{
 let selected=new Map<string,string>();
 for(let round=0;round<32;round++){
  const requested=new Map<string,string[]>(),order:string[]=[],parent=new Map<string,string|undefined>();
  const visit=async(dep:Dep,via:string|undefined,excluded:Set<string>,transitive:boolean,depth:number)=>{
   const k=dep.group+':'+dep.artifact;
   if([...excluded].some(e=>{const [g,a]=e.split(':');return (g==='*'||g===dep.group)&&(a==='*'||a===dep.artifact);}))return;
   if(!dep.version)throw Error(`No version for Gradle dependency ${k}`);
   if(/[[\](),]|\+|latest\./i.test(dep.version))throw Error(`Dynamic version ${k}:${dep.version} needs Gradle resolution`);
   if(dep.type!=='jar'||dep.classifier)throw Error(`Dependency ${k} uses type/classifier; not supported`);
   const list=requested.get(k)??[];if(!list.includes(dep.version))list.push(dep.version);requested.set(k,list);
   if(!order.includes(k)){order.push(k);parent.set(k,via);}
   const chosen=selected.get(k)??dep.version;if(chosen!==dep.version||!transitive||depth>64)return;
   const model:Model=await resolver.load(dep.group,dep.artifact,dep.version);
   for(const t of model.dependencies){if(t.optional||(t.scope&&t.scope!=='compile'))continue;
    const version=t.version??model.management.get(t.group+':'+t.artifact)?.version;
    await visit({...t,version},k,new Set([...excluded,...dep.exclusions]),true,depth+1);}
  };
  for(const d of direct)await visit(d.dep,undefined,new Set(),d.transitive,1);
  const next=new Map([...requested].map(([k,vs])=>[k,[...vs].sort(compareVersions).at(-1)!]));
  if(JSON.stringify([...next])===JSON.stringify([...selected])){
   return order.map(k=>{const [g,a]=k.split(':') as [string,string],v=next.get(k)!;return {group:g,artifact:a,version:v,scope:'compile',path:resolver.file(g,a,v,'jar'),depth:0,...(parent.get(k)?{parent:parent.get(k)!}:{})};});
  }
  selected=next;
 }
 throw Error('Gradle conflict resolution did not converge');
}

export async function importGradle(root:string,roots:string[],signal?:AbortSignal):Promise<MavenImport&{projects:string[]}>{
 const requested=await mavenRepository(root);
 const repository=await realpath(requested).catch(()=>{throw Error(`Local Maven repository not found: ${requested}`);});
 const approved=await Promise.all(roots.map(r=>realpath(r)));
 if(!approved.some(r=>isPathInsideRoot(repository,r)))throw Error(`Gradle import reads dependencies only from a local repository inside an approved root; ${repository} is not approved. Approve it or export forge.java.json.`);
 const resolver=new MavenResolver(repository,signal),inputs:MavenImport['inputs']=[];
 const read=async(file:string)=>{const path=join(root,file);const info=await lstat(path).catch(()=>undefined);if(!info)return undefined;if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024)throw Error(`${file} must be a bounded regular file`);const raw=await readFile(path);inputs.push({path,sha256:hash(raw),bytes:raw.length});return raw.toString('utf8');};
 const script=async(dir:string)=>{const g=await read(join(dir,'build.gradle')),k=await read(join(dir,'build.gradle.kts'));if(g!==undefined&&k!==undefined)throw Error(`${dir||'.'}: both build.gradle and build.gradle.kts`);return g??k;};
 for(const name of ['gradle.properties','buildSrc','init.gradle','gradle/libs.versions.toml'])if(await lstat(join(root,name)).then(()=>true,()=>false))throw Error(`${name} can change Gradle evaluation; export forge.java.json`);
 const settingsText=(await read('settings.gradle'))??(await read('settings.gradle.kts'));
 const settings=settingsText===undefined?{includes:[] as string[]}:parseSettings(settingsText,'settings.gradle');
 const projects:GradleProject[]=[];
 const rootScript=await script('');
 if(rootScript!==undefined&&rootScript.trim()){const parsed=strip(rootScript).length?parseBuild(rootScript,'build.gradle'):undefined;if(parsed)projects.push({path:':',dir:'',...parsed});}
 for(const inc of settings.includes){if(inc.includes('..'))throw Error('Escaping Gradle project');const text=await script(inc);if(text===undefined)throw Error(`Included project ${inc} has no build script`);projects.push({path:':'+inc,dir:inc,...parseBuild(text,inc+'/build.gradle')});}
 if(!projects.length)throw Error('No Gradle Java project found');
 const byPath=new Map(projects.map(p=>[p.path,p]));
 for(const p of projects)for(const d of p.deps)if(d.project&&!byPath.has(':'+d.project))throw Error(`${p.path}: project(':${d.project}') is not included`);
 // Exported (api) externals of a project, recursively through its api project deps.
 const apiOf=(p:GradleProject,seen=new Set<string>()):GradleProject['deps']=>{if(seen.has(p.path))throw Error('Gradle project dependency cycle');seen.add(p.path);
  return p.deps.flatMap(d=>d.config!=='api'?[]:d.module?[d]:apiOf(byPath.get(':'+d.project)!,new Set(seen)));};
 const toDep=(m:{group:string;artifact:string;version:string}):Dep=>({group:m.group,artifact:m.artifact,version:m.version,type:'jar',optional:false,exclusions:[]});
 const artifacts:MavenArtifact[]=[],byKey=new Map<string,MavenArtifact>();
 for(const p of projects){
  // Test compile classpath (all sources compile together) plus main-only
  // compileOnly; runtimeOnly never reaches compilation.
  const direct:{dep:Dep;transitive:boolean}[]=[];
  for(const d of p.deps){if(!COMPILE.has(d.config))continue;
   if(d.module)direct.push({dep:toDep(d.module),transitive:!d.config.endsWith('CompileOnly')&&d.config!=='compileOnly'});
   else for(const e of apiOf(byPath.get(':'+d.project)!))direct.push({dep:toDep(e.module!),transitive:true});}
  for(const a of await resolveGradle(resolver,direct)){const k=a.group+':'+a.artifact,seen=byKey.get(k);
   if(seen){if(seen.version!==a.version)throw Error(`${p.path}: ${k} resolves to ${a.version} but another project uses ${seen.version}; one compilation cannot hold both`);continue;}
   byKey.set(k,a);artifacts.push(a);}
 }
 const jars=new Map<string,Buffer>();
 for(const a of artifacts){const raw=await resolver.read(a.path,32*1024*1024);validateJavaJar(raw);jars.set(a.path,raw);}
 if([...jars.values()].reduce((n,b)=>n+b.length,0)>128*1024*1024)throw Error('Gradle classpath exceeds 128 MiB');
 return {kind:'maven_static',repository,artifacts,inputs:[...inputs,...resolver.inputs],jars,projects:projects.map(p=>p.path)};
}
