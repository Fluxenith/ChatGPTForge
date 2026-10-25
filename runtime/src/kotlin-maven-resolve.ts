import {CapturedMavenModels,pomValue as value,pomChild as child,pomChildren as children,type MavenModel} from './kotlin-maven-model.js';
import {validateJavaJar} from './java-archive.js';
type Dep=MavenModel['dependencies'][number];
const key=(d:Dep)=>[value(d,'groupId'),value(d,'artifactId'),value(d,'type')??'jar',value(d,'classifier')??''].join(':');
const conflictKey=(d:Dep)=>[value(d,'groupId'),value(d,'artifactId'),value(d,'type')==='test-jar'?'jar':value(d,'type')??'jar',value(d,'classifier')??(value(d,'type')==='test-jar'?'tests':'')].join(':');
const scopes:Record<string,Record<string,string>>={compile:{compile:'compile',runtime:'runtime'},provided:{compile:'provided',runtime:'provided'},runtime:{compile:'runtime',runtime:'runtime'},test:{compile:'test',runtime:'test'}};
export function resolveKotlinMaven(files:Map<string,Buffer>,model:MavenModel,set:'main'|'test',reactor:Map<string,{module:string;model:MavenModel}>){
 const models=new CapturedMavenModels(files),chosen=new Map<string,{path?:string;module?:string;scope:string;parent?:string}>();
 type Item={dep:Dep;scope:string;depth:number;excluded:Set<string>;parent?:string};
 let level:Item[]=model.dependencies.map(dep=>({dep,scope:value(dep,'scope')??'compile',depth:1,excluded:new Set()}));
 while(level.length){const next:Item[]=[];
  for(const item of level){
   const d=item.dep,g=value(d,'groupId')??'',a=value(d,'artifactId')??'',k=conflictKey(d);
   if([...item.excluded].some(e=>{const [eg,ea]=e.split(':');return (eg==='*'||eg===g)&&(ea==='*'||ea===a);}))continue;
   if(chosen.has(k))continue;
   const managed=model.management.get(key(d));
   const version=(item.depth>1?value(managed,'version'):undefined)??value(d,'version');
   if(!version||!/^[\w.-]+$/.test(version)||/SNAPSHOT$/i.test(version))throw Error('Maven range/SNAPSHOT requires a resolved build model: '+g+':'+a);
   let scope=item.scope;
   if(item.depth>1&&managed&&value(managed,'scope')&&scope!=='test'&&scope!=='provided')scope=value(managed,'scope')!;
   if(!scopes[scope])throw Error('Unsupported Maven dependency scope: '+scope);
   // Test dependencies are not part of a main compilation. Runtime nodes still
   // participate in mediation, but only test compile includes their classes.
   if(set==='main'&&scope==='test')continue;
   const peer=reactor.get(g+':'+a+':'+version);
   const type=value(d,'type')??'jar',classifier=value(d,'classifier')??(type==='test-jar'?'tests':'');
   if(!['jar','test-jar','pom'].includes(type)||classifier&&!/^[\w.-]+$/.test(classifier))throw Error('Unsupported Maven artifact type/classifier');
   let depModel:MavenModel,path:string|undefined;
   if(peer&&type==='jar'&&!classifier)depModel=peer.model;
   else{
    const pom=models.find(g,a,version);depModel=models.load(pom);
    if(type!=='pom'&&(set==='test'||scope!=='runtime')){
     path=pom.slice(0,-4)+(classifier?'-'+classifier:'')+'.jar';
     const bytes=files.get(path);if(!bytes)throw Error('Missing captured Maven artifact '+path);validateJavaJar(bytes);
    }
   }
   chosen.set(k,{path,...(peer&&type==='jar'&&!classifier?{module:peer.module}:{}),scope,parent:item.parent});
   const excluded=new Set([...item.excluded,...[...children(child(d,'exclusions'),'exclusion'),...(item.depth>1?children(child(managed,'exclusions'),'exclusion'):[])].map(e=>(value(e,'groupId')??'*')+':'+(value(e,'artifactId')??'*'))]);
   for(const t of depModel.dependencies){if(value(t,'optional')==='true')continue;const inherited=scopes[scope]?.[value(t,'scope')??'compile'];if(inherited)next.push({dep:t,scope:inherited,depth:item.depth+1,excluded,parent:k});}
  }
  level=next;if(chosen.size>512||level.some(x=>x.depth>64))throw Error('Maven dependency graph exceeds bounds');
 }
 const libraries:string[]=[],dependencies:string[]=[],visited=new Set<string>();
 const walk=(parent?:string)=>{for(const [k,v]of chosen){if(v.parent!==parent||visited.has(k))continue;visited.add(k);if(set==='test'||v.scope==='compile'||v.scope==='provided'){if(v.path)libraries.push(v.path);if(v.module)dependencies.push(v.module);}walk(k);}};
 walk();return {libraries:[...new Set(libraries)],dependencies:[...new Set(dependencies)]};
}
