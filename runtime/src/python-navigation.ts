import type {CodeNavigationInput} from './code-navigation.js';
import {runPythonAnalysis} from './python-analysis-runtime.js';
import {pythonExcludedDirectories,pythonHash,type PythonProject} from './python-project.js';

function point(text:string,line:number,column:number) {
  const lines=text.split(/\r\n|\r|\n/),value=lines[line-1];
  if(value===undefined)throw new Error('Python result has a line outside its source');
  const clean=line===1?value.replace(/^\uFEFF/,''):value;
  const codepoints=[...clean];
  if(column<0||column>codepoints.length)throw new Error('Python result has a column outside its source');
  return {line,column:codepoints.slice(0,column).join('').length+1+(line===1&&value.startsWith('\uFEFF')?1:0)};
}
function utf16Point(text:string,line:number,column:number) {
  const value=text.split(/\r\n|\r|\n/)[line-1];
  if(value===undefined||!Number.isSafeInteger(column)||column<0||column>value.length)
    throw new Error('Python type diagnostic has a position outside its source');
  if(column>0&&/[\uDC00-\uDFFF]/.test(value[column]??'')&&/[\uD800-\uDBFF]/.test(value[column-1]!))
    throw new Error('Python type diagnostic splits a UTF-16 surrogate pair');
  return {line,column:column+1};
}
function preserveFormat(before:string,after:string) {
  after=after.replace(/^\uFEFF/,'');
  const endings=before.match(/\r\n|\r|\n/g)??[];let index=0;
  after=after.replace(/\r\n|\r|\n/g,()=>{
    const ending=endings[index++];if(ending===undefined)throw new Error('Python rename changed source line structure');return ending;
  });
  if(index!==endings.length)throw new Error('Python rename changed source line structure');
  return (before.startsWith('\uFEFF')?'\uFEFF':'')+after;
}
export async function navigatePython(input:CodeNavigationInput,roots:string[],onCapture?:(project:PythonProject)=>void,signal?:AbortSignal) {
  if(!['symbols','diagnostics'].includes(input.action)&&!input.file)throw new Error('file is required for this action');
  if(input.action==='symbols'&&!input.query)throw new Error('query is required for symbols');
  if(['definition','references','rename_preview'].includes(input.action)&&(!input.line||!input.column))throw new Error('line and column (1-based) are required');
  const {project,reply}=await runPythonAnalysis(input,roots,{signal,onCaptured:onCapture});
  const results:Record<string,unknown>[]=[];let total=0;
  const add=(item:Record<string,unknown>)=>{total++;if(results.length<300)results.push(item);};
  for(const entry of reply.results) {
    const file=String(entry.file),text=project.sources.get(file)??project.dependencies.sources.get(file);
    const convert=entry.position_encoding==='utf16'?utf16Point:point;
    const start=text===undefined?{line:Number(entry.line),column:Number(entry.column)+1}:convert(text,Number(entry.line),Number(entry.column));
    const end=text===undefined?{line:Number(entry.end_line),column:Number(entry.end_column)+1}:convert(text,Number(entry.end_line),Number(entry.end_column));
    add({...entry,...start,end_line:end.line,end_column:end.column});
  }
  const edits: {file:string;sha256:string;replacements:{start:number;length:number;old_text:string;new_text:string;line:number;column:number;end_line:number;end_column:number}[]}[]=[];
  if(!Array.isArray(reply.edits))throw new Error('Python analysis omitted identifier edits');
  if(reply.edits.length>300)throw new Error('Rename exceeds 300 edits; no partial rename plan is returned');
  for(const [file,value] of Object.entries(reply.changed)) {
    const before=project.sources.get(file);if(before===undefined||file.toLowerCase().endsWith('.pyi'))throw new Error('Python rename touches read-only or uncaptured sources');
    const after=preserveFormat(before,value),replacements:typeof edits[number]['replacements']=[],starts=[0];
    for(const match of before.matchAll(/\r\n|\r|\n/g))starts.push(match.index+match[0].length);
    for(const entry of reply.edits.filter(item=>item.file===file)) {
      const a=point(before,entry.line,entry.column),b=point(before,entry.end_line,entry.end_column);
      const start=starts[a.line-1]!+a.column-1,end=starts[b.line-1]!+b.column-1;
      if(before.slice(start,end)!==entry.old_text||entry.new_text!==input.new_name)throw new Error('Python rename has an invalid identifier edit');
      if(entry.old_text===entry.new_text)continue;
      const replacement={start,length:end-start,old_text:entry.old_text,new_text:entry.new_text,...a,end_line:b.line,end_column:b.column};
      replacements.push(replacement);add({file,...a,end_line:b.line,end_column:b.column,old_text:entry.old_text,new_text:entry.new_text});
    }
    replacements.sort((a,b)=>b.start-a.start);
    let applied=before,previous=before.length;
    for(const entry of replacements){if(entry.start+entry.length>previous)throw new Error('Python rename has overlapping edits');previous=entry.start;applied=applied.slice(0,entry.start)+entry.new_text+applied.slice(entry.start+entry.length);}
    if(applied!==after)throw new Error('Python rename content and identifier plan disagree');
    if(replacements.length)edits.push({file,sha256:pythonHash(before),replacements});
  }
  if(edits.reduce((count,item)=>count+item.replacements.length,0)>300)throw new Error('Rename exceeds 300 edits; no partial rename plan is returned');
  return {
    scope:input.files?'selected_files_only' as const:'project_files' as const,
    project:{language:'python',source_files:project.snapshots.length,source_bytes:project.snapshots.reduce((sum,item)=>sum+item.bytes,0),opaque_sources:[...project.opaque_sources.keys()],configs:project.configs,import_settings:reply.import_settings,source_selection:reply.source_selection,skipped_links:project.skipped_links,excluded_directories:pythonExcludedDirectories,environment:{fingerprint:project.environment.fingerprint,files:project.environment.pins.length,python_version:reply.python_version,jedi_version:reply.jedi_version,parso_version:reply.parso_version,dependencies:{root:project.dependencies.root,selection:project.dependencies.selection,site_packages:project.dependencies.site_packages,files:project.dependencies.snapshots.length,bytes:project.dependencies.snapshots.reduce((sum,item)=>sum+item.bytes,0),snapshots:project.dependencies.snapshots.slice(0,100),snapshots_truncated:project.dependencies.snapshots.length>100,opaque_sources:[...project.dependencies.opaque_sources.keys()],ignored_files:project.dependencies.ignored_files.slice(0,100),ignored_files_truncated:project.dependencies.ignored_files.length>100,path_roots:project.dependencies.path_roots,path_ignored:project.dependencies.path_ignored}},diagnostics_kind:reply.type_checker?'syntax_and_type':'syntax',...(reply.type_checker?{type_checker:reply.type_checker}:{})},
    limitations:'Static Python navigation and rename use bounded Jedi/Parso snapshots. Diagnostics additionally run pinned Pyright in an owned Windows Job on the same snapshot, with configured entrypoints/import roots and a restricted set of checked Pyright options; syntax errors are retained from AST. Source dependencies, local venv, installed stubs and validated project-local custom stubPath are captured within read-only analysis snapshots. External/global environments, editable .pth/egg-link paths, binary extensions, external typeshedPath and most checker options are not applied. Selected-file mode omits project configuration and dependencies. Project interpreters, site hooks and modules are never executed. Dynamic imports and references can be incomplete. Rename preserves explicit aliases but may have collisions; run actual acceptance commands afterward. Module/file moves are refused. Re-query after edits.',
    snapshots:project.snapshots.map(({file,sha256})=>({file,sha256})),
    total,truncated:total>results.length,results,rename:reply.rename?{...reply.rename,can_rename:edits.length>0}:undefined,edits:input.action==='rename_preview'?edits:undefined,
  };
}
