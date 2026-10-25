import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,openSync,closeSync,unlinkSync,cpSync,lstatSync,readdirSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {satisfies,valid} from 'semver';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {componentHome,readManagedState,managedRelease,type ManagedRelease} from './managed-component-state.js';
import {writeLanguagePin} from './language-pin-transaction.js';
import {loadDevspaceFiles,setDevspaceConfigValue} from './user-config.js';
import {gatewayServersSchema} from './forge-mcp-gateway.js';
import {deploymentUv} from './deployment-tools.js';
const run=promisify(execFile);
const definitions={
  playwright:{kind:'npm',pkg:'@playwright/mcp',range:'>=0.0.80 <0.1.0',python:undefined},
  serena:{kind:'python',pkg:'serena-agent',range:'1.7.0',python:'3.13'},
  'windows-mcp':{kind:'python',pkg:'windows-mcp',range:'>=0.8.5 <1.0.0',python:'3.14'},
  'skills-manager':{kind:'git',pkg:'https://github.com/lite-milkfrog/skills-manager.git',range:'',python:undefined},
} as const;
function skillsBoundTo(root:string){
  const path=join(dirname(dirname(componentHome())),'skills-manager','profile.json');
  return existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).source_dir===root;
}
type Id=keyof typeof definitions;
function definition(id:string){if(!(id in definitions))throw Error('Unsupported managed component: '+id);return definitions[id as Id];}
export function compatibleComponentVersion(id:string,version:string){const d=definition(id);return d.kind==='git'?/^[a-f0-9]{40}$/.test(version):!!valid(version)&&satisfies(version,d.range);}
export function componentTree(root:string){
  if(lstatSync(root).isSymbolicLink())throw Error('Managed component root is a symbolic link');
  const hash=createHash('sha256');
  function visit(path:string){for(const name of readdirSync(path).sort()){
    if(name==='.git'||name==='__pycache__'||name.endsWith('.pyc'))continue;
    const file=join(path,name),stat=lstatSync(file);
    if(stat.isSymbolicLink())throw Error('Managed component contains a symbolic link: '+relative(root,file));
    if(stat.isDirectory())visit(file);else if(stat.isFile()){hash.update(relative(root,file).replaceAll('\\','/')+'\0');hash.update(createHash('sha256').update(readFileSync(file)).digest());}
  }}visit(root);return hash.digest('hex');
}
async function execute(command:string,args:string[],cwd?:string){return run(command,args,{cwd,windowsHide:true,timeout:600_000,maxBuffer:3*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',UV_NO_PROGRESS:'1'}});}
async function json(url:string){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Official metadata HTTP '+r.status);return r.json() as Promise<any>;}
export async function managedUpdates(){
  const active=readManagedState().active,results=[];
  for(const [id,d] of Object.entries(definitions))try{
    const latest=d.kind==='git'?(await execute('git',['ls-remote',d.pkg,'HEAD'])).stdout.trim().split(/\s+/)[0]!:
      d.kind==='npm'?(await json('https://registry.npmjs.org/'+encodeURIComponent(d.pkg)+'/latest')).version:(await json('https://pypi.org/pypi/'+d.pkg+'/json')).info.version;
    results.push({id,installed:active[id]?.version??null,latest,compatible:compatibleComponentVersion(id,latest),source:d.pkg});
  }catch(error){results.push({id,error:String(error)});}
  return results;
}
async function catalog(entry:ManagedRelease){
  if(entry.id==='skills-manager')return [];
  const flags=entry.id==='playwright'?['--headless','--isolated']:entry.id==='serena'?['start-mcp-server','--transport','stdio','--context','desktop-app','--enable-web-dashboard','false','--open-web-dashboard','false','--enable-gui-log-window','false']:[];
  const client=new Client({name:'forge-component-acceptance',version:'1.0'});
  const transport=new StdioClientTransport({command:entry.command,args:[...entry.args,...flags],stderr:'ignore',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'} as Record<string,string>});
  try{await client.connect(transport,{timeout:90000});const names:string[]=[],seen=new Set<string>();let cursor:string|undefined;
    do{const page=await client.listTools(cursor?{cursor}:undefined,{timeout:90000});names.push(...page.tools.map(t=>t.name));cursor=page.nextCursor;if(cursor){if(seen.has(cursor)||names.length>512)throw Error('Invalid MCP catalog pagination');seen.add(cursor);}}while(cursor);
    if(!names.length)throw Error('Empty MCP tool catalog');return names.sort();}
  finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
}
export async function verifyManaged(home=componentHome()){
  return Object.values(readManagedState(home).active).map(entry=>{
    try{managedRelease(entry.id,home);return {id:entry.id,version:entry.version,state:componentTree(entry.root)===entry.tree?'verified':'mismatch',tools:entry.tools.length};}
    catch(error){return {id:entry.id,version:entry.version,state:'unavailable',detail:String(error)};}
  });
}
export async function installManaged(id:string,version:string,repair=false){
  const d=definition(id);if(!compatibleComponentVersion(id,version))throw Error('Version outside the reviewed compatibility range for '+id);
  const home=componentHome();mkdirSync(home,{recursive:true});const mutex=join(home,'install.lock'),fd=openSync(mutex,'wx');
  const receipt=(phase:string,detail:unknown)=>appendFileSync(join(home,'receipts.jsonl'),JSON.stringify({time:new Date().toISOString(),id,version,phase,detail})+'\n');
  try{
    const state=readManagedState(home),old=state.active[id];
    if(repair&&(!old||old.version!==version))throw Error('Repair requires the current pinned version');
    if(repair&&d.kind!=='git'){
      const recipe=readFileSync(join(old!.root,d.kind==='npm'?'package-lock.json':'requirements.txt'));
      if(createHash('sha256').update(recipe).digest('hex')!==old!.recipe)throw Error('Repair recipe differs from its pin');
    }
    if(!repair&&old?.version===version&&componentTree(old.root)===old.tree)return {state:'already-installed',release:old};
    const root=join(home,'releases',id+'-'+version+'-'+randomUUID());mkdirSync(root,{recursive:true});receipt('preparing',{root,repair});
    const entry:ManagedRelease={id,version,root,command:'',args:[],tree:'',tools:[],created:new Date().toISOString()};
    if(d.kind==='npm'){
      const npm=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
      if(repair){for(const name of ['package.json','package-lock.json'])cpSync(join(old!.root,name),join(root,name));await execute(process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'],root);}
      else{await execute(process.execPath,[npm,'install','--save-exact','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org',d.pkg+'@'+version],root);}
      const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8')),pkg=lock.packages['node_modules/'+d.pkg];
      const official=await json('https://registry.npmjs.org/'+encodeURIComponent(d.pkg)+'/'+version);
      if(pkg.version!==version||pkg.integrity!==official.dist.integrity)throw Error('Installed npm lock differs from official package metadata');
      entry.command=process.execPath;entry.args=[join(root,'node_modules','@playwright','mcp','cli.js')];
    }else if(d.kind==='python'){
      const uv=deploymentUv(),venv=join(root,'venv'),lock=join(root,'requirements.txt');
      await execute(uv,['venv','--python',d.python!,venv]);
      entry.python=join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
      if(repair)cpSync(join(old!.root,'requirements.txt'),lock);
      else{const input=join(root,'requirements.in');writeFileSync(input,d.pkg+'=='+version+'\n');await execute(uv,['pip','compile','--python',entry.python,'--generate-hashes','--index-url','https://pypi.org/simple','--output-file',lock,input]);}
      await execute(uv,['pip','sync','--python',entry.python,'--require-hashes','--index-url','https://pypi.org/simple',lock]);
      entry.command=join(venv,process.platform==='win32'?'Scripts':'bin',id==='serena'?(process.platform==='win32'?'serena.exe':'serena'):(process.platform==='win32'?'windows-mcp.exe':'windows-mcp'));
      if(id==='windows-mcp')entry.args=['serve','--transport','stdio'];
      const found=(await execute(entry.python,['-I','-B','-c',`import importlib.metadata as m; print(m.version(${JSON.stringify(d.pkg)}))`])).stdout.trim();
      if(found!==version)throw Error('Installed Python package version differs from requested pin');
    }else{
      await execute('git',['init',root]);await execute('git',['-C',root,'remote','add','origin',d.pkg]);
      await execute('git',['-C',root,'fetch','--depth','1','origin',version]);await execute('git',['-C',root,'checkout','--detach','FETCH_HEAD']);
      if((await execute('git',['-C',root,'rev-parse','HEAD'])).stdout.trim()!==version)throw Error('Git source HEAD mismatch');
      const profilePath=join(dirname(dirname(home)),'skills-manager','profile.json');
      const profile=JSON.parse(readFileSync(profilePath,'utf8'));entry.python=profile.python_path;entry.command=profile.python_path;
      const probe=join(home,'probes',randomUUID());mkdirSync(probe,{recursive:true});
      const candidate={...profile,source_dir:root,source_head:version,state_dir:join(probe,'state')};const path=join(probe,'profile.json');writeLanguagePin(path,candidate);
      mkdirSync(candidate.state_dir,{recursive:true});
      const database=join(profile.state_dir,'control-plane.db');
      if(existsSync(database))await execute(entry.command,['-B','-c','import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()',database,join(candidate.state_dir,'control-plane.db')]);
      for(const name of ['workflow-imports.json','index.json','migration-source.json'])if(existsSync(join(profile.state_dir,name)))cpSync(join(profile.state_dir,name),join(candidate.state_dir,name));
      const launcher=fileURLToPath(new URL('../../scripts/forge-skills-service.py',import.meta.url));
      const result=await execute(entry.command,['-B',launcher,'import','--profile',path]);
      receipt('skills-contract',JSON.parse(result.stdout.trim()));
      const status=JSON.parse((await execute(entry.command,['-B',launcher,'status','--profile',path])).stdout.trim());
      if(!status.parity?.ok)throw Error('Skills registry parity failed');
    }
    if(d.kind!=='git')entry.recipe=createHash('sha256').update(readFileSync(join(root,d.kind==='npm'?'package-lock.json':'requirements.txt'))).digest('hex');
    entry.tools=await catalog(entry);
    if(old&&old.tools.some(tool=>!entry.tools.includes(tool)))throw Error('Candidate removed previously available MCP tools');
    entry.tree=componentTree(root);
    state.history[id]=[...(state.history[id]??[]),...(old?[old]:[])];state.active[id]=entry;
    const previousState=readManagedState(home);
    writeLanguagePin(join(home,'state.json'),state);
    try{if(id==='skills-manager'&&old&&skillsBoundTo(old.root))bindManaged(id);}
    catch(error){writeLanguagePin(join(home,'state.json'),previousState);throw error;}
    receipt('activated',{root,tree:entry.tree,tools:entry.tools.length});
    return {state:repair?'repaired':'installed',release:entry};
  }catch(error){receipt('failed',{error:String(error)});throw error;}
  finally{closeSync(fd);unlinkSync(mutex);}
}
export function bindManaged(id:string){
  const entry=managedRelease(id);if(!entry)throw Error('Component is not managed');
  if(componentTree(entry.root)!==entry.tree)throw Error('Managed release differs from its pin');
  if(id==='serena')return {id,bound:'Serena bridge and private analysis resolve the active managed release; restart Forge.'};
  if(id==='skills-manager'){
    const path=join(dirname(dirname(componentHome())),'skills-manager','profile.json');
    const before=readFileSync(path,'utf8'),profile=JSON.parse(before);
    writeFileSync(path+'.before-'+Date.now(),before,{flag:'wx'});
    writeLanguagePin(path,{...profile,source_dir:entry.root,source_head:entry.version});
    return {id,bound:'Skills profile updated; restart the owned Skills services.',source_head:entry.version};
  }
  const files=loadDevspaceFiles(),servers=gatewayServersSchema.parse(files.config.mcpGateway?.servers??[]);
  const launcher=fileURLToPath(new URL('./managed-component-launcher.js',import.meta.url));
  const ids=id==='playwright'?['playwright','playwright-browser']:['windows-mcp'];
  for(const serverId of ids){
    const index=servers.findIndex(s=>s.id===serverId),old=index<0?undefined:servers[index];
    if(old&&old.read_tools.concat(old.write_tools).some(t=>!entry.tools.includes(t)))throw Error('Candidate does not implement an approved tool');
    const flags=old?(old.args[0]===launcher?old.args.slice(3):old.args.slice(1)):(serverId==='playwright'?['--headless','--isolated']:serverId==='playwright-browser'?['--extension']:[]);
    const next=gatewayServersSchema.parse([{...old,id:serverId,endpoint:undefined,command:process.execPath,args:[launcher,id,componentHome(),...flags],source:'forge-managed:'+id,approved:old?.approved??false,read_tools:old?.read_tools??[],write_tools:old?.write_tools??[]}])[0]!;
    if(index<0)servers.push(next);else servers[index]=next;
  }
  setDevspaceConfigValue(['mcpGateway','servers'],servers);return {id,bound:ids,note:'Existing approval and origin scopes preserved; new entries remain unapproved. Restart Forge.'};
}
export async function rollbackManaged(id:string){
  definition(id);const home=componentHome(),mutex=join(home,'install.lock'),fd=openSync(mutex,'wx');
  try{const state=readManagedState(home),previous=state.history[id]?.at(-1);if(!previous)throw Error('No previous managed release');
    if(componentTree(previous.root)!==previous.tree)throw Error('Previous release differs from its pin');
    const before=readManagedState(home),rebind=id==='skills-manager'&&!!state.active[id]&&skillsBoundTo(state.active[id]!.root);
    state.history[id]!.pop();if(state.active[id])state.history[id]!.push(state.active[id]!);state.active[id]=previous;
    if(rebind&&before.active[id]?.version!==previous.version){
      const {rollbackSkillsDatabase}=await import('./skills-database-rollback.js');
      const path=join(dirname(dirname(home)),'skills-manager','profile.json'),oldProfile=JSON.parse(readFileSync(path,'utf8'));
      await rollbackSkillsDatabase(previous,()=>{try{writeLanguagePin(join(home,'state.json'),state);bindManaged(id);}catch(error){writeLanguagePin(join(home,'state.json'),before);writeLanguagePin(path,oldProfile);throw error;}},()=>{writeLanguagePin(join(home,'state.json'),before);writeLanguagePin(path,oldProfile);});
    }else{
      writeLanguagePin(join(home,'state.json'),state);
      try{if(rebind)bindManaged(id);}catch(error){writeLanguagePin(join(home,'state.json'),before);throw error;}
    }
    appendFileSync(join(home,'receipts.jsonl'),JSON.stringify({time:new Date().toISOString(),id,phase:'rolled-back',root:previous.root})+'\n');return previous;
  }finally{closeSync(fd);unlinkSync(mutex);}
}
