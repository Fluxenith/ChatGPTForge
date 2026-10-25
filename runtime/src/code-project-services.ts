import ts from 'typescript';
import {sourceKey,type CodeProject} from './code-project.js';

export function openCodeServices(project:CodeProject,selected?:string) {
  const {root,texts,names,environment,configs}=project;
  const capturedText=(file:string)=>texts.get(sourceKey(file))??environment.captures.get(sourceKey(file))?.text??configs.get(sourceKey(file))?.text;
  const capturedNames=[...names.values(),...[...environment.captures.values()].map(item=>item.path),...[...configs.values()].map(item=>item.name)];
  const registry=ts.createDocumentRegistry(process.platform!=='win32',root);
  const parsed=new Map<string,ts.ParsedCommandLine>();
  for(const node of project.projects)if(node.config)parsed.set(sourceKey(node.config),{
    fileNames:node.rootNames,options:{...node.options,configFile:ts.parseJsonText(node.config,configs.get(sourceKey(node.config))!.text)},projectReferences:node.references,errors:[],
  });
  type Context={node:CodeProject['projects'][number];service:ts.LanguageService;program:ts.Program};
  const contexts=new Map<CodeProject['projects'][number],Context>();
  function context(node:CodeProject['projects'][number]):Context {
    const cached=contexts.get(node);if(cached)return cached;
    const host:ts.LanguageServiceHost&Pick<ts.WatchCompilerHost<ts.BuilderProgram>,'useSourceOfProjectReferenceRedirect'>={
      getCompilationSettings:()=>node.options,
      getScriptFileNames:()=>[...node.rootNames,...[...node.environment.captures.values()].filter(item=>item.kind!=='manifest'&&item.kind!=='project_output').map(item=>item.path)],
      getProjectReferences:()=>node.references,
      getParsedCommandLine:file=>parsed.get(sourceKey(file)),
      useSourceOfProjectReferenceRedirect:()=>true,
      getScriptVersion:()=> '1',
      getScriptSnapshot:file=>{const text=capturedText(file);return text===undefined?undefined:ts.ScriptSnapshot.fromString(text);},
      getCurrentDirectory:()=>root,
      getDefaultLibFileName:()=>node.environment.defaultLib,
      fileExists:file=>capturedText(file)!==undefined,readFile:capturedText,readDirectory:()=>[],
      directoryExists:directory=>capturedNames.some(file=>sourceKey(file).startsWith(sourceKey(directory).replace(/\/$/,'')+'/')),
      getDirectories:directory=>{const prefix=sourceKey(directory).replace(/\/$/,'')+'/';return [...new Set(capturedNames.map(sourceKey).filter(file=>file.startsWith(prefix)).map(file=>file.slice(prefix.length).split('/')).filter(parts=>parts.length>1).map(parts=>parts[0]!))];},
      useCaseSensitiveFileNames:()=>process.platform!=='win32',
    };
    const service=ts.createLanguageService(host,registry);
    try {
      const program=service.getProgram();if(!program)throw new Error('No analyzable source files in project');
      const value={node,service,program};contexts.set(node,value);return value;
    }catch(error){service.dispose();throw error;}
  }
  function primary(file=selected) {
    const owners=file?project.projects.filter(node=>node.rootNames.some(name=>sourceKey(name)===sourceKey(file))):[];
    if(owners.length>1)throw new Error('Target belongs to multiple configured projects; choose an unambiguous project scope');
    if(owners[0])return context(owners[0]);
    if(file)for(const node of project.projects){const item=context(node);if(item.program.getSourceFile(file))return item;}
    if(file)throw new Error('Target is not included in any captured project program');
    return context(project.projects.at(-1)!);
  }
  const all=()=>project.projects.map(context);
  function definition(file:string,position:number){return primary(file).service.getDefinitionAtPosition(file,position);}
  function references(file:string,position:number) {
    const queries=[{file,position},...(definition(file,position)??[]).filter(item=>capturedText(item.fileName)!==undefined).map(item=>({file:item.fileName,position:item.textSpan.start}))];
    const results=new Map<string,ts.ReferenceEntry>();
    for(const query of queries)for(const item of all())if(item.program.getSourceFile(query.file)) {
      for(const entry of item.service.getReferencesAtPosition(query.file,query.position)??[]) {
        if(capturedText(entry.fileName)===undefined)continue;
        results.set(`${sourceKey(entry.fileName)}:${entry.textSpan.start}:${entry.textSpan.length}`,entry);
      }
    }
    return [...results.values()];
  }
  function rename(file:string,position:number) {
    if(project.projects.length>1&&project.projects.some(node=>node.options.disableSourceOfProjectReferenceRedirect))throw new Error('Cross-project rename requires source redirects in every project; built declarations cannot prove a complete source rename');
    const origin=primary(file).service.findRenameLocations(file,position,false,false,true)??[];
    const identity=(entry:{fileName:string;textSpan:ts.TextSpan})=>`${sourceKey(entry.fileName)}:${entry.textSpan.start}:${entry.textSpan.length}`;
    const initial=new Set(origin.map(identity));
    // Follow only definitions that TypeScript already included in the original
    // rename. A shorthand property or local import alias is a different symbol;
    // querying every returned occurrence would accidentally rename those keys.
    const queries=[{file,position},...(definition(file,position)??[]).filter(entry=>initial.has(identity(entry))).map(entry=>({file:entry.fileName,position:entry.textSpan.start}))];
    const results=new Map<string,ts.RenameLocation>();
    const queried=new Set<string>();
    function transparentExport(entry:ts.RenameLocation,program:ts.Program) {
      if(project.projects.length===1)return false;
      const source=program.getSourceFile(entry.fileName);if(!source)return false;
      let found=false;
      const visit=(node:ts.Node)=>{
        if(found||entry.textSpan.start<node.getFullStart()||entry.textSpan.start>=node.getEnd())return;
        if(ts.isExportSpecifier(node)&&!node.propertyName&&ts.isIdentifier(node.name)&&node.name.getStart(source)===entry.textSpan.start&&node.name.getWidth(source)===entry.textSpan.length){found=true;return;}
        ts.forEachChild(node,visit);
      };
      visit(source);return found;
    }
    for(let index=0;index<queries.length;index++) {
      const query=queries[index]!,queryKey=`${sourceKey(query.file)}:${query.position}`;
      if(queried.has(queryKey))continue;queried.add(queryKey);
      for(const item of all())if(item.program.getSourceFile(query.file)) {
        for(const original of item.service.findRenameLocations(query.file,query.position,false,false,true)??[]) {
          const transparent=transparentExport(original,item.program);
          const entry=transparent?{...original,prefixText:undefined,suffixText:undefined}:original;
          const key=identity(entry);
          const old=results.get(key);
          if(old&&(old.prefixText!==entry.prefixText||old.suffixText!==entry.suffixText))throw new Error('Project contexts disagree on a rename replacement; no partial rename plan is returned');
          if(!old)results.set(key,entry);
          if(transparent){
            queries.push({file:entry.fileName,position:entry.textSpan.start});
            for(const target of item.service.getDefinitionAtPosition(entry.fileName,entry.textSpan.start)??[])if(capturedText(target.fileName)!==undefined)queries.push({file:target.fileName,position:target.textSpan.start});
          }
          if(results.size>300)throw new Error('Rename exceeds 300 edits; no partial rename plan is returned');
        }
      }
    }
    return [...results.values()];
  }
  return {primary,all,capturedText,definition,references,rename,dispose:()=>{for(const item of contexts.values())item.service.dispose();}};
}
