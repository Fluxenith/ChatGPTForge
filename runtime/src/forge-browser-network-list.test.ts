import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {browserNetworkListSchema,checkNetworkList,networkListReceipt,validateNetworkList,type NetworkListObservation} from './forge-browser-network-list.js';
import {registerForgeBrowser} from './forge-browser.js';

const sample:NetworkListObservation[]=[
  {index:2,method:'GET',url:'https://demo.test/',path:'/',resource_type:'document',state:'completed',status:200,duration_ms:10,authorized:true},
  {index:4,method:'GET',url:'https://demo.test/app.js',path:'/app.js',resource_type:'script',state:'completed',status:200,duration_ms:8,authorized:true},
  {index:5,method:'GET',url:'https://demo.test/api/users',path:'/api/users',resource_type:'fetch',state:'completed',status:200,duration_ms:20,authorized:true},
  {index:7,method:'POST',url:'https://demo.test/api/orders',path:'/api/orders',resource_type:'xhr',state:'completed',status:503,duration_ms:45,authorized:true},
  {index:8,method:'GET',url:'https://demo.test/missing.png',path:'/missing.png',resource_type:'image',state:'completed',status:404,duration_ms:5,authorized:true},
  {index:9,method:'GET',url:'[blocked-origin]',path:'',resource_type:'fetch',state:'failed',status:null,authorized:false},
  {index:11,method:'GET',url:'https://demo.test/api/new',path:'/api/new',resource_type:'fetch',state:'pending',status:null,authorized:true},
];

test('network listing preserves original request indexes, excludes forbidden origins, and hides only successful static resources by default',()=>{
  const result=checkNetworkList({},sample,0);
  assert.deepEqual(result.entries.map(e=>e.index),[5,7,8,11]);
  assert.equal(result.hidden_static,2);
  assert.equal(result.excluded_unapproved,1);
  assert.equal(result.truncated,false);
  assert.equal(result.has_more,false);
  assert.equal(result.next_after_index,11);
  assert.equal(checkNetworkList({include_static:true},sample,0).entries.length,6);
  assert.equal(checkNetworkList({include_static:true},sample,3).truncated,true);
});

test('network listing filters multiple dimensions and pages with stable cursors',()=>{
  const narrowed=checkNetworkList({path_prefix:'/api/',status_min:400,method:'POST'},sample,0);
  assert.deepEqual(narrowed.entries.map(row=>row.index),[7]);
  assert.equal(checkNetworkList({state:'pending'},sample,0).entries[0]?.index,11);
  assert.deepEqual(checkNetworkList({min_duration_ms:40},sample,0).entries.map(row=>row.index),[7]);
  const first=checkNetworkList({limit:2},sample,0);
  assert.equal(first.has_more,true);
  assert.deepEqual(first.entries.map(e=>e.index),[5,7]);
  const second=checkNetworkList({limit:2,after_index:first.next_after_index},sample,0);
  assert.deepEqual(second.entries.map(e=>e.index),[8,11]);
  assert.equal(second.has_more,false);
  assert.equal(checkNetworkList({after_index:100},sample,0).next_after_index,100);
  assert.equal(checkNetworkList({},[...sample,{...sample[6]!,index:13,authorized:false,frame_unavailable:true}],0).unavailable_frames,1);
});

test('network list schema rejects malformed or unsafe filters; durable receipts hash pathname input',()=>{
  for(const invalid of [{path_prefix:'/api?token=abc'},{path_prefix:'/api#secret'},{status_min:500,status_max:400},{limit:81},{after_index:-1},{method:'INJECT'},{unknown:'secret'}]){
    assert.throws(()=>validateNetworkList(invalid),/Invalid network list filter/);
  }
  validateNetworkList({path_prefix:'/api',limit:20});
  const receipt=JSON.stringify(networkListReceipt({path_prefix:'/account/password',limit:10}));
  assert.match(receipt,/path_prefix_digest/);
  assert.doesNotMatch(receipt,/account\/password/);
  const defs=new Map<string,any>();
  registerForgeBrowser({registerTool(name:string,config:any){defs.set(name,config);}} as any,{resolvedConfig:()=>({})} as any);
  const schema=defs.get('browser_action').inputSchema;
  assert.ok(schema.action.options.includes('network_list')&&schema.action.options.includes('network_clear'));
  const published=z.object(schema),common={task_id:'task',lease_token:'123e4567-e89b-42d3-a456-426614174000',operation_id:'network-list',action:'network_list'};
  assert.equal(published.safeParse({...common,list:{path_prefix:'/api/',status_min:400,include_static:true}}).success,true);
  assert.equal(published.safeParse({...common,list:{path_prefix:'/api?token=abc'}}).success,false);
});
