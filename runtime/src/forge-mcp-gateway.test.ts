import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as z from 'zod/v4';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {DurableTasks} from './durable-tasks.js';
import {ForgeMcpGateway,gatewayParallelReadSchema,gatewayProbesSchema,gatewayServersSchema,registerMcpGateway} from './forge-mcp-gateway.js';
import {gatewayCompareReadSchema,type GatewayCompareRead} from './forge-gateway-compare.js';
import {GatewayOnboarding,gatewayManifestCandidate,gatewayOnboardingManifestSchema} from './forge-gateway-onboarding.js';
import {managedRelease} from './managed-component-state.js';

async function fixtureServer(extraReadTools=0){
  const state={requests:0,adds:0};
  const http:Server=createServer(async(req,res)=>{
    state.requests++;
    const server=new McpServer({name:'fixture',version:'1'});
    server.registerTool('echo',{description:'Echo text',inputSchema:{text:z.string()}},async({text})=>({content:[{type:'text',text}]}));
    server.registerTool('echo_upper',{description:'Uppercase text',inputSchema:{text:z.string()}},async({text})=>({content:[{type:'text',text:text.toUpperCase()}]}));
    server.registerTool('json_document',{description:'Structured fixture',inputSchema:{value:z.string(),delay_ms:z.number().int().min(0).max(100).optional()}},async({value,delay_ms})=>{
      if(delay_ms)await new Promise(resolve=>setTimeout(resolve,delay_ms));
      return {structuredContent:{root:{'a/b':{'til~de':value},list:[{active:true}],nullable:null}},
        content:[{type:'text' as const,text:JSON.stringify({root:{'a/b':{'til~de':'untrusted-alternate'}}})}]};
    });
    server.registerTool('json_text',{description:'JSON text fixture',inputSchema:{value:z.string()}},async({value})=>({
      content:[{type:'text' as const,text:JSON.stringify({records:[{id:value,valid:true}]})}],
    }));
    server.registerTool('json_numeric',{description:'Numeric structured fixture',inputSchema:{value:z.number()}},async({value})=>({
      structuredContent:{metric:{value}},content:[{type:'text' as const,text:'{"metric":{"value":-999}}'}],
    }));
    for(let i=0;i<extraReadTools;i++)server.registerTool(`read_${i}`,{description:'Fixture read',inputSchema:{text:z.string()}},async({text})=>({content:[{type:'text',text}]}));
    server.registerTool('counter_add',{description:'Add to a counter',inputSchema:{amount:z.number()}},async({amount})=>{state.adds+=amount;return {content:[{type:'text',text:String(state.adds)}]};});
    server.registerTool('secret',{description:'Unlisted',inputSchema:{}},async()=>({content:[{type:'text',text:'should never be reachable'}]}));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on('close',()=>{void transport.close();void server.close();});
    await server.connect(transport);
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    await transport.handleRequest(req,res,chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined);
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  return {state,endpoint:'http://127.0.0.1:'+(http.address() as any).port+'/mcp',close:async()=>{http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));}};
}

test('cross-provider JSON comparison maps different schemas, enforces grants and reports mismatch without leaking values',
  {timeout:45_000},async t=>{
    const root=mkdtempSync(join(tmpdir(),'forge-gateway-compare-'));
    const first=await fixtureServer(),second=await fixtureServer(),third=await fixtureServer(),pending=await fixtureServer();
    const engine=new DurableTasks(join(root,'state'));
    const gateway=new ForgeMcpGateway(engine,[
      {id:'first',endpoint:first.endpoint,approved:true,read_tools:['json_document','json_numeric'],write_tools:['counter_add']},
      {id:'second',endpoint:second.endpoint,approved:true,read_tools:['json_text','json_numeric'],write_tools:[],allowed_origins:['https://approved.example']},
      {id:'third',endpoint:third.endpoint,approved:true,read_tools:['json_numeric'],write_tools:[]},
      {id:'pending',endpoint:pending.endpoint,approved:false,read_tools:['echo'],write_tools:[]},
    ]);
    t.after(async()=>{
      await gateway.close();await Promise.all([first.close(),second.close(),third.close(),pending.close()]);
      engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    });
    const mapped=(left:string,right:string):GatewayCompareRead=>({reads:[
      {server:'first',tool:'json_document',arguments:{value:left},pointer:'/root/a~1b/til~0de',expected_type:'string'},
      {server:'second',tool:'json_text',arguments:{value:right},pointer:'/records/0/id',expected_type:'string'},
    ]});
    const before=[first.state.requests,second.state.requests];
    const forbidden:GatewayCompareRead={reads:[
      {server:'first',tool:'json_document',arguments:{value:'safe'},pointer:'/root'},
      {server:'pending',tool:'echo',arguments:{text:'no'},pointer:''},
    ]};
    await assert.rejects(gateway.compareRead(forbidden),/not approved/);
    await assert.rejects(gateway.compareRead({reads:[
      {server:'first',tool:'json_document',arguments:{value:'safe'},pointer:'/root'},
      {server:'second',tool:'json_text',arguments:{url:'https://unapproved.example'},pointer:'/records'},
    ]}),/allowed origins/);
    await assert.rejects(gateway.compareRead({reads:[
      {server:'first',tool:'json_document',arguments:{value:'safe'},pointer:'/root'},
      {server:'second',tool:'counter_add',arguments:{amount:3},pointer:''},
    ]}),/not listed as a read tool/);
    assert.deepEqual([first.state.requests,second.state.requests],before,'an invalid batch cannot contact any provider');
    assert.equal(pending.state.requests,0);
    assert.equal(first.state.adds,0);
    assert.equal(gatewayCompareReadSchema.safeParse({reads:[
      {server:'first',tool:'json_numeric',pointer:'/metric/value'},
      {server:'first',tool:'json_numeric',pointer:'/metric/value'},
    ]}).success,false,'each source must belong to a separate approved server');
    assert.equal(gatewayCompareReadSchema.safeParse({reads:[
      {server:'first',tool:'json_numeric',pointer:'/bad~2path'},
      {server:'second',tool:'json_numeric',pointer:'/metric/value'},
    ]}).success,false);

    const same=await gateway.compareRead(mapped('private-compared-value','private-compared-value'));
    assert.equal(same.status,'matched');
    assert.equal(same.complete_evidence,true);
    assert.equal(same.matched,1);
    assert.equal(same.results[0]?.content_source,'structured');
    assert.equal(same.results[1]?.content_source,'text');
    assert.equal(JSON.stringify(same).includes('private-compared-value'),false,'selected provider values stay private');
    const changed=await gateway.compareRead(mapped('secret-before','secret-after'));
    assert.equal(changed.status,'mismatch');
    assert.equal(changed.mismatched,1);
    assert.equal(JSON.stringify(changed).includes('secret-before'),false);
    assert.equal(JSON.stringify(changed).includes('secret-after'),false);
    const missing=await gateway.compareRead({reads:[
      mapped('same','same').reads[0]!,{...mapped('same','same').reads[1]!,pointer:'/nonexistent'},
    ]});
    assert.equal(missing.status,'inconclusive');
    assert.equal(missing.results[1]?.status,'missing_pointer');
    assert.equal(missing.complete_evidence,false);
    const mismatchedTypes=await gateway.compareRead({reads:[
      {server:'first',tool:'json_numeric',arguments:{value:42},pointer:'/metric/value',expected_type:'string'},
      {server:'second',tool:'json_numeric',arguments:{value:42},pointer:'/metric/value'},
    ]});
    assert.equal(mismatchedTypes.status,'inconclusive');
    assert.equal(mismatchedTypes.results[0]?.status,'type_mismatch');
    const numeric=(right:number,tolerance:{absolute?:number;relative?:number}={})=>({
      reads:[
        {server:'first',tool:'json_numeric',arguments:{value:100},pointer:'/metric/value'},
        {server:'second',tool:'json_numeric',arguments:{value:right},pointer:'/metric/value'},
        {server:'third',tool:'json_numeric',arguments:{value:100},pointer:'/metric/value'},
      ],tolerance,
    });
    const within=await gateway.compareRead(numeric(101,{absolute:0,relative:0.02}));
    assert.equal(within.status,'matched');
    assert.equal(within.comparable,2);
    assert.equal(within.results[1]?.comparison,'matched');
    assert.equal(within.results[1]?.absolute_difference,1);
    const outside=await gateway.compareRead(numeric(105,{absolute:0,relative:0.02}));
    assert.equal(outside.status,'mismatch');
    assert.equal(outside.mismatched,1);
    assert.equal(outside.matched,1);
    const strict=await gateway.compareRead(numeric(101));
    assert.equal(strict.status,'mismatch');
    assert.equal(strict.results[1]?.allowed_difference,0);
    const schemas=new Map<string,any>();
    registerMcpGateway({registerTool(name:string,definition:any){schemas.set(name,definition);}} as any,gateway);
    const tool=schemas.get('mcp_gateway_compare_read');
    assert.equal(tool.annotations.readOnlyHint,true);
    assert.equal(z.object(tool.inputSchema).safeParse(numeric(100)).success,true);
    assert.equal(first.state.adds,0,'comparisons never execute writes');
  });

test('parallel MCP reads compare approved providers, preserve partial failures and reject entire invalid batches',
  {timeout:45_000},async t=>{
    const root=mkdtempSync(join(tmpdir(),'forge-gateway-parallel-'));
    const first=await fixtureServer(),second=await fixtureServer(),pending=await fixtureServer();
    const engine=new DurableTasks(join(root,'state'));
    const gateway=new ForgeMcpGateway(engine,[
      {id:'first',endpoint:first.endpoint,approved:true,read_tools:['echo','json_document'],write_tools:['counter_add']},
      {id:'second',endpoint:second.endpoint,approved:true,read_tools:['echo','json_document'],write_tools:[],
        allowed_origins:['https://approved.example']},
      {id:'pending',endpoint:pending.endpoint,approved:false,read_tools:['echo'],write_tools:[]},
    ]);
    t.after(async()=>{await gateway.close();await first.close();await second.close();await pending.close();
      engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
    const reads=(a:string|number,b:string|number)=>({reads:[
      {server:'first',tool:'echo',arguments:{text:a}},
      {server:'second',tool:'echo',arguments:{text:b}},
    ]});
    const before=[first.state.requests,second.state.requests];
    await assert.rejects(gateway.parallelRead({reads:[
      {server:'first',tool:'echo',arguments:{text:'safe'}},
      {server:'second',tool:'counter_add',arguments:{amount:1}},
    ]}),/not listed as a read tool/);
    await assert.rejects(gateway.parallelRead({reads:[
      {server:'first',tool:'echo',arguments:{text:'safe'}},
      {server:'pending',tool:'echo',arguments:{text:'private'}},
    ]}),/not approved/);
    await assert.rejects(gateway.parallelRead({reads:[
      {server:'first',tool:'echo',arguments:{text:'safe'}},
      {server:'second',tool:'echo',arguments:{url:'https://outside.example'}},
    ]}),/allowed origins/);
    assert.deepEqual([first.state.requests,second.state.requests],before,'preflight must contact none of the approved servers on any invalid batch');
    assert.equal(pending.state.requests,0,'unapproved provider remains untouched');
    assert.equal(first.state.adds,0,'writes cannot be promoted to reads');
    assert.equal(gatewayParallelReadSchema.safeParse({reads:[
      {server:'first',tool:'echo',arguments:{}},{server:'first',tool:'echo',arguments:{}}]}).success,false);
    const same=await gateway.parallelRead(reads('identical','identical'));
    assert.equal(same.status,'complete');
    assert.deepEqual(same.results.map(r=>r.status),['ok','ok']);
    assert.equal(same.results[0]?.server,'first');
    assert.equal(same.results[1]?.server,'second');
    assert.equal(same.exact_duplicate_groups.length,1);
    assert.deepEqual(same.exact_duplicate_groups[0]?.sources,[
      {server:'first',tool:'echo'},{server:'second',tool:'echo'}]);
    const structured=await gateway.parallelRead({reads:[
      {server:'first',tool:'json_document',arguments:{value:'same'}},
      {server:'second',tool:'json_document',arguments:{value:'same'}},
    ]});
    assert.equal(structured.status,'complete');
    assert.equal((structured.results[0] as {content_source:string}).content_source,'structured');
    assert.equal(structured.exact_duplicate_groups.length,1,'structured data is compared ahead of a contradictory text fallback');
    const different=await gateway.parallelRead(reads('first response','second response'));
    assert.equal(different.exact_duplicate_groups.length,0);
    const mismatch=await gateway.parallelRead(reads('good',42));
    assert.equal(mismatch.status,'partial');
    assert.equal(mismatch.results[0]?.status,'ok');
    assert.equal(mismatch.results[1]?.status,'tool_error');
    const large=await gateway.parallelRead(reads('a'.repeat(9000),'small'));
    assert.equal(large.incomplete,1);
    assert.equal(large.status,'partial');
    assert.equal((large.results[0] as {excerpt:string}).excerpt.length,8192);
    const schemas=new Map<string,any>();
    registerMcpGateway({registerTool(name:string,definition:any){schemas.set(name,definition);}} as any,gateway);
    assert.equal(schemas.get('mcp_gateway_parallel_read')?.annotations.readOnlyHint,true);
    assert.equal(z.object(schemas.get('mcp_gateway_parallel_read').inputSchema).safeParse(reads('x','y')).success,true);
    assert.equal(first.state.adds,0);
  });

test('MCP gateway reaches only approved owner-listed servers and tools; writes are durable and never resent',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-')),project=join(root,'project');mkdirSync(project);
  const approved=await fixtureServer(),unapproved=await fixtureServer();
  const engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[
    {id:'tools',endpoint:approved.endpoint,approved:true,read_tools:['echo'],write_tools:['counter_add']},
    {id:'pending',endpoint:unapproved.endpoint,approved:false,read_tools:['echo'],write_tools:[]},
  ]);
  t.after(async()=>{await gateway.close();await approved.close();await unapproved.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(project,'gateway','gateway calls',['echo ok'],true);
  const listed=await gateway.list();
  const guide=await gateway.guide('tools');
  assert.equal(guide.tools.find(t=>t.name==='echo')?.routing,'mcp_gateway_read');
  assert.equal(guide.tools.find(t=>t.name==='counter_add')?.routing,'mcp_gateway_write');
  assert.equal(guide.tools.find(t=>t.name==='secret')?.callable,false);
  await assert.rejects(gateway.guide('pending'),/not approved/);
  const tools=listed.servers.find(s=>s.id==='tools') as any;
  assert.deepEqual(tools.tools.map((x:any)=>[x.name,x.class,x.present]),[['echo','read',true],['counter_add','write',true]]);
  assert.equal(tools.unlisted_tools,5);
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'needs_onboarding');
  assert.deepEqual(listed.servers.find(s=>s.id==='pending'),{id:'pending',approved:false,kind:'http',endpoint:unapproved.endpoint});
  await assert.rejects(gateway.read('pending','echo',{text:'x'}),/not approved/);
  assert.equal(unapproved.state.requests,0,'an unapproved server must never be contacted');
  assert.equal((await gateway.onboard('pending',true)).status,'unattempted');assert.equal(unapproved.state.requests,0);
  await assert.rejects(gateway.onboard('pending',false,[{tool:'echo',arguments:{text:'x'}}]),/approved MCP server/);
  await assert.rejects(gateway.onboard('tools',false,[{tool:'counter_add',arguments:{amount:1}}]),/approved read tool/);
  assert.equal(approved.state.adds,0,'an onboarding probe must never call a write tool');
  assert.equal((await gateway.onboard('tools')).mode,'dry-run');
  const transportOnly=await gateway.onboard('tools',true,[{tool:'echo',arguments:{text:'transport-only'}}]);
  assert.equal(transportOnly.probes[0]?.verification,'unattempted');
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'needs_verification');
  const mismatch=await gateway.onboard('tools',true,[{tool:'echo',arguments:{text:'actual-secret-value'},expect:{text_equals:'wrong-secret-value'}}]);
  assert.equal(mismatch.evidence.safe_call,'success','a content mismatch is distinct from a transport failure');
  assert.equal(mismatch.probes[0]?.verification,'failed');
  assert.equal(mismatch.probes[0]?.failure_class,'assertion_mismatch');
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'needs_probe');
  const onboard=await gateway.onboard('tools',true,[{tool:'echo',arguments:{text:'super-private-test-value'},
    expect:{text_equals:'super-private-test-value',text_contains:'private-test',content_type:'text'}}]);
  assert.equal(onboard.status,'success');assert.equal(onboard.evidence.safe_call,'success');
  assert.equal(onboard.probes[0]?.status,'success');
  assert.equal(onboard.probes[0]?.verification,'passed');
  assert.deepEqual(onboard.verification.verified_read_tools,['echo']);
  const saved=readFileSync(join(root,'state/gateway-onboarding/tools.json'),'utf8');
  assert.equal(JSON.parse(saved).approval_changed,false);
  assert.equal(saved.includes('super-private-test-value'),false,'arguments and tool results are excluded from persistent evidence');
  assert.equal(saved.includes('private-test'),false,'expectation values are excluded from persistent evidence');
  assert.equal(((await gateway.list()).servers.find(s=>s.id==='tools') as any)?.onboarding?.safe_call,'success');
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'ready');
  const failed=await gateway.onboard('tools',true,[{tool:'echo',arguments:{text:42}}]);
  assert.equal(failed.status,'success','the catalog result is separate from a failing probe');
  assert.equal(failed.evidence.safe_call,'failed');
  assert.equal(((await gateway.list()).servers.find(s=>s.id==='tools') as any)?.onboarding?.safe_call,'failed');
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'needs_probe');
  const recovered=await gateway.onboard('tools',true,[{tool:'echo',arguments:{text:'ok'},expect:{text_equals:'ok'}}]);
  assert.equal(recovered.evidence.safe_call,'success');
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'ready');
  assert.equal(((await gateway.list()).servers.find(s=>s.id==='tools') as any)?.onboarding?.status,'success');
  gateway.servers.get('tools')!.read_tools.push('missing');assert.equal(((await gateway.list()).servers.find(s=>s.id==='tools') as any)?.onboarding?.status,'stale');
  assert.equal((await gateway.doctor()).checks.find(c=>c.id==='tools')?.status,'degraded');
  assert.equal((await gateway.onboard('tools')).status,'failed');gateway.servers.get('tools')!.read_tools.pop();
  const echoed=await gateway.read('tools','echo',{text:'hello'});assert.equal((echoed.content[0] as any).text,'hello');
  await assert.rejects(gateway.read('tools','counter_add',{amount:1}),/not listed as a read tool/);
  await assert.rejects(gateway.read('tools','secret',{}),/not listed as a read tool/);
  await assert.rejects(gateway.write(task.task_id,'w-secret',task.lease_token!,'tools','secret',{}),/not listed as a write tool/);
  const first=await gateway.write(task.task_id,'add-1',task.lease_token!,'tools','counter_add',{amount:5});
  assert.equal((first.content[0] as any).text,'5');
  assert.deepEqual(await gateway.write(task.task_id,'add-1',task.lease_token!,'tools','counter_add',{amount:5}),first);
  assert.equal(approved.state.adds,5,'exact replay must not call the server again');
  await assert.rejects(gateway.write(task.task_id,'add-1',task.lease_token!,'tools','counter_add',{amount:6}),/different arguments/);
  await assert.rejects(gateway.write(task.task_id,'bad-lease','00000000-0000-4000-8000-000000000000','tools','counter_add',{amount:1}),/lease/i);
  // A call whose outcome is unknown blocks further task writes and is never resent.
  await approved.close();await gateway.close();
  await assert.rejects(gateway.write(task.task_id,'add-2',task.lease_token!,'tools','counter_add',{amount:1}));
  assert.equal((engine.db.prepare('SELECT state FROM mcp_gateway_operations WHERE task_id=? AND id=?').get(task.task_id,'add-2') as any).state,'unknown');
  const replay=await gateway.write(task.task_id,'add-2',task.lease_token!,'tools','counter_add',{amount:1});
  assert.equal(replay.isError,true);assert.match((replay.content[0] as any).text,/never resent/);
  assert.throws(()=>engine.assertIdle(engine.task(task.task_id)),/Unknown browser\/desktop result/);
});

test('approved Playwright debugger can step a pending Gateway write and close an owned context without replay',{skip:process.env.FORGE_PLAYWRIGHT_DEBUGGER_LIVE!=='1',timeout:150_000},async t=>{
  const release=managedRelease('playwright');
  assert.ok(release?.command&&release.args,'An installed managed Playwright release is required');
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-debugger-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  const server={id:'debugger',command:release.command,args:[...release.args,'--headless','--isolated','--caps','devtools'],
    approved:true,read_tools:['browser_snapshot'],write_tools:['browser_run_code_unsafe','browser_resume','browser_close']};
  const gateway=new ForgeMcpGateway(engine,[server]);
  t.after(async()=>{await gateway.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(project,'debugger','controlled debugger',['echo ok'],true);
  const args={code:'async(page)=>{await page.setContent(`<button id="step">Step</button>`);await page.waitForTimeout(3500);await page.context().debugger.requestPause();await page.locator("#step").click();await page.context().debugger.requestPause();return await page.locator("#step").textContent();}'};
  const write=(id:string,tool:string,parameters:Record<string,unknown>)=>gateway.write(task.task_id,id,task.lease_token!,'debugger',tool,parameters);
  const control=(id:string,source:string,command:'resume'|'close',step?:boolean)=>gateway.debuggerControl(task.task_id,id,task.lease_token!,'debugger',source,command,step);
  const inspect=(result:{content:{type:string;[key:string]:unknown}[]})=>JSON.parse(String(result.content[0]?.text)) as {state?:string;operation_id?:string};
  const poll=async(action:()=>Promise<{content:{type:string;[key:string]:unknown}[];isError?:boolean}>)=>{
    for(let i=0;i<32;i++){
      const receipt=await action();
      if(!['debugger_action_pending','debugger_pause_pending','debugger_control_pending'].includes(inspectOrNull(receipt)?.state??''))return receipt;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('Timed out polling a live debugger receipt');
  };
  const inspectOrNull=(receipt:{content:{type:string;[key:string]:unknown}[]})=>{
    try{return inspect(receipt);}catch{return null;}
  };
  await assert.rejects(control('bad','other','resume',true),/live matching debugger script/);
  assert.equal(engine.db.prepare('SELECT 1 FROM mcp_gateway_operations WHERE task_id=? AND id=?').get(task.task_id,'bad'),undefined);
  const pending=await write('script','browser_run_code_unsafe',args);
  assert.equal(inspect(pending).state,'debugger_action_pending');
  const notPaused=await control('step','script','resume',true);
  assert.equal(inspect(notPaused).state,'debugger_pause_pending','a pending code RPC is not automatically paused');
  assert.equal(engine.db.prepare('SELECT 1 FROM mcp_gateway_operations WHERE task_id=? AND id=?').get(task.task_id,'step'),undefined,
    'no write ID is consumed before Playwright reports a pause');
  assert.equal(inspect(await write('script','browser_run_code_unsafe',args)).state,'debugger_action_pending','same ID polls without resending');
  // Another Gateway instance sees the durable uncertain receipt, but has no
  // live RPC authority. Simulates the post-restart replay boundary.
  const restarted=new ForgeMcpGateway(engine,[server]);
  assert.equal((await restarted.write(task.task_id,'script',task.lease_token!,'debugger','browser_run_code_unsafe',args)).isError,true);
  await assert.rejects(restarted.debuggerControl(task.task_id,'stale','script-lease','debugger','script','resume',true),/lease/i);
  await assert.rejects(restarted.debuggerControl(task.task_id,'stale',task.lease_token!,'debugger','script','resume',true),/live matching debugger script/);
  await restarted.close();
  await assert.rejects(control('bad-source','wrong','resume',true),/live matching debugger script/);
  await assert.rejects(gateway.debuggerControl(task.task_id,'bad-lease','00000000-0000-4000-8000-000000000000','debugger','script','resume',true),/lease/i);
  await assert.rejects(write('blocked','browser_close',{}),/interaction in progress|busy|unknown|pending/i,'ordinary writes must stay fenced');
  const stepped=await poll(()=>control('step','script','resume',true));
  assert.ok(!stepped.isError,'actual debugger step must not error: '+JSON.stringify(stepped).slice(0,1200));
  assert.match(String(stepped.content[0]?.text),/Paused/);
  await assert.rejects(control('step','script','resume',false),/different arguments/,'the same receipt ID cannot change a step into resume');
  const finishing=await control('resume','script','resume');
  assert.equal(inspect(finishing).state,'debugger_control_pending','resume waits for another pause or context close');
  const action=await poll(()=>write('script','browser_run_code_unsafe',args));
  assert.ok(!action.isError);
  assert.match(String(action.content[0]?.text),/Step/);
  // The resume RPC is still awaiting context.close. A regular task write is
  // correctly fenced; the explicitly linked debugger close is the exit path.
  assert.equal(inspect(await control('resume','script','resume')).state,'debugger_control_pending');
  const closed=await poll(()=>control('close','resume','close'));
  assert.ok(!closed.isError);
  const resumed=await poll(()=>control('resume','script','resume'));
  assert.ok(!resumed.isError);
  assert.equal((engine.db.prepare("SELECT count(*) AS n FROM mcp_gateway_operations WHERE task_id=? AND state='completed'").get(task.task_id) as {n:number}).n,4);
  assert.doesNotThrow(()=>engine.assertIdle(engine.task(task.task_id)));
  await assert.rejects(control('late','script','resume',true),/live matching debugger script/,'a stale persisted receipt does not authorize debugger control');
});

test('debugger control denies unapproved resume and never records a write intent',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-debugger-deny-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[{id:'limited',command:'unused',approved:true,read_tools:[],write_tools:['browser_run_code_unsafe']}]);
  t.after(async()=>{await gateway.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(project,'debugger-deny','authorization boundary',['echo ok'],true);
  await assert.rejects(gateway.debuggerControl(task.task_id,'control',task.lease_token!,'limited','script','resume',true),/Owner must approve/);
  assert.equal(engine.db.prepare('SELECT 1 FROM mcp_gateway_operations WHERE task_id=? AND id=?').get(task.task_id,'control'),undefined);
});

test('MCP onboarding needs independent assertions for every approved read tool and never upgrades legacy receipts',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-proof-'));
  const site=await fixtureServer(),engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[{id:'proof',endpoint:site.endpoint,approved:true,read_tools:['echo','echo_upper'],write_tools:[]}]);
  t.after(async()=>{await gateway.close();await site.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const echo={tool:'echo',arguments:{text:'hello'},expect:{text_equals:'hello',content_type:'text'}};
  const upper={tool:'echo_upper',arguments:{text:'hello'},expect:{text_equals:'HELLO',text_contains:'ELL'}};
  const partial=await gateway.onboard('proof',true,[echo]);
  assert.deepEqual(partial.verification.verified_read_tools,['echo']);
  assert.deepEqual(partial.verification.missing_read_tools,['echo_upper']);
  assert.equal((await gateway.doctor()).checks[0]?.status,'partial');
  const conflicted=await gateway.onboard('proof',true,[echo,{tool:'echo',arguments:{text:'hello'},expect:{content_type:'image'}},upper]);
  assert.equal(conflicted.evidence.safe_call,'success');
  assert.equal(conflicted.verification.verification,'failed');
  assert.deepEqual(conflicted.verification.verified_read_tools,['echo_upper']);
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_probe');
  const complete=await gateway.onboard('proof',true,[echo,upper]);
  assert.equal(complete.verification.verification,'passed');
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  const dest=join(root,'state/gateway-onboarding/proof.json');
  const original=readFileSync(dest,'utf8');
  const legacy=JSON.parse(original);
  legacy.version=2;
  legacy.probes=legacy.probes.map(({verification,assertion_count,...rest}:any)=>rest);
  delete legacy.verification;
  writeFileSync(dest,JSON.stringify(legacy));
  assert.deepEqual(((await gateway.list()).servers[0] as any).onboarding.verified_read_tools,[]);
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_verification','v2 safe-call success cannot claim content verification');
  legacy.version=1;writeFileSync(dest,JSON.stringify(legacy));
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_probe','v1 has no read-call evidence');
  writeFileSync(dest,original);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  gateway.servers.get('proof')!.read_tools=[];
  await gateway.onboard('proof',true);
  assert.equal((await gateway.doctor()).checks[0]?.status,'catalog_only','a write-only or empty read catalog cannot claim verified');
  assert.equal((await gateway.doctor()).ok,false);
});

test('Gateway checks structured JSON contracts, JSON text fallback, latency and redacted proof',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-json-'));
  const site=await fixtureServer(),engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[{id:'contracts',endpoint:site.endpoint,approved:true,
    read_tools:['json_document','json_text'],write_tools:[]}]);
  t.after(async()=>{await gateway.close();await site.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const checks=[
    {pointer:'/root/a~1b/til~0de',equals:'private-json-value'},
    {pointer:'/root/list/0/active',equals:true,type:'boolean' as const},
    {pointer:'/root/nullable',type:'null' as const,equals:null},
    {pointer:'/root/missing',exists:false},
  ];
  const doc={tool:'json_document',arguments:{value:'private-json-value'},
    expect:{json_checks:checks,max_duration_ms:5_000}};
  const json={tool:'json_text',arguments:{value:'private-json-value'},expect:{json_checks:[
    {pointer:'/records/0/id',equals:'private-json-value'},
    {pointer:'/records/0/valid',type:'boolean' as const},
  ]}};
  const passed=await gateway.onboard('contracts',true,[doc,json]);
  assert.equal(passed.verification.verification,'passed');
  assert.equal(passed.probes[0]?.assertion_count,5,'each JSON path and latency budget counts as an assertion');
  assert.equal(passed.probes[1]?.assertion_count,2);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  const receipt=readFileSync(join(root,'state/gateway-onboarding/contracts.json'),'utf8');
  assert.equal(receipt.includes('private-json-value'),false,'neither JSON expectations nor values persist');
  assert.equal(receipt.includes('untrusted-alternate'),false,'response body never persists');

  const wrong=await gateway.onboard('contracts',true,[{...doc,expect:{json_checks:[
    {pointer:'/root/a~1b/til~0de',equals:'untrusted-alternate'},
  ]}}]);
  assert.equal(wrong.probes.find(p=>p.tool==='json_document')?.verification,'failed',
    'structuredContent is authoritative even when a text block claims a different value');
  assert.equal(wrong.evidence.safe_call,'success');
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_probe');
  const slow=await gateway.onboard('contracts',true,[{...doc,arguments:{value:'private-json-value',delay_ms:40},
    expect:{json_checks:checks,max_duration_ms:1}}]);
  assert.equal(slow.probes.find(p=>p.tool==='json_document')?.failure_class,'latency_budget_exceeded');
  assert.equal(slow.evidence.safe_call,'success','slow is a failed contract, not a transport failure');
  await gateway.onboard('contracts',true,[doc]);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready','a verified retry restores this tool alone');

  assert.equal(gatewayProbesSchema.safeParse([{tool:'json_text',expect:{max_duration_ms:1000}}]).success,false,
    'latency alone cannot claim a verified read result');
  for(const invalid of [
    {pointer:'/bad~2escape',exists:true},
    {pointer:'/missing'},
    {pointer:'/missing',exists:false,equals:null},
  ])assert.equal(gatewayProbesSchema.safeParse([{tool:'json_text',expect:{json_checks:[invalid]}}]).success,false);
});

test('opt-in verified write gate rejects stale contracts before writes and preserves durable replay',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-write-gate-')),project=join(root,'project');mkdirSync(project);
  const site=await fixtureServer(),engine=new DurableTasks(join(root,'state'));
  const server={id:'gated',endpoint:site.endpoint,approved:true,write_gate:'verified' as const,
    write_gate_max_age_seconds:60,read_tools:['json_document'],write_tools:['counter_add']};
  const gateway=new ForgeMcpGateway(engine,[server]);
  t.after(async()=>{await gateway.close();await site.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  assert.equal(gatewayServersSchema.safeParse([{...server,read_tools:[]}]).success,false,'a gate needs a read probe');
  assert.equal(gatewayServersSchema.safeParse([{...server,write_gate_max_age_seconds:1}]).success,false,'TTL must be bounded');
  const task=engine.create(project,'gated','verified writes',['safe calls'],true);
  const write=(id:string,amount:number)=>gateway.write(task.task_id,id,task.lease_token!,'gated','counter_add',{amount});
  await assert.rejects(write('write-1',1),/Verified write gate denied/);
  assert.equal(site.state.adds,0);
  assert.equal(engine.db.prepare('SELECT 1 FROM mcp_gateway_operations WHERE task_id=?').get(task.task_id),undefined,
    'rejected writes cannot reserve operation IDs');
  const probe={tool:'json_document',arguments:{value:'ready'},expect:{json_checks:[{pointer:'/root/list/0/active',equals:true}]}};
  await gateway.onboard('gated',true,[{tool:'json_document',arguments:{value:'ready'}}]);
  await assert.rejects(write('write-1',1),/Verified write gate denied/,'transport success cannot unlock a write');
  await gateway.onboard('gated',true,[probe]);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  const first=await write('write-1',1);
  assert.equal(first.content[0]?.text,'1');assert.equal(site.state.adds,1);

  const bad=await gateway.onboard('gated',true,[{...probe,expect:{json_checks:[{pointer:'/root/list/0/active',equals:false}]}}]);
  assert.equal(bad.probes[0]?.verification,'failed');
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_probe');
  assert.deepEqual(await write('write-1',1),first,'completed receipt can replay even when fresh writes are gated');
  await assert.rejects(write('write-2',2),/Verified write gate denied/);
  assert.equal(site.state.adds,1);

  await gateway.onboard('gated',true,[probe]);
  const receipt=join(root,'state/gateway-onboarding/gated.json');
  const saved=JSON.parse(readFileSync(receipt,'utf8'));
  saved.probes[0].checked_at=new Date(Date.now()-120_000).toISOString();
  writeFileSync(receipt,JSON.stringify(saved));
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_probe','old proof cannot authorize writes');
  await gateway.onboard('gated',true);
  await assert.rejects(write('write-2',2),/Verified write gate denied/,'a catalog refresh cannot extend the probe TTL');
  await gateway.onboard('gated',true,[probe]);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  const originalGuard=(gateway as any).assertVerifiedWrite;
  (gateway as any).assertVerifiedWrite=async function(s:unknown){
    const checked=await originalGuard.call(this,s);
    const raced=JSON.parse(readFileSync(receipt,'utf8'));
    raced.probes[0].verification='failed';
    writeFileSync(receipt,JSON.stringify(raced));
    return checked;
  };
  await assert.rejects(write('write-2',2),/evidence changed during write admission/,
    'a concurrent health regression cannot slip between preflight and write intent');
  assert.equal(site.state.adds,1);
  (gateway as any).assertVerifiedWrite=originalGuard;
  await gateway.onboard('gated',true,[probe]);
  assert.equal((await write('write-2',2)).content[0]?.text,'3');assert.equal(site.state.adds,3);
  const listed=(await gateway.list()).servers.find(s=>s.id==='gated');
  assert.equal(listed&&'write_gate' in listed?listed.write_gate:undefined,'verified');
});

test('MCP Gateway aggregates over 16 approved read-tool probes across batches and restores progress after restart',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-batches-'));
  const site=await fixtureServer(19),engine=new DurableTasks(join(root,'state'));
  const read_tools=Array.from({length:19},(_,i)=>`read_${i}`);
  const server={id:'batches',endpoint:site.endpoint,approved:true,read_tools,write_tools:[]};
  const gateway=new ForgeMcpGateway(engine,[server]);
  t.after(async()=>{await gateway.close();await site.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const probes=read_tools.map((tool,i)=>({tool,arguments:{text:`value-${i}`},expect:{text_equals:`value-${i}`}}));
  assert.equal((await gateway.onboard('batches',true,probes.slice(0,16))).batch_probe_count,16);
  assert.equal((await gateway.doctor()).checks[0]?.status,'partial');
  assert.equal((await gateway.onboard('batches',false,probes.slice(16))).verification.verification,'passed');
  assert.equal((await gateway.doctor()).checks[0]?.status,'partial','dry-run must not persist the second batch');
  const complete=await gateway.onboard('batches',true,probes.slice(16));
  assert.equal(complete.version,4);
  assert.equal(complete.probes.length,19);
  assert.equal(complete.verification.verification,'passed');
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  const restarted=new ForgeMcpGateway(engine,[server]);
  assert.equal((await restarted.doctor()).checks[0]?.status,'ready','persisted batches survive the client lifecycle');
  await restarted.close();
  const dest=join(root,'state/gateway-onboarding/batches.json');
  const saved=readFileSync(dest,'utf8');
  assert.equal(saved.includes('value-18'),false,'probe arguments, responses and expectations never persist');
  const bad=await gateway.onboard('batches',true,[{tool:'read_0',arguments:{text:'value-0'},expect:{text_equals:'wrong-answer'}}]);
  assert.equal(bad.verification.verification,'failed');
  assert.equal(bad.probes.length,19,'a failed re-probe replaces only that tool\'s last batch');
  assert.equal((await gateway.doctor()).checks[0]?.status,'needs_probe');
  const recovered=await gateway.onboard('batches',true,[probes[0]!]);
  assert.equal(recovered.verification.verification,'passed');
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  const catalogOnly=await gateway.onboard('batches',true);
  assert.equal(catalogOnly.probes.length,19,'catalog refresh retains matching verified results');
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  server.read_tools=[...read_tools.slice(1)];
  assert.equal((await gateway.doctor()).checks[0]?.status,'degraded','config drift invalidates the old digest');
  const newConfig=await gateway.onboard('batches',true,[probes[1]!]);
  assert.equal(newConfig.probes.length,1,'a changed config must not inherit previously verified tools');
  assert.equal((await gateway.doctor()).checks[0]?.status,'partial');
});

test('MCP Gateway merges concurrent read-tool batches, migrates v3 proof and rejects malformed stored proof',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-concurrent-'));
  const site=await fixtureServer(),engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[{id:'concurrent',endpoint:site.endpoint,approved:true,read_tools:['echo','echo_upper'],write_tools:[]}]);
  // Separate database connections exercise the same lock used by separate CLI processes.
  const otherEngine=new DurableTasks(join(root,'state'));
  const otherGateway=new ForgeMcpGateway(otherEngine,[{id:'concurrent',endpoint:site.endpoint,approved:true,read_tools:['echo','echo_upper'],write_tools:[]}]);
  t.after(async()=>{await gateway.close();await otherGateway.close();await site.close();otherEngine.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const a={tool:'echo',arguments:{text:'same'},expect:{text_equals:'same'}};
  const b={tool:'echo_upper',arguments:{text:'same'},expect:{text_equals:'SAME'}};
  await Promise.all([gateway.onboard('concurrent',true,[a]),otherGateway.onboard('concurrent',true,[b])]);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready','parallel batches must not lose earlier proof');
  const dest=join(root,'state/gateway-onboarding/concurrent.json');
  const legacy=JSON.parse(readFileSync(dest,'utf8'));
  legacy.version=3;legacy.probes=legacy.probes.filter((p:any)=>p.tool==='echo');
  writeFileSync(dest,JSON.stringify(legacy));
  assert.equal((await gateway.doctor()).checks[0]?.status,'partial','compatible v3 receipt retains only its recorded proof');
  assert.equal((await gateway.onboard('concurrent',true,[b])).version,4);
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready','v3 proof can be migrated by verified new batches');
  const invalid=JSON.parse(readFileSync(dest,'utf8'));
  invalid.probes[0].arguments_sha256='not-a-hash';
  writeFileSync(dest,JSON.stringify(invalid));
  assert.equal(((await gateway.list()).servers[0] as any).onboarding.status,'invalid');
  await assert.rejects(gateway.onboard('concurrent',true,[a]),/Invalid gateway probe receipt/);
});

test('stdio gateway servers launch only when approved, read env from the source config at launch, and imports stay unapproved',{timeout:60_000},async t=>{
  const {writeFileSync,existsSync}=await import('node:fs');
  const {discoverConfiguredServers,downloadsOnLaunch,readCodexServers}=await import('./forge-mcp-gateway.js');
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-stdio-')),project=join(root,'project');mkdirSync(project);
  const sdk=(p:string)=>JSON.stringify(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/'+p,import.meta.url).href);
  const zod=JSON.stringify(new URL('../node_modules/zod/v4/index.js',import.meta.url).href);
  const marker=join(root,'launched.txt'),script=join(root,'server.mjs');
  writeFileSync(script,`import {McpServer} from ${sdk('server/mcp.js')};import {StdioServerTransport} from ${sdk('server/stdio.js')};import * as z from ${zod};import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(marker)},'x');
const s=new McpServer({name:'stdio-fixture',version:'1'});
s.registerTool('secret_len',{description:'Length of FIXTURE_TOKEN',inputSchema:{}},async()=>({content:[{type:'text',text:String((process.env.FIXTURE_TOKEN??'').length)}]}));
s.registerTool('note',{description:'Store a note',inputSchema:{text:z.string()}},async({text})=>({content:[{type:'text',text:'stored '+text}]}));
await s.connect(new StdioServerTransport());`);
  const source=join(root,'mcp.json');writeFileSync(source,JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[script],env:{FIXTURE_TOKEN:'s3cret-value'}}}}));
  const engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[
    {id:'stdio-ok',command:process.execPath,args:[script],env_from:{file:source,format:'json',server:'fixture'},env_keys:['FIXTURE_TOKEN'],approved:true,read_tools:['secret_len'],write_tools:['note']},
    {id:'stdio-pending',command:process.execPath,args:[script],approved:false,read_tools:[],write_tools:[]},
  ]);
  t.after(async()=>{await gateway.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const listed=await gateway.list();
  const pending=listed.servers.find(s=>s.id==='stdio-pending') as any;assert.equal(pending.approved,false);assert.equal(pending.kind,'stdio');
  assert.equal((readFileSyncSafe(marker)).length,1,'only the approved server was launched');
  assert.equal(((await gateway.read('stdio-ok','secret_len',{})).content[0] as any).text,'12','env value read from the source config at launch');
  await assert.rejects(gateway.read('stdio-pending','secret_len',{}),/not approved/);
  const task=engine.create(project,'stdio','stdio write',['echo ok'],true);
  assert.equal(((await gateway.write(task.task_id,'n1',task.lease_token!,'stdio-ok','note',{text:'hi'})).content[0] as any).text,'stored hi');
  assert.equal(readFileSyncSafe(marker).length,1,'the unapproved server was never launched');
  // Discovery includes HTTPS, but every imported entry remains unapproved.
  const home=join(root,'home');mkdirSync(join(home,'.codex'),{recursive:true});mkdirSync(join(home,'.cursor'));
  writeFileSync(join(home,'.codex','config.toml'),'model = "x"\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n\n[mcp_servers.local]\ncommand = \'C:/tools/node.exe\'\nargs = ["server.mjs"]\n[mcp_servers.local.env]\nAPI_KEY = "abc123"\n');
  writeFileSync(join(home,'.cursor','mcp.json'),JSON.stringify({mcpServers:{think:{command:'npx',args:['-y','@modelcontextprotocol/server-sequential-thinking']}}}));
  assert.deepEqual(readCodexServers('[mcp_servers.a]\ncommand = "n"\nargs = ["x", "y"]\n[mcp_servers.a.env]\nK = "v"\n[other]\ncommand = "no"\n'),{a:{command:'n',args:['x','y'],env:{K:'v'}}});
  const {found,skipped}=discoverConfiguredServers(home);
  assert.deepEqual(found.map(f=>[f.id,f.approved,f.env_keys??[]]),[['codex-playwright',false,[]],['codex-docs',false,[]],['codex-local',false,['API_KEY']],['cursor-think',false,[]]]);
  assert.ok(!JSON.stringify(found).includes('abc123'),'secret values are never copied');
  assert.deepEqual(skipped,[]);
  assert.equal(downloadsOnLaunch(found[0]!),true);assert.equal(downloadsOnLaunch(found[1]!),false);
  function readFileSyncSafe(p:string){return existsSync(p)?readFileSync(p,'utf8'):'';}
});

test('gateway origin allowlist refuses off-list url arguments before contacting the server',{timeout:30_000},async t=>{
  const {originAllowed,gatewayServersSchema}=await import('./forge-mcp-gateway.js');
  assert.equal(originAllowed('http://127.0.0.1:8134/',['http://127.0.0.1:*']),true);
  assert.equal(originAllowed('https://example.com/x',['http://127.0.0.1:*']),false);
  assert.equal(originAllowed('https://myaccount.google.com/',['https://myaccount.google.com']),true);
  assert.equal(originAllowed('https://myaccount.google.com.evil.test/',['https://myaccount.google.com']),false);
  assert.equal(originAllowed('file:///C:/secret.txt',['http://127.0.0.1:*']),false);
  assert.throws(()=>gatewayServersSchema.parse([{id:'x',endpoint:'http://127.0.0.1:1/mcp',allowed_origins:['https://example.com/path']}]),/exact origin/);
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-origins-')),project=join(root,'project');mkdirSync(project);
  const site=await fixtureServer();
  const engine=new DurableTasks(join(root,'state'));
  const gateway=new ForgeMcpGateway(engine,[{id:'tools',endpoint:site.endpoint,approved:true,allowed_origins:['http://127.0.0.1:*'],read_tools:['echo'],write_tools:['counter_add']}]);
  t.after(async()=>{await gateway.close();await site.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(project,'origins','origins',['echo ok'],true);
  await assert.rejects(gateway.read('tools','echo',{text:'x',url:'https://example.com/'}),/not in the allowed origins/);
  await assert.rejects(gateway.write(task.task_id,'w1',task.lease_token!,'tools','counter_add',{amount:1,nested:{url:'https://example.com/'}}),/not in the allowed origins/);
  assert.equal(site.state.requests,0,'refused before contacting the server');
  assert.equal((engine.db.prepare('SELECT COUNT(*) AS n FROM mcp_gateway_operations').get() as {n:number}).n,0,'no intent recorded for a refused call');
  assert.equal(((await gateway.read('tools','echo',{text:'ok'})).content[0] as any).text,'ok');
});

 test('remote gateway requires explicit HTTPS opt-in and accepts credential references only',async()=>{
  const {gatewayServersSchema}=await import('./forge-mcp-gateway.js');
  assert.throws(()=>gatewayServersSchema.parse([{id:'remote',endpoint:'https://example.com/mcp'}]),/allow_remote/);
  assert.throws(()=>gatewayServersSchema.parse([{id:'remote',endpoint:'http://example.com/mcp',allow_remote:true}]),/HTTPS/);
  assert.throws(()=>gatewayServersSchema.parse([{id:'remote',endpoint:'https://user:secret@example.com/mcp',allow_remote:true}]),/credential/);
  const s=gatewayServersSchema.parse([{id:'remote',endpoint:'https://example.com/mcp',allow_remote:true,bearer_env:'FORGE_REMOTE_TOKEN'}])[0]!;
  assert.equal(s.approved,false);assert.equal(s.bearer_env,'FORGE_REMOTE_TOKEN');
 });

test('manifest onboarding persists a portable guide and route evidence without granting approval or calling writes',{timeout:60_000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-manifest-'));
  const allowed=await fixtureServer(),pending=await fixtureServer();
  const engine=new DurableTasks(join(root,'state'));
  const owner={id:'owner',endpoint:allowed.endpoint,approved:true,read_tools:['echo'],write_tools:['counter_add']};
  const unapproved={id:'pending',endpoint:pending.endpoint,approved:false,read_tools:[],write_tools:[]};
  const gateway=new ForgeMcpGateway(engine,[owner,unapproved]);
  const onboarding=new GatewayOnboarding(gateway,engine.stateDir);
  t.after(async()=>{await gateway.close();await allowed.close();await pending.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const manifest={schema_version:1 as const,id:'owner',display_name:'Local fixture',role:'fixture automation',required:false,
    enabled_by_default:false,transport:'streamable_http' as const,default_endpoint:allowed.endpoint,
    best_use_cases:['Check an approved response'],poor_use_cases:['Unapproved writes'],
    goal_oriented_patterns:[{goal:'Read a safe echo',tool:'echo'},{goal:'Try unknown tool',tool:'secret'}],
    performance_cost_notes:['Only the local fixture was timed.']};
  const approvedProbe={tool:'echo',arguments:{text:'ready'},expect:{text_equals:'ready'}};
  const preview=await onboarding.run(manifest,false,[approvedProbe]);
  assert.equal(preview.mode,'dry-run');
  assert.equal(preview.capability_evidence.verification.verification,'passed');
  assert.equal(preview.registry.path,null);
  assert.equal(preview.routing.applied_to_host,false);
  assert.equal(preview.routing.tools.find(tool=>tool.name==='echo')?.routing,'mcp_gateway_read');
  assert.equal(preview.routing.tools.find(tool=>tool.name==='counter_add')?.requires_lease,true);
  assert.ok(!JSON.stringify(preview.routing).includes('secret'));
  assert.equal(allowed.state.adds,0);
  assert.deepEqual((await onboarding.inventory()).entries.map(row=>row.status),['not_onboarded','not_onboarded']);
  const applied=await onboarding.run(manifest,true,[approvedProbe]);
  assert.equal(applied.registry.status,'saved');
  assert.equal((await gateway.doctor()).checks[0]?.status,'ready');
  assert.equal((await onboarding.inventory()).entries[0]?.status,'current');
  assert.equal((await onboarding.guide('owner')).status,'current');
  const persisted=readFileSync(join(engine.stateDir,'gateway-manifests','owner.json'),'utf8');
  const stored=JSON.parse(persisted);
  assert.equal(stored.manifest.display_name,'Local fixture');
  assert.equal(stored.approval_changed,false);
  assert.equal(stored.routing.tools.some((tool:{name:string})=>tool.name==='secret'),false,'unapproved tools cannot enter routing');
  assert.equal(persisted.includes('"routing": "mcp_gateway_write"'),true,'approved write route is documented, never invoked');
  assert.equal(allowed.state.adds,0);

  await gateway.onboard('owner',true,[{tool:'echo',arguments:{text:'changed'},expect:{text_equals:'changed'}}]);
  assert.equal((await onboarding.guide('owner')).status,'stale','new probe evidence invalidates the saved manifest');
  assert.equal((await onboarding.inventory()).entries[0]?.status,'stale');
  await onboarding.run(manifest,true,[approvedProbe]);
  assert.equal((await onboarding.guide('owner')).status,'current');

  const pendingManifest={...manifest,id:'pending',default_endpoint:pending.endpoint};
  const before=pending.state.requests;
  const parked=await onboarding.run(pendingManifest,true);
  assert.equal(parked.capability_evidence.status,'unattempted');
  assert.equal(parked.routing.status,'defer-until-owner-approval');
  assert.equal(pending.state.requests,before,'unapproved server never contacted');
  assert.equal((await onboarding.inventory()).entries[1]?.status,'pending_approval');
  assert.equal((await onboarding.guide('pending')).status,'pending_approval');
  await assert.rejects(onboarding.run({...manifest,default_endpoint:'https://example.com/mcp'}),/differs/);
  assert.equal(gatewayOnboardingManifestSchema.safeParse({...manifest,display_name:'Bearer abcdefgh12345678'}).success,false);
  assert.equal(gatewayOnboardingManifestSchema.safeParse({...manifest,default_endpoint:'https://example.com/sk-abcdefgh12345678'}).success,false);
  assert.equal(gatewayOnboardingManifestSchema.safeParse({...manifest,safe_tool:'echo',upstream:null}).success,true,
    'Imported manifest hints are accepted as documentation');
  assert.equal(gatewayOnboardingManifestSchema.safeParse({...manifest,transport:'stdio',default_endpoint:null}).success,true);
  const proposed=gatewayManifestCandidate({...manifest,id:'external',default_endpoint:'https://example.com/mcp'},[]);
  assert.equal(proposed.needs_registration,true);
  assert.equal(proposed.server.approved,false,'new manifests can only propose unapproved servers');

  const reopenedEngine=new DurableTasks(engine.stateDir),reopenedGateway=new ForgeMcpGateway(reopenedEngine,[owner]);
  try{
    assert.equal((await new GatewayOnboarding(reopenedGateway,reopenedEngine.stateDir).guide('owner')).status,'current',
      'operating guide persists across Gateway instance recreation');
  }finally{await reopenedGateway.close();reopenedEngine.close();}

  gateway.servers.get('owner')!.read_tools.push('echo_upper');
  assert.equal((await onboarding.inventory()).entries[0]?.status,'stale','changed owner approval invalidates the persisted config fingerprint');
  assert.equal(allowed.state.adds,0);
});

test('gateway manifest CLI registers new remote servers as unapproved and exposes a durable inventory',{timeout:60_000},t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-manifest-cli-'));
  t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const project=join(root,'workspace'),config=join(root,'config');mkdirSync(project);
  const env={...process.env,CHATGPTFORGE_CONFIG_DIR:config};
  const executable=fileURLToPath(new URL('./forge-cli.ts',import.meta.url));
  const cli=(args:string[])=>{
    const executed=spawnSync(process.execPath,['--import','tsx',executable,...args],
      {cwd:fileURLToPath(new URL('..',import.meta.url)),env,encoding:'utf8',timeout:30_000,windowsHide:true});
    assert.equal(executed.error,undefined,String(executed.error));
    assert.equal(executed.status,0,executed.stderr||executed.stdout);
    return executed.stdout;
  };
  assert.match(cli(['init','--workspace',project,'--public-url','https://forge-manifest.invalid']),/configured/);
  const manifest=join(root,'gateway-manifest.json');
  writeFileSync(manifest,JSON.stringify({schema_version:1,id:'mcp-example',display_name:'Example',role:'docs',required:false,
    enabled_by_default:false,transport:'streamable_http',default_endpoint:'https://example.com/mcp'}));
  const preview=JSON.parse(cli(['gateway','manifest','--manifest',manifest]));
  assert.equal(preview.registration,'planned_unapproved');
  assert.equal(preview.registry.path,null);
  assert.deepEqual(JSON.parse(cli(['gateway','list'])),[],'dry-run must not change owner configuration');
  const applied=JSON.parse(cli(['gateway','manifest','--manifest',manifest,'--apply']));
  assert.equal(applied.registration,'registered_unapproved');
  assert.equal(applied.server_approved,false);
  assert.equal(applied.capability_evidence.status,'unattempted');
  const servers=JSON.parse(cli(['gateway','list']));
  assert.equal(servers.length,1);
  assert.equal(servers[0]?.approved,false);
  const inventory=JSON.parse(cli(['gateway','inventory']));
  assert.equal(inventory.entries[0]?.status,'pending_approval');
  assert.equal(JSON.parse(cli(['gateway','manifest','--manifest',manifest,'--apply'])).registration,'already_registered');
});
