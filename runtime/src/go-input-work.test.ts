import assert from 'node:assert/strict';
import test from 'node:test';
import {visitGoInputs} from './go-input-work.js';

function deferred(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('Go input traversal fills a free slot while a slow file stays active and preserves index ownership',async()=>{
  const slow=deferred(),advanced=deferred(),seen=new Map<number,number>();let active=0,peak=0;
  const work=visitGoInputs(Array.from({length:40},(_,i)=>i),async(item,index)=>{
    active++;peak=Math.max(peak,active);assert.equal(item,index);assert.ok(!seen.has(index));seen.set(index,item);
    try{if(index===0)await slow.promise;else if(index===16)advanced.release();else await tick();}finally{active--;}
  });
  try{await Promise.race([advanced.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Free slots waited for the slow file')),1000).unref())]);assert.ok(seen.has(16));assert.ok(active>0);}finally{slow.release();await work;}
  assert.equal(seen.size,40);assert.ok(peak<=16);assert.equal(active,0);
});

test('Go input failure stops new work and drains every in-flight callback before cleanup can proceed',async()=>{
  const held=deferred(),error=Error('owned failure');let started=0,finished=0,settled=false;
  const work=visitGoInputs(Array.from({length:60},(_,i)=>i),async(_,i)=>{
    started++;try{if(i===0)throw error;await held.promise;}finally{finished++;}
  }).then(()=>{throw Error('Expected failure');},e=>{assert.equal(e,error);settled=true;});
  try{await tick();assert.equal(started,16);assert.equal(settled,false);assert.equal(finished,1);}finally{held.release();await work;}
  assert.equal(started,16);assert.equal(finished,16);assert.equal(settled,true);
});

test('Go input cancellation drains started callbacks without dispatching queued files',async()=>{
  const held=deferred(),abort=new AbortController();let started=0,settled=false;
  const work=visitGoInputs(Array.from({length:60},(_,i)=>i),async()=>{started++;await held.promise;},abort.signal)
    .then(()=>{throw Error('Expected cancellation');},e=>{assert.equal(e,abort.signal.reason);settled=true;});
  abort.abort(new Error('owned cancellation'));try{await tick();assert.equal(started,16);assert.equal(settled,false);}finally{held.release();await work;}
  assert.equal(started,16);assert.equal(settled,true);
  let called=false;await assert.rejects(visitGoInputs([1],async()=>{called=true;},abort.signal),/owned cancellation/);assert.equal(called,false);
});
