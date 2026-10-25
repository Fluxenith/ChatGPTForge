import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {desktopCall} from './forge-desktop.js';

// Opt-in, read-only integration against the explicitly opened disposable fixture.
// Never launch or select an arbitrary user application during the normal suite.
test('native UIA identifies WinForms controls and rejects stale identity before input', {
  skip:process.platform!=='win32'||!process.env.FORGE_DESKTOP_FIXTURE_RECEIPT,
},async()=>{
  const receipt=JSON.parse(readFileSync(process.env.FORGE_DESKTOP_FIXTURE_RECEIPT!,'utf8').replace(/^\uFEFF/,''));
  const base={pid:receipt.pid,creation:receipt.startFileTime};
  const snapshot=await desktopCall({...base,action:'inspect'});
  assert.equal(snapshot.title,'ChatGPTForge Desktop Acceptance');
  const input=snapshot.controls.find((c:any)=>c.automation_id==='ForgeName');
  const button=snapshot.controls.find((c:any)=>c.automation_id==='RecordOnce');
  assert.equal(input?.type,'ControlType.Edit');
  assert.equal(input?.name,'Forge Name');
  assert.equal(button?.type,'ControlType.Button');
  await assert.rejects(desktopCall({...base,creation:'0',action:'inspect'}),/Window identity changed/);
  await assert.rejects(desktopCall({...base,action:'fill',element:{...input,runtime_id:'stale-test-ref'},text:'must not be written'}),/Element changed/);
});

test('native list selection, tab selection and absolute scroll match independent fixture state', {
  skip:process.platform!=='win32'||!process.env.FORGE_DESKTOP_SELECTION_SCROLL_FIXTURE,
},async()=>{
  const read=()=>JSON.parse(readFileSync(process.env.FORGE_DESKTOP_SELECTION_SCROLL_FIXTURE!,'utf8').replace(/^\uFEFF/,''));
  const receipt=read(),base={pid:receipt.pid,creation:receipt.creation,hwnd:receipt.hwnd};
  const inspect=()=>desktopCall({...base,action:'inspect'});
  const observe=async(predicate:(state:any)=>boolean)=>{
    for(let i=0;i<30;i++){await delay(100);const state=read();if(predicate(state))return state;}
    assert.fail('Fixture did not reach expected state: '+JSON.stringify(read()));
  };
  const initial=await inspect();assert.equal(initial.title,'Forge Selection Scroll Fixture');
  const item=initial.controls.find((c:any)=>c.name==='Item 05');assert.equal(item?.selected,false);
  await desktopCall({...base,action:'select',element:item});
  await observe(s=>s.selected_index===5);
  let snapshot=await inspect();assert.equal(snapshot.controls.find((c:any)=>c.name==='Item 05').selected,true);
  const second=snapshot.controls.find((c:any)=>c.type==='ControlType.TabItem'&&c.name==='Second page');
  assert.equal(second?.selected,false);
  await desktopCall({...base,action:'select',element:second});await observe(s=>s.tab_index===1);
  snapshot=await inspect();assert.equal(snapshot.controls.find((c:any)=>c.type==='ControlType.TabItem'&&c.name==='Second page').selected,true);
  const list=snapshot.controls.find((c:any)=>c.automation_id==='ForgeItems');
  assert.equal(list?.scroll?.vertical_scrollable,true);
  assert.equal(list.scroll.horizontal_scrollable,false);
  await assert.rejects(desktopCall({...base,action:'scroll',element:list,horizontal_percent:100}),/not scrollable/);
  await assert.rejects(desktopCall({...base,action:'scroll',element:list,vertical_percent:101}),/0\.\.100/);
  const bottom=await desktopCall({...base,action:'scroll',element:list,vertical_percent:100});
  assert.ok(bottom.scroll.vertical_percent>=98);
  const atBottom=await observe(s=>s.top_index>50);assert.equal(atBottom.selected_index,5,'Scrolling must not change selection');
  snapshot=await inspect();const currentList=snapshot.controls.find((c:any)=>c.automation_id==='ForgeItems');
  await desktopCall({...base,action:'scroll',element:currentList,vertical_percent:0});await observe(s=>s.top_index===0);
  snapshot=await inspect();assert.equal(snapshot.controls.find((c:any)=>c.automation_id==='ForgeItems').scroll.vertical_percent,0);
  const stale={...snapshot.controls.find((c:any)=>c.name==='Item 05'),runtime_id:'stale'};
  await assert.rejects(desktopCall({...base,action:'select',element:stale}),/Element changed/);
  assert.equal(read().selected_index,5);
  await assert.rejects(desktopCall({...base,hwnd:'1',action:'inspect'}),/Window handle changed/);
  await assert.rejects(desktopCall({...base,creation:'0',action:'inspect'}),/Window identity changed/);
  const field=snapshot.controls.find((c:any)=>c.automation_id==='ForgeText');
  const literal="繁體中文 ' $() ` literal input";
  await desktopCall({...base,action:'fill',element:field,text:literal});
  await observe(s=>s.text===literal);
});


test('native authorized fixture screenshot, checkbox and changed window handle', {
  skip:process.platform!=='win32'||!process.env.FORGE_DESKTOP_LOCAL_CONTROL_FIXTURE,
},async()=>{
  const receipt=JSON.parse(readFileSync(process.env.FORGE_DESKTOP_LOCAL_CONTROL_FIXTURE!,'utf8').replace(/^\uFEFF/,''));
  const base={pid:receipt.pid,creation:receipt.creation,hwnd:receipt.hwnd};
  const snapshot=await desktopCall({...base,action:'inspect'});
  assert.equal(snapshot.title,'Forge Local Control Fixture');
  const checkbox=snapshot.controls.find((c:any)=>c.type==='ControlType.CheckBox'&&c.name==='Forge Check');
  assert.ok(checkbox,'fixture must expose UIA CheckBox');
  assert.equal(checkbox.checked,false,'UIA checked value must match actual unchecked fixture');
  await assert.rejects(desktopCall({...base,hwnd:'1',action:'screenshot'}),/Window handle changed/);
  const screenshot=await desktopCall({...base,action:'screenshot'});
  assert.equal(screenshot.state,'captured');
  const png=Buffer.from(screenshot.image,'base64');
  assert.ok(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.ok(png.length>100&&png.length<3*1024*1024);
  if(process.env.FORGE_DESKTOP_SCREENSHOT_EVIDENCE)writeFileSync(process.env.FORGE_DESKTOP_SCREENSHOT_EVIDENCE,png);
  await desktopCall({...base,action:'check',element:checkbox,checked:true});
  let observed=await desktopCall({...base,action:'inspect'});
  assert.equal(observed.controls.find((c:any)=>c.name==='Forge Check').checked,true);
  await desktopCall({...base,action:'check',element:observed.controls.find((c:any)=>c.name==='Forge Check'),checked:true});
  observed=await desktopCall({...base,action:'inspect'});
  assert.equal(observed.controls.find((c:any)=>c.name==='Forge Check').checked,true);
  await desktopCall({...base,action:'check',element:observed.controls.find((c:any)=>c.name==='Forge Check'),checked:false});
  observed=await desktopCall({...base,action:'inspect'});
  assert.equal(observed.controls.find((c:any)=>c.name==='Forge Check').checked,false);
});

test('native key messages and non-activating window management on the owned offscreen fixture', {
  skip:process.platform!=='win32'||!process.env.FORGE_DESKTOP_KEYS_WINDOW_FIXTURE,
},async()=>{
  // The fixture replaces its receipt atomically; retry a read that lands mid-replace.
  const read=()=>{for(let i=0;;i++){try{return JSON.parse(readFileSync(process.env.FORGE_DESKTOP_KEYS_WINDOW_FIXTURE!,'utf8').replace(/^﻿/,''));}catch(e){if(i>=50)throw e;}}};
  const receipt=read(),base={pid:receipt.pid,creation:receipt.creation,hwnd:receipt.hwnd};
  const observe=async(predicate:(state:any)=>boolean)=>{for(let i=0;i<40;i++){await delay(100);const state=read();if(predicate(state))return state;}assert.fail('Fixture did not reach expected state: '+JSON.stringify(read()));};
  let snapshot=await desktopCall({...base,action:'inspect'});assert.equal(snapshot.title,'Forge Keys Window Fixture');
  const list=snapshot.controls.find((c:any)=>c.name==='Forge Items'&&c.type==='ControlType.List');assert.ok(list,'list control');
  const start=read().selected_index;
  await desktopCall({...base,action:'press',element:list,key:'ArrowDown'});
  await observe(s=>s.selected_index===start+1);
  const field=snapshot.controls.find((c:any)=>c.name==='Forge Text');
  await desktopCall({...base,action:'fill',element:field,text:'abc'});await observe(s=>s.text==='abc');
  snapshot=await desktopCall({...base,action:'inspect'});
  // fill leaves the caret at the start; End moves it before Backspace deletes.
  await desktopCall({...base,action:'press',element:snapshot.controls.find((c:any)=>c.name==='Forge Text'),key:'End'});
  await desktopCall({...base,action:'press',element:snapshot.controls.find((c:any)=>c.name==='Forge Text'),key:'Backspace'});
  await observe(s=>s.text==='ab');
  await assert.rejects(desktopCall({...base,action:'press',element:snapshot.controls.find((c:any)=>c.name==='Forge Text'),key:'F13'}),/Unsupported key/);
  const moved=await desktopCall({...base,action:'window',x:-30000,y:-30000,width:600,height:420});
  assert.deepEqual([moved.window.x,moved.window.width,moved.window.height],[-30000,600,420]);
  await observe(s=>s.width===600&&s.height===420&&s.x===-30000);
  const minimized=await desktopCall({...base,action:'window',window_state:'minimize'});assert.equal(minimized.window.minimized,true);await observe(s=>s.minimized===true);
  await assert.rejects(desktopCall({...base,action:'window',x:-30000,y:-30000,width:500,height:400}),/Restore the window/);
  const restored=await desktopCall({...base,action:'window',window_state:'restore'});assert.equal(restored.window.minimized,false);await observe(s=>s.minimized===false&&s.x===-30000);
});
