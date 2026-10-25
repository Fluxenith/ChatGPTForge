import {parseBuild,parseSettings} from './java-gradle-static.js';
import {parsePom} from './java-maven-static.js';
import {validateJavaJar} from './java-archive.js';
import {CapturedMavenModels,type MavenModel} from './kotlin-maven-model.js';
import {gradleCatalog} from './kotlin-gradle-catalog.js';
import {resolveKotlinMaven} from './kotlin-maven-resolve.js';

type Xml=ReturnType<typeof parsePom>;
export interface KotlinModule {name:string;roots:string[];dependencies?:string[];libraries?:string[]}
type Coord={group:string;artifact:string;version:string;transitive?:boolean};
const child=(n:Xml|undefined,k:string)=>n?.children.find(c=>c.name===k);
const value=(n:Xml|undefined,k:string)=>child(n,k)?.text.trim();
const children=(n:Xml|undefined,k:string)=>n?.children.filter(c=>c.name===k)??[];
const fail=(why:string):never=>{throw Error(`Kotlin automatic import: ${why}; supply .forge/kotlin-workspace.json for non-declarative builds`);};
const safe=(p:string)=>{if(!/^[\w./-]+$/.test(p)||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'))fail('invalid project path '+p);return p;};
const coord=(s:string):Coord=>{const parts=s.split(':');if(parts.length!==3||parts.some(p=>!/^[\w.-]+$/.test(p)||p==='..'||p==='.'))fail('non-literal dependency '+s);return {group:parts[0]!,artifact:parts[1]!,version:parts[2]!};};

// Resolve only captured, local Maven-layout artifacts. No network or build code.
// Ambiguous versions and nontrivial POM semantics are refused, never flattened.
function libraries(files:Map<string,Buffer>,direct:Coord[],management?:Map<string,Xml>):string[]{
 const models=new CapturedMavenModels(files);
 const out=new Set<string>(),seen=new Map<string,string>(),expanded=new Set<string>();
 const visit=(c:Coord,depth:number)=>{
  if(depth>32)fail('dependency graph exceeds 32 levels');
  const key=c.group+':'+c.artifact,prior=seen.get(key);
  if(prior){if(prior!==c.version)fail('dependency version conflict for '+key);if(expanded.has(key)||c.transitive===false)return;}seen.set(key,c.version);
  const stem=c.group.replaceAll('.','/')+'/'+c.artifact+'/'+c.version+'/'+c.artifact+'-'+c.version;
  const matches=[...files.keys()].filter(p=>p===stem+'.pom'||p.endsWith('/'+stem+'.pom'));
  if(matches.length!==1)fail('need one captured Maven POM for '+key+':'+c.version);
  const pomPath=matches[0]!,jarPath=pomPath.slice(0,-4)+'.jar',jar=files.get(jarPath);
  if(!jar)fail('missing captured JAR '+jarPath);validateJavaJar(jar!);out.add(jarPath);
  if(c.transitive===false)return;expanded.add(key);
  for(const raw of models.load(pomPath).dependencies){
   if(value(raw,'optional')==='true')continue;
   const managed=management?.get([value(raw,'groupId'),value(raw,'artifactId'),value(raw,'type')??'jar',value(raw,'classifier')??''].join(':'));
   const overrides=managed?.children.filter(n=>['version','scope','exclusions'].includes(n.name))??[];
   const d={...raw,children:[...raw.children.filter(n=>!overrides.some(x=>x.name===n.name)),...overrides]};
   const scope=value(d,'scope')??'compile';if(value(d,'optional')==='true'||['test','provided','runtime'].includes(scope))continue;
   if(scope!=='compile'||value(d,'classifier')||child(d,'exclusions')||value(d,'type')&&value(d,'type')!=='jar')fail('unsupported transitive dependency for '+key);
   visit(coord([value(d,'groupId'),value(d,'artifactId'),value(d,'version')].join(':')),depth+1);
  }
 };
 for(const c of direct)visit(c,0);return [...out].sort();
}

export function importKotlinBuild(files:Map<string,Buffer>):{version:1;modules:KotlinModule[]}|undefined {
 const text=(p:string)=>files.get(p)?.toString('utf8').replace(/^\uFEFF/,'');
 const script=(dir:string,base:string)=>{const prefix=dir?dir+'/':'';const a=text(prefix+base),b=text(prefix+base+'.kts');if(a!==undefined&&b!==undefined)fail('both '+base+' variants exist');return a??b;};
 const modules:KotlinModule[]=[];
 const roots=(dir:string,set:string)=>['kotlin','java'].map(lang=>(dir?dir+'/':'')+'src/'+set+'/'+lang).filter(r=>[...files.keys()].some(p=>p.startsWith(r+'/')&&/\.(kt|java)$/.test(p)));
 if(text('pom.xml')!==undefined){
  if(script('','build.gradle')!==undefined||script('','settings.gradle')!==undefined)fail('both Maven and Gradle roots exist');
  for(const p of files.keys())if(p.startsWith('.mvn/'))fail('Maven extensions/config can affect the model');
  const models=new CapturedMavenModels(files);
  type P={dir:string;xml:Xml;coord:Coord;deps:Xml[];model:MavenModel;kotlin:boolean};
  const projects:P[]=[];
  const visit=(dir:string,parent?:P)=>{
   if(projects.length>=64)fail('too many Maven modules');
   const src=text((dir?dir+'/':'')+'pom.xml');if(src===undefined)fail('missing module POM '+dir);
   const xml=parsePom(src!);if(xml.name!=='project')fail('not a Maven project');
   const model=models.model(xml,parent?.model,[(dir?dir+'/':'')+'pom.xml']);
   const c=coord([model.group,model.artifact,model.version].join(':'));
   let kotlin=false;
   for(const build of model.builds){
   if(build?.children.some(n=>!['plugins'].includes(n.name)))fail('custom Maven build directories/extensions');
   for(const plugin of children(child(build,'plugins'),'plugin')){
    const id=value(plugin,'artifactId');
    if(value(plugin,'inherited')==='false')fail('non-inherited plugin needs explicit model');
    if(!['kotlin-maven-plugin','maven-compiler-plugin','maven-surefire-plugin','maven-jar-plugin'].includes(id??''))fail('unsupported Maven plugin '+id);
    if(id==='kotlin-maven-plugin'){if(value(plugin,'groupId')!=='org.jetbrains.kotlin')fail('unrecognized Kotlin plugin group');kotlin=true;}
    else if(value(plugin,'groupId')&&value(plugin,'groupId')!=='org.apache.maven.plugins')fail('unrecognized Maven plugin group');
    if(child(plugin,'configuration')||child(plugin,'dependencies')||child(plugin,'extensions')&&!(id==='kotlin-maven-plugin'&&value(plugin,'extensions')==='true'))fail('custom Maven compiler/plugin configuration');
    for(const ex of children(child(plugin,'executions'),'execution')){
     if(child(ex,'configuration'))fail('custom Maven execution configuration');
     for(const goal of children(child(ex,'goals'),'goal'))if(!['compile','test-compile','testCompile','jar','test'].includes(goal.text.trim()))fail('custom Maven execution goal');
    }
   }
   }
   const p={dir,xml,coord:c,model,deps:model.dependencies,kotlin};if(projects.some(x=>x.dir===dir||JSON.stringify(x.coord)===JSON.stringify(c)))fail('duplicate Maven module');projects.push(p);
   for(const m of children(child(xml,'modules'),'module'))visit((dir?dir+'/':'')+safe(m.text.trim()),p);
  };visit('');
  const byCoord=new Map(projects.map((p,i)=>[p.coord.group+':'+p.coord.artifact+':'+p.coord.version,{module:'m'+i+'_main',model:p.model}]));
  for(const [i,p]of projects.entries()){
   if(!['jar','pom',undefined].includes(value(p.xml,'packaging')))fail('non-JVM Maven packaging');
   const main=roots(p.dir,'main'),test=roots(p.dir,'test');
   if(!p.kotlin&&[...main,...test].some(r=>[...files.keys()].some(f=>f.startsWith(r+'/')&&f.endsWith('.kt'))))fail('Kotlin sources without Kotlin Maven plugin');
   for(const [set,rs]of [['main',main],['test',test]] as const){if(!rs.length)continue;
    const resolved=resolveKotlinMaven(files,p.model,set,byCoord);
    modules.push({name:'m'+i+'_'+set,roots:[...rs],dependencies:[...new Set([...(set==='test'&&main.length?['m'+i+'_main']:[]),...resolved.dependencies])],libraries:resolved.libraries});
   }
  }
 }else if(script('','build.gradle')!==undefined||script('','settings.gradle')!==undefined){
  for(const p of files.keys())if(/(^|\/)(gradle\.properties|init\.gradle(\.kts)?)$|(^|\/)buildSrc\//.test(p)||p.endsWith('libs.versions.toml')&&p!=='gradle/libs.versions.toml')fail('dynamic Gradle configuration '+p);
  const catalogText=text('gradle/libs.versions.toml'),catalog=catalogText===undefined?undefined:gradleCatalog(catalogText);
  const settings=parseSettings(script('','settings.gradle')??'','Kotlin settings');
  const dirs=['',...settings.includes],projects:{dir:string;parsed:ReturnType<typeof parseBuild>;version?:string}[]=[];
  for(const dir of dirs){let src=script(dir,'build.gradle');if(!src?.trim()){if(dir)fail('missing Gradle module '+dir);continue;}
   if(catalog)src=catalog(src);
   let version:string|undefined;
   // Only literal Kotlin JVM plugin declarations are rewritten for the existing
   // strict Java DSL parser; custom Kotlin blocks still fail explicitly.
   src=src.replace(/(?:kotlin\(\s*["']jvm["']\s*\)|id\s*\(?\s*["']org\.jetbrains\.kotlin\.jvm["']\s*\)?)\s+version\s+["']([\d.]+)["']/g,(_,v)=>{if(version&&version!==v)fail('conflicting Kotlin versions');version=v;return 'id("java")';});
   projects.push({dir,parsed:parseBuild(src,dir+'/build.gradle'),version});
  }
  const index=new Map(projects.map((p,i)=>[p.dir,i]));
  const api=(name:string,seen=new Set<string>()):ReturnType<typeof parseBuild>['deps']=>{
   if(seen.has(name))fail('cyclic Gradle API dependency');seen.add(name);
   const i=index.get(name);if(i===undefined)fail('unknown Gradle project '+name);
   return projects[i!]!.parsed.deps.filter(d=>d.config==='api').flatMap(d=>d.project?[d,...api(d.project,new Set(seen))]:[d]);
  };
  for(const [i,p]of projects.entries())for(const set of ['main','test']){
   const rs=roots(p.dir,set);if(!rs.length)continue;
   if(!p.version&&rs.some(r=>[...files.keys()].some(f=>f.startsWith(r+'/')&&f.endsWith('.kt'))))fail('Kotlin sources without a literal Kotlin JVM plugin version');
   const direct=p.parsed.deps.filter(d=>set==='test'?!['runtimeOnly','testRuntimeOnly'].includes(d.config):['api','implementation','compileOnly'].includes(d.config));
   const deps=direct.flatMap(d=>d.project?[d,...api(d.project)]:[d]);
   const external:Coord[]=deps.flatMap(d=>d.module?[{...d.module,transitive:!['compileOnly','testCompileOnly'].includes(d.config)}]:[]);
   if(p.version)external.push({group:'org.jetbrains.kotlin',artifact:'kotlin-stdlib',version:p.version});
   const dependencies=deps.flatMap(d=>{if(!d.project)return [];const idx=index.get(d.project);if(idx===undefined)fail('unknown Gradle project '+d.project);return ['m'+idx+'_main'];});
   if(set==='test'&&roots(p.dir,'main').length)dependencies.push('m'+i+'_main');
   modules.push({name:'m'+i+'_'+set,roots:rs,dependencies:[...new Set(dependencies)],libraries:libraries(files,external)});
  }
 }else return undefined;
 if(!modules.length)fail('no conventional JVM source sets');
 return {version:1,modules};
}
