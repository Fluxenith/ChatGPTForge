import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {loadConfig} from './config.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {windowsProcessIdentity} from './durable-windows-job.js';
import {SqliteOAuthStore} from './oauth-store.js';
import {createServer} from './server.js';
import {captureSerenaProject,convertSerenaWorkspaceEdit,planSerenaRename,planSerenaSymbolEdit,serenaLanguagesHome,serenaPython,type SerenaRenamePlan} from './serena-workspace-edit.js';
import {TaskFileBatches} from './task-file-batches.js';
import {serenaRenameTask} from './task-rename.js';
import {writeTestDevspaceConfig} from './test-support/config.test.js';

const live=process.platform==='win32'&&existsSync(serenaPython());
const MATH='# \u{1F600} original CRLF\r\ndef twice(value: int) -> int:\r\n    return value * 2\r\n';
const APP='from mathlib import twice\r\n# twice in comments stays\r\nassert twice(3) == 6\r\nassert "twice" == "twice"\r\n';
function pyProject(t:{after:(f:()=>unknown)=>void}){
  const root=mkdtempSync(join(tmpdir(),'forge-serena-edit-')),project=join(root,'project');mkdirSync(project);
  writeFileSync(join(project,'mathlib.py'),MATH);writeFileSync(join(project,'app.py'),APP);
  // Close owned databases before deleting their verified temporary directory.
  const closers:(()=>unknown)[]=[];
  t.after(async()=>{for(const close of closers)await close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {root,project,own:(engine:DurableTasks)=>{closers.push(()=>engine.close());return engine;},later:(close:()=>unknown)=>closers.push(close)};
}
const uri=(root:string,path:string)=>pathToFileURL(join(root,path)).href;
const at=(line:number,character:number)=>({line,character});
const span=(l:number,c:number,n:number)=>({start:at(l,c),end:at(l,c+n)});

test('Serena WorkspaceEdit conversion keeps exact UTF-16/CRLF contents and refuses unsafe plans',async t=>{
  const {project}=pyProject(t),root=await realpath(project),capture=captureSerenaProject(root);
  const refs=[{uri:uri(root,'app.py'),range:span(0,20,5)},{uri:uri(root,'app.py'),range:span(2,7,5)}];
  const documentChanges=[{textDocument:{uri:uri(root,'app.py'),version:null},edits:[{range:span(0,20,5),newText:'scale',annotationId:'default'},{range:span(2,7,5),newText:'scale'}]},
    {textDocument:{uri:uri(root,'mathlib.py'),version:null},edits:[{range:span(1,4,5),newText:'scale'}]}];
  const both=await convertSerenaWorkspaceEdit(root,capture,'mathlib.py',{documentChanges,changeAnnotations:{default:{needsConfirmation:false}}},refs);
  assert.deepEqual(both.changes.map(c=>[c.path,c.content]),[
    ['app.py',APP.replace('import twice','import scale').replace('assert twice(3)','assert scale(3)')],
    ['mathlib.py',MATH.replace('def twice(','def scale(')]]);
  assert.equal(both.changes[1]!.expected_hash,capture.hashes['mathlib.py']);
  const changes=await convertSerenaWorkspaceEdit(root,capture,'mathlib.py',{changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,5),newText:'scale'}],[uri(root,'app.py')]:[{range:span(0,20,5),newText:'scale'},{range:span(2,7,5),newText:'scale'}]}},refs);
  assert.deepEqual(changes.changes,both.changes);
  await convertSerenaWorkspaceEdit(root,capture,'mathlib.py',{documentChanges},[{uri:uri(root,'app.py'),range:span(0,5,20)}]);
  await assert.rejects(convertSerenaWorkspaceEdit(root,capture,'mathlib.py',{documentChanges},[{uri:uri(root,'app.py'),range:span(0,0,20)}]),/omits a reference/);
  const refuse=async(edit:unknown,pattern:RegExp,references=refs)=>assert.rejects(convertSerenaWorkspaceEdit(root,capture,'mathlib.py',edit as never,references),pattern);
  // The first real TypeScript plan held only the declaration before indexing.
  await refuse({changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,5),newText:'scale'}]}},/omits referenced file app\.py/);
  await refuse({changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,5),newText:'scale'}],[uri(root,'app.py')]:[{range:span(0,20,5),newText:'scale'}]}},/omits a reference in app\.py/);
  await refuse({documentChanges:[...documentChanges,{kind:'delete',uri:uri(root,'app.py')}]},/create\/rename\/delete/);
  await refuse({documentChanges,changeAnnotations:{default:{needsConfirmation:true}}},/confirmation/);
  await refuse({changes:{[pathToFileURL(join(project,'..','outside.py')).href]:[{range:span(0,0,0),newText:'x'}]}},/missing file|leaves the captured project/);
  await refuse({changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,5),newText:'a'},{range:span(1,6,2),newText:'b'}]}},/Overlapping/,[]);
  await refuse({changes:{[uri(root,'mathlib.py')]:[{range:span(0,3,1),newText:'x'}]}},/surrogate/,[]);
  await refuse({changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,99),newText:'x'}]}},/outside the captured line/,[]);
  await refuse({changes:{[uri(root,'app.py')]:[{range:span(0,20,5),newText:'scale'},{range:span(2,7,5),newText:'scale'}]}},/does not edit the requested file/);
  // JDT LS sends both forms: empty changes are ignored, identical ones accepted,
  // and differing ones refused.
  await refuse({changes:{},documentChanges:[]},/empty rename plan/,[]);
  assert.deepEqual((await convertSerenaWorkspaceEdit(root,capture,'mathlib.py',{changes:{},documentChanges},refs)).changes,both.changes);
  assert.deepEqual((await convertSerenaWorkspaceEdit(root,capture,'mathlib.py',{changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,5),newText:'scale'}],[uri(root,'app.py')]:[{range:span(2,7,5),newText:'scale'},{range:span(0,20,5),newText:'scale'}]},documentChanges},refs)).changes,both.changes);
  await refuse({changes:{[uri(root,'mathlib.py')]:[{range:span(1,4,5),newText:'scale'}]},documentChanges},/Ambiguous/);
  await refuse({changes:{}},/empty rename plan/,[]);
});

function fakePlan(project:string,mutate?:()=>void):(input:unknown,signal?:AbortSignal)=>Promise<SerenaRenamePlan>{
  return async(_input,signal)=>{
    const capture=captureSerenaProject(project);
    await new Promise(done=>setTimeout(done,40));mutate?.();
    if(signal?.aborted)throw Error('Serena rename cancelled; nothing applied');
    const changes=[{path:'app.py',content:APP.replaceAll('twice(3)','scale(3)').replace('import twice','import scale'),expected_hash:capture.hashes['app.py']!},
      {path:'mathlib.py',content:MATH.replace('def twice(','def scale('),expected_hash:capture.hashes['mathlib.py']!}];
    return {backend:'serena',serena_version:'1.7.0',language:'python',fingerprint:capture.fingerprint,readiness:{references:2,stable_plans:2,prerequisites_unchanged:true},files:[],changes};
  };
}

test('Serena filename plans preserve transaction replay and rollback and refuse unsafe destinations',async t=>{
 const {root,project,own}=pyProject(t),privateRoot=await realpath(project),capture=captureSerenaProject(privateRoot);
 const text={textDocument:{uri:uri(privateRoot,'mathlib.py')},edits:[{range:span(1,4,5),newText:'scale'}]};
 const move=(to:string,extra={})=>({kind:'rename',oldUri:uri(privateRoot,'mathlib.py'),newUri:uri(privateRoot,to),...extra});
 const convert=(docs:unknown[],annotations?:Record<string,{needsConfirmation:boolean}>)=>convertSerenaWorkspaceEdit(privateRoot,capture,'mathlib.py',{documentChanges:docs,changeAnnotations:annotations},[]);
 const plan=await convert([text,move('renamed.py')]);
 assert.deepEqual(plan.file_moves,[{from:'mathlib.py',to:'renamed.py',sha256:capture.hashes['mathlib.py']}]);
 const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
 const task=engine.create(project,'moves','rename file',['echo ok'],true);
 const request={kind:'serena-file-move'};
 const result=batches.write(task.task_id,'move',plan.changes,task.fingerprint,task.lease_token!,request);
 assert.ok(!existsSync(join(project,'mathlib.py')));
 assert.equal(readFileSync(join(project,'renamed.py'),'utf8'),MATH.replace('def twice(','def scale('));
 assert.deepEqual(batches.write(task.task_id,'move',plan.changes,task.fingerprint,task.lease_token!,request),result);
 batches.rollback(task.task_id,'move','undo',task.lease_token!);
 assert.equal(snapshot(project).fingerprint,task.fingerprint);
 const casePlan=await convert([text,move('Mathlib.py')]);
 assert.equal(casePlan.changes[0]!.rename_to,'Mathlib.py');
 batches.write(task.task_id,'case',casePlan.changes,task.fingerprint,task.lease_token!);
 assert.ok(readdirSync(project).includes('Mathlib.py'));
 batches.rollback(task.task_id,'case','undo-case',task.lease_token!);
 assert.ok(readdirSync(project).includes('mathlib.py'));
 assert.equal(snapshot(project).fingerprint,task.fingerprint);
 await assert.rejects(convert([text,move('app.py')]),/already exists/);
 await assert.rejects(convert([text,move('../escaped.py')]),/leaves the captured project/);
 await assert.rejects(convert([text,move('renamed.py',{options:{overwrite:true}})]),/overwrite/);
 await assert.rejects(convert([move('renamed.py'),text]),/preceding source edits/);
 await assert.rejects(convert([text,move('renamed.py'),text]),/after a filename move/);
 await assert.rejects(convert([text,move('renamed.py'),move('other.py')]),/cannot be chained/);
 await assert.rejects(convert([text,move('renamed.py',{annotationId:'confirm'})],{confirm:{needsConfirmation:true}}),/confirmation/);
 // Empty legacy changes must not discard annotation metadata from documentChanges.
 await assert.rejects(convertSerenaWorkspaceEdit(privateRoot,capture,'mathlib.py',{changes:{},documentChanges:[text,move('renamed.py',{annotationId:'confirm'})],changeAnnotations:{confirm:{needsConfirmation:true}}},[]),/confirmation/);
 const collision=await convert([text,move('renamed.py')]);
 writeFileSync(join(project,'renamed.py'),'external content');
 await assert.rejects(serenaRenameTask(engine,batches,{task_id:task.task_id,operation_id:'collision',lease_token:task.lease_token!,expected_fingerprint:snapshot(project).fingerprint,language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'},undefined,async()=>({backend:'serena',serena_version:'1.7.0',language:'python',fingerprint:snapshot(project).fingerprint,readiness:{references:0,stable_plans:2,prerequisites_unchanged:true},...collision})),/File conflict/);
 assert.equal(readFileSync(join(project,'renamed.py'),'utf8'),'external content');
 assert.equal(batches.has(task.task_id,'collision'),false);
});

test('Serena task transaction refuses stale or externally changed input and cancellation before intent; replay and rollback are exact',async t=>{
  const {root,project,own}=pyProject(t),engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
  const task=engine.create(project,'serena-transaction','rename through Serena',['python -B app.py'],true);
  const input={task_id:task.task_id,operation_id:'serena-rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'};
  const ops=()=>engine.status(task.task_id).operations.length;
  // External change after inspection but before analysis.
  writeFileSync(join(project,'note.txt'),'external');
  await assert.rejects(serenaRenameTask(engine,batches,input,undefined,fakePlan(project)),/changed before Serena rename analysis/);
  rmSync(join(project,'note.txt'));
  // External change while Serena analyses the private copy.
  await assert.rejects(serenaRenameTask(engine,batches,input,undefined,fakePlan(project,()=>writeFileSync(join(project,'app.py'),APP+'# edit\r\n'))),/changed since Serena capture|Workspace conflict/);
  writeFileSync(join(project,'app.py'),APP);
  const controller=new AbortController();setTimeout(()=>controller.abort(),10);
  await assert.rejects(serenaRenameTask(engine,batches,input,controller.signal,fakePlan(project)),/cancelled/);
  assert.equal(ops(),0,'no write intent for refused or cancelled plans');
  assert.equal(snapshot(project).fingerprint,task.fingerprint);
  const applied=await serenaRenameTask(engine,batches,input,undefined,fakePlan(project));
  assert.equal(applied.state,'completed');
  const renamed=snapshot(project).fingerprint;
  assert.deepEqual(await serenaRenameTask(engine,batches,input,undefined,async()=>{throw Error('replay must not plan');}),applied);
  await assert.rejects(serenaRenameTask(engine,batches,{...input,new_name:'other'},undefined,fakePlan(project)),/different batch input/);
  assert.equal(snapshot(project).fingerprint,renamed);
  const undo=batches.rollback(task.task_id,'serena-rename','undo',task.lease_token!);
  assert.deepEqual(batches.rollback(task.task_id,'serena-rename','undo',task.lease_token!),undo);
  assert.equal(snapshot(project).fingerprint,task.fingerprint);
  assert.equal(readFileSync(join(project,'app.py'),'utf8'),APP);
});

test('Serena helper cancellation and failure stop the owned job tree, clean private copies and release the queue',{skip:!live,timeout:120_000},async t=>{
  const {root,project}=pyProject(t),helpers=join(root,'helpers');mkdirSync(helpers);
  const sleeper=join(helpers,'sleep.py'),failing=join(helpers,'fail.py'),pidFile=join(root,'child.pid');
  writeFileSync(sleeper,`import subprocess,sys,time\nchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(600)'])\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\ntime.sleep(600)\n`);
  writeFileSync(failing,'import sys\nsys.stderr.write("helper failure evidence")\nsys.exit(3)\n');
  const before=new Set(readdirSync(tmpdir()).filter(n=>n.startsWith('forge-serena-rename-')));
  const controller=new AbortController();let launched=0;
  const running=planSerenaRename({root:project,language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'},controller.signal,{helper:sleeper,onLaunched:pid=>{launched=pid;}});
  while(!existsSync(pidFile))await new Promise(done=>setTimeout(done,50));
  const child=Number(readFileSync(pidFile,'utf8'));assert.ok(windowsProcessIdentity(child),'helper grandchild is running');
  controller.abort();
  await assert.rejects(running,/cancelled; nothing applied/);
  for(let i=0;i<40&&(windowsProcessIdentity(child)||windowsProcessIdentity(launched));i++)await new Promise(done=>setTimeout(done,50));
  assert.equal(windowsProcessIdentity(child),null,'job cancellation terminated helper descendants');
  assert.equal(windowsProcessIdentity(launched),null);
  await assert.rejects(planSerenaRename({root:project,language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'},undefined,{helper:failing}),/exited 3: [\s\S]*helper failure evidence/);
  await assert.rejects(planSerenaRename({root:project,language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'},undefined,{helper:sleeper,timeoutMs:1500}),/timed out/);
  assert.deepEqual(readdirSync(tmpdir()).filter(n=>n.startsWith('forge-serena-rename-')&&!before.has(n)),[],'private copies removed');
  await assert.rejects(planSerenaRename({root:project,language:'rust',file:'mathlib.py',line:2,column:5,new_name:'scale'}),/verified only for python, typescript, go/);
  await assert.rejects(planSerenaRename({root:project,language:'python',file:'../x.py',line:2,column:5,new_name:'scale'}),/traversal/);
  assert.equal(readFileSync(join(project,'mathlib.py'),'utf8'),MATH);
});

const tsFiles={'tsconfig.json':JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext'},include:['*.ts']}),
  'mathlib.ts':'// \u{1F600} original CRLF\r\nexport function twice(value: number): number { return value * 2; }\r\n',
  'app.ts':'import {twice} from "./mathlib.js";\r\n// twice in comments stays\r\nif (twice(3) !== 6 || "twice".length !== 5) throw Error("behavior");\r\n'};
const tsc=join(process.cwd(),'node_modules','typescript','bin','tsc');
function native(language:'python'|'typescript',project:string,out:string){
  if(language==='python')execFileSync(serenaPython(),['-B','app.py'],{cwd:project,windowsHide:true,stdio:'pipe'});
  else{execFileSync(process.execPath,[tsc,'-p',project,'--outDir',out],{windowsHide:true,stdio:'pipe'});execFileSync(process.execPath,[join(out,'app.js')],{windowsHide:true,stdio:'pipe'});}
}

test('real Serena plans cross-file Python and TypeScript renames into exact durable batches',{skip:!live,timeout:600_000},async t=>{
  for(const language of ['python','typescript'] as const){
    const {root,project,own}=pyProject(t);
    if(language==='typescript'){rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));for(const [p,s] of Object.entries(tsFiles))writeFileSync(join(project,p),s);}
    native(language,project,join(root,'before'));rmSync(join(root,'before'),{recursive:true,force:true});
    const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
    const task=engine.create(project,'serena-'+language,'shared Serena rename',['echo ok'],true);
    const file=language==='python'?'mathlib.py':'mathlib.ts';
    const input={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language,file,line:2,column:language==='python'?5:17,new_name:'scale'};
    const result=await serenaRenameTask(engine,batches,input);
    assert.equal(result.state,'completed',JSON.stringify(result));
    const expected=language==='python'
      ?{'mathlib.py':MATH.replace('def twice(','def scale('),'app.py':APP.replace('import twice','import scale').replace('assert twice(3)','assert scale(3)')}
      :{'mathlib.ts':tsFiles['mathlib.ts'].replace('function twice(','function scale('),'app.ts':tsFiles['app.ts'].replace('{twice}','{scale}').replace('if (twice(3)','if (scale(3)')};
    for(const [p,s] of Object.entries(expected))assert.equal(readFileSync(join(project,p),'utf8'),s,`${language} ${p}`);
    native(language,project,join(root,'after'));rmSync(join(root,'after'),{recursive:true,force:true});
    const renamed=snapshot(project).fingerprint;
    assert.deepEqual(await serenaRenameTask(engine,batches,input),result);
    assert.equal(snapshot(project).fingerprint,renamed);
    const undo=batches.rollback(task.task_id,'rename','undo',task.lease_token!);
    assert.deepEqual(batches.rollback(task.task_id,'rename','undo',task.lease_token!),undo);
    assert.equal(snapshot(project).fingerprint,task.fingerprint);
  }
});

test('authenticated Forge MCP previews and completes a real Serena rename task with fixed acceptance',{skip:!live,timeout:600_000},async t=>{
  const {root,project,later}=pyProject(t);
  const config=loadConfig(writeTestDevspaceConfig(join(root,'config'),{
    server:{publicBaseUrl:'https://forge.example.com'},storage:{stateDir:join(root,'state')},
    workspaces:{allowedRoots:[project],worktreeRoot:join(root,'worktrees')},
    ui:{enabled:false},skills:{enabled:false},logging:{level:'silent'},
  }));
  const token=randomBytes(32).toString('base64url'),store=new SqliteOAuthStore(config.stateDir);
  const registered=store.registerClient({redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']},config.oauth.allowedRedirectHosts);
  store.saveAccessToken(createHash('sha256').update(token).digest('base64url'),{clientId:registered.client_id,scopes:['devspace'],expiresAt:Math.floor(Date.now()/1000)+600,resource:'https://forge.example.com/mcp'});
  store.close();
  const runtime=createServer(config),listener=runtime.app.listen(0,'127.0.0.1'),client=new Client({name:'serena-edit-live',version:'1.0.0'});
  later(async()=>{await client.close();await runtime.close();listener.closeAllConnections();await new Promise<void>(done=>listener.close(()=>done()));});
  await once(listener,'listening');const address=listener.address();assert.ok(address&&typeof address!=='string');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args},undefined,{timeout:300_000});return {error:!!r.isError,text:(r.content as {text:string}[])[0]!.text};};
  const ok=async(name:string,args:Record<string,unknown>)=>{const r=await call(name,args);assert.equal(r.error,false,`${name}: ${r.text}`);return JSON.parse(r.text);};
  const tools=(await client.listTools()).tools.map(item=>item.name);
  assert.ok(tools.includes('serena_rename_preview')&&tools.includes('task_serena_rename'));
  const query={language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'};
  const preview=await ok('serena_rename_preview',{path:project,...query});
  assert.deepEqual(preview.files.map((f:{file:string})=>f.file),['app.py','mathlib.py']);
  assert.equal(preview.readiness.stable_plans,2);
  assert.equal(readFileSync(join(project,'app.py'),'utf8'),APP,'preview is read-only');
  const python=serenaPython().replaceAll("'","''");
  const task=await ok('task_create',{path:project,idempotency_key:'serena-mcp',goal:'Rename twice to scale through Serena',acceptance_commands:[`& '${python}' -B app.py`]});
  assert.equal(preview.fingerprint,task.fingerprint);
  const denied=await call('task_serena_rename',{task_id:task.task_id,operation_id:'bad',expected_fingerprint:task.fingerprint,lease_token:task.lease_token,...query,language:'go'});
  assert.equal(denied.error,true);
  const args={task_id:task.task_id,operation_id:'serena-rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token,...query};
  const applied=await ok('task_serena_rename',args);
  assert.equal(applied.state,'completed');
  assert.deepEqual(await ok('task_serena_rename',args),applied,'exact receipt replay over MCP');
  const fingerprint=snapshot(project).fingerprint;
  await ok('task_verify',{task_id:task.task_id,operation_id:'verify',cmd:`& '${python}' -B app.py`,expected_fingerprint:fingerprint,lease_token:task.lease_token});
  let receipt;for(let i=0;i<600;i++){receipt=await ok('task_operation',{task_id:task.task_id,operation_id:'verify'});if(!['prepared','running'].includes(receipt.state))break;await new Promise(done=>setTimeout(done,100));}
  assert.equal(receipt.state,'completed',JSON.stringify(receipt));
  assert.equal(receipt.exit_code,0,JSON.stringify(receipt));
  const done=await ok('task_complete',{task_id:task.task_id,lease_token:task.lease_token});
  assert.equal(done.status,'complete',JSON.stringify(done));
  assert.match(readFileSync(join(project,'mathlib.py'),'utf8'),/def scale\(/);
});

const GO={'go.mod':'module demo\n\ngo 1.21\n','mathx/mathx.go':'package mathx\n\n// Twice doubles. 😀\nfunc Twice(v int) int { return v * 2 }\n','main.go':'package main\n\nimport (\n\t"demo/mathx"\n\t"fmt"\n)\n\nfunc main() {\n\tif mathx.Twice(3) != 6 {\n\t\tpanic("behavior")\n\t}\n\tfmt.Print("PASS")\n}\n'};
const goAvailable=live&&(()=>{try{execFileSync('go',['version'],{stdio:'pipe'});return true;}catch{return false;}})();
test('real Serena plans a cross-package Go rename with Forge pinned gopls and offline settings',{skip:!goAvailable,timeout:300_000},async t=>{
 const {root,project,own}=pyProject(t);rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));
 for(const [p,text] of Object.entries(GO)){mkdirSync(dirname(join(project,p)),{recursive:true});writeFileSync(join(project,p),text);}
 const run=()=>execFileSync('go',['run','.'],{cwd:project,encoding:'utf8',windowsHide:true,env:{...process.env,GOPROXY:'off',GOTOOLCHAIN:'local',GOFLAGS:'-mod=readonly',GOWORK:'off'}});
 assert.equal(run(),'PASS');
 const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
 const task=engine.create(project,'serena-go','shared Serena Go rename',['echo ok'],true);
 const input={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language:'go',file:'mathx/mathx.go',line:4,column:6,new_name:'Scale'};
 const result=await serenaRenameTask(engine,batches,input);assert.equal(result.state,'completed',JSON.stringify(result));
 // gopls also renames the doc comment that starts with the identifier.
 assert.equal(readFileSync(join(project,'mathx/mathx.go'),'utf8'),GO['mathx/mathx.go'].replace('func Twice(','func Scale(').replace('// Twice doubles','// Scale doubles'));
 assert.equal(readFileSync(join(project,'main.go'),'utf8'),GO['main.go'].replace('mathx.Twice(3)','mathx.Scale(3)'));
 assert.equal(run(),'PASS');
 assert.deepEqual(await serenaRenameTask(engine,batches,input),result);
 batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(snapshot(project).fingerprint,task.fingerprint);
 // gopls refuses an unexported name that would break other packages; nothing is written.
 await assert.rejects(serenaRenameTask(engine,batches,{...input,operation_id:'bad',new_name:'scale'}),/unexported|exited/);
 assert.equal(snapshot(project).fingerprint,task.fingerprint);
});

const JAVA={'pom.xml':'<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>demo</artifactId><version>1</version></project>\n',
 'src/main/java/demo/util/Calc.java':'package demo.util;\n\n/** Doubles values. \u{1F600} */\npublic final class Calc {\n    private Calc() {}\n    public static int twice(int value) { return value * 2; }\n}\n',
 'src/main/java/demo/App.java':'package demo;\n\nimport demo.util.Calc;\n\npublic class App {\n    public static void main(String[] args) {\n        // twice in comments stays\n        if (Calc.twice(3) != 6) throw new AssertionError("twice");\n        System.out.print("PASS");\n    }\n}\n'};
const javaAvailable=live&&existsSync(join(process.env.USERPROFILE??'','.chatgptforge','serena-java'))&&(()=>{try{execFileSync('javac',['-version'],{stdio:'pipe'});return true;}catch{return false;}})();
test('real Serena plans a cross-package Java rename with the private pinned JDT LS and no build import',{skip:!javaAvailable,timeout:600_000},async t=>{
 const {root,project,own}=pyProject(t);rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));
 for(const [p,text] of Object.entries(JAVA)){mkdirSync(dirname(join(project,p)),{recursive:true});writeFileSync(join(project,p),text);}
 const run=()=>{const out=join(root,'classes-'+randomBytes(4).toString('hex'));execFileSync('javac',['-encoding','UTF-8','-d',out,join(project,'src/main/java/demo/util/Calc.java'),join(project,'src/main/java/demo/App.java')],{stdio:'pipe'});return execFileSync('java',['-cp',out,'demo.App'],{encoding:'utf8'});};
 assert.equal(run(),'PASS');
 const {serenaJavaDigest,serenaJavaDir,serenaJavaLock}=await import('./serena-java.js');
 const pinned=serenaJavaLock().tree;assert.deepEqual(await serenaJavaDigest(serenaJavaDir()),pinned);
 const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
 const task=engine.create(project,'serena-java','shared Serena Java rename',['echo ok'],true);
 const input={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language:'java',file:'src/main/java/demo/util/Calc.java',line:6,column:23,new_name:'scale'};
 const result=await serenaRenameTask(engine,batches,input);assert.equal(result.state,'completed',JSON.stringify(result));
 assert.equal(readFileSync(join(project,'src/main/java/demo/util/Calc.java'),'utf8'),JAVA['src/main/java/demo/util/Calc.java'].replace('int twice(','int scale('));
 assert.equal(readFileSync(join(project,'src/main/java/demo/App.java'),'utf8'),JAVA['src/main/java/demo/App.java'].replace('Calc.twice(3)','Calc.scale(3)'));
 assert.equal(readFileSync(join(project,'pom.xml'),'utf8'),JAVA['pom.xml']);
 assert.equal(run(),'PASS');
 assert.deepEqual(await serenaRenameTask(engine,batches,input),result);
 batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(snapshot(project).fingerprint,task.fingerprint);
 // The private install is unchanged and nothing JDT LS wrote reached the project.
 assert.deepEqual(await serenaJavaDigest(serenaJavaDir()),pinned);
 assert.deepEqual(readdirSync(project).sort(),['pom.xml','src']);
 await assert.rejects(planSerenaRename({root:project,language:'java',file:'pom.xml',line:1,column:1,new_name:'x'}),/must be a source file/);
});

test('Serena Java private project derives source roots from package declarations and excludes nested roots',async()=>{
 const {javaSourceRoots,eclipseJavaProject,javaBuildFile}=await import('./serena-java.js');
 const files:[string,Buffer][]=[
  ['src/main/java/a/b/One.java',Buffer.from('/* package wrong; */\n// package wrong;\npackage a . b;\nclass One {}\n')],
  ['src/test/java/a/OneTest.java',Buffer.from('@Deprecated\npackage a;\n')],
  ['Root.java',Buffer.from('class Root {}\n')],
  ['odd/place/Mismatch.java',Buffer.from('package elsewhere;\n')],
  ['README.md',Buffer.from('package x;')],
 ];
 const roots=javaSourceRoots(files);
 assert.deepEqual(roots,['','odd/place','src/main/java','src/test/java']);
 const classpath=eclipseJavaProject(roots)['.classpath']!;
 assert.match(classpath,/kind="src" path="" excluding="odd\/place\/\|src\/main\/java\/\|src\/test\/java\/"/);
 assert.match(classpath,/kind="src" path="src\/main\/java"\/>/);
 assert.ok(['pom.xml','sub/build.gradle.kts','settings.gradle','.mvn/wrapper/x','gradle/wrapper/gradle-wrapper.properties','.settings/org.eclipse.jdt.core.prefs'].every(javaBuildFile));
 assert.ok(!['src/main/java/org/gradle/Api.java','pom.xml.txt'].some(javaBuildFile));
});

test('real Serena Java public type rename journals the filename move and restores exact source names',{skip:!javaAvailable,timeout:600_000},async t=>{
 const {root,project,own}=pyProject(t);rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));
 for(const [p,text] of Object.entries(JAVA)){mkdirSync(dirname(join(project,p)),{recursive:true});writeFileSync(join(project,p),text);}
 const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
 const task=engine.create(project,'serena-java-type','rename public Java type',['echo ok'],true);
 const input={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language:'java',file:'src/main/java/demo/util/Calc.java',line:4,column:20,new_name:'Calculator'};
 const result=await serenaRenameTask(engine,batches,input);assert.equal(result.state,'completed');
 assert.ok(!existsSync(join(project,input.file)));
 assert.equal(readFileSync(join(project,'src/main/java/demo/util/Calculator.java'),'utf8'),JAVA['src/main/java/demo/util/Calc.java'].replaceAll('Calc','Calculator'));
 assert.equal(readFileSync(join(project,'src/main/java/demo/App.java'),'utf8'),JAVA['src/main/java/demo/App.java'].replaceAll('Calc','Calculator'));
 const out=join(root,'classes');execFileSync('javac',['-encoding','UTF-8','-d',out,join(project,'src/main/java/demo/util/Calculator.java'),join(project,'src/main/java/demo/App.java')],{stdio:'pipe',windowsHide:true});
 assert.equal(execFileSync('java',['-cp',out,'demo.App'],{encoding:'utf8',windowsHide:true}),'PASS');
 assert.deepEqual(await serenaRenameTask(engine,batches,input),result);
 batches.rollback(task.task_id,'rename','undo',task.lease_token!);
 assert.equal(snapshot(project).fingerprint,task.fingerprint);
 assert.deepEqual(readdirSync(join(project,'src/main/java/demo/util')),['Calc.java']);
});

test('real Serena Java uses captured dependency jars and class directories without changing library bytes',{skip:!javaAvailable,timeout:600_000},async t=>{
 const {root,project}=pyProject(t);rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));
 const source=join(root,'library-src'),classes=join(root,'library-classes');mkdirSync(source);
 writeFileSync(join(source,'Base.java'),'package ext; public class Base { public int value(){return 21;} }');
 execFileSync('javac',['-d',classes,join(source,'Base.java')],{stdio:'pipe',windowsHide:true});
 mkdirSync(join(project,'lib'));const jar=join(project,'lib','base.jar');
 const settings=spawnSync('java',['-XshowSettings:properties','-version'],{encoding:'utf8',windowsHide:true});
 assert.equal(settings.status,0);const javaHome=settings.stderr.match(/java.home = (.+)/)![1]!.trim();
 execFileSync(join(javaHome,'bin','jar.exe'),['--create','--file',jar,'-C',classes,'.'],{stdio:'pipe',windowsHide:true});
 mkdirSync(join(project,'classes','ext'),{recursive:true});
 writeFileSync(join(project,'classes','ext','Base.class'),readFileSync(join(classes,'ext','Base.class')));
 const app='import ext.Base;\npublic class App extends Base {\n public int twice(){return value()*2;}\n public static void main(String[] args){System.out.print(new App().twice());}\n}\n';
 writeFileSync(join(project,'App.java'),app);
 const libraryBytes=readFileSync(jar);
 for(const cp of ['lib/base.jar','classes']){
  writeFileSync(join(project,'forge.java.json'),JSON.stringify({version:1,classpath:[cp]}));
  const before=snapshot(project).fingerprint;
  const plan=await planSerenaRename({root:project,language:'java',file:'App.java',line:3,column:13,new_name:'scaled'});
  assert.equal(plan.java_environment?.classpath_entries,1);assert.equal(plan.java_environment?.model_present,true);
  assert.equal(snapshot(project).fingerprint,before);assert.deepEqual(readFileSync(jar),libraryBytes);
  assert.equal(plan.changes.length,1);assert.equal(plan.changes[0]!.path,'App.java');
  assert.equal(plan.changes[0]!.content,app.replaceAll('twice','scaled'));
  const output=join(root,'output-'+randomBytes(4).toString('hex'));mkdirSync(output);
  writeFileSync(join(output,'App.java'),plan.changes[0]!.content!);
  execFileSync('javac',['-cp',join(project,cp),'-d',output,join(output,'App.java')],{stdio:'pipe',windowsHide:true});
  assert.equal(execFileSync('java',['-cp',output+';'+join(project,cp),'App'],{encoding:'utf8',windowsHide:true}),'42');
 }
 const query={root:project,language:'java',file:'App.java',line:3,column:13,new_name:'scaled'};
 let launched=false;
 await assert.rejects(planSerenaRename(query,undefined,{onLaunched:()=>{
  launched=true;
  writeFileSync(join(project,'forge.java.json'),JSON.stringify({version:1,classpath:[]}));
 }}),/classpath changed during analysis/);
 assert.equal(launched,true,'drift occurs after private dependencies have been captured');
 assert.equal(readFileSync(join(project,'App.java'),'utf8'),app);
 assert.deepEqual(readFileSync(jar),libraryBytes);
 writeFileSync(join(project,'forge.java.json'),JSON.stringify({version:1,classpath:[classes]}));
 let unauthorizedLaunch=false;
 await assert.rejects(planSerenaRename(query,undefined,{onLaunched:()=>{unauthorizedLaunch=true;}}),/approved|allowed|outside/i);
 assert.equal(unauthorizedLaunch,false,'out-of-root dependencies are refused before launching JDT LS');
 assert.equal(readFileSync(join(project,'App.java'),'utf8'),app);
});

test('real Serena Java preserves binary superclass contracts while renaming source hierarchies',{skip:!javaAvailable,timeout:600_000},async t=>{
 const {root,project}=pyProject(t);rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));
 const librarySource=join(root,'Base.java');
 writeFileSync(librarySource,'package ext; public class Base { public int value(){return 21;} }');
 const classes=join(project,'classes');
 execFileSync('javac',['-d',classes,librarySource],{stdio:'pipe',windowsHide:true});
 writeFileSync(join(project,'forge.java.json'),JSON.stringify({version:1,classpath:['classes']}));
 const binary=readFileSync(join(classes,'ext','Base.class'));
 const inherited='import ext.Base;\npublic class App extends Base {\n public int calculate(){return value()*2;}\n}\n';
 const override='import ext.Base;\npublic class App extends Base {\n @Override public int value(){return 42;}\n}\n';
 for(const source of [inherited,override]){
  const line=3,column=source.split('\n')[line-1]!.indexOf('value')+1;
  writeFileSync(join(project,'App.java'),source);
  const before=snapshot(project).fingerprint;
  await assert.rejects(planSerenaRename({root:project,language:'java',file:'App.java',line,column,new_name:'renamedValue'}),source===inherited?/value\(\) is read-only/:/Method to be renamed is binary/);
  assert.equal(snapshot(project).fingerprint,before);
  assert.deepEqual(readFileSync(join(classes,'ext','Base.class')),binary);
 }
 const base='public class Parent { public int value(){return 21;} }\n';
 const child='public class App extends Parent {\n @Override public int value(){return 42;}\n public static void main(String[] args){Parent p=new App();System.out.print(p.value());}\n}\n';
 writeFileSync(join(project,'Parent.java'),base);writeFileSync(join(project,'App.java'),child);
 const before=snapshot(project).fingerprint;
 const plan=await planSerenaRename({root:project,language:'java',file:'App.java',line:2,column:23,new_name:'renamedValue'});
 const changed=new Map(plan.changes.map(change=>[change.path,change.content]));
 assert.equal(changed.get('Parent.java'),base.replaceAll('value','renamedValue'));
 assert.equal(changed.get('App.java'),child.replaceAll('value','renamedValue'));
 assert.equal(snapshot(project).fingerprint,before);
 const output=join(root,'compiled');mkdirSync(output);
 for(const name of ['Parent.java','App.java'])writeFileSync(join(output,name),changed.get(name)!);
 execFileSync('javac',['-d',output,join(output,'Parent.java'),join(output,'App.java')],{stdio:'pipe',windowsHide:true});
 assert.equal(execFileSync('java',['-cp',output,'App'],{encoding:'utf8',windowsHide:true}),'42');
});

test('real Serena symbol editor changes Python symbols through durable batches; safe_delete refuses referenced symbols',{skip:!live,timeout:600_000},async t=>{
 const {root,project,own}=pyProject(t);
 writeFileSync(join(project,'extra.py'),'# \u{1F600} keep\r\ndef unused() -> int:\r\n    return 1\r\n\r\n\r\ndef kept() -> int:\r\n    return 2\r\n');
 const {serenaSymbolEditTask}=await import('./task-rename.js');
 const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
 const task=engine.create(project,'serena-edit','Serena symbol edits',['echo ok'],true);
 const run=()=>execFileSync('python',['-B','app.py'],{cwd:project,encoding:'utf8'});
 const base={task_id:task.task_id,lease_token:task.lease_token!,language:'python'};
 // Referenced symbols are never deleted and no intent is written.
 await assert.rejects(serenaSymbolEditTask(engine,batches,{...base,operation_id:'del-twice',expected_fingerprint:task.fingerprint,file:'mathlib.py',operation:'safe_delete',name_path:'twice'}),/referenced in .*app\.py/);
 assert.equal(engine.db.prepare("SELECT 1 FROM operations WHERE task_id=? AND id='del-twice'").get(task.task_id),undefined);
 const replace={...base,operation_id:'replace',expected_fingerprint:task.fingerprint,file:'mathlib.py',operation:'replace_body' as const,name_path:'twice',body:'def twice(value: int) -> int:\r\n    return value + value'};
 const replaced=await serenaSymbolEditTask(engine,batches,replace);assert.equal(replaced.state,'completed',JSON.stringify(replaced));
 assert.equal(readFileSync(join(project,'mathlib.py'),'utf8'),MATH.replace('return value * 2','return value + value'));
 assert.deepEqual(await serenaSymbolEditTask(engine,batches,replace),replaced);
 const afterReplace=snapshot(project).fingerprint;
 const insert=await serenaSymbolEditTask(engine,batches,{...base,operation_id:'insert',expected_fingerprint:afterReplace,file:'mathlib.py',operation:'insert_after',name_path:'twice',body:'\r\n\r\ndef thrice(value: int) -> int:\r\n    return value * 3\r\n'});
 assert.equal(insert.state,'completed');assert.match(readFileSync(join(project,'mathlib.py'),'utf8'),/def thrice\(value: int\) -> int:\r?\n    return value \* 3/);
 const before=await serenaSymbolEditTask(engine,batches,{...base,operation_id:'before',expected_fingerprint:snapshot(project).fingerprint,file:'extra.py',operation:'insert_before',name_path:'kept',body:'LIMIT = 3\r\n\r\n\r\n'});
 assert.equal(before.state,'completed');assert.match(readFileSync(join(project,'extra.py'),'utf8'),/LIMIT = 3\r?\n\r?\n\r?\ndef kept/);
 const deleted=await serenaSymbolEditTask(engine,batches,{...base,operation_id:'del-unused',expected_fingerprint:snapshot(project).fingerprint,file:'extra.py',operation:'safe_delete',name_path:'unused'});
 assert.equal(deleted.state,'completed');const extra=readFileSync(join(project,'extra.py'),'utf8');
 assert.doesNotMatch(extra,/def unused/);assert.match(extra,/\u{1F600} keep/u);assert.match(extra,/def kept/);
 assert.equal(run(),'');
 // Each batch rolls back exactly, newest first.
 for(const id of ['del-unused','before','insert','replace'])batches.rollback(task.task_id,id,'undo-'+id,task.lease_token!);
 assert.equal(snapshot(project).fingerprint,task.fingerprint);
 await assert.rejects(serenaSymbolEditTask(engine,batches,{...base,operation_id:'missing',expected_fingerprint:task.fingerprint,file:'mathlib.py',operation:'replace_body',name_path:'no_such_symbol',body:'def x():\n    pass'}),/exited|No symbol|not found/i);
 await assert.rejects(serenaSymbolEditTask(engine,batches,{...base,operation_id:'bad-body',expected_fingerprint:task.fingerprint,file:'mathlib.py',operation:'replace_body',name_path:'twice',body:'  '}),/non-empty/);
});

test('real Serena symbol editor replaces a TypeScript method body and a Java method body',{skip:!live,timeout:900_000},async t=>{
 const {root,project,own}=pyProject(t);rmSync(join(project,'mathlib.py'));rmSync(join(project,'app.py'));
 writeFileSync(join(project,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext'},include:['*.ts']}));
 writeFileSync(join(project,'calc.ts'),'export class Calc {\n  twice(value: number): number {\n    return value * 2;\n  }\n}\n');
 const {serenaSymbolEditTask}=await import('./task-rename.js');
 const engine=own(new DurableTasks(join(root,'state'))),batches=new TaskFileBatches(engine);
 const task=engine.create(project,'serena-edit-ts','Serena TS edit',['echo ok'],true);
 const ts=await serenaSymbolEditTask(engine,batches,{task_id:task.task_id,lease_token:task.lease_token!,operation_id:'ts',expected_fingerprint:task.fingerprint,language:'typescript',file:'calc.ts',operation:'replace_body',name_path:'Calc/twice',body:'twice(value: number): number {\n    return value + value;\n  }'});
 assert.equal(ts.state,'completed',JSON.stringify(ts));
 assert.equal(readFileSync(join(project,'calc.ts'),'utf8'),'export class Calc {\n  twice(value: number): number {\n    return value + value;\n  }\n}\n');
 if(!javaAvailable)return;
 const javaProject=join(root,'java');mkdirSync(join(javaProject,'src/main/java/demo/util'),{recursive:true});
 for(const [p,text] of Object.entries(JAVA)){mkdirSync(dirname(join(javaProject,p)),{recursive:true});writeFileSync(join(javaProject,p),text);}
 const jtask=engine.create(javaProject,'serena-edit-java','Serena Java edit',['echo ok'],true);
 const java=await serenaSymbolEditTask(engine,batches,{task_id:jtask.task_id,lease_token:jtask.lease_token!,operation_id:'java',expected_fingerprint:jtask.fingerprint,language:'java',file:'src/main/java/demo/util/Calc.java',operation:'replace_body',name_path:'Calc/twice',body:'public static int twice(int value) { return value + value; }'});
 assert.equal(java.state,'completed',JSON.stringify(java));
 assert.match(readFileSync(join(javaProject,'src/main/java/demo/util/Calc.java'),'utf8'),/public static int twice\(int value\) \{ return value \+ value; \}/);
 assert.equal(readFileSync(join(javaProject,'pom.xml'),'utf8'),JAVA['pom.xml']);
});

test('Serena private runs use parallel slots: two run at once and a third waits for a free slot',{skip:!live,timeout:120_000},async t=>{
  const {root,project}=pyProject(t);
  const {SERENA_SLOTS,serenaSlotStatus}=await import('./serena-workspace-edit.js');
  if(SERENA_SLOTS<2){t.skip('FORGE_SERENA_SLOTS is 1');return;}
  const helper=join(root,'slow.py');writeFileSync(helper,'import time,sys\ntime.sleep(3)\nsys.exit(7)\n');
  const launched:number[]=[];const start=Date.now();
  const runs=[0,1,2].map(()=>planSerenaRename({root:project,language:'python',file:'mathlib.py',line:2,column:5,new_name:'scale'},undefined,{helper,onLaunched:()=>{launched.push(Date.now()-start);}}));
  await new Promise(r=>setTimeout(r,1500));
  const midway=serenaSlotStatus();
  assert.equal(midway.active,SERENA_SLOTS);assert.equal(midway.waiting,3-Math.min(3,SERENA_SLOTS));
  const settled=await Promise.allSettled(runs);
  assert.ok(settled.every(r=>r.status==='rejected'&&/exited 7/.test(String(r.reason))));
  assert.equal(launched.length,3);
  // The first two started together; the third only after a slot was released.
  assert.ok(Math.abs(launched[1]!-launched[0]!)<1500,JSON.stringify(launched));
  if(SERENA_SLOTS===2)assert.ok(launched[2]!-launched[0]!>=2500,JSON.stringify(launched));
  assert.deepEqual({active:serenaSlotStatus().active,waiting:serenaSlotStatus().waiting},{active:0,waiting:0});
});

const languagesInstalled=live&&existsSync(join(serenaLanguagesHome(),'language_servers','static'));
test('Forge-installed Serena languages: Lua and Bash cross-file renames, C/C++ and PHP file-local edits; C/C++ rename and safe_delete refused',{skip:!languagesInstalled,timeout:900_000},async t=>{
  const make=(files:Record<string,string>)=>{const root=mkdtempSync(join(tmpdir(),'forge-serena-lang-'));for(const [f,s] of Object.entries(files))writeFileSync(join(root,f),s);t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5}));return root;};
  const lua=make({'calc.lua':'local M = {}\nfunction M.add(a, b)\n  return a - b\nend\nreturn M\n','main.lua':'local calc = require("calc")\nprint(calc.add(1, 2))\n'});
  const luaPlan=await planSerenaRename({root:lua,language:'lua',file:'calc.lua',line:2,column:12,new_name:'sum'});
  assert.deepEqual(luaPlan.files.map(f=>f.file),['calc.lua','main.lua']);assert.equal(luaPlan.readiness.stable_plans,2);
  const bash=make({'main.sh':'add() {\n  echo $(($1 - $2))\n}\nadd 1 2\n'});
  assert.equal((await planSerenaRename({root:bash,language:'bash',file:'main.sh',line:1,column:1,new_name:'sum'})).files[0]!.replacements.length,2);
  const cpp=make({'calc.cpp':'int add(int a, int b) { return a - b; }\nint main() { return add(1, 2); }\n'});
  const edit=await planSerenaSymbolEdit({root:cpp,language:'cpp',file:'calc.cpp',operation:'replace_body',name_path:'add',body:'int add(int a, int b) { return a + b; }'});
  assert.match(edit.changes[0]!.content!,/return a \+ b/);
  await assert.rejects(planSerenaRename({root:cpp,language:'cpp',file:'calc.cpp',line:1,column:5,new_name:'sum'}),/verified only for/);
  await assert.rejects(planSerenaSymbolEdit({root:cpp,language:'cpp',file:'calc.cpp',operation:'safe_delete',name_path:'add'}),/needs verified cross-file references/);
  const php=make({'calc.php':'<?php\nfunction add($a, $b) { return $a - $b; }\n'});
  const phpEdit=await planSerenaSymbolEdit({root:php,language:'php',file:'calc.php',operation:'replace_body',name_path:'add',body:'function add($a, $b) { return $a + $b; }'});
  assert.match(phpEdit.changes[0]!.content!,/\$a \+ \$b/);
});
