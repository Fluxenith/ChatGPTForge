import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableTasks} from './durable-tasks.js';
import {TaskPlans,SOFT_BUDGET_DEFAULT_MINUTES} from './task-plan.js';
import {handoffContext} from './handoff-context.js';
import {execFileSync} from 'node:child_process';

function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'forge-plan-')),project=join(root,'project'),state=join(root,'state');mkdirSync(project);
  writeFileSync(join(project,'value.cjs'),'module.exports = 1;\n');
  let engine=new DurableTasks(state);
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  return {project,get engine(){return engine;},restart(){engine.close();engine=new DurableTasks(state);return engine;}};
}
const cmd='node -e "if (require(\'./value.cjs\') !== 2) process.exit(1)"';
const steps=[{id:'read',title:'Read code',objective:'Understand value.cjs'},{id:'fix',title:'Fix value',objective:'Make value 2',estimate_minutes:5}];

test('closure binds fresh verification and source, supports explicit reopen and blocks incomplete plans',async t=>{
  const f=fixture(t),e=f.engine,p=new TaskPlans(e),command='node -e "process.exit(0)"';
  const task=e.create(f.project,'closure','Closure',[command],true),id=task.task_id,lease=task.lease_token!;
  const verify=async(op:string)=>{e.exec(id,op,command,e.status(id).fingerprint,30000,'verify',lease);for(let i=0;i<300;i++){const r=e.result(id,op);if(r.state==='completed'){assert.equal(r.exit_code,0);return;}await delay(50);}throw Error('verify timeout');};
  p.define(id,lease,'plan',[steps[0]!]);await verify('v1');
  assert.throws(()=>e.complete(id,lease),/Plan steps remain/);
  p.update(id,lease,'start',{step_id:'read',state:'in_progress'});
  p.update(id,lease,'done',{step_id:'read',state:'done',evidence_operation_id:'v1'});
  p.closure(id,lease,'committed',{phase:'committed',note:'Source reviewed',evidence_operation_id:'v1'});
  assert.throws(()=>e.complete(id,lease),/Closure is not closed/);
  writeFileSync(join(f.project,'value.cjs'),'module.exports = 2;\n');
  assert.throws(()=>p.closure(id,lease,'bad',{phase:'closed',note:'changed',evidence_operation_id:'v1'}),/Source changed/);
  p.closure(id,lease,'reopen',{phase:'validating',reopen:true,note:'Contradictory source evidence'});
  assert.throws(()=>p.closure(id,lease,'stale',{phase:'closed',note:'stale evidence',evidence_operation_id:'v1'}),/fresh passing/);
  await verify('v2');
  const closed=p.closure(id,lease,'close',{phase:'closed',note:'Fresh verification',evidence_operation_id:'v2'});
  assert.equal(closed?.reopen_count,1);e.complete(id,lease);
});

test('handoff rejects a Git HEAD change even when all workspace bytes are unchanged',t=>{
  const f=fixture(t),e=f.engine;
  const git=(...args:string[])=>execFileSync('git',['-C',f.project,...args],{windowsHide:true,stdio:'pipe'});
  git('init');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','first');
  const task=e.create(f.project,'head','Source identity',['echo ok'],true),id=task.task_id,lease=task.lease_token!;
  const fp=e.status(id).fingerprint,h=e.prepareHandoff(id,'handoff',fp,'continue',lease);
  assert.match(h.context.source_head!,/^[a-f0-9]{40}$/);
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','second');
  assert.equal(e.status(id).fingerprint,fp);
  assert.throws(()=>e.claimHandoff(id,'handoff',h.claim_token,'next',fp),/Source HEAD changed/);
});

test('plan lifecycle with real verification evidence, split depth, lessons and hand-off context',async t=>{
  const f=fixture(t);let e=f.engine,plans=new TaskPlans(e);
  const task=e.create(f.project,'plan','Repair value',[cmd],true),id=task.task_id,lease=task.lease_token!;
  assert.deepEqual(plans.status(id),{task_id:id,defined:false,steps:[],closure:null});
  assert.throws(()=>plans.define(id,'00000000-0000-4000-8000-000000000000','p1',steps),/lease/i);
  const defined=plans.define(id,lease,'p1',steps);
  assert.equal(defined.current_step,'read');assert.equal(defined.sizing.soft_budget_minutes,SOFT_BUDGET_DEFAULT_MINUTES);
  assert.deepEqual(plans.define(id,lease,'p1',steps),defined,'same operation replays its receipt');
  assert.throws(()=>plans.define(id,lease,'p1',[steps[0]!]),/different arguments/);
  assert.throws(()=>plans.define(id,lease,'p2',steps),/already has a plan/);
  assert.throws(()=>plans.update(id,lease,'u0',{step_id:'read',state:'done'}),/pending step cannot become done/);
  plans.update(id,lease,'u1',{step_id:'read',state:'in_progress'});
  assert.throws(()=>plans.update(id,lease,'u1x',{step_id:'read',state:'done'}),/evidence_operation_id/);
  const verify=async(op:string)=>{e.exec(id,op,cmd,e.status(id).fingerprint,30000,'verify',lease);for(let i=0;i<300;i++){const r=e.result(id,op);if(!['prepared','running'].includes(r.state))return r;await delay(100);}throw Error('worker did not finish');};
  assert.equal((await verify('v-fail')).exit_code,1);
  assert.throws(()=>plans.update(id,lease,'u2',{step_id:'read',state:'done',evidence_operation_id:'v-fail'}),/exit code 0/);
  assert.throws(()=>plans.update(id,lease,'u2b',{step_id:'read',state:'done',evidence_operation_id:'missing'}),/exit code 0/);
  plans.update(id,lease,'u3',{step_id:'read',state:'blocked',note:'needs a decision'});
  plans.update(id,lease,'u4',{step_id:'read',state:'split',split_into:[{id:'read-a',title:'A',objective:'first half'},{id:'read-b',title:'B',objective:'second half'}]});
  let s=plans.status(id);
  assert.deepEqual(s.steps.map(x=>[x.id,x.state,x.depth]),[['read','split',0],['read-a','pending',1],['read-b','pending',1],['fix','pending',0]]);
  plans.update(id,lease,'u5',{step_id:'read-a',state:'in_progress'});
  assert.throws(()=>plans.update(id,lease,'u6',{step_id:'read-a',state:'split',split_into:[{id:'read-b',title:'dup',objective:'dup'}]}),/new and unique/);
  plans.update(id,lease,'u6',{step_id:'read-a',state:'split',split_into:[{id:'read-a1',title:'A1',objective:'deeper'}]});
  plans.update(id,lease,'u7',{step_id:'read-a1',state:'in_progress'});
  assert.throws(()=>plans.update(id,lease,'u8',{step_id:'read-a1',state:'split',split_into:[{id:'x',title:'x',objective:'x'}]}),/depth exhausted/);
  assert.equal((plans.status(id).sizing as {action:string}).action,'continue');
  writeFileSync(join(f.project,'value.cjs'),'module.exports = 2;\n');
  assert.equal((await verify('v-pass')).exit_code,0);
  plans.update(id,lease,'u9',{step_id:'read-a1',state:'done',evidence_operation_id:'v-pass'});
  writeFileSync(join(f.project,'value.cjs'),'module.exports = 2; // changed\n');
  plans.update(id,lease,'u10',{step_id:'read-b',state:'in_progress'});
  assert.throws(()=>plans.update(id,lease,'u11',{step_id:'read-b',state:'done',evidence_operation_id:'v-pass'}),/different workspace/,'stale evidence after a change is refused');
  const lesson=plans.recordLesson(id,lease,'l1','value.cjs is loaded with require; keep CommonJS',['commonjs']);
  assert.deepEqual(plans.recordLesson(id,lease,'l1','value.cjs is loaded with require; keep CommonJS',['commonjs']),lesson);
  assert.throws(()=>plans.recordLesson(id,lease,'l2','x',['Bad Tag']),/Invalid|pattern|string/i);
  // The plan survives restart and travels with a hand-off.
  e=f.restart();plans=new TaskPlans(e);
  s=plans.status(id);assert.equal(s.current_step,'read-b');assert.equal(s.counts.done,1);assert.equal((s.steps.find(x=>x.id==='read-a1')!.evidence as {operation_id:string}).operation_id,'v-pass');
  const fp=e.status(id).fingerprint;
  const h=e.prepareHandoff(id,'next',fp,'continue the plan',lease);
  assert.equal((handoffContext(e,id,'next').context as {plan:{plan_sha256:string}}).plan.plan_sha256,s.plan_sha256);
  const claimed=e.claimHandoff(id,'next',h.claim_token,'receiver',fp);
  assert.throws(()=>plans.update(id,lease,'u12',{step_id:'read-b',state:'blocked'}),/lease/i,'the old owner can no longer write the plan');
  plans.update(id,claimed.lease_token,'u12',{step_id:'read-b',state:'blocked',note:'receiver continues'});
  // A later task on the same project reads the lesson.
  e.cancel(id,claimed.lease_token);
  const other=e.create(f.project,'plan-2','Next work',[cmd],true);
  assert.deepEqual(plans.lessons(other.task_id,'commonjs').lessons.map(l=>l.lesson),['value.cjs is loaded with require; keep CommonJS']);
});

test('sizing uses the median of verified first-pass steps in the same project once three exist',t=>{
  const f=fixture(t),e=f.engine,plans=new TaskPlans(e);
  const task=e.create(f.project,'size','Size',[cmd],true),id=task.task_id,lease=task.lease_token!;
  plans.define(id,lease,'p',[1,2,3,4].map(n=>({id:'s'+n,title:'s'+n,objective:'o'+n,estimate_minutes:n===4?50:undefined})));
  const now=Date.now();
  for(const [n,minutes] of [[1,30],[2,40],[3,60]] as const)e.db.prepare("UPDATE plan_steps SET state='done',started=?,finished=? WHERE task_id=? AND id=?").run(now-minutes*60_000,now,id,'s'+n);
  e.db.prepare("UPDATE plan_steps SET state='in_progress',started=? WHERE task_id=? AND id='s4'").run(now-5*60_000,id);
  const s=plans.status(id).sizing as Record<string,unknown>;
  assert.equal(s.history_samples,3);assert.equal(s.soft_budget_minutes,40);assert.equal(s.closure_reserve_minutes,10);
  assert.equal(s.projected_minutes,50);assert.equal(s.action,'split');
  e.db.prepare("UPDATE plan_steps SET blocked_count=1 WHERE task_id=? AND id='s3'").run(id);
  assert.equal((plans.status(id).sizing as Record<string,unknown>).soft_budget_minutes,SOFT_BUDGET_DEFAULT_MINUTES,'a blocked step is not first-pass history');
});

 test('reopening a done step requires a reason and drops its verification evidence',t=>{
  const f=fixture(t),e=f.engine,plans=new TaskPlans(e);
  const task=e.create(f.project,'reopen','Reopen',[cmd],true),id=task.task_id,lease=task.lease_token!;
  plans.define(id,lease,'define',steps);
  e.db.prepare("UPDATE plan_steps SET state='done',evidence='{}',finished=1 WHERE task_id=? AND id='read'").run(id);
  assert.throws(()=>plans.update(id,lease,'bad',{step_id:'read',state:'in_progress'}),/reason/);
  const result=plans.update(id,lease,'reopen',{step_id:'read',state:'in_progress',note:'New contradictory evidence'});
  const step=result.steps.find(s=>s.id==='read')!;
  assert.equal(step.state,'in_progress');assert.equal(step.evidence,null);assert.equal(step.finished,null);
  assert.deepEqual(plans.update(id,lease,'reopen',{step_id:'read',state:'in_progress',note:'New contradictory evidence'}),result);
 });
