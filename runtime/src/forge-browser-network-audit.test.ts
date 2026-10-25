import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {checkNetworkAudit,networkAuditReceipt,validateNetworkAudit,type NetworkAuditObservation} from './forge-browser-network-audit.js';
import {registerForgeBrowser} from './forge-browser.js';

const samples:NetworkAuditObservation[]=[
  {index:1,method:'GET',path:'/api/orders',resource_type:'fetch',state:'completed',status:200,duration_ms:30,authorized:true},
  {index:2,method:'GET',path:'/api/orders',resource_type:'xhr',state:'completed',status:200,duration_ms:50,authorized:true},
  {index:3,method:'POST',path:'/api/orders',resource_type:'fetch',state:'completed',status:503,duration_ms:100,authorized:true},
  {index:4,method:'GET',path:'/api/orders',resource_type:'fetch',state:'failed',status:null,duration_ms:150,authorized:true},
  {index:5,method:'GET',path:'/api/queue',resource_type:'xhr',state:'response',status:202,authorized:true},
  {index:6,method:'GET',path:'/private/asset',resource_type:'script',state:'completed',status:200,duration_ms:200,authorized:true},
  {index:7,method:'GET',path:'',resource_type:'fetch',state:'failed',status:null,authorized:false},
];

test('MCP browser_action publishes a bounded network audit schema',()=>{
  const definitions=new Map<string,any>();
  registerForgeBrowser({registerTool(name:string,definition:any){definitions.set(name,definition);}} as any,{resolvedConfig:()=>({})} as any);
  const published=definitions.get('browser_action');
  assert.ok(published.inputSchema.action.options.includes('network_audit'));
  const schema=z.object(published.inputSchema);
  const common={task_id:'task',lease_token:'123e4567-e89b-42d3-a456-426614174000',operation_id:'audit',action:'network_audit'};
  assert.equal(schema.safeParse({...common,audit:{path_prefix:'/api/',max_p95_ms:100}}).success,true);
  assert.equal(schema.safeParse({...common,audit:{path_prefix:'/api?secret=abc'}}).success,false);
  assert.equal(schema.safeParse({...common,audit:{max_p95_ms:-1}}).success,false);
});

test('API cohort budgets check completed-only nearest-rank p95, HTTP errors, failures and pending requests',()=>{
  const input={path_prefix:'/api/',min_completed:3,max_failed:1,max_http_errors:1,max_pending:1,max_p95_ms:100,max_duration_ms:100};
  validateNetworkAudit(input);
  const result=checkNetworkAudit(input,samples,0);
  assert.equal(result.passed,true,JSON.stringify(result));
  assert.equal(result.matched,5);
  assert.equal(result.completed,3);
  assert.equal(result.http_errors,1);
  assert.equal(result.failed,1);
  assert.equal(result.pending,1);
  assert.equal(result.latency_ms.p95,100);
  assert.deepEqual(result.slowest.map(row=>row.index),[3,2,1]);
  assert.equal(result.excluded_unapproved,1);
  assert.doesNotMatch(JSON.stringify(result),/orders|queue|private|Bearer/);
  assert.equal(checkNetworkAudit({...input,max_p95_ms:99},samples,0).checks.find(row=>row.check==='max_p95_ms')?.passed,false);
  assert.equal(checkNetworkAudit({...input,max_failed:0},samples,0).checks.find(row=>row.check==='max_failed')?.passed,false);
  assert.equal(checkNetworkAudit({...input,max_http_errors:0},samples,0).checks.find(row=>row.check==='max_http_errors')?.passed,false);
  assert.equal(checkNetworkAudit({...input,max_pending:0},samples,0).checks.find(row=>row.check==='max_pending')?.passed,false);
});

test('network audit fails closed for empty or incomplete retained evidence; zero-duration values are valid',()=>{
  assert.equal(checkNetworkAudit({path_prefix:'/not-found'},samples,0).passed,false);
  const partial=checkNetworkAudit({path_prefix:'/api/'},samples,3);
  assert.equal(partial.passed,false);
  assert.equal(partial.checks[0]?.reason,'retention_window_truncated');
  const detached=checkNetworkAudit({path_prefix:'/api/',allow_truncated:true},
    [...samples,{...samples[0]!,index:8,authorized:false,frame_unavailable:true,path:''}],0);
  assert.equal(detached.passed,false);
  assert.equal(detached.checks[0]?.reason,'frame_unavailable');
  assert.equal(checkNetworkAudit({path_prefix:'/api/',min_completed:3,max_http_errors:1,max_failed:1,max_pending:1,allow_truncated:true},samples,3).passed,true);
  const missing=checkNetworkAudit({max_p95_ms:10},[{...samples[0]!,duration_ms:undefined}],0);
  assert.equal(missing.checks.find(row=>row.check==='max_p95_ms')?.reason,'missing_duration');
  assert.equal(checkNetworkAudit({max_duration_ms:1},[{...samples[0]!,duration_ms:0}],0).passed,true);
  assert.throws(()=>validateNetworkAudit({path_prefix:'/bad?key=x'}),/Invalid network audit/);
});

test('durable audit receipts store only a digest of a configured path prefix',()=>{
  const input={path_prefix:'/secret-identifier',max_p95_ms:250};
  const receipt=JSON.stringify(networkAuditReceipt(input));
  assert.match(receipt,/path_prefix_digest/);
  assert.doesNotMatch(receipt,/secret-identifier/);
  assert.equal(receipt,JSON.stringify(networkAuditReceipt(input)));
});
