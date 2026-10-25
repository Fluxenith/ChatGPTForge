import {parsePom} from './java-maven-static.js';
type Xml=ReturnType<typeof parsePom>;
export const pomChild=(n:Xml|undefined,k:string)=>n?.children.find(c=>c.name===k);
export const pomValue=(n:Xml|undefined,k:string)=>pomChild(n,k)?.text.trim();
export const pomChildren=(n:Xml|undefined,k:string)=>n?.children.filter(c=>c.name===k)??[];
const fail=(why:string):never=>{throw Error('Kotlin Maven model: '+why);};
const key=(d:Xml)=>[pomValue(d,'groupId'),pomValue(d,'artifactId'),pomValue(d,'type')??'jar',pomValue(d,'classifier')??''].join(':');
export interface MavenModel {group:string;artifact:string;version:string;props:Map<string,string>;management:Map<string,Xml>;managementTemplates:Map<string,Xml>;dependencyTemplates:Xml[];dependencies:Xml[];builds:Xml[]}
export class CapturedMavenModels {
 constructor(private files:Map<string,Buffer>){}
 find(group:string,artifact:string,version:string){
  if([group,artifact,version].some(p=>!p||!/^[\w.-]+$/.test(p)||p==='.'||p==='..'))fail('invalid dependency coordinates');
  const suffix=group.replaceAll('.','/')+'/'+artifact+'/'+version+'/'+artifact+'-'+version+'.pom';
  const matches=[...this.files.keys()].filter(p=>p===suffix||p.endsWith('/'+suffix));
  if(matches.length!==1)fail('need one captured POM for '+group+':'+artifact+':'+version);
  return matches[0]!;
 }
 load(path:string,ancestors:string[]=[]):MavenModel {
  if(ancestors.includes(path)||ancestors.length>=32)fail('cyclic or over-depth parent/BOM graph');
  const raw=this.files.get(path);if(!raw)fail('missing POM '+path);
  return this.model(parsePom(raw!.toString('utf8')),undefined,[...ancestors,path]);
 }
 model(xml:Xml,reactorParent?:MavenModel,ancestors:string[]=[]):MavenModel {
  if(pomChild(xml,'profiles')||pomChild(pomChild(xml,'distributionManagement'),'relocation'))fail('profiles/relocation require explicit model');
  const declaration=pomChild(xml,'parent');let parent:MavenModel|undefined;
  if(declaration){
   const g=pomValue(declaration,'groupId')??'',a=pomValue(declaration,'artifactId')??'',v=pomValue(declaration,'version')??'';
   parent=reactorParent?.group===g&&reactorParent.artifact===a&&reactorParent.version===v?reactorParent:this.load(this.find(g,a,v),ancestors);
  }
  const props=new Map(parent?.props);
  for(const p of pomChild(xml,'properties')?.children??[])props.set(p.name,p.text.trim());
  const expand=(s:string)=>{for(let i=0;i<32&&s.includes('${');i++)s=s.replace(/\$\{([^}]+)\}/g,(_,k)=>props.get(k)??fail('unknown property '+k));if(s.includes('${'))fail('cyclic properties');return s;};
  const group=expand(pomValue(xml,'groupId')??parent?.group??''),artifact=expand(pomValue(xml,'artifactId')??''),version=expand(pomValue(xml,'version')??parent?.version??'');
  for(const [k,v]of Object.entries({groupId:group,artifactId:artifact,version}))for(const prefix of ['project.','pom.'])props.set(prefix+k,v);
  const normalize=(n:Xml):Xml=>({...n,text:expand(n.text),children:n.children.map(normalize)});
  const managementTemplates=new Map(parent?.managementTemplates);
  const management=new Map([...managementTemplates].map(([k,d])=>[k,normalize(d)])),localRaw=pomChildren(pomChild(pomChild(xml,'dependencyManagement'),'dependencies'),'dependency'),local=localRaw.map(normalize);
  const imports=new Map<string,Xml>();
  for(const d of local){if(pomValue(d,'scope')!=='import')continue;
   if(pomValue(d,'type')!=='pom')fail('BOM import must have type pom');
   const bom=this.load(this.find(pomValue(d,'groupId')??'',pomValue(d,'artifactId')??'',pomValue(d,'version')??''),ancestors);
   for(const [k,v]of bom.management)if(!imports.has(k))imports.set(k,v);
  }
  for(const [k,v]of imports)if(!management.has(k)){management.set(k,v);managementTemplates.set(k,v);}
  for(const [i,d]of local.entries())if(pomValue(d,'scope')!=='import'){management.set(key(d),d);managementTemplates.set(key(d),localRaw[i]!);}
  const merged=new Map((parent?.dependencyTemplates??[]).map(d=>[key(normalize(d)),d]));
  for(const raw of pomChildren(pomChild(xml,'dependencies'),'dependency'))merged.set(key(normalize(raw)),raw);
  const dependencyTemplates=[...merged.values()];
  const dependencies=dependencyTemplates.map(normalize).map(d=>{
   const defaults=management.get(key(d));if(!defaults)return d;
   return {...d,children:[...d.children,...defaults.children.filter(n=>!d.children.some(c=>c.name===n.name))]};
  });
  const build=pomChild(xml,'build');
  return {group,artifact,version,props,management,managementTemplates,dependencyTemplates,dependencies,builds:[...(parent?.builds??[]),...(build?[build]:[])]};
 }
}
