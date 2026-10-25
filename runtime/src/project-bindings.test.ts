import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {loadConfig} from './config.js';
import {createServer} from './server.js';
import {createForgeManager} from './forge-manager.js';
import {SqliteOAuthStore} from './oauth-store.js';
import {writeTestDevspaceConfig} from './test-support/config.test.js';
import {DurableTasks} from './durable-tasks.js';
import {ForgeProjectBindings} from './project-bindings.js';
import {z} from 'zod';

test('multi-project Serena calls retain their explicit project lists without a default binding',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-multi-binding-'));
  const engine=new DurableTasks(join(root,'state'));
  t.after(async()=>{engine.close();await rm(root,{recursive:true,force:true,maxRetries:5});});
  const bindings=new ForgeProjectBindings(engine,[root]);
  const handlers=new Map<string,Function>();
  const target=bindings.wrap({registerTool:((name:string,_definition:unknown,handler:Function)=>handlers.set(name,handler)) as any,registerResource:(()=>{}) as any},{} as any);
  for(const name of ['serena_compare_memories','serena_compare_symbols','serena_compare_diagnostics','serena_query_projects']){
    target.registerTool(name,{description:'multiple projects',inputSchema:{paths:z.array(z.string())}},async input=>input as any);
    const input={paths:[join(root,'a'),join(root,'b')]};
    assert.deepEqual(await handlers.get(name)!(input),input);
  }
  target.registerTool('serena_find_file',{description:'single project',inputSchema:{path:z.string()}},async input=>input as any);
  assert.equal((await handlers.get('serena_find_file')!({})).isError,true);
});

test('custom project setup saves an explicit grant and binding together, with no access before restart',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'forge-custom-binding-'))),a=join(root,'approved'),b=join(root,'自己的 專案');
  await mkdir(a);await mkdir(b);
  const state=join(root,'state'),roots=[a];let saved:string[]|undefined;
  let engine=new DurableTasks(state),bindings=new ForgeProjectBindings(engine,roots);
  bindings.seen('custom-client','ChatGPT');
  const manager=createForgeManager(engine,roots,undefined,{projectBindings:bindings,saveRoots:value=>{saved=value;}});
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(async()=>{listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const url='http://127.0.0.1:'+(listener.address() as {port:number}).port+'/api/project-bindings';
  const headers={Authorization:'Bearer '+manager.token,'Content-Type':'application/json'};
  const input={client_id:'custom-client',name:'我的專案',path:b};
  const post=(body:object,auth:Record<string,string>=headers)=>fetch(url,{method:'POST',headers:auth,body:JSON.stringify(body)});
  assert.equal((await post({...input,approve_project:true},{...headers,Authorization:'Bearer wrong'})).status,401);
  assert.equal((await post({...input,approve_project:true},{...headers,Origin:'https://foreign.example'})).status,403);
  assert.equal((await post(input)).status,400,'A path alone must not grant a new root');
  assert.equal((await post({...input,client_id:'unknown',approve_project:true})).status,400);
  assert.equal((await post({...input,path:join(root,'missing'),approve_project:true})).status,400);
  assert.equal(saved,undefined);assert.equal(bindings.list()[0]!.root,null);
  const response=await post({...input,approve_project:true});assert.equal(response.status,200);
  const receipt=await response.json() as any;assert.equal(receipt.restart_required,true);assert.equal(receipt.connection.root,b);
  assert.deepEqual(saved,[a,b]);assert.deepEqual(roots,[a],'Live filesystem access is unchanged until restart');
  await assert.rejects(bindings.withClient('custom-client',()=>bindings.context()),/outside allowed/);
  const listing=await (await fetch(url,{headers})).json() as any;
  assert.deepEqual(listing.projects.find((p:any)=>p.path===b),{name:'自己的 專案',path:b,pending:true});
  assert.equal((await post({...input,name:'重新命名'})).status,200,'An already saved pending grant can be selected again');
  engine.close();engine=new DurableTasks(state);bindings=new ForgeProjectBindings(engine,saved!);
  const context=await bindings.withClient('custom-client',()=>bindings.context());
  assert.equal(context.project_path,b);assert.equal(context.connection_name,'重新命名');
});

test('a failed custom-project config save leaves the previous binding intact',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'forge-binding-save-fail-'))),a=join(root,'a'),b=join(root,'b');await mkdir(a);await mkdir(b);
  const engine=new DurableTasks(join(root,'state')),bindings=new ForgeProjectBindings(engine,[a]);bindings.seen('client','ChatGPT');await bindings.set('client','Original',a);
  const manager=createForgeManager(engine,[a],undefined,{projectBindings:bindings,saveRoots:()=>{throw Error('Cannot save config');}});
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(async()=>{listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const response=await fetch('http://127.0.0.1:'+(listener.address() as {port:number}).port+'/api/project-bindings',{method:'POST',headers:{Authorization:'Bearer '+manager.token,'Content-Type':'application/json'},body:JSON.stringify({client_id:'client',name:'New',path:b,approve_project:true})});
  assert.equal(response.status,400);assert.equal((await bindings.withClient('client',()=>bindings.context())).project_path,a);
});

test('authenticated plugin clients use project defaults while allowing explicit other projects and task/workspace IDs',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'forge-binding-http-'))),a=join(root,'a'),b=join(root,'b');
  await Promise.all([mkdir(a),mkdir(b)]);
  await Promise.all([writeFile(join(a,'marker.txt'),'A'),writeFile(join(b,'marker.txt'),'B')]);
  const config=loadConfig(writeTestDevspaceConfig(join(root,'config'),{
    server:{publicBaseUrl:'https://forge.example.com'},storage:{stateDir:join(root,'state')},
    workspaces:{allowedRoots:[a,b],worktreeRoot:join(root,'worktrees')},logging:{level:'silent'},skills:{enabled:false},
  }));
  const store=new SqliteOAuthStore(config.stateDir);
  const identities=['Forge A','Forge B','General Forge'].map(client_name=>{
    const client=store.registerClient({client_name,redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']},config.oauth.allowedRedirectHosts);
    const token=randomBytes(32).toString('base64url');
    store.saveAccessToken(createHash('sha256').update(token).digest('base64url'),{clientId:client.client_id,scopes:config.oauth.scopes,expiresAt:Math.floor(Date.now()/1000)+600,resource:config.publicBaseUrl+'/mcp'});
    return {id:client.client_id,token};
  });
  const renewedToken=randomBytes(32).toString('base64url');
  store.saveAccessToken(createHash('sha256').update(renewedToken).digest('base64url'),{clientId:identities[0]!.id,scopes:config.oauth.scopes,expiresAt:Math.floor(Date.now()/1000)+600,resource:config.publicBaseUrl+'/mcp'});
  const renewedIdentity={id:identities[0]!.id,token:renewedToken};store.close();
  const runtime=createServer(config),listener=runtime.app.listen(0,'127.0.0.1');await once(listener,'listening');
  const manager=createForgeManager(runtime.durableTasks,[a,b],undefined,{projectBindings:runtime.projectBindings});
  const management=manager.app.listen(0,'127.0.0.1');await once(management,'listening');
  const port=(listener.address() as {port:number}).port,managerUrl='http://127.0.0.1:'+(management.address() as {port:number}).port;
  const clients:Client[]=[];
  t.after(async()=>{
    for(const c of clients)await c.close();
    listener.closeAllConnections();management.closeAllConnections();
    await Promise.all([new Promise<void>(r=>listener.close(()=>r())),new Promise<void>(r=>management.close(()=>r()))]);
    await runtime.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  for(const identity of [...identities,renewedIdentity]){
    const c=new Client({name:'binding-fixture',version:'1'});
    await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+identity.token}}}));clients.push(c);
  }
  const raw=(client:number,name:string,args:Record<string,unknown>={})=>clients[client]!.callTool({name,arguments:args});
  const ok=async(client:number,name:string,args:Record<string,unknown>={})=>{
    const r=await raw(client,name,args);assert.ok(!r.isError,JSON.stringify(r));
    if(r.structuredContent)return r.structuredContent as any;
    return JSON.parse((r.content as {type:string,text:string}[]).find(c=>c.type==='text')!.text);
  };
  const denied=async(client:number,name:string,args:Record<string,unknown>={})=>assert.equal((await raw(client,name,args)).isError,true,name);
  const headers={Authorization:'Bearer '+manager.token,'Content-Type':'application/json'};
  assert.equal((await fetch(managerUrl+'/api/project-bindings')).status,401);
  assert.equal((await fetch(managerUrl+'/api/project-bindings',{method:'POST',headers:{...headers,Origin:'https://foreign.example'},body:'{}'})).status,403);
  const bind=async(client:number,name:string,path:string)=>{
    const r=await fetch(managerUrl+'/api/project-bindings',{method:'POST',headers,body:JSON.stringify({client_id:identities[client]!.id,name,path})});
    assert.equal(r.status,200,await r.text());
  };
  await bind(0,'Forge A',a);await bind(1,'Forge B',b);
  const schema=(await clients[0]!.listTools()).tools;
  for(const name of ['open_workspace','task_create','code_navigate','serena_find_file'])assert.ok(!schema.find(t=>t.name===name)!.inputSchema.required?.includes('path'),name);
  assert.ok(schema.some(t=>t.name==='project_context'));
  const [ca,cb,cg]=await Promise.all([ok(0,'project_context'),ok(1,'project_context'),ok(2,'project_context')]);
  assert.equal(ca.project_path,a);assert.equal(cb.project_path,b);assert.equal(cg.bound,false);
  assert.equal((await ok(3,'project_context')).project_path,a,'A new bearer for the same OAuth client keeps its project');
  assert.equal(runtime.projectBindings.list().length,3,'Token rotation must not create a second connection');
  const [wa,wb]=await Promise.all([ok(0,'open_workspace'),ok(1,'open_workspace')]);
  assert.equal(wa.root,a);assert.equal(wb.root,b);
  assert.equal((await ok(0,'open_workspace',{path:b})).root,b);assert.equal((await ok(0,'open_workspace',{path:'../b'})).root,b);
  await denied(0,'open_workspace',{path:root});
  assert.equal((await ok(0,'project_context')).project_path,a,'Explicit overrides never change the default');
  assert.equal((await raw(0,'read',{workspace_id:wb.workspace_id,path:'marker.txt'})).isError,undefined);
  assert.equal(ca.binding_mode,'default');assert.equal(ca.allows_other_projects,true);
  await denied(2,'open_workspace');
  assert.equal((await ok(2,'open_workspace',{path:b})).root,b);
  const cmd=`node -e "if(require('fs').readFileSync('receipt.txt','utf8')!=='A')process.exit(1);console.log(process.cwd())"`;
  const [ta,tb]=await Promise.all([
    ok(0,'task_create',{idempotency_key:'bound',goal:'A no-path acceptance',acceptance_commands:[cmd]}),
    ok(1,'task_create',{idempotency_key:'bound',goal:'B no-path acceptance',acceptance_commands:['echo B']}),
  ]);
  assert.equal(ta.root,a);assert.equal(tb.root,b);
  assert.equal((await ok(0,'task_status',{task_id:tb.task_id})).root,b);
  await denied(0,'task_write',{task_id:tb.task_id,lease_token:'wrong-lease',operation_id:'wrong-lease',path:'receipt.txt',expected_hash:null,content:'bad'});
  assert.deepEqual(new Set((await ok(0,'task_list')).map((r:any)=>r.id)),new Set([ta.task_id,tb.task_id]));
  assert.deepEqual(new Set((await ok(1,'task_list')).map((r:any)=>r.id)),new Set([ta.task_id,tb.task_id]));
  await ok(0,'task_write',{task_id:ta.task_id,lease_token:ta.lease_token,operation_id:'write',path:'receipt.txt',expected_hash:null,content:'A'});
  await ok(0,'task_write',{task_id:tb.task_id,lease_token:tb.lease_token,operation_id:'cross-project-write',path:'cross.txt',expected_hash:null,content:'explicit B task'});
  assert.equal(await readFile(join(b,'cross.txt'),'utf8'),'explicit B task');
  assert.equal(await readFile(join(a,'receipt.txt'),'utf8'),'A');
  await assert.rejects(readFile(join(b,'receipt.txt')),/ENOENT/);
  const status=await ok(0,'task_status',{task_id:ta.task_id});
  await ok(0,'task_verify',{task_id:ta.task_id,lease_token:ta.lease_token,operation_id:'verify',cmd,expected_fingerprint:status.fingerprint,timeout_ms:60000});
  let operation;
  for(let i=0;i<200;i++){operation=await ok(0,'task_operation',{task_id:ta.task_id,operation_id:'verify'});if(operation.state==='completed')break;await delay(100);}
  assert.equal(operation.state,'completed');assert.equal(operation.exit_code,0);assert.ok(operation.output.includes(a));
  assert.equal((await ok(0,'task_complete',{task_id:ta.task_id,lease_token:ta.lease_token})).status,'complete');
  // Same live client sees rename/rebind without a catalog refresh or reconnect.
  await bind(0,'Renamed A',a);assert.equal((await ok(0,'project_context')).connection_name,'Renamed A');
  await bind(0,'Now B',b);assert.equal((await ok(0,'open_workspace')).root,b);assert.equal((await ok(0,'task_status',{task_id:ta.task_id})).root,a);
  const unbind=await fetch(managerUrl+'/api/project-bindings',{method:'POST',headers,body:JSON.stringify({client_id:identities[0]!.id,unbind:true})});assert.equal(unbind.status,200);
  assert.equal((await ok(0,'project_context')).bound,false);await denied(0,'task_create',{idempotency_key:'missing',goal:'explicit required',acceptance_commands:['echo x']});
});

test('project defaults persist and explicit overrides survive revoked defaults while global roots remain enforced',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'forge-binding-store-'))),a=join(root,'a'),b=join(root,'b');await mkdir(a);await mkdir(b);
  const state=join(root,'state'),roots=[a,b];let engine=new DurableTasks(state),bindings=new ForgeProjectBindings(engine,roots);
  t.after(async()=>{engine.close();await rm(join(a,'escape'),{force:true});await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await assert.rejects(bindings.set('unknown','x',a),/尚未出現/);
  bindings.seen('alpha','ChatGPT');await assert.rejects(bindings.set('alpha','outside',root),/outside allowed/);
  await bindings.set('alpha','My project',a);engine.close();engine=new DurableTasks(state);bindings=new ForgeProjectBindings(engine,roots);
  assert.equal((await bindings.withClient('alpha',()=>bindings.context())).project_path,a);
  roots.splice(0,1);await assert.rejects(bindings.withClient('alpha',()=>bindings.context()),/outside allowed/);
  roots.unshift(a);
  const link=join(a,'escape');await symlink(b,link,process.platform==='win32'?'junction':'dir');
  // A symlink to another globally allowed project is a valid explicit override.
  const handlers=new Map<string,Function>();
  const target=bindings.wrap({registerTool:((name:string,_def:unknown,run:Function)=>handlers.set(name,run)) as any,registerResource:(()=>{}) as any},{} as any);
  target.registerTool('code_navigate',{inputSchema:{},description:'test'},async()=>({content:[{type:'text',text:'allowed override'}]}));
  const r=await bindings.withClient('alpha',()=>handlers.get('code_navigate')!({path:link}));assert.ok(!r.isError);
  roots.splice(0,1);
  const override=await bindings.withClient('alpha',()=>handlers.get('code_navigate')!({path:b}));assert.ok(!override.isError,'Invalid default must not block explicit other project');
  const missing=await bindings.withClient('alpha',()=>handlers.get('code_navigate')!({}));assert.equal(missing.isError,true);
  const outside=await bindings.withClient('alpha',()=>handlers.get('code_navigate')!({path:root}));assert.equal(outside.isError,true);
  assert.equal(bindings.list()[0]!.name,'My project');assert.equal((engine.db.prepare('SELECT COUNT(*) n FROM project_binding_events').get() as any).n,1);
});
