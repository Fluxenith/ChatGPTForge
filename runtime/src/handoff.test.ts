import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';

test('three-stage handoff survives restart, fences old owners and rejects changed files',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-handoff-')); const project=join(root,'project');mkdirSync(project);
  let e=new DurableTasks(join(root,'state'));
  t.after(()=>{e.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const task=e.create(project,'three','three stages',['echo ok'],true);
  let lease=task.lease_token!;
  for(let stage=0;stage<3;stage++) {
    const h=e.prepareHandoff(task.task_id,'stage'+stage,task.fingerprint,'next stage',lease);
    const queued=e.queueContinuation(task.task_id,h.handoff_id,lease);
    assert.deepEqual(e.queueContinuation(task.task_id,h.handoff_id,lease),queued);
    assert.equal(e.prepareHandoff(task.task_id,'stage'+stage,task.fingerprint,'next stage',lease).claim_token,h.claim_token);
    assert.throws(()=>e.exec(task.task_id,'bad','echo bad',task.fingerprint,1000,'command',lease),/frozen/);
    assert.throws(()=>e.cancel(task.task_id,lease),/frozen/);
    e.close();e=new DurableTasks(join(root,'state'));
    const next=e.claimHandoff(task.task_id,h.handoff_id,h.claim_token,'receiver'+stage,task.fingerprint);
    assert.deepEqual(e.claimHandoff(task.task_id,h.handoff_id,h.claim_token,'receiver'+stage,task.fingerprint),next);
    assert.throws(()=>e.claimHandoff(task.task_id,h.handoff_id,h.claim_token,'other',task.fingerprint),/claimed/);
    assert.throws(()=>e.checkpoint(task.task_id,task.fingerprint,'old',lease),/lease/);
    assert.throws(()=>e.cancel(task.task_id,lease),/lease/);
    assert.throws(()=>e.complete(task.task_id,lease),/lease/);
    assert.throws(()=>e.withdrawHandoff(task.task_id,h.handoff_id,lease),/lease/);
    lease=next.lease_token;
    e.checkpoint(task.task_id,task.fingerprint,'stage complete',lease);
  }
  assert.throws(()=>e.create(project,'three','three stages',['echo ok'],true),/transferred/);
  const last=e.prepareHandoff(task.task_id,'changed',task.fingerprint,'next',lease);
  writeFileSync(join(project,'outside.txt'),'outside');
  assert.throws(()=>e.claimHandoff(task.task_id,last.handoff_id,last.claim_token,'receiver',task.fingerprint),/changed/);
  e.withdrawHandoff(task.task_id,last.handoff_id,lease);
  assert.throws(()=>e.claimHandoff(task.task_id,last.handoff_id,last.claim_token,'receiver',task.fingerprint),/claimable/);
  assert.equal(e.cancel(task.task_id,lease).status,'cancelled');
});

test('repeated identical failures pause dispatch until an explicit operator review',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-retry-')),project=join(root,'project');mkdirSync(project);
  const e=new DurableTasks(join(root,'state'));t.after(()=>{e.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const task=e.create(project,'retry','retry',['exit 1']);
  for(let n=0;n<3;n++)e.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash,after_hash,exit_code) VALUES(?,?,?,'exit 1','verify','completed',?,?,1000,?,?,1)").run(task.task_id,'fail'+n,'r'+n,n,n,task.fingerprint,task.fingerprint);
  assert.equal(e.status(task.task_id).retry_blocked,true);
  assert.throws(()=>e.exec(task.task_id,'retry-again','exit 1',task.fingerprint,1000,'verify'),/Three identical/);
  e.operatorReview(task.task_id,task.fingerprint,'Investigated tool configuration; allow a fresh attempt','tester','retry');
  assert.equal(e.status(task.task_id).retry_blocked,false);
});
