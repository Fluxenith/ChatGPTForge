import test from 'node:test';
import assert from 'node:assert/strict';
import {DeferredReads} from './deferred-reads.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('cold reads continue one operation, deliver once and invalidate changed inputs',async()=>{
 const reads=new DeferredReads(5,1000);let calls=0,finish!:(s:string)=>void;
 const run=()=>{calls++;return new Promise<string>(r=>finish=r);};
 const first=JSON.parse(await reads.invoke('a','1',run));
 assert.equal(first.status,'indexing');assert.equal(JSON.parse(await reads.invoke('a','1',run)).operation_id,first.operation_id);assert.equal(calls,1);
 finish('references');await sleep(0);assert.equal(await reads.invoke('a','1',run),'references');
 assert.equal(await reads.invoke('a','1',async()=> 'fresh'),'fresh');
 let aborted=false;
 await reads.invoke('a','1',signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);}))); 
 assert.equal(await reads.invoke('a','2',async()=> 'changed'),'changed');assert.ok(aborted);await reads.close();
});
test('deadline, cancellation, capacity and shutdown include superseded jobs',async()=>{
 const reads=new DeferredReads(5,35,2);let cleaned=0;
 const run=(signal:AbortSignal)=>new Promise<string>((_,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>{cleaned++;reject(signal.reason);},10),{once:true}));
 await reads.invoke('a','1',run);await reads.invoke('a','2',run);
 await assert.rejects(reads.invoke('b','1',run),/limit/);await reads.close();assert.equal(cleaned,2);
 await assert.rejects(reads.invoke('a','1',run),/closing/);
 const deadline=new DeferredReads(5,25);await deadline.invoke('x','1',run);await sleep(40);await assert.rejects(deadline.invoke('x','1',run),/deadline/);await deadline.close();
 const cancel=new DeferredReads(100,1000),controller=new AbortController();const waiting=cancel.invoke('x','1',run,controller.signal);await sleep(1);controller.abort();await assert.rejects(waiting);await cancel.close();assert.equal(cleaned,4);
});
test('failed reads are reported then retryable',async()=>{
 const reads=new DeferredReads(5);await assert.rejects(reads.invoke('x','1',async()=>{throw Error('backend failed');}),/backend failed/);
 assert.equal(await reads.invoke('x','1',async()=>'ok'),'ok');await reads.close();
});
