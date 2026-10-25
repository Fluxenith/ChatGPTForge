import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableTasks,digest} from './durable-tasks.js';
import {TaskWorkflow} from './task-workflow.js';
import {handoffContext,continuationPrompt} from './handoff-context.js';
import {TaskFiles} from './task-files.js';

function fixture(t: test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'forge-workflow-')),project=join(root,'project'),state=join(root,'state');
  mkdirSync(join(project,'.agents','skills','repair'),{recursive:true});
  const skillPath='.agents/skills/repair/SKILL.md',content='---\nname: repair\n---\nRun the fixed acceptance before completion.\n';
  writeFileSync(join(project,skillPath),content);
  let engine=new DurableTasks(state);
  t.after(()=>{engine.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'));rmSync(root,{recursive:true,force:true,maxRetries:10});});
  return {project,skillPath,content,get engine(){return engine;},restart(){engine.close();engine=new DurableTasks(state);return engine;}};
}
const stage=(id:string,cmd:string,skills:{path:string;sha256:string}[]=[])=>({id,title:id,objective:'Verify '+id,acceptance_commands:[cmd],skills});

test('workflow freezes acceptance and skill snapshots and rejects skip, drift and replacement',t=>{
  const f=fixture(t),e=f.engine,w=new TaskWorkflow(e),task=e.create(f.project,'flow','repair',['echo one','echo two'],true);
  const pin=w.catalog(task.task_id).skills[0]!;
  const definition={stages:[stage('one','echo one',[pin]),stage('two','echo two')]};
  const flow=w.define(task.task_id,task.fingerprint,definition,task.lease_token!);
  assert.deepEqual(w.define(task.task_id,task.fingerprint,definition,task.lease_token!),flow);
  assert.throws(()=>w.define(task.task_id,task.fingerprint,{stages:[stage('one','echo one')]},task.lease_token!),/fixed/);
  assert.throws(()=>w.advance(task.task_id,'two',task.fingerprint,task.lease_token!),/skip/);
  assert.throws(()=>w.advance(task.task_id,'one',task.fingerprint,task.lease_token!),/task_verify/);
  assert.throws(()=>e.complete(task.task_id,task.lease_token!),/stages remain/);
  writeFileSync(join(f.project,f.skillPath),'changed instructions');
  assert.throws(()=>w.read(task.task_id,pin.path,pin.sha256),/version changed/);
  assert.equal(w.read(task.task_id,pin.path,pin.sha256,true).content,f.content);
  assert.throws(()=>w.advance(task.task_id,'one',task.fingerprint,task.lease_token!),/changed/);
  assert.deepEqual(new TaskWorkflow(f.restart()).inspect(task.task_id),flow);
});

test('workflow validates full command coverage and refuses escaped or linked skills',t=>{
  const f=fixture(t),e=f.engine,w=new TaskWorkflow(e),task=e.create(f.project,'flow','repair',['echo one','echo two'],true);
  assert.throws(()=>w.define(task.task_id,task.fingerprint,{stages:[stage('one','echo one')]},task.lease_token!),/Every task/);
  assert.throws(()=>w.define(task.task_id,task.fingerprint,{stages:[stage('one','echo bad')]},task.lease_token!),/fixed task/);
  assert.throws(()=>w.read(task.task_id,'../SKILL.md',digest('')),/project/);
  mkdirSync(join(f.project,'outside'));writeFileSync(join(f.project,'outside','SKILL.md'),'outside');
  symlinkSync(join(f.project,'outside'),join(f.project,'.agents','skills','linked'),'junction');
  assert.throws(()=>w.read(task.task_id,'.agents/skills/linked/SKILL.md',digest('outside')),/Linked/);
  assert.ok(w.catalog(task.task_id).diagnostics.some(d=>d.path.endsWith('/linked')));
});

test('handoff freezes structured context without disclosing leases and withdraw retires delivery',t=>{
  const f=fixture(t),e=f.engine,w=new TaskWorkflow(e),task=e.create(f.project,'flow','repair',['echo one'],true);
  w.define(task.task_id,task.fingerprint,{stages:[stage('one','echo one')]},task.lease_token!);
  const h=e.prepareHandoff(task.task_id,'handoff',task.fingerprint,'continue current stage',task.lease_token!);
  e.queueContinuation(task.task_id,h.handoff_id,task.lease_token!);
  const context=handoffContext(e,task.task_id,h.handoff_id);
  assert.equal(context.context.workflow.current_stage,'one');
  assert.deepEqual(context.context.acceptance_commands,['echo one']);
  assert.ok(!JSON.stringify(context).includes(task.lease_token!));
  assert.ok(!JSON.stringify(context).includes(h.claim_token));
  assert.match(continuationPrompt(e,task.task_id,h.handoff_id).prompt,/handoff_context/);
  assert.throws(()=>w.advance(task.task_id,'one',task.fingerprint,task.lease_token!),/frozen/);
  assert.deepEqual(handoffContext(f.restart(),task.task_id,h.handoff_id),context);
  f.engine.withdrawHandoff(task.task_id,h.handoff_id,task.lease_token!);
  assert.equal((f.engine.status(task.task_id).continuation[0] as {state:string}).state,'obsolete');
});

test('real durable workers repair a failure, pass stages across restart/claim, and require final fresh evidence',async t=>{
  const f=fixture(t);writeFileSync(join(f.project,'value.cjs'),'module.exports = 1;\n');
  const cmd='node -e "if (require(\'./value.cjs\') !== 2) process.exit(1)"';
  const cmd2='node -e "require(\'node:assert/strict\').equal(require(\'./value.cjs\') * 3, 6)"';
  let e=f.engine,w=new TaskWorkflow(e);
  const task=e.create(f.project,'live','Repair value',[cmd,cmd2],true),id=task.task_id;
  let lease=task.lease_token!;
  w.define(id,task.fingerprint,{stages:[stage('repair',cmd),stage('regression',cmd2)]},lease);
  const verify=async(op:string,command:string)=>{
    e.exec(id,op,command,e.status(id).fingerprint,30000,'verify',lease);
    for(let i=0;i<300;i++){const result=e.result(id,op);if(!['prepared','running'].includes(result.state))return result;await delay(100);}
    throw Error('Worker did not finish');
  };
  assert.equal((await verify('baseline',cmd)).exit_code,1);
  assert.throws(()=>w.advance(id,'repair',task.fingerprint,lease),/task_verify/);
  new TaskFiles(e).write(id,'repair-value','value.cjs','module.exports = 2;\n',digest('module.exports = 1;\n'),lease);
  assert.equal((await verify('fixed',cmd)).exit_code,0);
  const fingerprint=e.status(id).fingerprint;
  w.advance(id,'repair',fingerprint,lease);
  const h=e.prepareHandoff(id,'next',fingerprint,'Run regression stage',lease);
  const oldLease=lease;e=f.restart();w=new TaskWorkflow(e);
  lease=e.claimHandoff(id,h.handoff_id,h.claim_token,'receiver',fingerprint).lease_token;
  assert.throws(()=>w.advance(id,'regression',fingerprint,oldLease),/lease/);
  assert.equal(w.inspect(id)!.current_stage,'regression');
  assert.equal((await verify('regression',cmd2)).exit_code,0);
  const done=w.advance(id,'regression',fingerprint,lease);
  assert.equal(done!.current_stage,null);
  assert.deepEqual(w.advance(id,'regression',fingerprint,lease),done);
  writeFileSync(join(f.project,'extra.txt'),'new source');
  assert.throws(()=>e.complete(id,lease),/stale successful/);
  assert.equal((await verify('final-one',cmd)).exit_code,0);
  assert.equal((await verify('final-two',cmd2)).exit_code,0);
  assert.equal(e.complete(id,lease).status,'complete');
});
