import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeDesktop} from './desktop-observation.js';
import {ForgeDesktop} from './forge-desktop.js';
import {DurableTasks} from './durable-tasks.js';
import type {InputMonitor,InputStamp} from './desktop-input-monitor.js';

const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
test('observation preserves its screenshot across UIA timeout, distinguishes unavailable, and can recover',async()=>{
  let mode='timeout';const calls:any[]=[];
  const worker=async(input:any,deadline:number)=>{
    calls.push([input.action,deadline]);
    if(input.action==='screenshot')return {image,width:1,height:1,capture_method:'fixture'};
    if(mode==='timeout')throw Object.assign(Error('hung provider'),{code:'DESKTOP_TIMEOUT'});
    if(mode==='unavailable')throw Error('provider unavailable');
    return {controls:[{index:1}],window:{x:10}};
  };
  const timed=await observeDesktop({pid:1},worker);
  assert.equal(timed.image,image);assert.equal(timed.accessibility_status,'timeout');assert.deepEqual(timed.controls,[]);
  assert.deepEqual(calls,[['screenshot',20000],['inspect',5000]]);
  mode='unavailable';assert.equal((await observeDesktop({pid:1},worker)).accessibility_status,'unavailable');
  mode='available';assert.equal((await observeDesktop({pid:1},worker)).controls.length,1);
  await assert.rejects(observeDesktop({},async()=>{throw Error('capture failed');}),/capture failed/);
});

class Monitor implements InputMonitor {
  epoch=0;stopped=false;name='test';closed=false;
  async authorize(){if(this.stopped){this.name+='-new';this.stopped=false;}this.closed=false;}
  stamp(){if(this.closed)throw Error('Monitor lost');if(this.stopped)throw Error('Desktop stopped by physical Escape');return {name:this.name,epoch:this.epoch};}
  check(stamp:InputStamp){const now=this.stamp();if(now.name!==stamp.name||now.epoch!==stamp.epoch)throw Error('User input detected');}
  close(){this.closed=true;}
}
test('user intervention invalidates old refs; Escape stays latched until local grant and cannot replay completed input',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-input-guard-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));const monitor=new Monitor();
  let actions=0,interveneDuringRead=false,failInspect=false;
  const call=async(r:any)=>{
    if(r.action==='list')return [{pid:42,creation:'1',hwnd:'99',app:'fixture'}];
    if(r.action==='observe'||r.action==='inspect'){
      if(r.action==='inspect'&&failInspect)throw Error('UIA read timeout');
      if(interveneDuringRead)monitor.epoch++;
      return {image,controls:[{index:0,name:'Count',runtime_id:'count',type:'ControlType.Button',password:false}]};
    }
    monitor.check(r.input_guard);actions++;return {state:'performed'};
  };
  const desktop=new ForgeDesktop(engine,[project],call,monitor);
  t.after(()=>{desktop.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:5});});
  const task=engine.create(project,'resilience','resilience',['echo ok'],true);
  const run=(id:string,args:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:42,...args});
  await desktop.grant(42);
  const first=await run('first',{action:'observe'});monitor.epoch++;
  await assert.rejects(run('old',{action:'invoke',ref:0,revision:first.revision}),/User input/);assert.equal(actions,0);
  const fresh=await run('fresh',{action:'observe'});
  const click={action:'invoke',ref:0,revision:fresh.revision};await run('click',click);assert.equal(actions,1);
  monitor.stopped=true;
  assert.equal((await run('click',click)).state,'performed');assert.equal(actions,1);
  await assert.rejects(run('stopped',{action:'observe'}),/Escape/);
  await assert.rejects(run('stopped-window',{action:'window',window_state:'minimize'}),/Escape/);
  await desktop.grant(42);
  await assert.rejects(run('after-resume',click),/Stale/);
  interveneDuringRead=true;
  const interrupted=await run('changed-during-read',{action:'observe'});
  assert.equal(interrupted.image,image);assert.equal(interrupted.actionable,false);assert.equal(interrupted.revision,undefined);
  interveneDuringRead=false;
  const recovered=await run('recovered',{action:'observe'});assert.ok(recovered.revision);
  failInspect=true;
  await assert.rejects(run('inspect-timeout',{action:'inspect'}),/UIA read timeout/);
  assert.equal((engine.db.prepare("SELECT count(*) n FROM desktop_operations WHERE state='unknown'").get() as {n:number}).n,0);
  assert.ok((await run('after-inspect-timeout',{action:'observe'})).revision);
  monitor.close();await assert.rejects(run('monitor-lost',{action:'invoke',ref:0,revision:recovered.revision}),/Monitor lost/);
  assert.equal(actions,1);
});
