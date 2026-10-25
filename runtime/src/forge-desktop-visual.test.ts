import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';
import {ForgeDesktop} from './forge-desktop.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
const geometry={window_x:100,window_y:200,width:200,height:120,image_width:100,image_height:60,capture_method:'print_window_renderfullcontent'};

test('window screenshot revisions support physical image coordinates without UIA refs',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-visual-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const calls:any[]=[];let failPost=false;
  const desktop=new ForgeDesktop(engine,[project],async request=>{
    const r=request as any;calls.push(r);
    if(r.action==='list')return [{pid:42,creation:'fixture',hwnd:'1001',app:'fixture',title:'Visual'}];
    if(r.action==='screenshot')return {state:'captured',image:png,...geometry};
    if(r.action==='observe'){
      if(failPost)throw Error('post capture unavailable');
      return {state:'captured',image:png,...geometry,controls:[],accessibility_available:false};
    }
    if(r.action==='click'||r.action==='drag')return {state:'performed',verification:'needs_observation'};
    throw Error('unexpected '+r.action);
  });
  const task=engine.create(project,'visual','visual',['echo ok'],true);
  const run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:42,...input});
  await desktop.grant(42);
  const first=await run('capture',{action:'screenshot'});
  assert.equal(first.image,png);assert.equal(first.image_width,100);assert.equal(first.width,200);
  assert.ok(first.revision);
  const observed=await run('observe',{action:'observe'});
  assert.notEqual(observed.revision,first.revision);
  assert.equal(observed.accessibility_available,false);
  const click={action:'click',coordinate_space:'window',input_mode:'physical',revision:observed.revision,x:25,y:18};
  const invalid=[
    {...click,input_mode:'messages'},
    {...click,input_mode:undefined},
    {...click,ref:0},
    {...click,x:100},
    {...click,y:60},
    {...click,x:-1},
    {...click,x:2.5},
    {...click,revision:first.revision},
  ];
  for(let i=0;i<invalid.length;i++)await assert.rejects(run('invalid-'+i,invalid[i]));
  await assert.rejects(run('invalid-space',{action:'inspect',coordinate_space:'window'}));
  assert.equal(calls.filter(r=>r.action==='click').length,0);
  assert.equal((engine.db.prepare('SELECT count(*) n FROM desktop_operations').get() as any).n,0);
  const performed=await run('click-once',click);
  assert.equal(performed.state,'performed');assert.equal(performed.verification,'post_state_observed');
  assert.equal(performed.image,png);assert.ok(performed.post_observation.revision);
  const {image,...persistedResult}=performed;
  assert.deepEqual(await run('click-once',click),persistedResult);
  assert.equal(calls.filter(r=>r.action==='click').length,1);
  const receipt=engine.db.prepare("SELECT result FROM desktop_operations WHERE id='click-once'").get() as {result:string};
  assert.ok(!receipt.result.includes(png),'Post-observation image bytes must not be persisted in SQLite');
  const native=calls.find(r=>r.action==='click');
  const {capture_method:ignoredMethod,...expectedCapture}=geometry;
  assert.deepEqual(native.capture,expectedCapture);
  assert.equal(native.coordinate_space,'window');assert.equal(native.element,undefined);
  await assert.rejects(run('stale',click),/Stale/);
  const after=await run('observe-after',{action:'observe'});
  assert.ok(after.revision&&after.revision!==observed.revision);
  const nextImage=await run('image-before-post-failure',{action:'screenshot'});
  failPost=true;
  const failing={...click,revision:nextImage.revision};
  const stillPerformed=await run('click-with-post-failure',failing);
  assert.equal(stillPerformed.state,'performed');
  assert.match(stillPerformed.post_observation_error,/post capture unavailable/);
  assert.deepEqual(await run('click-with-post-failure',failing),stillPerformed);
  assert.equal(calls.filter(r=>r.action==='click').length,2,'Failed post-capture must not resend input');
  assert.equal((engine.db.prepare("SELECT state FROM desktop_operations WHERE id='click-with-post-failure'").get() as any).state,'completed');
});

test('visual pointer blocks password controls and revocation during capture',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-visual-credential-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let release:(()=>void)|undefined,hold=false,clicks=0;
  const desktop=new ForgeDesktop(engine,[project],async request=>{
    const r=request as any;
    if(r.action==='list')return [{pid:42,creation:'fixture',hwnd:'1001',app:'fixture',title:'Visual'}];
    if(r.action==='observe'){
      if(hold)await new Promise<void>(resolve=>{release=resolve;});
      return {state:'captured',image:png,...geometry,controls:[{index:0,name:'Secret',runtime_id:'password',type:'ControlType.Edit',password:true}]};
    }
    if(r.action==='click'){clicks++;return {state:'performed'};}
    throw Error('unexpected '+r.action);
  });
  const task=engine.create(project,'visual-credential','visual',['echo ok'],true);
  const run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:42,...input});
  await desktop.grant(42);
  const state=await run('observe',{action:'observe'});
  await assert.rejects(run('blocked',{action:'click',coordinate_space:'window',input_mode:'physical',revision:state.revision,x:1,y:1}),/password controls/);
  assert.equal(clicks,0);
  hold=true;
  const pending=run('pending',{action:'observe'});
  while(!release)await new Promise(resolve=>setTimeout(resolve,5));
  desktop.revoke();release();
  await assert.rejects(pending,/revoked or expired/);
  await assert.rejects(run('after-revoke',{action:'observe'}),/授權/);
  assert.equal((engine.db.prepare('SELECT count(*) n FROM desktop_operations').get() as any).n,0);
});

test('failed refresh and malformed post-capture geometry cannot leave actionable pixels',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-visual-invalid-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let bad=false,fail=false,clicks=0;
  const desktop=new ForgeDesktop(engine,[project],async request=>{
    const r=request as any;
    if(r.action==='list')return [{pid:42,creation:'fixture',hwnd:'1001',app:'fixture',title:'Visual'}];
    if(r.action==='screenshot'||r.action==='observe'){
      if(fail)throw Error('capture unavailable');
      return {image:png,...geometry,...(bad?{image_width:0}:{}),controls:[]};
    }
    if(r.action==='click'){clicks++;bad=true;return {state:'performed',verification:'needs_observation'};}
    throw Error('unexpected '+r.action);
  });
  const task=engine.create(project,'invalid','invalid',['echo ok'],true);
  const run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:42,...input});
  const click=(revision:string)=>({action:'click',coordinate_space:'window',input_mode:'physical',revision,x:1,y:1});
  await desktop.grant(42);
  const first=await run('first',{action:'screenshot'});
  fail=true;await assert.rejects(run('failed',{action:'observe'}),/capture unavailable/);
  await assert.rejects(run('old',click(first.revision)),/Stale/);
  fail=false;
  const second=await run('second',{action:'observe'});
  const result=await run('click',click(second.revision));
  assert.equal(result.state,'performed');assert.match(result.post_observation_error,/geometry/);
  assert.equal(result.post_observation,undefined);assert.equal(result.image,undefined);
  await assert.rejects(run('after',click(second.revision)),/Stale/);
  assert.deepEqual(await run('click',click(second.revision)),result);assert.equal(clicks,1);
});
