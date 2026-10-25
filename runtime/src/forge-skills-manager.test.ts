import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createServer as createForgeServer} from './server.js';
import {loadConfig} from './config.js';
import {SqliteOAuthStore} from './oauth-store.js';
import {writeTestDevspaceConfig} from './test-support/config.test.js';
import {createForgeManager} from './forge-manager.js';
import {devspaceConfigSchema} from './config-schema.js';
import {DurableTasks} from './durable-tasks.js';
import {ForgeSkillsManager,skillsManagerEndpoint,registerSkillsManager} from './forge-skills-manager.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';

test('manager endpoint and schemas exclude remote redirects, arbitrary files and arbitrary tools',()=>{
  assert.equal(skillsManagerEndpoint('http://127.0.0.1:8943/mcp'),'http://127.0.0.1:8943/mcp');
  for(const endpoint of ['https://example.test/mcp','http://localhost:8943/mcp','http://127.0.0.1:8943/mcp?token=secret','http://user:secret@127.0.0.1/mcp','http://127.0.0.1:8943/manager','file:///mcp'])assert.throws(()=>skillsManagerEndpoint(endpoint));
  const tools:{name:string;definition:any}[]=[];
  registerSkillsManager({registerTool:(name:string,definition:unknown)=>{tools.push({name,definition});}} as unknown as McpRegistrationTarget,{} as ForgeSkillsManager);
  assert.equal(tools.length,22);
  assert.ok(!tools.some(t=>/deploy|execute|provider|delete/.test(t.name)));
  assert.equal('path' in tools.find(t=>t.name==='skills_manager_skills_validate')!.definition.inputSchema,false);
  assert.ok(tools.filter(t=>!t.definition.annotations.readOnlyHint).every(t=>'lease_token' in t.definition.inputSchema&&'operation_id' in t.definition.inputSchema));
  assert.equal(devspaceConfigSchema.parse({configVersion:1}).skillsManager.endpoint,null);
  for(const endpoint of ['http://127.0.0.1:8943/mcp','http://[::1]:8943/mcp'])assert.ok(devspaceConfigSchema.safeParse({configVersion:1,skillsManager:{endpoint}}).success);
  assert.equal(devspaceConfigSchema.safeParse({configVersion:1,skillsManager:{endpoint:'https://example.test/mcp'}}).success,false);
});

test('real Skills Manager preserves authority, recursive resources, versions, run transitions and replay receipts',{
  skip:!process.env.FORGE_SKILLS_MANAGER_FIXTURE,
},async t=>{
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'forge-skills-integration-'));
  const project=join(root,'project'),backend=join(root,'backend');await mkdir(project);await mkdir(backend);
  const child=spawn(process.env.FORGE_SKILLS_MANAGER_PYTHON??'python',[process.env.FORGE_SKILLS_MANAGER_FIXTURE!,backend],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const engine=new DurableTasks(join(root,'state'));
  const owned=engine.create(project,'manager','Skills Manager integration',['echo accepted'],true);
  const taskId=owned.task_id,lease=owned.lease_token!;
  let proxy:ReturnType<typeof createServer>|undefined;
  let managerListener:ReturnType<ReturnType<typeof createForgeManager>['app']['listen']>|undefined;
  let closeHost:(()=>Promise<void>)|undefined;
  const actors:ReturnType<typeof spawn>[]=[];
  let releaseRaceReply=()=>{};
  const raceReply=new Promise<void>(resolve=>{releaseRaceReply=resolve;});
  t.after(async()=>{
    releaseRaceReply();
    for(const actor of actors)if(actor.exitCode===null&&actor.signalCode===null){const ended=once(actor,'exit');actor.kill();await ended;}
    await closeHost?.();
    if(managerListener){managerListener.closeAllConnections();await new Promise<void>(resolve=>managerListener!.close(()=>resolve()));}
    if(proxy){proxy.closeAllConnections();await new Promise<void>(resolve=>proxy!.close(()=>resolve()));}
    if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
    engine.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(parent+ (process.platform==='win32'?'\\':'/')));await rm(root,{recursive:true,force:true});
  });
  let endpoint='';
  for(let i=0;i<500;i++){
    if(child.exitCode!==null)throw Error('Backend exited: '+stderr);
    try{endpoint=JSON.parse(await readFile(join(backend,'endpoint.json'),'utf8')).endpoint;break;}catch{await new Promise(r=>setTimeout(r,20));}
  }
  assert.ok(endpoint,'Actual manager did not start: '+stderr);
  const manager=new ForgeSkillsManager(engine,[project],endpoint);
  const payload=(result:any)=>{assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const read=async(tool:any,args:Record<string,unknown>={})=>payload(await manager.read(tool,args));
  const change=async(tool:any,id:string,args:Record<string,unknown>)=>payload(await manager.mutate(taskId,id,lease,tool,args));
  assert.equal((await read('skills_status')).skill_count,3);
  const selected=await read('skills_get',{name:'one-skill'});
  assert.match(JSON.stringify(selected),/HIGH AUTHORITY/);
  assert.ok((await read('skills_search',{query:'fixture'})).length>0);
  assert.equal((await read('skills_list')).length,3);
  assert.equal((await read('skills_validate',{name:'one-skill'})).ok,true);
  await read('skills_evaluate',{name:'one-skill',query:'fixture'});
  const resources=await read('skills_resources',{name:'one-skill'});
  assert.match(JSON.stringify(resources),/Fixture script must never execute/);
  const resolved=await read('skills_resolve',{name:'one-skill',task:'Child',max_depth:2});
  assert.equal(resolved.resolution.analysis.kind,'router');
  assert.match(JSON.stringify(resolved),/two-skill/);
  const spec={name:'Forge workflow',version:1,stages:[{key:'work',title:'Implement',bindings:[{key:'primary',skill_id:'one-skill',type:'required'}]},{key:'finish',title:'Verify',bindings:[{key:'child',skill_id:'two-skill',type:'required'}]}]};
  await change('workflow_create','workflow-dry',{spec,dry_run:true});
  const workflow=await change('workflow_create','workflow-1',{spec});
  const version2=await change('workflow_create','workflow-2',{spec:{...spec,version:2}});
  assert.notEqual(workflow.workflow_id,version2.workflow_id);
  assert.equal((await read('workflow_get',{workflow_id:workflow.workflow_id})).version,1);
  assert.equal((await read('workflow_list')).items.length,2);
  assert.equal((await read('workflow_search',{query:'Forge'})).items.length,2);
  await read('workflow_plan',{workflow_id:workflow.workflow_id});
  await read('workflow_prompt',{workflow_id:workflow.workflow_id});
  const run=await change('run_create','create',{workflow_id:workflow.workflow_id,context:{deliverable:'fixture'},run_key:'acceptance'});
  assert.equal(run.context._forge_task_id,taskId);
  await assert.rejects(manager.mutate(taskId,'bad-lease','00000000-0000-4000-8000-000000000000','run_start',{run_id:run.run_id}),/lease/);
  await assert.rejects(manager.mutate(taskId,'alien',lease,'run_start',{run_id:'not-owned'}),/not owned/);
  const resumed=new ForgeSkillsManager(engine,[project],endpoint);
  assert.deepEqual(payload(await resumed.mutate(taskId,'create',lease,'run_create',{run_key:'acceptance',context:{deliverable:'fixture'},workflow_id:workflow.workflow_id})),run);
  assert.equal(JSON.parse(await readFile(join(backend,'calls.json'),'utf8')).run_create,1);
  await assert.rejects(resumed.mutate(taskId,'create',lease,'run_create',{workflow_id:version2.workflow_id,run_key:'acceptance'}),/different/);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(manager.mutate(taskId,'pre-cancelled',lease,'run_start',{run_id:run.run_id},cancelled.signal));
  assert.equal(engine.db.prepare('SELECT 1 FROM skills_manager_operations WHERE task_id=? AND id=?').get(taskId,'pre-cancelled'),undefined);
  await assert.rejects(manager.read('deployment_plan' as any,{}),/Unknown/);
  await change('run_start','start',{run_id:run.run_id});
  await change('run_block','block',{run_id:run.run_id,reason:'Need evidence'});
  const invalidResume=await manager.mutate(taskId,'resume-before-evidence',lease,'run_resume',{run_id:run.run_id});
  assert.equal(invalidResume.isError,true);
  await change('run_evidence_add','evidence',{run_id:run.run_id,kind:'verification',payload:{result:'fixture'},evidence_key:'verified'});
  await change('run_resume','resume',{run_id:run.run_id});
  await change('run_succeed','success-1',{run_id:run.run_id,gate_result:{passed:true}});
  assert.equal((await change('run_succeed','success-2',{run_id:run.run_id,gate_result:{passed:true}})).status,'completed');
  const snapshot=await read('run_get',{run_id:run.run_id});
  assert.ok(snapshot.evidence.length>0&&snapshot.audit.some((a:any)=>a.action==='run.create'));
  assert.throws(()=>engine.complete(taskId,lease),/Missing or stale successful verification/);
  const verifyFingerprint=engine.status(taskId).fingerprint;
  engine.exec(taskId,'before-unknown-verify','echo accepted',verifyFingerprint,8000,'verify',lease);
  for(let i=0;i<1000;i++){
    const receipt=engine.result(taskId,'before-unknown-verify');
    if(receipt.state==='completed'){assert.equal(receipt.exit_code,0);break;}
    assert.ok(!['unknown','reconciled'].includes(receipt.state),JSON.stringify(receipt));
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(engine.result(taskId,'before-unknown-verify').state,'completed');
  assert.equal(engine.result(taskId,'before-unknown-verify').after_hash,verifyFingerprint);

  // Drop the real backend reply after committing a new run. The retry must not
  // reach the manager; only the local operator can bind the recovered run.
  let dropped:any;let proxyWrites=0;
  proxy=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);
    if(request.params.name==='run_create'&&request.params.arguments.context?._forge_operation_id==='no-commit'){proxyWrites++;res.destroy();return;}
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
    const reply=await response.text();
    if(request.params.name==='workflow_create'&&request.params.arguments.spec?.name==='Lease race workflow')await raceReply;
    if(request.params.name==='run_create'){
      proxyWrites++;dropped=JSON.parse(JSON.parse(reply).result.content[0].text);res.destroy();return;
    }
    res.writeHead(response.status,{'Content-Type':'application/json'});res.end(reply);
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const address=proxy.address();assert.ok(address&&typeof address!=='string');
  const uncertain=new ForgeSkillsManager(engine,[project],`http://127.0.0.1:${address.port}/mcp`);
  await assert.rejects(uncertain.mutate(taskId,'lost',lease,'run_create',{workflow_id:workflow.workflow_id}));
  const replay=await uncertain.mutate(taskId,'lost',lease,'run_create',{workflow_id:workflow.workflow_id});
  assert.match(replay.content[0].text,/unknown/);assert.equal(proxyWrites,1);
  await assert.rejects(uncertain.mutate(taskId,'new-write',lease,'workflow_create',{spec:{...spec,version:3}}),/Unknown|unknown/);
  assert.throws(()=>engine.complete(taskId,lease),/Unknown|unknown/);
  assert.equal(payload(await uncertain.read('run_get',{run_id:dropped.run_id})).context._forge_operation_id,'lost');
  const fingerprint=engine.status(taskId).fingerprint;
  await assert.rejects(uncertain.reconcile(taskId,'lost',fingerprint,'Checked audit','fixture',run.run_id),/does not match/);
  const localManager=createForgeManager(engine,[project],undefined,{skillsManager:uncertain});
  managerListener=localManager.app.listen(0,'127.0.0.1');await once(managerListener,'listening');
  const managerAddress=managerListener.address();assert.ok(managerAddress&&typeof managerAddress!=='string');
  const managerUrl=`http://127.0.0.1:${managerAddress.port}`;
  const reconcileUrl=managerUrl+'/api/tasks/'+taskId+'/review-skills-manager';
  const recovery={fingerprint,operation_id:'lost',evidence:'Checked the real committed run and exact context',manager_run_id:dropped.run_id};
  assert.equal((await fetch(reconcileUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recovery)})).status,401);
  const response=await fetch(reconcileUrl,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localManager.token,Origin:managerUrl},body:JSON.stringify(recovery)});
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).state,'reviewed');
  assert.match(await (await fetch(managerUrl+'/')).text(),/manager-run-not-created/);
  assert.match((await uncertain.mutate(taskId,'lost',lease,'run_create',{workflow_id:workflow.workflow_id})).content[0].text,/reviewed/);
  assert.equal(proxyWrites,1);
  assert.equal(engine.result(taskId,'before-unknown-verify').after_hash,null);
  assert.throws(()=>engine.complete(taskId,lease),/Missing or stale successful verification/);
  assert.equal(payload(await uncertain.mutate(taskId,'recovered-start',lease,'run_start',{run_id:dropped.run_id})).status,'active');
  await assert.rejects(uncertain.mutate(taskId,'no-commit',lease,'run_create',{workflow_id:workflow.workflow_id}));
  await assert.rejects(uncertain.reconcile(taskId,'no-commit',fingerprint,'Inspected backend after dispatch stopped','fixture'),/explicitly attest/);
  const noCommit=await fetch(reconcileUrl,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localManager.token,Origin:managerUrl},body:JSON.stringify({fingerprint,operation_id:'no-commit',evidence:'Fixture did not forward the request; inspected backend and dispatch is stopped',manager_run_not_created:true})});
  assert.equal(noCommit.status,200,await noCommit.clone().text());
  assert.match((await uncertain.mutate(taskId,'no-commit',lease,'run_create',{workflow_id:workflow.workflow_id})).content[0].text,/reviewed/);
  assert.equal(proxyWrites,2);

  // Two OS processes share the task DB. Pause dispatch after its authority
  // check, then attempt a handoff from the other process. Keep the real backend
  // response pending until the competitor has observed the durable fence.
  const raceProject=join(root,'race-project');await mkdir(raceProject);
  const raceTask=engine.create(raceProject,'lease-race','Cross-process authority',['echo verified'],true);
  const releaseFile=join(root,'release-race');
  const actorSource=`
    import {existsSync} from 'node:fs';
    let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>raw+=x);
    process.stdin.on('end',async()=>{
      const p=JSON.parse(raw),{DurableTasks}=await import(p.engine),{ForgeSkillsManager}=await import(p.bridge);
      const db=new DurableTasks(p.state),manager=new ForgeSkillsManager(db,[p.project],p.endpoint);
      process.once('message',async()=>{
        let answer;
        try{
          if(p.mode==='manager'){
            const check=db.assertIdle.bind(db);
            db.assertIdle=(...args)=>{check(...args);process.send({type:'paused'});const until=Date.now()+10000;while(!existsSync(p.release)){if(Date.now()>until)throw Error('Fixture barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}};
            const result=await manager.mutate(p.task,'race-create',p.lease,'workflow_create',{spec:{name:'Lease race workflow',version:1,stages:[{key:'work'}]}});
            if(result.isError)throw Error(JSON.stringify(result));
          }else{
            process.send({type:'attempting'});
            db.prepareHandoff(p.task,'race-handoff',p.fingerprint,'Fixture handoff',p.lease);
          }
          answer={type:'done',ok:true};
        }catch(error){answer={type:'done',ok:false,error:String(error)};}
        finally{db.close();}
        process.send(answer,()=>process.exit(0));
      });
      process.send({type:'ready'});
    });`;
  const waitActor=(actor:ReturnType<typeof spawn>,type:string)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('Actor did not report '+type));},15000);
    const onMessage=(message:any)=>{if(message?.type===type){cleanup();resolve(message);}};
    const onExit=()=>{cleanup();reject(Error('Actor exited before '+type));};
    const cleanup=()=>{clearTimeout(timer);actor.off('message',onMessage);actor.off('exit',onExit);};
    actor.on('message',onMessage);actor.on('exit',onExit);
  });
  const actorReady:Promise<any>[]=[];
  for(const mode of ['manager','handoff']){
    const actor=spawn(process.execPath,['--input-type=module','-e',actorSource],{windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});actors.push(actor);
    actorReady.push(waitActor(actor,'ready'));
    actor.stdin!.end(JSON.stringify({mode,engine:new URL('../dist/durable-tasks.js',import.meta.url).href,bridge:new URL('../dist/forge-skills-manager.js',import.meta.url).href,state:join(root,'state'),project:raceProject,task:raceTask.task_id,lease:raceTask.lease_token,endpoint:uncertain.endpoint,release:releaseFile,fingerprint:raceTask.fingerprint}));
  }
  await Promise.all(actorReady);
  const paused=waitActor(actors[0]!,'paused'),ownerDone=waitActor(actors[0]!,'done');actors[0]!.send('start');await paused;
  const attempted=waitActor(actors[1]!,'attempting'),competitorDone=waitActor(actors[1]!,'done');actors[1]!.send('start');await attempted;
  await new Promise(resolve=>setTimeout(resolve,150));await writeFile(releaseFile,'release');
  const competitor=await competitorDone;releaseRaceReply();const owner=await ownerDone;
  assert.equal(competitor.ok,false,'A competing handoff must not pass between the lease check and intent');
  assert.match(competitor.error,/Unknown Skills Manager/);assert.equal(owner.ok,true,owner.error);
  assert.equal(engine.status(raceTask.task_id).handoffs.length,0);

  const hostProject=join(root,'host-project');await mkdir(hostProject);
  const config=loadConfig(writeTestDevspaceConfig(join(root,'host-config'),{
    workspaces:{allowedRoots:[hostProject]},storage:{stateDir:join(root,'host-state')},
    ui:{enabled:false},skills:{enabled:false},logging:{level:'silent'},
    skillsManager:{endpoint},
  }));
  const token=randomBytes(32).toString('base64url'),store=new SqliteOAuthStore(config.stateDir);
  const oauthClient=store.registerClient({redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']},config.oauth.allowedRedirectHosts);
  store.saveAccessToken(createHash('sha256').update(token).digest('base64url'),{clientId:oauthClient.client_id,scopes:['devspace'],expiresAt:Math.floor(Date.now()/1000)+120,resource:config.publicBaseUrl+'/mcp'});store.close();
  const serverFactory=process.env.FORGE_SKILLS_MANAGER_COMPILED
    ?((await import(new URL('../dist/server.js',import.meta.url).href)) as typeof import('./server.js')).createServer:createForgeServer;
  const runtime=serverFactory(config),listener=runtime.app.listen(0,'127.0.0.1');await once(listener,'listening');
  const host=new Client({name:'forge-skills-manager-integration',version:'1'});
  closeHost=async()=>{await host.close();await runtime.close();listener.closeAllConnections();await new Promise<void>(resolve=>listener.close(()=>resolve()));};
  const hostAddress=listener.address();assert.ok(hostAddress&&typeof hostAddress!=='string');
  const url=new URL(`http://127.0.0.1:${hostAddress.port}/mcp`);
  assert.equal((await fetch(url)).status,401);
  await host.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const catalog=await host.listTools();assert.equal(catalog.tools.filter(tool=>tool.name.startsWith('skills_manager_')).length,22);
  assert.match(JSON.stringify(await host.callTool({name:'skills_manager_skills_get',arguments:{name:'one-skill'}})),/HIGH AUTHORITY/);
  const hostTask=payload(await host.callTool({name:'task_create',arguments:{path:hostProject,idempotency_key:'skills-host',goal:'Manager host surface',acceptance_commands:['echo verified']}}));
  const hostWorkflow=payload(await host.callTool({name:'skills_manager_workflow_create',arguments:{task_id:hostTask.task_id,operation_id:'host-workflow',lease_token:hostTask.lease_token,spec:{...spec,name:'Host integration workflow'}}}));
  assert.equal(hostWorkflow.version,1);
  const resume=payload(await host.callTool({name:'task_resume',arguments:{task_id:hostTask.task_id}}));
  assert.equal(resume.skills_manager_operations.length,1);
});

