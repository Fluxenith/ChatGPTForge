// Static JVM workspace model for the pinned JetBrains Kotlin LSP. Build scripts
// never execute inside a rename preview. Dependencies must be captured inputs.
import {importKotlinBuild} from './kotlin-build-import.js';
import {kotlinBuildInputs,kotlinInputHash} from './kotlin-model-inputs.js';
import {kotlinSettings,validateKotlinCompiler,type KotlinCompilerSettings} from './kotlin-compiler-settings.js';
import {kotlinModelFiles} from './kotlin-generated.js';
export const KOTLIN_MODEL='.forge/kotlin-workspace.json';
export const kotlinBuildFile=(path:string)=>/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew(\.bat)?|mvnw(\.cmd)?)$/i.test(path)||/(^|\/)(\.idea|\.gradle|\.mvn)\//i.test(path);
interface Module {name:string;roots:string[];dependencies?:string[];libraries?:string[];compiler?:KotlinCompilerSettings}
export function kotlinWorkspace(files:Map<string,Buffer>,target:string):string {
  const raw=files.get(KOTLIN_MODEL);
  const imported=raw?undefined:importKotlinBuild(files);
  if(!raw&&!imported&&[...files.keys()].some(p=>kotlinBuildFile(p)||p==='workspace.json'))throw Error(`Kotlin build projects require ${KOTLIN_MODEL} with explicit JVM modules, source roots and captured library paths`);
  const spec=raw?JSON.parse(raw.toString('utf8')):imported??{version:1,modules:[{name:'forge',roots:['.']}]};
  if(!spec||Object.keys(spec).some(k=>!(spec.version===3?['version','modules','input_hashes','library_hashes','generated_hashes','generated_origins']:spec.version===2?['version','modules','input_hashes','library_hashes']:['version','modules']).includes(k)))throw Error('Unsupported Kotlin workspace settings');
  if(![1,2,3].includes(spec.version)||!Array.isArray(spec.modules)||!spec.modules.length||spec.modules.length>128)throw Error('Invalid Kotlin workspace model version/modules');
  if(spec.version>=2){
    const current=kotlinBuildInputs(files),saved=spec.input_hashes;
    if(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).length!==Object.keys(current).length||Object.entries(current).some(([p,h])=>saved[p]!==h))throw Error('Kotlin dynamic model is stale; run explicit build import again');
    if(!spec.library_hashes||typeof spec.library_hashes!=='object'||Array.isArray(spec.library_hashes))throw Error('Missing dynamic library hashes');
  }
  const names=new Set<string>(),roots:string[]=[],libraries=new Set<string>();
  const path=(p:unknown)=>{if(typeof p!=='string'||!p||p.includes('\\')||p.includes(':')||p.startsWith('/')||p.split('/').some(x=>x==='..'||x==='')||p!=='.'&&p.split('/').includes('.'))throw Error('Kotlin model paths must be project-relative without traversal');return p;};
  if(spec.version===3){
    for(const k of ['generated_hashes','generated_origins'])if(!spec[k]||typeof spec[k]!=='object'||Array.isArray(spec[k]))throw Error('Invalid generated source manifest');
    if(Object.keys(spec.generated_hashes).length!==Object.keys(spec.generated_origins).length)throw Error('Incomplete generated source provenance');
    for(const [p,h]of Object.entries(spec.generated_hashes)){path(p);path(spec.generated_origins[p]);if(!p.startsWith('.forge/kotlin-import/')||!files.has(p)||kotlinInputHash(files.get(p)!)!==h)throw Error('Generated source snapshot changed: '+p);}
  }
  const modelFiles=kotlinModelFiles(files);
  for(const m of spec.modules as Module[]){
    if(!m||Object.keys(m).some(k=>!(spec.version===3?['name','roots','dependencies','libraries','compiler']:['name','roots','dependencies','libraries']).includes(k)))throw Error('Unsupported Kotlin module settings');
    if(typeof m.name!=='string'||!/^[\w.-]{1,128}$/.test(m.name)||names.has(m.name))throw Error('Invalid or duplicate Kotlin module name');names.add(m.name);
    if(!Array.isArray(m.roots)||!m.roots.length)throw Error('Kotlin module requires source roots');
    for(const r of m.roots){path(r);if(roots.some(p=>p===r||p==='.'||r==='.'||p.startsWith(r+'/')||r.startsWith(p+'/')))throw Error('Kotlin source roots overlap');roots.push(r);if(![...files.keys()].some(p=>(r==='.'||p.startsWith(r+'/'))&&/\.(kt|java)$/.test(p)))throw Error('Kotlin source root has no captured JVM sources: '+r);}
    if(m.dependencies!==undefined&&!Array.isArray(m.dependencies)||m.libraries!==undefined&&!Array.isArray(m.libraries))throw Error('Invalid Kotlin dependencies');
    if(m.compiler)validateKotlinCompiler(m.compiler);
    for(const lib of [...(m.libraries??[]),...(m.compiler?.pluginClasspaths??[])]){path(lib);if(!lib.endsWith('.jar')||!files.has(lib))throw Error('Kotlin library must be a captured JAR: '+lib);if(spec.version>=2&&spec.library_hashes[lib]!==kotlinInputHash(files.get(lib)!))throw Error('Dynamic Kotlin library changed: '+lib);if(m.libraries?.includes(lib))libraries.add(lib);}
  }
  if(!roots.some(r=>r==='.'||target.startsWith(r+'/')))throw Error('Kotlin target is outside the declared source roots');
  for(const m of spec.modules as Module[])for(const dep of m.dependencies??[])if(!names.has(dep)||dep===m.name)throw Error('Unknown/self Kotlin module dependency: '+dep);
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(name:string)=>{if(visiting.has(name))throw Error('Cyclic Kotlin module dependencies');if(visited.has(name))return;visiting.add(name);for(const dep of (spec.modules as Module[]).find(m=>m.name===name)!.dependencies??[])visit(dep);visiting.delete(name);visited.add(name);};
  for(const name of names)visit(name);
  for(const file of files.keys())if(modelFiles.copied(file)&&/\.(kt|java)$/.test(file)&&!roots.some(r=>r==='.'||file.startsWith(r+'/')))throw Error('Kotlin model omits captured JVM source: '+file);
  return JSON.stringify({modules:(spec.modules as Module[]).map(m=>({name:m.name,type:'JAVA_MODULE',
    dependencies:[{type:'moduleSource'},{type:'inheritedSdk'},...(m.dependencies??[]).map(name=>({type:'module',name,scope:'compile'})),...(m.libraries??[]).map(name=>({type:'library',name,scope:'compile'}))],
    contentRoots:m.roots.map(r=>({path:'<WORKSPACE>/'+(r==='.'?'':r),sourceRoots:[{path:'<WORKSPACE>/'+(r==='.'?'':r),type:'java-source'}]}))})),
    kotlinSettings:(spec.modules as Module[]).filter(m=>m.compiler).map(m=>kotlinSettings(m.name,m.roots,m.compiler!)),
    libraries:[...libraries].map(name=>({name,type:null,roots:[{path:'<WORKSPACE>/'+name,type:'CLASSES'}]}))});
}
