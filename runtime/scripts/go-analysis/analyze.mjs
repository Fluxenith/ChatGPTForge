import {readFile,mkdir,writeFile,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,dirname,resolve,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {GoLsp} from './lsp-client.mjs';

const execute=promisify(execFile);
function inside(path,root){const rel=relative(root,resolve(path));return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));}
export function jsonSequence(text) {
  const objects=[];let start=-1,depth=0,string=false,escape=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(start<0){if(/\s/.test(c))continue;if(c!=='{')throw new Error('Go JSON stream has unexpected text');start=i;depth=1;continue;}
    if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
    if(c==='"')string=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){objects.push(JSON.parse(text.slice(start,i+1)));start=-1;}
    if(objects.length>10000)throw new Error('Go JSON stream exceeds bounds');
  }
  if(start>=0)throw new Error('Incomplete Go JSON stream');
  return objects;
}
async function goEnvironment(input) {
  const owned=input.owned,home=join(owned,'home'),temp=join(owned,'tmp'),appdata=join(home,'AppData','Roaming'),local=join(home,'AppData','Local');
  const goroot=input.goroot??join(owned,'goroot');
  for(const path of [home,temp,local,join(appdata,'go','telemetry'),join(owned,'gocache'),join(owned,'gopath'),join(owned,'gomodcache')])await mkdir(path,{recursive:true});
  await writeFile(join(appdata,'go','telemetry','mode'),'off\n');
  const system=process.env.SystemRoot??'C:\\Windows';
  return {SystemRoot:system,WINDIR:system,COMSPEC:join(system,'System32','cmd.exe'),
    PATH:join(goroot,'bin')+';'+join(system,'System32'),PATHEXT:'.EXE;.COM',
    HOME:home,USERPROFILE:home,APPDATA:appdata,LOCALAPPDATA:local,TMP:temp,TEMP:temp,
    GOROOT:goroot,GOPATH:join(owned,'gopath'),GOMODCACHE:join(owned,'gomodcache'),GOCACHE:join(owned,'gocache'),
    GOENV:'off',GOPROXY:'off',GOSUMDB:'off',GOVCS:'*:off',GOTOOLCHAIN:'local',CGO_ENABLED:'0',GOPACKAGESDRIVER:'off',
    GOFLAGS:'-mod=readonly',GOWORK:input.project_files.includes('go.work')?join(input.snapshot,'go.work'):'off',
    GOOS:'windows',GOARCH:process.arch==='arm64'?'arm64':'amd64',GOMAXPROCS:'2'};
}
async function go(env,cwd,args) {
  const reply=await execute(join(env.GOROOT,'bin','go.exe'),args,{cwd,env,windowsHide:true,timeout:90000,maxBuffer:16*1024*1024});
  return reply.stdout;
}
async function localPath(value,base,input) {
  let path=resolve(base,value);
  if(isAbsolute(value)&&inside(path,input.original_root))path=resolve(input.snapshot,relative(input.original_root,path));
  if(!inside(path,input.snapshot))throw new Error('Go configuration references a directory outside the captured project');
  const item=await lstat(path);
  if(!item.isDirectory()||item.isSymbolicLink())throw new Error('Go configuration references an uncaptured directory');
  return path;
}
async function prepare(input,env) {
  const mainRoots=new Set(),pending=[];
  const inspectReplacements=async(config,cwd,kind)=>{
    for(const replacement of config.Replace??[]) {
      if(replacement.New.Version)continue;
      const path=await localPath(replacement.New.Path,cwd,input);
      pending.push(path);
      if(isAbsolute(replacement.New.Path)) {
        const old=replacement.Old.Path+(replacement.Old.Version?'@'+replacement.Old.Version:'');
        await go(env,cwd,[kind,'edit','-replace='+old+'='+path]);
      }
    }
  };
  if(input.project_files.includes('go.work')) {
    const config=JSON.parse(await go(env,input.snapshot,['work','edit','-json']));
    for(const use of config.Use??[]) {
      const path=await localPath(use.DiskPath,input.snapshot,input);mainRoots.add(path);pending.push(path);
      if(isAbsolute(use.DiskPath))await go(env,input.snapshot,['work','edit','-dropuse='+use.DiskPath,'-use='+path]);
    }
    await inspectReplacements(config,input.snapshot,'work');
  } else {mainRoots.add(input.snapshot);pending.push(input.snapshot);}
  if(!mainRoots.size)throw new Error('Go workspace has no captured modules');
  const visited=new Set();
  while(pending.length) {
    const cwd=pending.shift();if(visited.has(cwd))continue;visited.add(cwd);
    if(visited.size>32)throw new Error('Go workspace exceeds 32 local modules');
    if(!input.project_files.includes(relative(input.snapshot,join(cwd,'go.mod')).replaceAll('\\','/')))throw new Error('Go local module lacks a captured go.mod');
    await inspectReplacements(JSON.parse(await go(env,cwd,['mod','edit','-json'])),cwd,'mod');
  }
  const vendored=input.project_files.includes('vendor/modules.txt');
  const modules=new Map();
  // -e lets Go report selected workspace main modules even when an unused
  // version of another main module has no downloaded remote go.mod. Errors on
  // actual selected external modules remain explicit and are refused below.
  if(!vendored)for(const cwd of mainRoots)for(const item of jsonSequence(await go(env,cwd,['list','-m','-e','-json','all']))) {
    if(item.Error)throw new Error('Go module graph is incomplete: '+item.Error.Err);
    const effective=item.Replace??item;
    if(item.Main||effective.Dir&&inside(effective.Dir,input.snapshot))continue;
    if(!effective.Path||!effective.Version)throw new Error('Go module graph returned an uncaptured local dependency');
    modules.set(effective.Path+'@'+effective.Version,{path:effective.Path,version:effective.Version});
  }
  if(modules.size>128)throw new Error('Go project exceeds 128 installed modules');
  return {modules:[...modules.values()],main_roots:[...mainRoots],local_roots:[...visited],vendored};
}
async function analyze(input,env) {
  const config=input.prepared;
  if(config.vendored)env.GOFLAGS='-mod=vendor';
  const files=new Set();const errors=[];
  for(const cwd of config.main_roots)for(const pkg of jsonSequence(await go(env,cwd,['list','-e','-json','./...']))) {
    if(pkg.Error)errors.push({directory:relative(input.snapshot,pkg.Dir??cwd).replaceAll('\\','/'),message:pkg.Error.Err});
    for(const file of [...(pkg.GoFiles??[]),...(pkg.TestGoFiles??[]),...(pkg.XTestGoFiles??[]),...(pkg.InvalidGoFiles??[])]) {
      const path=join(pkg.Dir,file);
      if(!inside(path,input.snapshot))throw new Error('Go package loader escaped its snapshot');
      const name=relative(input.snapshot,path).replaceAll('\\','/');
      if(!input.source_files.includes(name))throw new Error('Go loader selected an uncaptured source');
      files.add(name);
    }
  }
  if(input.query.file) {
    if(!input.source_files.includes(input.query.file))throw new Error('Go query targets an uncaptured source');
    const target=join(input.snapshot,input.query.file);
    const module=input.project_files.filter(file=>file.endsWith('go.mod')).map(file=>dirname(join(input.snapshot,file)))
      .filter(root=>inside(target,root)).sort((a,b)=>b.length-a.length)[0];
    if(!module||!config.local_roots.includes(module))throw new Error('Go target is outside configured local modules');
    files.add(input.query.file);
  }
  if(!files.size)throw new Error('Go package loader found no supported Go sources');
  const query=input.query,settings={env,buildFlags:[env.GOFLAGS],telemetryPrompt:false,vulncheck:'Off',staticcheck:false,
    directoryFilters:['-.git','-node_modules','-.venv','-venv'],symbolScope:'workspace',diagnosticsTrigger:'Save',
    codelenses:{generate:false,tidy:false,upgrade_dependency:false,vulncheck:false,run_govulncheck:false},renameMovesSubpackages:false};
  const folders=[{uri:pathToFileURL(input.snapshot).href,name:'Forge snapshot'}];
  const client=new GoLsp(input.gopls,input.snapshot,env,settings,folders);
  try {
    const initialized=await client.request('initialize',{processId:process.pid,rootUri:folders[0].uri,workspaceFolders:folders,
      capabilities:{general:{positionEncodings:['utf-16']},workspace:{configuration:true,workspaceFolders:true},
        window:{workDoneProgress:true},textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true},
          publishDiagnostics:{relatedInformation:true},rename:{prepareSupport:true}}},initializationOptions:settings});
    if(initialized.capabilities.positionEncoding&&initialized.capabilities.positionEncoding!=='utf-16')throw new Error('gopls negotiated unsupported position encoding');
    client.notify('initialized',{});
    const uri=file=>pathToFileURL(join(input.snapshot,file)).href;
    const open=async file=>client.notify('textDocument/didOpen',{textDocument:{uri:uri(file),languageId:'go',version:1,text:await readFile(join(input.snapshot,file),'utf8')}});
    const target=query.file,selected=query.files?.length?query.files:[...files];
    let raw,diagnostics_complete=false;
    if(query.action==='diagnostics') {
      const diagnosing=target?[target]:selected.filter(file=>files.has(file));
      if(!diagnosing.length)throw new Error('No selected Go diagnostic sources');
      for(const file of diagnosing)await open(file);
      if(!initialized.capabilities.executeCommandProvider?.commands?.includes('gopls.diagnose_files'))throw new Error('Pinned gopls synchronous diagnostics command is unavailable');
      await client.request('workspace/executeCommand',{command:'gopls.diagnose_files',arguments:[{Files:diagnosing.map(uri)}]});
      raw=diagnosing.flatMap(file=>(client.diagnostics.get(uri(file))??[]).map(diagnostic=>({uri:uri(file),...diagnostic})));
      diagnostics_complete=true;
    } else if(query.action==='symbols')raw=await client.request('workspace/symbol',{query:query.query});
    else {
      await open(target);
      if(query.action==='outline')raw=await client.request('textDocument/documentSymbol',{textDocument:{uri:uri(target)}});
      else {
        const position={line:query.line-1,character:query.column-1},textDocument={uri:uri(target)};
        if(query.action==='definition')raw=await client.request('textDocument/definition',{textDocument,position});
        else if(query.action==='references')raw=await client.request('textDocument/references',{textDocument,position,context:{includeDeclaration:true}});
        else if(query.action==='rename_preview')raw=await client.request('textDocument/rename',{textDocument,position,newName:query.new_name});
        else throw new Error('Unsupported Go action');
      }
    }
    return {raw,language_server:initialized.serverInfo,diagnostics_complete,analysis_files:[...files].sort(),
      package_errors:errors,build_flags:settings.buildFlags,goos:env.GOOS,goarch:env.GOARCH,cgo_enabled:false};
  } finally {await client.shutdown();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input=JSON.parse(await readFile(process.argv[2],'utf8'));
    const env=await goEnvironment(input);
    const reply=input.mode==='prepare'?await prepare(input,env):await analyze(input,env);
    process.stdout.write(JSON.stringify({ok:true,...reply}));
  } catch(error) {
    process.stdout.write(JSON.stringify({ok:false,error:String(error?.message??error)}));process.exitCode=1;
  }
}
