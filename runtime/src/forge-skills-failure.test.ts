import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DurableTasks} from './durable-tasks.js';
import {ForgeSkillsManager} from './forge-skills-manager.js';

// The fixture runs the unchanged pinned Skills Manager engine with Forge's
// launch-layer run_fail (scripts/forge_skills_extensions.py).
test('Skills Manager stage failures follow the engine retry, fallback skill and fallback stage only from measured Forge failures',{
  skip:!process.env.FORGE_SKILLS_FAILURE_FIXTURE,timeout:180_000,
},async t=>{
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'forge-skills-failure-'));
  const project=join(root,'project'),backend=join(root,'backend');await mkdir(project);await mkdir(backend);
  const child=spawn(process.env.FORGE_SKILLS_MANAGER_PYTHON??'python',[process.env.FORGE_SKILLS_FAILURE_FIXTURE!,backend],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const engine=new DurableTasks(join(root,'state'));
  t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}engine.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const owned=engine.create(project,'failure','Skills failure transitions',['exit 3','echo accepted'],true);
  const taskId=owned.task_id,lease=owned.lease_token!;
  let endpoint='';
  for(let i=0;i<500&&!endpoint;i++){
    if(child.exitCode!==null)throw Error('Backend exited: '+stderr);
    try{endpoint=JSON.parse(await readFile(join(backend,'endpoint.json'),'utf8')).endpoint;}catch{await new Promise(r=>setTimeout(r,20));}
  }
  assert.ok(endpoint,'Actual manager did not start: '+stderr);
  const manager=new ForgeSkillsManager(engine,[project],endpoint);
  const payload=(result:any)=>{assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const change=async(tool:any,id:string,args:Record<string,unknown>)=>payload(await manager.mutate(taskId,id,lease,tool,args));
  const calls=async()=>JSON.parse(await readFile(join(backend,'calls.json'),'utf8')) as Record<string,number>;
  const verify=async(id:string,cmd:string)=>{
    engine.exec(taskId,id,cmd,engine.status(taskId).fingerprint,8000,'verify',lease);
    for(let i=0;i<1000&&engine.result(taskId,id).state!=='completed';i++)await new Promise(r=>setTimeout(r,20));
    return engine.result(taskId,id);
  };
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM skills_manager_operations WHERE task_id=? AND id=?').get(taskId,id),undefined);

  const spec={name:'Failure workflow',version:1,stages:[
    {key:'implement',title:'Implement',retry_limit:1,fallback_stage:'repair',bindings:[{key:'main',skill_id:'one-skill',fallback_skill_id:'fallback-skill'}]},
    {key:'repair',title:'Repair',bindings:[{key:'main',skill_id:'two-skill'}]},
    {key:'close',title:'Close',bindings:[{key:'main',skill_id:'two-skill'}]}]};
  const workflow=await change('workflow_create','workflow',{spec});
  const run=await change('run_create','create',{workflow_id:workflow.workflow_id,run_key:'failure'});
  await change('run_start','start',{run_id:run.run_id});
  const [implement,repair,close]=run.stages.map((s:any)=>s.stage_id);

  // Only Forge's own finished failing fixed-command measurement is accepted.
  await assert.rejects(manager.mutate(taskId,'no-measure',lease,'run_fail',{run_id:run.run_id,verification_operation_id:'missing'}),/requires a task_verify/);noIntent('no-measure');
  assert.equal((await verify('passed','echo accepted')).exit_code,0);
  await assert.rejects(manager.mutate(taskId,'passed-measure',lease,'run_fail',{run_id:run.run_id,verification_operation_id:'passed'}),/passing measurement/);noIntent('passed-measure');
  await assert.rejects(manager.mutate(taskId,'host-claim',lease,'run_fail',{run_id:run.run_id,verification_operation_id:'passed',gate_result:{passed:false}}),/Unrecognized key/);noIntent('host-claim');
  const failed=await verify('failed','exit 3');assert.equal(failed.exit_code,3);

  const first=await change('run_fail','fail-1',{run_id:run.run_id,verification_operation_id:'failed',reason:'fixed command failed'});
  const stage=(snapshot:any,id:string)=>snapshot.stages.find((s:any)=>s.stage_id===id);
  assert.equal(first.current_stage_id,implement);assert.equal(stage(first,implement).retry_count,1);
  assert.deepEqual(stage(first,implement).gate_result,{passed:false,source:'forge_task_verify',operation_id:'failed',cmd:'exit 3',exit_code:3,before_hash:failed.before_hash,after_hash:failed.after_hash,reason:'fixed command failed'});
  // Exact replay returns the receipt without a second backend transition.
  assert.deepEqual(await change('run_fail','fail-1',{run_id:run.run_id,verification_operation_id:'failed',reason:'fixed command failed'}),first);
  assert.equal((await calls()).run_fail,1);
  await assert.rejects(manager.mutate(taskId,'fail-1',lease,'run_fail',{run_id:run.run_id,verification_operation_id:'failed'}),/different/);

  const second=await change('run_fail','fail-2',{run_id:run.run_id,verification_operation_id:'failed'});
  const binding=stage(second,implement).resolved_bindings[0];
  assert.deepEqual([binding.skill_id,binding.primary_skill_id,binding.using_fallback],['fallback-skill','one-skill',true]);
  const third=await change('run_fail','fail-3',{run_id:run.run_id,verification_operation_id:'failed'});
  assert.equal(stage(third,implement).status,'failed');assert.equal(third.current_stage_id,repair);assert.equal(stage(third,repair).status,'running');
  const repaired=await change('run_succeed','repair-ok',{run_id:run.run_id,gate_result:{passed:true}});
  assert.equal(repaired.current_stage_id,close);

  const plain=await change('workflow_create','plain',{spec:{name:'No fallback',version:1,stages:[{key:'only',title:'Only',bindings:[{key:'main',skill_id:'two-skill'}]}]}});
  const single=await change('run_create','create-plain',{workflow_id:plain.workflow_id,run_key:'plain'});await change('run_start','start-plain',{run_id:single.run_id});
  const terminal=await change('run_fail','fail-plain',{run_id:single.run_id,verification_operation_id:'failed'});
  assert.equal(terminal.status,'failed');assert.deepEqual(terminal.terminal_result,{result:'stage-failed',stage_id:single.stages[0].stage_id});
  const illegal=await manager.mutate(taskId,'fail-after-terminal',lease,'run_fail',{run_id:single.run_id,verification_operation_id:'failed'});
  assert.equal(illegal.isError,true);assert.match(illegal.content[0]!.text,/illegal-stage-failure-transition/);
  assert.equal((await calls()).run_fail,5);
  const audit=(await manager.read('run_get',{run_id:run.run_id})).content[0]!.text;
  for(const action of ['run.stage.retry','run.stage.fallback-skill','run.stage.fallback-stage'])assert.match(audit,new RegExp(action.replaceAll('.','\\.')));
});
