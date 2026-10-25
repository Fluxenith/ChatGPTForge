import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {HttpAnalysisCancellation,analysisRequestSignal,withAnalysisRequestSignal} from './mcp-cancellation.js';
const request=(id:string|number,name='task_rename')=>({jsonrpc:'2.0',id,method:'tools/call',params:{name}});
const cancel=(id:string|number)=>({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}});

test('HTTP cancellation isolates bearer grants, sessions and typed IDs and ignores unknown or malformed notifications',()=>{
  const registry=new HttpAnalysisCancellation();
  const own=registry.open('owner','one',request(1))!,other=registry.open('other','one',request(1))!;
  const session=registry.open('owner','two',request(1))!,string=registry.open('owner','one',request('1'))!;
  registry.open('owner','one',cancel(2));registry.open('owner','one',{...cancel(1),id:90});
  registry.open('owner','one',{...cancel(1),params:{requestId:1,reason:{invalid:true}}});
  assert.equal(own.signal.aborted,false);
  registry.open('owner','one',cancel(1));assert.equal(own.signal.aborted,true);
  for(const scope of [other,session,string])assert.equal(scope.signal.aborted,false);
  own.dispose();registry.open('owner','one',cancel(1));
  const next=registry.open('owner','one',request(1))!;assert.equal(next.signal.aborted,false,'late notifications leave no tombstone');
  assert.equal(registry.open('owner','one',request(3,'task_exec')),undefined,'independent durable command is not HTTP-cancelled');
  registry.close();for(const scope of [next,other,session,string])assert.equal(scope.signal.aborted,true);
});

test('ambiguous active IDs are not guessed and cleanup releases bounded capacity',()=>{
  const registry=new HttpAnalysisCancellation(),one=registry.open('same',undefined,request(1))!,two=registry.open('same',undefined,request(1))!;
  registry.open('same',undefined,cancel(1));assert.equal(one.signal.aborted,false);assert.equal(two.signal.aborted,false);
  one.dispose();one.dispose();registry.open('same',undefined,cancel(1));assert.equal(two.signal.aborted,true);two.dispose();
  const scopes=Array.from({length:64},(_,i)=>registry.open('same',undefined,request(i))!);
  assert.throws(()=>registry.open('same',undefined,request(65)),/capacity/);
  scopes[0]!.dispose();assert.ok(registry.open('same',undefined,request(65)));
  registry.close();assert.equal(scopes[0]!.signal.aborted,false,'disposed requests are no longer owned');
  for(const scope of scopes.slice(1)){scope.dispose();assert.equal(scope.signal.aborted,true);}
  assert.throws(()=>registry.open('same',undefined,request(66)),/closed/);
});

test('request-scoped cancellation merges protocol and HTTP signals without leaking to concurrent requests',async()=>{
  const own=new AbortController(),other=new AbortController();
  const protocol=new AbortController(),http=new AbortController();
  const [first,second]=await Promise.all([
    withAnalysisRequestSignal(own.signal,async()=>{await delay(5);return analysisRequestSignal(protocol.signal,http.signal);}),
    withAnalysisRequestSignal(other.signal,async()=>{await delay(1);return analysisRequestSignal(protocol.signal);}),
  ]);
  own.abort();assert.equal(first.aborted,true);assert.equal(second.aborted,false);
  http.abort();assert.equal(second.aborted,false);protocol.abort();assert.equal(second.aborted,true);
  const fresh=new AbortController();assert.equal(analysisRequestSignal(fresh.signal),fresh.signal);
});
