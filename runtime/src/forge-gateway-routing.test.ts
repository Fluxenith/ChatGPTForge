import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as z from 'zod/v4';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {DurableTasks} from './durable-tasks.js';
import {GatewayOnboarding} from './forge-gateway-onboarding.js';
import {rankGatewayRoutes} from './forge-gateway-routing.js';
import {ForgeMcpGateway,registerMcpGateway} from './forge-mcp-gateway.js';

async function fixture(){
  const events={writes:0,requests:0};
  const server:Server=createServer(async(req,res)=>{
    events.requests++;
    const target=new McpServer({name:'routing-fixture',version:'1'});
    target.registerTool('search_docs',{description:'Search project documentation and return matching pages',inputSchema:{query:z.string()}},
      async({query})=>({content:[{type:'text',text:'Found documents: '+query}]}));
    target.registerTool('archive_documents',{description:'Archive project documentation',inputSchema:{id:z.string()}},
      async()=>{events.writes++;return {content:[{type:'text',text:'archived'}]};});
    target.registerTool('unapproved_secret',{description:'Search project documentation secretly',inputSchema:{}},
      async()=>{events.writes++;return {content:[{type:'text',text:'should not be called'}]};});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on('close',()=>{void transport.close();void target.close();});
    await target.connect(transport);
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    await transport.handleRequest(req,res,chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`,events,
    close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}

test('cross-provider route ranking keeps write and unapproved tools out of default read search',()=>{
  const result=rankGatewayRoutes([{
    id:'docs',status:'available',manifest_status:'current',manifest:{role:'docs',
      best_use_cases:['Find project documentation'],poor_use_cases:['Archive project documentation'],
      goal_oriented_patterns:[{goal:'Find project documentation',tool:'search_docs'},
        {goal:'Archive project documentation',tool:'archive_documents'}],performance_cost_notes:[]},
    onboarding:{status:'success',verification:'passed',verified_read_tools:['search_docs'],write_gate:{ready:false}},
    write_gate:'verified',tools:[
      {name:'search_docs',classification:'read',description:'Search documents',input_schema:{properties:{query:{}},required:['query']}},
      {name:'archive_documents',classification:'write',description:'Archive documents',input_schema:{}},
    ],
  }], 'Find project documentation');
  assert.equal(result.status,'matches');
  assert.deepEqual(result.results.map(r=>r.tool),['search_docs']);
  assert.equal(result.results[0]?.verification,'content_verified');
  assert.deepEqual(result.results[0]?.required_parameters,['query']);
  const write=rankGatewayRoutes([{
    id:'docs',status:'available',manifest_status:'current',manifest:{role:'docs',best_use_cases:[],
      poor_use_cases:[],goal_oriented_patterns:[{goal:'Archive project documentation',tool:'archive_documents'}],performance_cost_notes:[]},
    onboarding:{status:'success',write_gate:{ready:false}},write_gate:'verified',tools:[
      {name:'archive_documents',classification:'write',description:'Archive documents',input_schema:{}},
    ],
  }],'Archive project documentation','write');
  assert.equal(write.results[0]?.route,'mcp_gateway_write');
  assert.equal(write.results[0]?.execution_status,'write_gate_not_ready');
  assert.equal(write.results[0]?.requires_lease,true);
});

test('cross-server discovery understands bounded Chinese and English task aliases',()=>{
  const servers=[
    {id:'docs',status:'available' as const,manifest_status:'missing' as const,write_gate:'off' as const,tools:[
      {name:'search_docs',classification:'read' as const,description:'Search project documentation',input_schema:{}},
    ]},
    {id:'browser',status:'available' as const,manifest_status:'missing' as const,write_gate:'off' as const,tools:[
      {name:'browser_screenshot',classification:'read' as const,description:'Capture browser screenshot',input_schema:{}},
    ]},
  ];
  const docs=rankGatewayRoutes(servers,'幫我搜尋專案文件');
  assert.equal(docs.status,'matches');
  assert.equal(docs.results[0]?.tool,'search_docs');
  const screenshot=rankGatewayRoutes(servers,'在瀏覽器截圖');
  assert.equal(screenshot.results[0]?.tool,'browser_screenshot');
  const synonyms=rankGatewayRoutes(servers,'Find project docs');
  assert.equal(synonyms.results[0]?.tool,'search_docs');
  assert.equal(rankGatewayRoutes(servers,'請幫我整理工作安排').status,'no_matches');
});

test('live federated recommendation uses current saved manifest, probes and owner approval without calling writes',
  {timeout:60_000},async t=>{
    const root=mkdtempSync(join(tmpdir(),'forge-gateway-federated-'));
    const project=join(root,'workspace');mkdirSync(project);
    const approved=await fixture(),pending=await fixture();
    const engine=new DurableTasks(join(root,'state'));
    const gateway=new ForgeMcpGateway(engine,[
      {id:'docs',endpoint:approved.endpoint,approved:true,read_tools:['search_docs'],write_tools:['archive_documents']},
      {id:'pending',endpoint:pending.endpoint,approved:false,read_tools:['search_docs'],write_tools:[]},
    ]);
    t.after(async()=>{await gateway.close();await approved.close();await pending.close();engine.close();
      rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
    const onboarding=new GatewayOnboarding(gateway,engine.stateDir);
    const manifest={schema_version:1,id:'docs',display_name:'Docs',role:'Documentation',required:false,
      enabled_by_default:false,transport:'streamable_http' as const,default_endpoint:approved.endpoint,
      best_use_cases:['Find project documentation'],poor_use_cases:['Archive project documentation'],
      goal_oriented_patterns:[{goal:'Find project documentation',tool:'search_docs'},
        {goal:'Archive project documentation',tool:'archive_documents'},
        {goal:'Read secret documentation',tool:'unapproved_secret'}],
      performance_cost_notes:['Results depend on local fixture.']};
    const probes=[{tool:'search_docs',arguments:{query:'hello'},expect:{text_contains:'Found documents'}}];
    await onboarding.run(manifest,true,probes);
    const result=await onboarding.recommend('Find project documentation');
    assert.equal(result.status,'matches');
    assert.equal(result.available_servers,1);
    assert.equal(result.results[0]?.server,'docs');
    assert.equal(result.results[0]?.tool,'search_docs');
    assert.equal(result.results[0]?.manifest_status,'current');
    assert.equal(result.results[0]?.verification,'content_verified');
    assert.equal(result.results[0]?.route,'mcp_gateway_read');
    assert.equal(result.results.some(r=>r.tool==='unapproved_secret'),false);
    assert.equal(approved.events.writes,0);
    assert.equal(pending.events.requests,0,'routing must not launch or contact an unapproved server');
    assert.deepEqual((await onboarding.recommend('Archive project documentation','write')).results.map(r=>r.tool),['archive_documents']);
    const definitions=new Map<string,any>();
    registerMcpGateway({registerTool(name:string,def:any){definitions.set(name,def);}} as any,gateway);
    assert.equal(definitions.get('mcp_gateway_recommend')?.annotations.readOnlyHint,true);
    assert.equal(z.object(definitions.get('mcp_gateway_recommend').inputSchema).safeParse({goal:'Find project documentation'}).success,true);
    assert.equal(approved.events.writes,0);
    // Revoked approval immediately removes all recommendations. A changed
    // manifest/receipt invalidates goal patterns but does not grant rights.
    gateway.servers.get('docs')!.approved=false;
    assert.equal((await onboarding.recommend('Find project documentation')).results.length,0);
    gateway.servers.get('docs')!.approved=true;
    gateway.servers.get('docs')!.read_tools.push('missing');
    const stale=await onboarding.recommend('Search project documentation');
    assert.equal(stale.results[0]?.manifest_status,'stale');
    assert.notEqual(stale.results[0]?.verification,'content_verified');
    assert.equal(approved.events.writes,0);
  });

test('isolated gateway recommend CLI accepts goal and filters without modifying owner config',{timeout:30_000},t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-gateway-recommend-cli-'));
  t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const project=join(root,'workspace');mkdirSync(project);
  const cliPath=fileURLToPath(new URL('./forge-cli.ts',import.meta.url));
  const env={...process.env,CHATGPTFORGE_CONFIG_DIR:join(root,'config')};
  const cli=(args:string[])=>{
    const result=spawnSync(process.execPath,['--import','tsx',cliPath,...args],{
      cwd:fileURLToPath(new URL('..',import.meta.url)),env,encoding:'utf8',windowsHide:true,timeout:15000,
    });
    assert.equal(result.status,0,result.stderr||String(result.error));return result.stdout;
  };
  assert.match(cli(['init','--workspace',project,'--public-url','https://forge-recommend.invalid']),/configured/);
  const result=JSON.parse(cli(['gateway','recommend','--goal','Search project documentation','--kind','read','--max-results','2']));
  assert.equal(result.status,'no_matches');
  assert.equal(result.scanned_servers,0);
  assert.deepEqual(result.results,[]);
});
