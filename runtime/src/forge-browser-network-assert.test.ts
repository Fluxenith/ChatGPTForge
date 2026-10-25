import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {checkNetworkAssertion,validateNetworkAssertion,type BrowserNetworkAssertion} from './forge-browser-network-assert.js';
import {registerForgeBrowser} from './forge-browser.js';

test('MCP registration advertises network_assert and validates its JSON contract parameters',()=>{
  const definitions=new Map<string,any>();
  registerForgeBrowser({registerTool(name:string,definition:any){definitions.set(name,definition);}} as any,{resolvedConfig:()=>({})} as any);
  const published=definitions.get('browser_action');
  assert.ok(published.inputSchema.action.options.includes('network_assert'));
  const schema=z.object(published.inputSchema);
  const request={task_id:'fixture',lease_token:'123e4567-e89b-42d3-a456-426614174000',operation_id:'network-check',action:'network_assert',
    index:1,expected_status:200,expected_path:'/api',json_checks:[{pointer:'/success',type:'boolean'}]};
  assert.equal(schema.safeParse(request).success,true);
  assert.equal(schema.safeParse({...request,expected_path:'/api?secret=do-not-store'}).success,false);
});

test('network assertions require completed requests by default and distinguish failures from HTTP responses',()=>{
  const input={index:1,expected_status:200,max_duration_ms:300};
  validateNetworkAssertion(input);
  assert.equal(checkNetworkAssertion(input,{method:'GET',status:200,state:'response'}).passed,false);
  assert.equal(checkNetworkAssertion(input,{method:'GET',status:200,state:'failed',duration_ms:100}).passed,false);
  assert.equal(checkNetworkAssertion(input,{method:'GET',status:200,state:'completed',duration_ms:400}).passed,false);
  assert.equal(checkNetworkAssertion(input,{method:'GET',status:200,state:'completed',duration_ms:100}).passed,true);
  assert.equal(checkNetworkAssertion({index:1,expected_state:'failed'},{method:'GET',status:200,state:'failed'}).passed,true);
  assert.equal(checkNetworkAssertion({index:1,expected_state:'pending'},{method:'GET',status:null,state:'pending'}).passed,true);
});

test('bounded RFC 6901 assertions inspect arrays and escaped keys without returning values',()=>{
  const input:BrowserNetworkAssertion={index:2,json_checks:[
    {pointer:'/items/0/a~1b',equals:'private fixture value'},
    {pointer:'/items/1',exists:false},
    {pointer:'/~0key',type:'null'},
  ]};
  validateNetworkAssertion(input);
  const result=checkNetworkAssertion(input,{method:'GET',status:200,state:'completed',duration_ms:10},
    {available:true,value:{items:[{'a/b':'private fixture value'}],'~key':null}});
  assert.equal(result.passed,true);
  assert.doesNotMatch(JSON.stringify(result),/private fixture value/);
  assert.equal(checkNetworkAssertion(input,{method:'GET',status:200,state:'completed'},
    {available:false,reason:'response_unavailable'}).passed,false);
  assert.throws(()=>validateNetworkAssertion({index:2,json_checks:[{pointer:'/a',exists:false,equals:3}]}),/Invalid network JSON checks/);
});
