import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';
import {ForgeDesktop} from './forge-desktop.js';

test('surface requires session, fresh coordinates and both endpoints; returns observation and replays without input',async t=>{
 const root=mkdtempSync(join(tmpdir(),'forge-surface-')),project=join(root,'p');mkdirSync(project);const engine=new DurableTasks(join(root,'state'));
 let epoch=0,inputs=0,password=false;
 const monitor={authorize:async()=>{},stamp:()=>({name:'test',epoch}),check:(s:any)=>{if(s.epoch!==epoch)throw Error('User input');},close:()=>{}};
 const windows=[{pid:12,creation:'1',hwnd:'42',window:{x:-100,y:0,width:100,height:100}},{pid:13,creation:'2',hwnd:'43',window:{x:0,y:0,width:100,height:100}}];
 const desktop=new ForgeDesktop(engine,[project],async (r:any)=>{if(r.action==='list')return windows.filter(w=>!r.pid||r.pid===w.pid);if(r.action==='screen')return {image:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),x:-100,y:0,width:200,height:100,image_width:200,image_height:100};if(r.action==='surface_catalog')return [{hwnd:'99',kind:'taskbar',x:-100,y:90,width:200,height:10}];if(r.action==='inspect')return {controls:[{password}]};if(r.action==='surface_input'){inputs++;return {state:'performed'};}throw Error(r.action);},monitor);
 t.after(()=>{desktop.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:5});});
 const task=engine.create(project,'surface','surface',['ok'],true),run=(id:string,i:any)=>desktop.surface(task.task_id,id,task.lease_token!,i);
 desktop.grantScreen();await assert.rejects(run('no',{action:'observe'}),/session grant/);
 await desktop.grantSession();let snap=await run('observe',{action:'observe'});
 await assert.rejects(run('outside',{action:'click',source_hwnd:'42',revision:snap.revision,x:150,y:30}),/outside selected/);
 epoch++;await assert.rejects(run('stale',{action:'click',source_hwnd:'42',revision:snap.revision,x:20,y:30}),/User input/);
 snap=await run('observe2',{action:'observe'});password=true;
 const args={action:'drag',source_hwnd:'42',destination_hwnd:'43',revision:snap.revision,x:30,y:30,end_x:150,end_y:30};
 await assert.rejects(run('password',args),/Password/);password=false;
 const first=await run('drag',args);assert.equal(first.verification,'post_state_observed');assert.ok(first.post_observation.revision);assert.equal((await run('drag',args)).image,undefined);assert.equal(inputs,1);
 desktop.revoke();await assert.rejects(run('revoked',{action:'observe'}),/session grant/);
});
