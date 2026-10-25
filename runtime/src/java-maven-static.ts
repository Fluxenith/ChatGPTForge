import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,relative,sep} from 'node:path';
import {isPathInsideRoot} from './roots.js';
import {validateJavaJar} from './java-archive.js';

// Static Maven import for navigation. Maven is never run and nothing is
// downloaded: a strict subset of the POM model is resolved only from a local
// repository that lies inside an approved root. Anything whose meaning needs
// Maven itself (version ranges, activatable profiles that change dependencies,
// unresolved properties, system scope, classifiers, relocations, missing files)
// is refused instead of approximated. Checked against Maven 3.9.9's actual javac
// classpath (artifacts/java-maven-import-v1).
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export interface MavenArtifact {group:string;artifact:string;version:string;scope:string;path:string;depth:number;parent?:string}
export interface MavenImport {kind:'maven_static';repository:string;release?:string;artifacts:MavenArtifact[];inputs:{path:string;sha256:string;bytes:number}[];jars:Map<string,Buffer>}

interface Node {name:string;attrs:Record<string,string>;children:Node[];text:string}
const ENT:Record<string,string>={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};
const decode=(s:string)=>s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi,(_,e:string)=>{if(e[0]==='#')return String.fromCodePoint(e[1]?.toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10));const v=ENT[e];if(v===undefined)throw Error('Unsupported XML entity in POM');return v;});
export function parsePom(text:string):Node {
 let i=0;const s=text.replace(/^﻿/,'');
 const skipMisc=()=>{for(;;){while(i<s.length&&/\s/.test(s[i]!))i++;
  if(s.startsWith('<!--',i)){const e=s.indexOf('-->',i);if(e<0)throw Error('Bad POM comment');i=e+3;}
  else if(s.startsWith('<?',i)){const e=s.indexOf('?>',i);if(e<0)throw Error('Bad POM declaration');i=e+2;}
  else if(s.startsWith('<!DOCTYPE',i))throw Error('POM DOCTYPE is not supported');else return;}};
 const name=()=>{const m=/^[A-Za-z_][\w.:-]*/.exec(s.slice(i));if(!m)throw Error('Invalid POM XML name');i+=m[0].length;return m[0];};
 const element=():Node=>{
  i++;const n:Node={name:name(),attrs:{},children:[],text:''};
  for(;;){while(/\s/.test(s[i]!))i++;if(s.startsWith('/>',i)){i+=2;return n;}if(s[i]==='>'){i++;break;}
   const k=name();while(/\s/.test(s[i]!))i++;if(s[i]!=='=')throw Error('Invalid POM attribute');i++;while(/\s/.test(s[i]!))i++;const q=s[i];if(q!=='"'&&q!=="'")throw Error('Invalid POM attribute');const e=s.indexOf(q,i+1);if(e<0)throw Error('Unterminated POM attribute');n.attrs[k]=decode(s.slice(i+1,e));i=e+1;}
  for(;;){
   if(i>=s.length)throw Error('Unterminated POM element');
   if(s.startsWith('<!--',i)){const e=s.indexOf('-->',i);if(e<0)throw Error('Bad POM comment');i=e+3;continue;}
   if(s.startsWith('<![CDATA[',i)){const e=s.indexOf(']]>',i);if(e<0)throw Error('Bad POM CDATA');n.text+=s.slice(i+9,e);i=e+3;continue;}
   if(s.startsWith('<?',i)){const e=s.indexOf('?>',i);if(e<0)throw Error('Bad POM declaration');i=e+2;continue;}
   if(s.startsWith('</',i)){i+=2;if(name()!==n.name)throw Error('Mismatched POM end tag');while(/\s/.test(s[i]!))i++;if(s[i]!=='>')throw Error('Invalid POM end tag');i++;return n;}
   if(s[i]==='<'){n.children.push(element());continue;}
   const e=s.indexOf('<',i);if(e<0)throw Error('Unterminated POM text');n.text+=decode(s.slice(i,e));i=e;
  }
 };
 skipMisc();if(s[i]!=='<')throw Error('Invalid POM');const root=element();skipMisc();if(i!==s.length)throw Error('Trailing POM content');return root;
}
const child=(n:Node|undefined,name:string)=>n?.children.find(c=>c.name===name);
const all=(n:Node|undefined,name:string)=>n?.children.filter(c=>c.name===name)??[];
const text=(n:Node|undefined,name:string)=>{const c=child(n,name);return c?c.text.trim():undefined;};

export interface Dep {group:string;artifact:string;version?:string;scope?:string;type:string;classifier?:string;optional:boolean;exclusions:string[]}
export interface Model {group:string;artifact:string;version:string;properties:Map<string,string>;profileProps:Set<string>;management:Map<string,Dep>;dependencies:Dep[]}
const key=(g:string,a:string)=>g+':'+a;

export class MavenResolver {
 private cache=new Map<string,Model>();
 readonly inputs:MavenImport['inputs']=[];
 // Reactor POMs (g:a:v) read from the approved project; parents resolve here first.
 readonly reactor=new Map<string,{raw:Buffer;where:string}>();
 constructor(readonly repository:string,private signal?:AbortSignal){}
 file(g:string,a:string,v:string,ext:string){
  for(const part of [g,a,v])if(!/^[A-Za-z0-9_.-]+$/.test(part)||part==='.'||part==='..')throw Error(`Unsupported Maven coordinate ${g}:${a}:${v}`);
  return join(this.repository,...g.split('.'),a,v,`${a}-${v}.${ext}`);
 }
 async read(path:string,limit:number){
  this.signal?.throwIfAborted();
  if(!isPathInsideRoot(path,this.repository))throw Error('Maven file leaves the local repository');
  let current=this.repository;for(const part of relative(this.repository,path).split(sep)){current=join(current,part);
   const info=await lstat(current).catch(()=>undefined);if(!info)throw Error(`Missing in local Maven repository (no download is attempted): ${relative(this.repository,path)}`);if(info.isSymbolicLink())throw Error('Maven repository path contains a link');}
  const first=await lstat(path);if(!first.isFile()||first.size>limit)throw Error('Maven file must be a bounded regular file');
  const raw=await readFile(path),last=await lstat(path);if(raw.length!==first.size||first.mtimeMs!==last.mtimeMs||first.size!==last.size)throw Error('Maven file changed during capture');
  this.inputs.push({path,sha256:hash(raw),bytes:raw.length});return raw;
 }
 // Effective model subset: parent inheritance, properties, dependencyManagement
 // (including scope-import BOMs) and inherited dependencies.
 async model(raw:Buffer,where:string,depth=0,root=false):Promise<Model>{
  if(depth>16)throw Error('Maven parent chain too deep');
  const xml=parsePom(raw.toString('utf8'));if(xml.name!=='project')throw Error(`${where}: not a POM`);
  if(child(xml,'distributionManagement')&&child(child(xml,'distributionManagement'),'relocation'))throw Error(`${where}: relocated artifact`);
  const p=child(xml,'parent');let parent:Model|undefined;
  if(p){const g=text(p,'groupId'),a=text(p,'artifactId'),v=text(p,'version');if(!g||!a||!v)throw Error(`${where}: incomplete parent`);parent=await this.load(g,a,v,depth+1);}
  const group=text(xml,'groupId')??parent?.group,version=text(xml,'version')??parent?.version,artifact=text(xml,'artifactId');
  if(!group||!version||!artifact)throw Error(`${where}: incomplete coordinates`);
  const properties=new Map(parent?.properties??[]);for(const c of child(xml,'properties')?.children??[])properties.set(c.name,c.text.trim());
  const profileProps=new Set(parent?.profileProps??[]);
  for(const profile of all(child(xml,'profiles'),'profile')){
   for(const c of child(profile,'properties')?.children??[])profileProps.add(c.name);
   // A dependency's optional dependencies never reach consumers, so profiles that
   // only add optional dependencies to a non-root POM cannot change our classpath.
   const added=all(child(profile,'dependencies'),'dependency'),harmless=!root&&!child(profile,'dependencyManagement')&&added.every(d=>text(d,'optional')==='true');
   if((added.length||child(profile,'dependencyManagement'))&&child(profile,'activation')&&!harmless)throw Error(`${where}: an activatable profile changes dependencies; Maven evaluation is required`);
  }
  const model:Model={group,artifact,version,properties,profileProps,management:new Map(parent?.management??[]),dependencies:[...(parent?.dependencies??[])]};
  const deps=(n:Node|undefined)=>all(child(n,'dependencies'),'dependency').map(d=>this.dep(d,model,where));
  for(const d of deps(child(xml,'dependencyManagement'))){
   if(d.scope==='import'){if(d.type!=='pom'||!d.version)throw Error(`${where}: invalid BOM import`);const bom=await this.load(d.group,d.artifact,d.version,depth+1);for(const [k,v] of bom.management)if(!model.management.has(k))model.management.set(k,v);}
   else model.management.set(key(d.group,d.artifact),d);
  }
  model.dependencies.push(...deps(xml));
  return model;
 }
 private interpolate(value:string,model:Pick<Model,'group'|'artifact'|'version'|'properties'|'profileProps'>,where:string,seen=0):string{
  return value.replace(/\$\{([^}]+)\}/g,(_,name:string)=>{
   if(seen>20)throw Error(`${where}: recursive property`);
   if(model.profileProps.has(name)&&!model.properties.has(name))throw Error(`${where}: property ${name} is only defined by a profile`);
   const builtin:Record<string,string>={'project.groupId':model.group,'project.version':model.version,'project.artifactId':model.artifact,'pom.groupId':model.group,'pom.version':model.version,'version':model.version,'groupId':model.group};
   const v=model.properties.get(name)??builtin[name];if(v===undefined)throw Error(`${where}: unresolved property \${${name}}`);
   if(model.profileProps.has(name))throw Error(`${where}: property ${name} may be changed by a profile`);
   return this.interpolate(v,model,where,seen+1);});
 }
 private dep(d:Node,model:Model,where:string):Dep{
  const get=(n:string)=>{const v=text(d,n);return v===undefined?undefined:this.interpolate(v,model,where);};
  const group=get('groupId'),artifact=get('artifactId');if(!group||!artifact)throw Error(`${where}: incomplete dependency`);
  return {group,artifact,version:get('version'),scope:get('scope'),type:get('type')??'jar',classifier:get('classifier'),optional:get('optional')==='true',
   exclusions:all(child(d,'exclusions'),'exclusion').map(e=>key(text(e,'groupId')??'*',text(e,'artifactId')??'*'))};
 }
 async load(g:string,a:string,v:string,depth=0){
  if(/[[\](),]/.test(v))throw Error(`Maven version range ${g}:${a}:${v} needs Maven resolution`);
  const k=`${g}:${a}:${v}`;const hit=this.cache.get(k);if(hit)return hit;
  const local=this.reactor.get(k);
  const m=local?await this.model(local.raw,local.where,depth,true):await this.model(await this.read(this.file(g,a,v,'pom'),4*1024*1024),k,depth);this.cache.set(k,m);return m;
 }
 // Maven 3 scope mediation for the test-compile classpath (all project sources
 // are compiled together), nearest-wins with first declaration on ties.
 async resolve(root:Model,skip:Set<string>=new Set()):Promise<MavenArtifact[]>{
  const transitive:Record<string,Record<string,string|undefined>>={compile:{compile:'compile',runtime:'runtime'},provided:{compile:'provided',runtime:'provided'},runtime:{compile:'runtime',runtime:'runtime'},test:{compile:'test',runtime:'test'}};
  const chosen=new Map<string,MavenArtifact>();
  type Item={dep:Dep;scope:string;depth:number;excluded:Set<string>;owner:Model;parent?:string};
  let level:Item[]=root.dependencies.map(dep=>({dep,scope:'',depth:1,excluded:new Set<string>(),owner:root}));
  while(level.length){const next:Item[]=[];
   for(const item of level){const d=item.dep,k=key(d.group,d.artifact);
    if(chosen.has(k))continue;
    // Sibling reactor modules are compiled from source; their own dependencies
    // are resolved with their module, so neither a JAR nor transitives are added.
    if(skip.has(k))continue;
    if([...item.excluded].some(e=>{const [eg,ea]=e.split(':');return (eg==='*'||eg===d.group)&&(ea==='*'||ea===d.artifact);}))continue;
    const managed=root.management.get(k),own=item.owner.management.get(k);
    const version=(item.depth>1?managed?.version:undefined)??d.version??own?.version??managed?.version;
    let scope=item.depth===1?(d.scope??own?.scope??'compile'):item.scope;
    if(item.depth>1&&managed?.scope&&scope!=='test'&&scope!=='provided')scope=managed.scope==='test'?scope:managed.scope;
    if(!version)throw Error(`No version for Maven dependency ${k}`);
    if(scope==='system'||scope==='import')throw Error(`Maven ${scope} scope dependency ${k} is not supported`);
    if(d.type!=='jar'||d.classifier)throw Error(`Maven dependency ${k} uses type/classifier ${d.type}/${d.classifier??''}; not supported`);
    if(/SNAPSHOT$/i.test(version))throw Error(`Maven SNAPSHOT dependency ${k} needs repository metadata`);
    const model=await this.load(d.group,d.artifact,version);
    chosen.set(k,{group:d.group,artifact:d.artifact,version,scope,path:this.file(d.group,d.artifact,version,'jar'),depth:item.depth,...(item.parent?{parent:item.parent}:{})});
    for(const t of model.dependencies){if(t.optional)continue;const ts=transitive[scope]?.[t.scope??'compile'];if(!ts)continue;
     next.push({dep:t,scope:ts,depth:item.depth+1,excluded:new Set([...item.excluded,...d.exclusions]),owner:model,parent:k});}
   }
   level=next;if(chosen.size>256)throw Error('Maven classpath exceeds 256 artifacts');
  }
  // Maven orders the classpath as a pre-order walk of the mediated tree.
  const ordered:MavenArtifact[]=[],values=[...chosen.values()];
  const walk=(parent:string|undefined)=>{for(const a of values)if(a.parent===parent&&!ordered.includes(a)){ordered.push(a);walk(key(a.group,a.artifact));}};
  walk(undefined);if(ordered.length!==values.length)throw Error('Maven tree ordering failed');
  return ordered;
 }
}

// Order: explicit setting, project-local repository (maven.repo.local=.m2/repository,
// inside the approved project by construction), then the user's default repository.
export async function mavenRepository(root:string){
 if(process.env.CHATGPTFORGE_MAVEN_REPOSITORY)return process.env.CHATGPTFORGE_MAVEN_REPOSITORY;
 const local=join(root,'.m2','repository');
 if(await lstat(local).then(s=>s.isDirectory()&&!s.isSymbolicLink(),()=>false))return local;
 return join(homedir(),'.m2','repository');
}

interface ReactorPom {dir:string;raw:Buffer;xml:Node;where:string}
async function reactorPoms(root:string,roots:string[],signal?:AbortSignal){
 const out:ReactorPom[]=[];const seen=new Set<string>();
 const visit=async(dir:string,depth:number)=>{
  signal?.throwIfAborted();if(depth>4||out.length>=64)throw Error('Maven reactor exceeds 64 modules / depth 4');
  const path=join(dir,'pom.xml');if(!isPathInsideRoot(path,root))throw Error('Maven module leaves the project');
  const info=await lstat(path).catch(()=>undefined);if(!info||!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error(`Maven module POM missing or not a bounded regular file: ${relative(root,path)}`);
  const key=(await realpath(path)).toLowerCase();if(seen.has(key))throw Error('Maven module listed twice');seen.add(key);
  const raw=await readFile(path),xml=parsePom(raw.toString('utf8')),where=relative(root,path).replaceAll('\\','/')||'pom.xml';
  out.push({dir,raw,xml,where});
  for(const m of all(child(xml,'modules'),'module')){const name=m.text.trim();
   if(!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name)||name.split('/').some(x=>x==='.'||x==='..'))throw Error(`Unsupported Maven module path ${name}`);
   await visit(join(dir,...name.split('/')),depth+1);}
 };
 await visit(root,0);void roots;return out;
}
function checkBuild(xml:Node,where:string){
 if(child(xml,'profiles')&&all(child(xml,'profiles'),'profile').some(p=>child(p,'modules')))throw Error(`${where}: profile-dependent modules need Maven evaluation`);
 for(const plugin of all(child(child(xml,'build'),'plugins'),'plugin')){
  const id=text(plugin,'artifactId');
  if(id!=='maven-compiler-plugin'&&id!=='maven-surefire-plugin'&&id!=='maven-jar-plugin')throw Error(`${where}: Maven build plugin ${id} may change sources or classpath; export forge.java.json`);
 }
 for(const name of ['sourceDirectory','testSourceDirectory'])if(child(child(xml,'build'),name))throw Error(`${where}: custom ${name} needs forge.java.json`);
}
export async function importMaven(root:string,rootPom:Buffer,roots:string[],signal?:AbortSignal):Promise<MavenImport>{
 const requested=await mavenRepository(root);
 const repository=await realpath(requested).catch(()=>{throw Error(`Local Maven repository not found: ${requested}`);});
 const approved=await Promise.all(roots.map(r=>realpath(r)));
 if(!approved.some(r=>isPathInsideRoot(repository,r)))throw Error(`Maven import reads dependencies only from a local repository inside an approved root; ${repository} is not approved. Approve it or export forge.java.json.`);
 const resolver=new MavenResolver(repository,signal);
 // The root and every <modules> POM form the reactor. Parents resolve from the
 // reactor before the repository; sibling modules are sources, not JARs.
 const poms=await reactorPoms(root,roots,signal);
 if(poms[0]!.raw.compare(rootPom)!==0)throw Error('Root pom.xml changed during capture');
 const models:{pom:ReactorPom;model:Model;packaging:string}[]=[];
 for(const pom of poms){
  const parent=child(pom.xml,'parent'),g=text(pom.xml,'groupId')??text(parent,'groupId'),a=text(pom.xml,'artifactId'),v=text(pom.xml,'version')??text(parent,'version');
  if(!g||!a||!v)throw Error(`${pom.where}: incomplete coordinates`);
  if(/\$\{/.test(g+a+v))throw Error(`${pom.where}: interpolated reactor coordinates need Maven evaluation`);
  resolver.reactor.set(`${g}:${a}:${v}`,{raw:pom.raw,where:pom.where});
  resolver.inputs.push({path:join(pom.dir,'pom.xml'),sha256:hash(pom.raw),bytes:pom.raw.length});
 }
 const skip=new Set([...resolver.reactor.keys()].map(k=>k.split(':').slice(0,2).join(':')));
 for(const pom of poms){
  checkBuild(pom.xml,pom.where);
  const packaging=text(pom.xml,'packaging')??'jar';
  if(packaging!=='jar'&&packaging!=='pom')throw Error(`${pom.where}: Maven packaging ${packaging} is not supported`);
  if(packaging==='pom'&&pom!==poms[0]&&!child(pom.xml,'modules'))throw Error(`${pom.where}: pom-packaged module without modules`);
  models.push({pom,model:await resolver.model(pom.raw,pom.where,0,true),packaging});
 }
 if(models.length===1&&models[0]!.packaging!=='jar')throw Error(`Maven packaging ${models[0]!.packaging} is not supported`);
 // One compilation holds every module, so all modules must agree on versions.
 const artifacts:MavenArtifact[]=[],byKey=new Map<string,MavenArtifact>();
 for(const {model,packaging,pom} of models){if(packaging!=='jar')continue;
  for(const a of await resolver.resolve(model,skip)){const k=key(a.group,a.artifact),seen=byKey.get(k);
   if(seen){if(seen.version!==a.version)throw Error(`${pom.where}: ${k} resolves to ${a.version} but another module uses ${seen.version}; one compilation cannot hold both`);continue;}
   byKey.set(k,a);artifacts.push(a);}
 }
 const model=models[0]!.model;
 const jars=new Map<string,Buffer>();
 for(const a of artifacts){const raw=await resolver.read(a.path,32*1024*1024);validateJavaJar(raw);jars.set(a.path,raw);}
 if([...jars.values()].reduce((n,b)=>n+b.length,0)>128*1024*1024)throw Error('Maven classpath exceeds 128 MiB');
 const release=model.properties.get('maven.compiler.release');
 return {kind:'maven_static',repository,...(release?{release}:{}),artifacts,inputs:resolver.inputs,jars};
}
