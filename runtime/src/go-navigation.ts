import {join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {CodeNavigationInput} from './code-navigation.js';
import {runGoAnalysis,type GoAnalysisPhase} from './go-analysis-runtime.js';
import {goHash,readGoInput,type GoProject} from './go-project.js';

const keywords=new Set('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'.split(' '));
export function goIdentifier(value:string){return value!=='_'&&/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(value)&&!keywords.has(value);}
export function goOffset(text:string,line:number,character:number) {
  if(!Number.isInteger(line)||!Number.isInteger(character)||line<0||character<0)throw new Error('Invalid Go UTF-16 position');
  const lines=text.split(/\r\n|\r|\n/),value=lines[line];
  if(value===undefined||character>value.length)throw new Error('Go position is outside its source');
  if(character>0&&character<value.length&&/[\uDC00-\uDFFF]/.test(value[character]!)&&/[\uD800-\uDBFF]/.test(value[character-1]!))throw new Error('Go position splits a UTF-16 surrogate pair');
  let offset=0,index=0;
  for(const ending of text.matchAll(/\r\n|\r|\n/g)){if(index++===line)break;offset=ending.index+ending[0].length;}
  return offset+character;
}
type Point={line:number;character:number};type Range={start:Point;end:Point};
interface Location {uri:string;range:Range}
interface Replacement {start:number;length:number;old_text:string;new_text:string;line:number;column:number;end_line:number;end_column:number}
const kinds=['','file','module','namespace','package','class','method','property','field','constructor','enum','interface','function','variable','constant','string','number','boolean','array','object','key','null','enum_member','struct','event','operator','type_parameter'];
export async function navigateGo(input:CodeNavigationInput,roots:string[],onCapture?:(project:GoProject)=>void,signal?:AbortSignal,onPhase?:(phase:GoAnalysisPhase,elapsedMs:number)=>void) {
  if(!['symbols','diagnostics'].includes(input.action)&&!input.file)throw new Error('file is required for this action');
  if(input.action==='symbols'&&!input.query)throw new Error('query is required for symbols');
  if(['definition','references','rename_preview'].includes(input.action)&&(!input.line||!input.column))throw new Error('line and column (1-based) are required');
  if(input.action==='rename_preview'&&!goIdentifier(input.new_name??''))throw new Error('new_name must be a valid, non-keyword Go identifier');
  const {project,reply}=await runGoAnalysis(input,roots,{signal,onCaptured:onCapture,onPhase});
  const index=new Map<string,{file:string;path:string;sha256:string;bytes:number;read_only:boolean;origin:string}>();
  for(const [treeIndex,tree] of project.trees.entries())for(const pin of tree.files) {
    const vendor=treeIndex===0&&(pin.file==='vendor'||pin.file.startsWith('vendor/'));
    const origin=treeIndex===0?(vendor?'go_vendor':'project'):treeIndex===1?'go_standard_library':tree.filter?'go_module_metadata':'go_module';
    const file=treeIndex===0?pin.file:treeIndex===1?'go:'+pin.file:tree.filter?'go-module-metadata:'+pin.file:'go-module:'+relative(join(project.snapshot,'..','gomodcache'),tree.destination).replaceAll('\\','/')+'/'+pin.file;
    index.set(resolve(tree.destination,pin.file).toLowerCase(),{file,path:join(tree.root,pin.file),sha256:pin.sha256,bytes:pin.bytes,read_only:treeIndex!==0||vendor,origin});
  }
  const texts=new Map<string,string>();
  async function source(uri:string) {
    if(typeof uri!=='string'||!uri.startsWith('file:'))throw new Error('Go result has an unsupported URI');
    const item=index.get(resolve(fileURLToPath(uri)).toLowerCase());
    if(!item)throw new Error('gopls returned a file outside captured inputs');
    let text=project.sources.get(item.file)??texts.get(item.file);
    if(text===undefined){const bytes=await readGoInput(item.path,Math.max(item.bytes,1),signal);if(goHash(bytes)!==item.sha256)throw new Error('Go result source changed after capture');text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw new Error('Go result source requires UTF-8');texts.set(item.file,text);}
    return {item,text};
  }
  async function location(uri:string,range:Range) {
    const value=await source(uri);
    if(!range?.start||!range?.end)throw new Error('Go result omitted its source range');
    const start=goOffset(value.text,range.start.line,range.start.character),end=goOffset(value.text,range.end.line,range.end.character);
    if(end<start)throw new Error('Go result has a reversed source range');
    return {...value,start,end,place:{file:value.item.file,line:range.start.line+1,column:range.start.character+1,end_line:range.end.line+1,end_column:range.end.character+1,
      ...(value.item.read_only?{read_only:true,origin:value.item.origin}:{})}};
  }
  const results:Record<string,unknown>[]=[];let total=0;
  const add=(result:Record<string,unknown>)=>{total++;if(results.length<300)results.push(result);};
  const raw=reply.raw;
  let rename:{can_rename:boolean;reason?:string}|undefined;
  let edits:{file:string;sha256:string;replacements:Replacement[]}[]|undefined;
  if(input.action==='rename_preview') {
    const value=raw as {changes?:Record<string,{range:Range;newText:string}[]>;documentChanges?:{textDocument?:{uri:string};edits?:{range:Range;newText:string}[];kind?:string}[]}|null;
    const byFile=new Map<string,NonNullable<typeof edits>[number]>();
    const apply=async(uri:string,entries:{range:Range;newText:string}[])=>{
      if(!Array.isArray(entries))throw new Error('Go rename omitted its edits');
      for(const entry of entries) {
        if(total>=300)throw new Error('Rename exceeds 300 edits; no partial rename plan is returned');
        const value=await location(uri,entry.range);
        if(value.item.read_only)throw new Error('Go rename touches a read-only environment');
        const old_text=value.text.slice(value.start,value.end);
        if(!goIdentifier(old_text)||entry.newText!==input.new_name)throw new Error('Go rename returned a non-identifier edit or file/package move');
        if(old_text===entry.newText)continue;
        let file=byFile.get(value.item.file);
        if(!file){file={file:value.item.file,sha256:value.item.sha256,replacements:[]};byFile.set(file.file,file);}
        file.replacements.push({start:value.start,length:value.end-value.start,old_text,new_text:entry.newText,...value.place});
        add({...value.place,old_text,new_text:entry.newText});
      }
    };
    if(value?.changes&&value.documentChanges)throw new Error('Go rename returned ambiguous edit representations');
    for(const [uri,entries] of Object.entries(value?.changes??{}))await apply(uri,entries);
    for(const change of value?.documentChanges??[]) {
      if(change.kind||!change.textDocument?.uri||!Array.isArray(change.edits))throw new Error('Go rename resource operations are refused');
      await apply(change.textDocument.uri,change.edits);
    }
    edits=[...byFile.values()];
    if(edits.length>64)throw new Error('Go rename exceeds the 64-file recoverable batch bound');
    for(const file of edits) {
      file.replacements.sort((a,b)=>b.start-a.start);let previous=project.sources.get(file.file)!.length;
      for(const entry of file.replacements){if(entry.start+entry.length>previous)throw new Error('Go rename returned overlapping edits');previous=entry.start;}
    }
    rename={can_rename:edits.length>0,...(!edits.length?{reason:'gopls returned no identifier edits'}:{})};
  } else if(input.action==='outline') {
    const target=project.selected.find(file=>file.toLowerCase()===relative(project.root,resolve(project.root,input.file!)).replaceAll('\\','/').toLowerCase())!;
    const uri=pathToFileURL(resolve(project.snapshot,target)).href;
    const visit=async(entries:any[],parent:string)=>{
      for(const entry of entries){const place=await location(entry.location?.uri??uri,entry.location?.range??entry.range);add({name:entry.name,kind:kinds[entry.kind]??String(entry.kind),parent,...place.place});if(entry.children)await visit(entry.children,entry.name);}
    };
    if(raw!==null&&!Array.isArray(raw))throw new Error('Go outline is invalid');
    await visit((raw??[]) as any[],'');
  } else {
    const entries=raw===null?[]:Array.isArray(raw)?raw:[raw];
    if(entries.length>10000)throw new Error('Go result count exceeds bounds');
    for(const entry of entries as any[]) {
      if(input.action==='symbols') {
        const value=await location(entry.location.uri,entry.location.range);
        if(value.item.read_only||input.files&&!project.selected.includes(value.item.file))continue;
        add({name:entry.name,kind:kinds[entry.kind]??String(entry.kind),parent:entry.containerName??'',...value.place});
      } else if(input.action==='diagnostics') {
        const value=await location(entry.uri,entry.range);
        add({code:entry.code??entry.source??'gopls',severity:['','error','warning','information','hint'][entry.severity]??'error',message:entry.message,...value.place});
      } else {
        const value=await location(entry.targetUri??entry.uri,entry.targetSelectionRange??entry.range);
        add({...value.place,...(input.action==='references'?{includes_declaration:true}:{})});
      }
    }
    if(input.action==='diagnostics')for(const error of reply.package_errors)add({code:'go-list',severity:'error',message:error.message,package_directory:error.directory});
  }
  return {scope:input.files?'selected_files_with_project_context' as const:'project_files' as const,
    project:{language:'go',source_files:project.sources.size,source_bytes:project.trees[0]!.files.filter(file=>project.sources.has(file.file)).reduce((sum,file)=>sum+file.bytes,0),
      analysis_files:reply.analysis_files,configs:project.trees[0]!.files.filter(file=>/(^|\/)(go\.(mod|sum|work)|go\.work\.sum)$/.test(file.file)),
      language_server:reply.language_server,diagnostics_kind:'syntax_and_types',diagnostics_complete:reply.diagnostics_complete,
      toolchain_version:project.toolchain_version,build_flags:reply.build_flags,goos:reply.goos,goarch:reply.goarch,cgo_enabled:reply.cgo_enabled,
      environment:{fingerprint:project.environment.fingerprint,files:project.trees.slice(1).reduce((sum,tree)=>sum+tree.files.length,0),bytes:project.trees.slice(1).reduce((sum,tree)=>sum+tree.files.reduce((bytes,file)=>bytes+file.bytes,0),0),installed_modules:project.trees.filter(tree=>tree.filter===undefined&&tree!==project.trees[0]&&tree!==project.trees[1]).length}},
    limitations:'Bounded Go module/workspace snapshots with pinned gopls over UTF-16 LSP and an installed Go 1.26+ toolchain. Windows builds disable CGO. The complete bounded toolchain, module graph metadata, installed module sources and vendored assets are captured. Network module/toolchain downloads, project generators and tests are not run during analysis. Go package loading may invoke the trusted captured compiler on project sources. External local replacements and linked inputs are refused. Selected files retain full project context; rename may update other captured project files. Standard-library/module/vendor results are read-only. File/package moves and non-identifier rename edits are refused. Diagnostics and references do not replace full project build/tests; re-query and verify after edits.',
    snapshots:project.trees[0]!.files.filter(file=>project.sources.has(file.file)).map(({file,sha256})=>({file,sha256})),
    total,truncated:total>results.length,results,rename,edits};
}
