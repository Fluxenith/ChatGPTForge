import {lstat} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';
import ts from 'typescript';
import {isPathInsideRoot,resolveCanonicalAllowedPath} from './roots.js';
import {boundedText,configMatches,sourceKey} from './code-project.js';

// Each project retains its own settings and roots. Configs are captured once;
// compiler configuration reads are restricted to these immutable snapshots.
export async function loadCodeConfigGraph(root:string,candidates:Map<string,string>,entry:string,defaults:ts.CompilerOptions) {
  const configs=new Map<string,{name:string;text:string}>();
  const nodes:{config:string;rootNames:string[];options:ts.CompilerOptions;references?:ts.ProjectReference[]}[]=[];
  const active=new Set<string>(),completed=new Set<string>();
  async function configPath(path:string) {
    if(!isPathInsideRoot(path,root))throw new Error('Project config is outside the project');
    let current=root;
    for(const part of relative(root,path).split(/[\\/]/).filter(Boolean)) {
      current=join(current,part);
      if((await lstat(current)).isSymbolicLink())throw new Error('Project config refuses linked paths/junctions');
    }
    const canonical=await resolveCanonicalAllowedPath(path,root,[root]);
    if(extname(canonical).toLowerCase()!=='.json')throw new Error('Project config must be JSON');
    return canonical;
  }
  async function load(path:string,chain:string[]=[]) {
    const canonical=await configPath(path),key=sourceKey(canonical);
    if(chain.includes(key))throw new Error('Project config extends cycle');
    if(chain.length>=8)throw new Error('Project config exceeds 8-file inheritance limit');
    let item=configs.get(key);
    if(!item) {
      if(configs.size>=128)throw new Error('Project graph exceeds 128 captured configs');
      item={name:canonical,text:(await boundedText(canonical,64*1024)).text};configs.set(key,item);
    }
    const parsed=ts.parseConfigFileTextToJson(canonical,item.text);
    if(parsed.error)throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText,'\n'));
    const json=parsed.config as {extends?:unknown};
    if(!json||typeof json!=='object'||Array.isArray(json))throw new Error('Project config must be an object');
    const extensions=Array.isArray(json.extends)?json.extends:json.extends===undefined?[]:[json.extends];
    for(const extension of extensions) {
      if(typeof extension!=='string'||isAbsolute(extension)||!/^\.\.?[\\/]/.test(extension))throw new Error('Config extends must use a relative JSON path inside the project; package and external configs are unsupported');
      const target=resolve(dirname(canonical),extension);await load(extname(target)?target:`${target}.json`,[...chain,key]);
    }
    return {canonical,key,json};
  }
  const host:ts.ParseConfigHost={
    useCaseSensitiveFileNames:process.platform!=='win32',
    fileExists:path=>configs.has(sourceKey(path))||candidates.has(sourceKey(path)),
    readFile:path=>configs.get(sourceKey(path))?.text,
    readDirectory:(directory,extensions,excludes,includes)=>[...candidates.values()].filter(path=>
      isPathInsideRoot(path,directory)&&(!extensions||extensions.some(e=>path.toLowerCase().endsWith(e.toLowerCase())))&&
      (!includes||includes.some(pattern=>configMatches(path,directory,pattern)))&&!excludes?.some(pattern=>configMatches(path,directory,pattern))),
  };
  async function visit(path:string) {
    const {canonical,key,json}=await load(path);
    if(active.has(key))throw new Error('Project reference cycle');
    if(completed.has(key))return;
    if(active.size+completed.size>=32)throw new Error('Project graph exceeds 32 projects');
    active.add(key);
    const parsed=ts.parseJsonConfigFileContent(json,host,dirname(canonical),undefined,canonical);
    const errors=parsed.errors.filter(error=>error.code!==18003);
    if(errors.length)throw new Error(errors.map(error=>ts.flattenDiagnosticMessageText(error.messageText,'\n')).join('\n'));
    const references=parsed.projectReferences?.map(ref=>({...ref,path:ts.resolveProjectReferencePath(ref)}));
    for(const ref of references??[])await visit(ref.path);
    nodes.push({config:canonical,rootNames:parsed.fileNames,options:{...defaults,...parsed.options,allowJs:parsed.options.allowJs??false},references});
    active.delete(key);completed.add(key);
  }
  await visit(entry);
  return {configs,nodes};
}
