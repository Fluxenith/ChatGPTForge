import {parseDesktopHotkey} from './desktop-hotkey.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';
import {ForgeDesktop} from './forge-desktop.js';

test('whole-screen capture needs independent consent and suppresses revoked in-flight images',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-screen-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const png='iVBORw0KGgo=';let captures=0,release:(()=>void)|undefined,hold=false;
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    if((input as any).action==='list')return [{pid:12,creation:'1',hwnd:'42',app:'fixture',title:'Text'}];
    captures++;if(hold)await new Promise<void>(r=>{release=r;});
    return {image:png,x:-1920,y:0,width:3840,height:1080,image_width:1920,image_height:540};
  });
  const task=engine.create(project,'screen','screen',['echo ok'],true);
  await desktop.grant(12);
  await assert.rejects(desktop.screen(task.task_id,task.lease_token!),/獨立授權/);assert.equal(captures,0);
  desktop.grantScreen();
  const first=await desktop.screen(task.task_id,task.lease_token!);assert.equal(first.x,-1920);assert.equal(first.image,png);
  await desktop.screen(task.task_id,task.lease_token!);assert.equal(captures,2);
  assert.equal((engine.db.prepare('SELECT count(*) n FROM desktop_operations').get() as any).n,0);
  hold=true;const pending=desktop.screen(task.task_id,task.lease_token!);
  while(!release)await new Promise(r=>setTimeout(r,5));
  desktop.revoke();release();await assert.rejects(pending,/revoked/);
  await assert.rejects(desktop.screen(task.task_id,task.lease_token!),/獨立授權/);
});

test('Unicode typing preserves payload and never resends completed or uncertain input',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-text-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const received:string[]=[];let fail=false;
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return [{pid:12,creation:'1',hwnd:'42',app:'fixture',title:'Text'}];
    if(r.action==='inspect')return {controls:[{index:0,name:'Text',type:'ControlType.Edit',runtime_id:'text',password:false,enabled:true},{index:1,name:'Secret',type:'ControlType.Edit',runtime_id:'secret',password:true,enabled:true}]};
    assert.equal(r.action,'type_text');received.push(r.text);if(fail)throw Error('delivery uncertain');return {state:'performed'};
  });
  const task=engine.create(project,'text','text',['echo ok'],true),run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:12,...input});
  await desktop.grant(12);let s=await run('inspect',{action:'inspect'});
  const args={action:'type_text',revision:s.revision,ref:0,text:'中文😀'};
  for(const [i,text] of [undefined,'','x'.repeat(10001),42].entries())await assert.rejects(run('bad'+i,{...args,text}),/UTF-16/);
  await assert.rejects(run('secret',{...args,ref:1}),/password/);
  assert.deepEqual(received,[]);
  await run('type',args);await run('type',args);assert.deepEqual(received,['中文😀']);
  await assert.rejects(run('stale',args),/Stale/);
  s=await run('fresh',{action:'inspect'});fail=true;
  const uncertain={...args,revision:s.revision,text:'尾端🧪'};
  await assert.rejects(run('uncertain',uncertain),/delivery uncertain/);
  assert.equal((await run('uncertain',uncertain)).state,'unknown');
  assert.deepEqual(received,['中文😀','尾端🧪']);
  assert.throws(()=>engine.assertIdle(engine.task(task.task_id)),/Unknown browser/);
});

test('desktop pointer validates bounds and fences replay and ambiguous dispatch',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-pointer-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let dispatches=0,fail=false;const modes:string[]=[];
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return [{pid:12,creation:'1',hwnd:'42',app:'fixture',title:'Pointer'}];
    if(r.action==='inspect')return {controls:[{index:0,name:'Canvas',type:'ControlType.Pane',runtime_id:'canvas',password:false,enabled:true,pointer_bounds:[200,50]},{index:1,name:'Virtual',type:'ControlType.Pane',runtime_id:'v',password:false,enabled:true},{index:2,name:'Password',type:'ControlType.Edit',runtime_id:'p',password:true,pointer_bounds:[200,50]}]};
    dispatches++;modes.push(r.input_mode);if(fail)throw Error('ambiguous pointer');return {state:'performed',pid:12};
  });
  const task=engine.create(project,'pointer','pointer',['echo ok'],true),run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:12,...input});
  await desktop.grant(12);let s=await run('i1',{action:'inspect'});
  const click={action:'click',revision:s.revision,ref:0,x:10,y:10};
  for(const [n,change] of [{x:-1},{x:200},{y:50},{x:0.5},{x:NaN},{button:'middle'},{end_x:1},{ref:1},{ref:2}].entries())await assert.rejects(run('invalid'+n,{...click,...change}));
  assert.equal(dispatches,0);assert.equal((engine.db.prepare('SELECT count(*) n FROM desktop_operations').get() as any).n,1);
  await run('click',click);await run('click',click);assert.equal(dispatches,1);
  assert.equal(modes[0],'messages');
  await assert.rejects(run('stale',click),/Stale/);
  s=await run('i2',{action:'inspect'});
  await assert.rejects(run('bad-drag',{action:'drag',revision:s.revision,ref:0,x:1,y:1}),/coordinates/);
  await assert.rejects(run('bad-mode',{action:'inspect',input_mode:'physical'}),/input_mode/);
  await assert.rejects(run('invalid-mode',{...click,revision:s.revision,input_mode:'other'}),/input_mode/);
  const drag={action:'drag',revision:s.revision,ref:0,x:1,y:1,end_x:199,end_y:49,input_mode:'physical'};
  fail=true;await assert.rejects(run('drag',drag),/ambiguous/);assert.equal(dispatches,2);
  assert.equal((await run('drag',drag)).state,'unknown');assert.equal(dispatches,2);
  assert.equal(modes[1],'physical');
  assert.throws(()=>engine.assertIdle(engine.task(task.task_id)),/Unknown browser/);
  await run('observe',{action:'inspect'});
});
test('desktop requires local grant, fresh snapshot, deduplicates input and honors revocation',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let invoked=0,fail=false;
  const desktop=new ForgeDesktop(engine,[project],async i=>{const r=i as any;if(r.action==='list')return [{pid:1,creation:'123',app:'fixture',title:'Fixture'}];if(r.action==='inspect')return {controls:[{index:0,name:'Save',type:'ControlType.Button',runtime_id:'1',password:false}]};invoked++;if(fail)throw Error('ambiguous input');return {state:'performed'};});
  const task=engine.create(project,'desktop','desktop',['echo ok'],true),run=(id:string,args:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:1,...args});
  await assert.rejects(run('no',{action:'inspect'}),/授權/);await desktop.grant(1);
  const state=await run('inspect',{action:'inspect'});
  const args={action:'invoke',ref:0,revision:state.revision};
  await run('invoke',args);await run('invoke',args);assert.equal(invoked,1);
  await assert.rejects(run('stale',args),/Stale/);
  const fresh=await run('fresh',{action:'inspect'});fail=true;
  const ambiguous={action:'invoke',ref:0,revision:fresh.revision};
  await assert.rejects(run('unknown',ambiguous),/ambiguous/);
  assert.equal((await run('unknown',ambiguous)).state,'unknown');assert.equal(invoked,2);
  assert.throws(()=>engine.assertIdle(engine.task(task.task_id)),/Unknown browser/);
  await run('read-after-unknown',{action:'inspect'});
  desktop.revoke();await assert.rejects(run('revoked',{action:'inspect'}),/授權/);
});

test('desktop checkbox uses desired state and authorized screenshot leaves no durable image receipt',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-controls-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let checked=false,toggles=0,captures=0;const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
  const calls:any[]=[];
  const desktop=new ForgeDesktop(engine,[project],async i=>{
    const r=i as any;calls.push(r);
    if(r.action==='list')return [{pid:7,creation:'abc',hwnd:'9988',app:'fixture',title:'Authorized fixture'}];
    if(r.action==='inspect')return {controls:[{index:0,name:'Enabled',type:'ControlType.CheckBox',runtime_id:'checkbox-1',password:false,enabled:true,checked},{index:1,name:'Save',type:'ControlType.Button',runtime_id:'button-1',password:false}]};
    if(r.action==='screenshot'){captures++;return {state:'captured',pid:7,image:png};}
    if(r.action==='check'){if(checked!==r.checked){toggles++;checked=r.checked;}return {state:'performed',pid:7};}
    throw Error('Unexpected fixture operation '+r.action);
  });
  const task=engine.create(project,'desktop-controls','exercise checkbox and screenshot',['echo ok'],true);
  const run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:7,...input});
  await desktop.grant(7);
  const first=await run('inspect-1',{action:'inspect'});
  assert.equal(first.controls[0].checked,false);
  await assert.rejects(run('missing-bool',{action:'check',ref:0,revision:first.revision}),/explicit boolean/);
  await assert.rejects(run('wrong-type',{action:'check',ref:1,revision:first.revision,checked:true}),/checkbox/);
  assert.equal((engine.db.prepare('SELECT count(*) AS count FROM desktop_operations').get() as {count:number}).count,1,'Invalid input must not make unknown receipts');
  const args={action:'check',ref:0,revision:first.revision,checked:true};
  const changed=await run('check-true',args);assert.equal(changed.state,'performed');
  assert.deepEqual(await run('check-true',args),changed);assert.equal(toggles,1,'Same operation ID must not toggle twice');
  const next=await run('inspect-2',{action:'inspect'});assert.equal(next.controls[0].checked,true);
  await run('check-again',{action:'check',ref:0,revision:next.revision,checked:true});
  assert.equal(toggles,1,'Setting the same boolean state is idempotent');
  const png1=await run('image',{action:'screenshot'});assert.equal(png1.state,'captured');assert.equal(png1.image,png);
  await run('image',{action:'screenshot'});assert.equal(captures,2,'Read-only images should refresh without a mutation journal');
  assert.equal((engine.db.prepare("SELECT count(*) AS count FROM desktop_operations WHERE id='image'").get() as {count:number}).count,0);
  assert.ok(calls.filter(c=>c.action==='screenshot'||c.action==='check').every(c=>c.hwnd==='9988'&&c.creation==='abc'));
  desktop.revoke();await assert.rejects(run('image-denied',{action:'screenshot'}));
});

test('unsupported UIA checkbox pattern fails before recording a mutation',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-unavailable-check-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let invoked=0;
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return [{pid:8,creation:'1',hwnd:'42',app:'fixture',title:'Checkbox unsupported'}];
    if(r.action==='inspect')return {controls:[{index:0,name:'Custom CheckBox',type:'ControlType.CheckBox',runtime_id:'custom',password:false,checked:null}]};
    invoked++;return {state:'performed'};
  });
  const task=engine.create(project,'unsupported-toggle','reject unsupported checkbox',['echo ok'],true);
  await desktop.grant(8);
  const snapshot=await desktop.run(task.task_id,'inspect',task.lease_token!,{pid:8,action:'inspect'}) as any;
  await assert.rejects(desktop.run(task.task_id,'check',task.lease_token!,{pid:8,action:'check',ref:0,revision:snapshot.revision,checked:true}),/state unavailable/);
  assert.equal(invoked,0);
  assert.equal((engine.db.prepare("SELECT count(*) AS count FROM desktop_operations WHERE id='check'").get() as {count:number}).count,0);
});

test('desktop selection and scroll retain grants, capability checks, fresh refs and durable replay fencing',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-selection-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let selected=false,vertical=0,selects=0,scrolls=0,ambiguous=false;
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return [{pid:9,creation:'fixture-start',hwnd:'fixture-window',app:'fixture',title:'Selection'}];
    if(r.action==='inspect')return {controls:[
      {index:0,name:'Second item',type:'ControlType.ListItem',runtime_id:'item-2',password:false,enabled:true,selected},
      {index:1,name:'Items',type:'ControlType.List',runtime_id:'list',password:false,enabled:true,scroll:{horizontal_scrollable:false,vertical_scrollable:true,horizontal_percent:-1,vertical_percent:vertical}},
      {index:2,name:'Label',type:'ControlType.Text',runtime_id:'label',password:false,enabled:true},
      {index:3,name:'Disabled',type:'ControlType.ListItem',runtime_id:'disabled',password:false,enabled:false,selected:false},
      {index:4,name:'Password',type:'ControlType.ListItem',runtime_id:'secret',password:true,enabled:true,selected:false},
    ]};
    assert.equal(r.creation,'fixture-start');assert.equal(r.hwnd,'fixture-window');
    if(r.action==='select'){selects++;selected=true;return {state:'performed',selected};}
    if(r.action==='scroll'){scrolls++;vertical=r.vertical_percent;if(ambiguous)throw Error('scroll result lost');return {state:'performed',scroll:{vertical_percent:vertical}};}
    throw Error('Unexpected action');
  });
  const task=engine.create(project,'selection-scroll','select and scroll',['echo ok'],true);
  const run=(id:string,args:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:9,...args});
  await assert.rejects(run('ungranted',{action:'inspect'}),/授權/);await desktop.grant(9);
  const state=await run('inspect',{action:'inspect'});
  const select={action:'select',ref:0,revision:state.revision};
  for(const [id,args,error] of [
    ['unsupported',{action:'select',ref:2,revision:state.revision},/selection/],
    ['disabled',{action:'select',ref:3,revision:state.revision},/disabled/],
    ['password',{action:'select',ref:4,revision:state.revision},/password/],
    ['unscrollable',{action:'scroll',ref:1,revision:state.revision,horizontal_percent:100},/not scrollable/],
    ['unsupported-action',{action:'unknown'},/Unsupported/],
  ] as const)await assert.rejects(run(id,args),error);
  for(const value of [-1,101,NaN,Infinity,'50',null])await assert.rejects(run('bad-'+String(value),{action:'scroll',ref:1,revision:state.revision,vertical_percent:value}),/finite percent/);
  await assert.rejects(run('no-axis',{action:'scroll',ref:1,revision:state.revision}),/finite percent/);
  assert.equal((engine.db.prepare('SELECT count(*) AS count FROM desktop_operations').get() as any).count,1,'Rejected inputs must not reserve mutation receipts');
  assert.equal((await run('select',select)).selected,true);
  assert.equal((await run('select',select)).selected,true);assert.equal(selects,1);
  await assert.rejects(run('stale-select',select),/Stale/);
  const fresh=await run('fresh',{action:'inspect'});
  const scroll={action:'scroll',ref:1,revision:fresh.revision,vertical_percent:100};
  assert.equal((await run('bottom',scroll)).scroll.vertical_percent,100);
  await run('bottom',scroll);assert.equal(scrolls,1);
  await assert.rejects(run('bottom',{...scroll,vertical_percent:0}),/Operation ID reused/);
  const bottom=await run('bottom-observed',{action:'inspect'});assert.equal(bottom.controls[1].scroll.vertical_percent,100);
  ambiguous=true;const uncertain={action:'scroll',ref:1,revision:bottom.revision,vertical_percent:0};
  await assert.rejects(run('uncertain',uncertain),/result lost/);
  assert.equal((await run('uncertain',uncertain)).state,'unknown');assert.equal(scrolls,2);
  const actual=await run('observe-unknown',{action:'inspect'});assert.equal(actual.controls[1].scroll.vertical_percent,0);
  await assert.rejects(run('new-write',{action:'select',ref:0,revision:actual.revision}),/Unknown browser/);
  desktop.revoke();await assert.rejects(run('revoked',{action:'inspect'}),/授權/);
});

test('a process with two windows requires an exact grant and old refs cannot cross a new window grant',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-two-windows-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return ['11','22'].map(hwnd=>({pid:4,creation:'start',hwnd,app:'fixture',title:'Window '+hwnd}));
    if(r.action==='inspect')return {controls:[{index:0,name:'Save',type:'ControlType.Button',runtime_id:'same-id',password:false,enabled:true}]};
    return {state:'performed',hwnd:r.hwnd};
  });
  const task=engine.create(project,'two-windows','exact window',['echo ok'],true);
  await assert.rejects(desktop.grant(4),/exact window handle/);
  await assert.rejects(desktop.grant(4,'33'),/no longer available/);
  await desktop.grant(4,'11');
  const old=await desktop.run(task.task_id,'inspect-11',task.lease_token!,{pid:4,action:'inspect'});
  await desktop.grant(4,'22');
  await assert.rejects(desktop.run(task.task_id,'cross-window',task.lease_token!,{pid:4,hwnd:'22',action:'invoke',ref:0,revision:old.revision}),/Stale/);
  const fresh=await desktop.run(task.task_id,'inspect-22',task.lease_token!,{pid:4,hwnd:'22',action:'inspect'});
  const result=await desktop.run(task.task_id,'invoke-22',task.lease_token!,{pid:4,hwnd:'22',action:'invoke',ref:0,revision:fresh.revision});
  assert.equal(result.hwnd,'22');
});

test('an inspection completing after a window regrant cannot publish actionable refs for the new grant',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-regrant-race-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let release!:(result:any)=>void,entered!:()=>void,writes=0;
  const inspecting=new Promise<void>(r=>{entered=r;});
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return ['11','22'].map(hwnd=>({pid:4,creation:'same-process',hwnd,app:'fixture',title:'Fixture '+hwnd}));
    if(r.action==='inspect'){entered();return new Promise(r=>{release=r;});}
    writes++;return {state:'performed'};
  });
  const task=engine.create(project,'regrant-race','late inspect',['echo ok'],true);
  await desktop.grant(4,'11');
  const pending=desktop.run(task.task_id,'late-inspect',task.lease_token!,{pid:4,action:'inspect'});
  await inspecting;await desktop.grant(4,'22');
  release({controls:[{index:0,name:'Save',type:'ControlType.Button',runtime_id:'shared-id',password:false}]});
  const old=await pending;
  await assert.rejects(desktop.run(task.task_id,'cross-grant',task.lease_token!,{pid:4,hwnd:'22',action:'invoke',ref:0,revision:old.revision}),/Stale/);
  assert.equal(writes,0);
  assert.equal(engine.db.prepare("SELECT * FROM desktop_operations WHERE id='cross-grant'").get(),undefined);
});

test('desktop press and window actions validate keys, bounds and snapshots and keep exactly-once receipts',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-keys-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const calls:any[]=[];
  const desktop=new ForgeDesktop(engine,[project],async i=>{const r=i as any;calls.push(r);
    if(r.action==='list')return [{pid:3,creation:'c',hwnd:'77',app:'fixture',title:'Fixture'}];
    if(r.action==='inspect')return {controls:[{index:0,name:'Forge Text',type:'ControlType.Edit',runtime_id:'e',password:false,enabled:true},{index:1,name:'Secret',type:'ControlType.Edit',runtime_id:'p',password:true,enabled:true}]};
    if(r.action==='press'||r.action==='window')return {state:'performed',pid:3,...(r.action==='window'?{window:{minimized:r.window_state==='minimize',maximized:r.window_state==='maximize',x:r.x??0,y:r.y??0,width:r.width??500,height:r.height??300}}:{})};
    throw Error('unexpected '+r.action);});
  const task=engine.create(project,'desktop-keys','keys',['echo ok'],true),run=(id:string,args:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:3,...args});
  await desktop.grant(3);let s=await run('i1',{action:'inspect'});
  await assert.rejects(run('k0',{action:'press',ref:0,revision:s.revision,key:'F4'}),/supported key/);
  await assert.rejects(run('k1',{action:'press',ref:0,key:'Enter'}),/Stale/);
  await assert.rejects(run('k2',{action:'press',ref:1,revision:s.revision,key:'Enter'}),/password/);
  const press={action:'press',ref:0,revision:s.revision,key:'Backspace'};
  assert.equal((await run('k3',press)).state,'performed');assert.deepEqual(await run('k3',press),{state:'performed',pid:3});
  assert.equal(calls.filter(c=>c.action==='press').length,1,'exact replay never re-sends a key');
  assert.equal(calls.find(c=>c.action==='press').hwnd,'77');
  await assert.rejects(run('k4',press),/Stale/,'a key consumes the snapshot');
  await assert.rejects(run('w0',{action:'window'}),/window requires/);
  await assert.rejects(run('w1',{action:'window',window_state:'minimize',x:1}),/window requires/);
  await assert.rejects(run('w2',{action:'window',x:0,y:0,width:50,height:300}),/window requires/);
  await assert.rejects(run('w3',{action:'window',x:99999,y:0,width:500,height:300}),/window requires/);
  assert.equal((await run('w4',{action:'window',window_state:'minimize'})).window.minimized,true);
  assert.equal((await run('w5',{action:'window',x:-30000,y:-30000,width:600,height:400})).window.width,600);
  const maximize={action:'window',window_state:'maximize'};
  assert.equal((await run('w6',maximize)).window.maximized,true);
  assert.equal((await run('w6',maximize)).window.maximized,true);
  await assert.rejects(run('w7',{action:'window',window_state:'invalid'}),/Unsupported window state/);
  assert.equal(calls.filter(c=>c.action==='window').length,3);
});

test('task-owned GUI permits desktop input only while running and retains other mutation fences',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-desktop-lifetime-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  let fills=0;
  const desktop=new ForgeDesktop(engine,[project],async input=>{
    const r=input as any;
    if(r.action==='list')return [{pid:5,creation:'1',hwnd:'42',app:'fixture',title:'App'}];
    if(r.action==='inspect')return {controls:[{index:0,name:'Text',type:'ControlType.Edit',runtime_id:'e',password:false,enabled:true}]};
    fills++;return {state:'performed',pid:5};
  });
  const task=engine.create(project,'gui','GUI lifecycle',['echo ok'],true),run=(id:string,input:any)=>desktop.run(task.task_id,id,task.lease_token!,{pid:5,...input});
  await desktop.grant(5);
  engine.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?,?,?,?,?,?,?)").run(task.task_id,'app','r','gui','desktop_app','prepared',Date.now(),Date.now(),30000,task.fingerprint);
  await assert.rejects(run('before',{action:'inspect'}),/Outstanding/);
  engine.db.prepare("UPDATE operations SET state='running' WHERE id='app'").run();
  const s=await run('running',{action:'inspect'});
  await run('fill',{action:'fill',revision:s.revision,ref:0,text:'hello'});assert.equal(fills,1);
  assert.throws(()=>engine.exec(task.task_id,'other','echo bad',task.fingerprint,1000,'command',task.lease_token!),/Outstanding/);
  assert.throws(()=>engine.complete(task.task_id,task.lease_token!),/Outstanding/);
  assert.throws(()=>engine.prepareHandoff(task.task_id,'h',task.fingerprint,'next',task.lease_token!),/Outstanding/);
  engine.db.prepare("UPDATE operations SET state='unknown' WHERE id='app'").run();
  await assert.rejects(run('unknown',{action:'inspect'}),/Outstanding/);
  engine.db.prepare("UPDATE operations SET state='running',kind='command' WHERE id='app'").run();
  await assert.rejects(run('ordinary',{action:'inspect'}),/Outstanding/);
  engine.db.prepare("UPDATE operations SET state='completed' WHERE id='app'").run();
  await run('ended',{action:'inspect'});
});

test('desktop hotkey chords resolve modifiers and reject malformed sequences',()=>{
  assert.deepEqual(parseDesktopHotkey('Ctrl+Shift+S'),[17,16,83]);
  assert.deepEqual(parseDesktopHotkey('Alt+F4'),[18,115]);
  assert.deepEqual(parseDesktopHotkey('Win+ArrowLeft'),[91,37]);
  assert.deepEqual(parseDesktopHotkey('F24'),[135]);
  for(const chord of [undefined,'','Ctrl','Ctrl++S','Ctrl+Ctrl+S','Alt+Something','F25','Ctrl+S+X','toString'])assert.throws(()=>parseDesktopHotkey(chord));
});
