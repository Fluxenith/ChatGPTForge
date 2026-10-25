import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {checkNetworkFlow,networkFlowReceipt,validateNetworkFlow,type BrowserNetworkFlow,type NetworkFlowObservation} from './forge-browser-network-flow.js';
import {registerForgeBrowser} from './forge-browser.js';

const input:BrowserNetworkFlow={
  steps:[
    {index:3,expected_status:201,expected_method:'POST',json_checks:[{pointer:'/payment/id',equals:'order-123'}]},
    {index:6,expected_status:200,expected_path:'/payment/status',json_checks:[{pointer:'/paid',equals:true}]},
  ],links:[{from_index:3,from_pointer:'/payment/id',to_index:6,to_pointer:'/payment_id'}],
  max_start_gap_ms:500,max_start_span_ms:700,
};
const observations:NetworkFlowObservation[]=[
  {index:3,started_ms:1000,method:'POST',path:'/payment/create',state:'completed',status:201,duration_ms:25,
    evidence:{available:true,value:{payment:{id:'order-123'}}}},
  {index:6,started_ms:1120,method:'GET',path:'/payment/status',state:'completed',status:200,duration_ms:10,
    evidence:{available:true,value:{payment_id:'order-123',paid:true}}},
];

test('browser flow contract is published and rejects malformed pointers at the MCP boundary',()=>{
  const definitions=new Map<string,any>();
  registerForgeBrowser({registerTool(name:string,definition:any){definitions.set(name,definition);}} as any,{resolvedConfig:()=>({})} as any);
  const tool=definitions.get('browser_action');assert.ok(tool.inputSchema.action.options.includes('network_flow_assert'));
  const schema=z.object(tool.inputSchema);
  const common={task_id:'task',lease_token:'123e4567-e89b-42d3-a456-426614174000',operation_id:'flow',action:'network_flow_assert'};
  assert.equal(schema.safeParse({...common,flow:input}).success,true);
  assert.equal(schema.safeParse({...common,flow:{...input,links:[{...input.links![0],from_pointer:'/bad~2'}]}}).success,false);
  assert.equal(schema.safeParse({...common,flow:{...input,steps:[input.steps[0]]}}).success,false);
});

test('network flow checks observed order, per-step HTTP/JSON, start timing and correlated response fields',()=>{
  validateNetworkFlow(input);
  const result=checkNetworkFlow(input,observations);
  assert.equal(result.passed,true,JSON.stringify(result));
  assert.equal(result.links[0]?.passed,true);
  assert.equal(result.steps[0]?.checks.at(-1)?.check,'json_1');
  assert.doesNotMatch(JSON.stringify(result),/order-123/);
  assert.doesNotMatch(JSON.stringify(networkFlowReceipt(input)),/order-123/);
  assert.match(JSON.stringify(networkFlowReceipt(input)),/equals_digest/);
  const reversed=checkNetworkFlow({...input,steps:[...input.steps].reverse()},[...observations].reverse());
  assert.equal(reversed.passed,false);assert.equal(reversed.checks[0]?.check,'request_order');
  assert.equal(reversed.checks[0]?.passed,false);
  const slow=checkNetworkFlow({...input,max_start_gap_ms:50},observations);
  assert.equal(slow.passed,false);assert.equal(slow.checks.find(c=>c.check==='max_start_gap_ms')?.passed,false);
  const mismatched=checkNetworkFlow(input,[observations[0]!,{...observations[1]!,evidence:{available:true,value:{payment_id:'wrong',paid:true}}}]);
  assert.equal(mismatched.links[0]?.passed,false);assert.equal(mismatched.passed,false);
});

test('flow links fail closed on masked secrets and missing JSON or bodies',()=>{
  const linked={...input,links:[{from_index:3,from_pointer:'/access_token',to_index:6,to_pointer:'/access_token'}]};
  const withSecrets=observations.map(o=>({...o,evidence:{available:true as const,value:{access_token:'[redacted]'}}}));
  const verdict=checkNetworkFlow(linked,withSecrets);
  assert.equal(verdict.passed,false);
  assert.equal(verdict.links[0]?.reason,'redacted_data');
  assert.doesNotMatch(JSON.stringify(verdict),/order-123/);
  const withoutBody=checkNetworkFlow(input,[observations[0]!,{...observations[1]!,evidence:{available:false,reason:'json_too_large'}}]);
  assert.equal(withoutBody.links[0]?.reason,'json_too_large');
  assert.equal(withoutBody.passed,false);
  const missing=checkNetworkFlow(input,[observations[0]!,{...observations[1]!,evidence:{available:true,value:{paid:true}}}]);
  assert.equal(missing.links[0]?.reason,'missing_path');
  const objectLink=checkNetworkFlow({...input,links:[{from_index:3,from_pointer:'/payment',to_index:6,to_pointer:'/payment'}]},
    [observations[0]!,{...observations[1]!,evidence:{available:true,value:{payment:{id:'order-123'},paid:true}}}]);
  assert.equal(objectLink.links[0]?.reason,'non_scalar_correlation');
});

test('invalid flow inputs fail before an operation can be recorded',()=>{
  assert.throws(()=>validateNetworkFlow({...input,steps:[input.steps[0]!,input.steps[0]!]}),/cannot select/);
  assert.throws(()=>validateNetworkFlow({...input,links:[{from_index:3,from_pointer:'/id',to_index:99,to_pointer:'/id'}]}),/two distinct selected/);
  assert.throws(()=>validateNetworkFlow({...input,steps:[{index:3,expected_method:'GET'},input.steps[1]!]}),/requires a state/);
  assert.throws(()=>validateNetworkFlow({...input,max_start_span_ms:200000}),/Invalid network flow/);
  assert.throws(()=>validateNetworkFlow({...input,steps:new Array(9).fill(input.steps[0])}),/Invalid network flow/);
});
