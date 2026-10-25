import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser,videoRecorderAvailable} from './forge-browser.js';

// The fixture registers WebMCP tools on document.modelContext itself, so the
// Forge path is exercised regardless of the browser build's native support.
const page='<!doctype html><body style="margin:0;height:3000px">'+
  '<div id="pad" style="position:absolute;left:100px;top:100px;width:200px;height:100px;background:#eef"></div>'+
  '<ul aria-label="Fruits"><li>Apple</li><li hidden>Invisible Kiwi</li><li>Banana</li><li>Cherry</li></ul>'+
  '<ol aria-label="Hidden list" hidden><li>Apple</li></ol>'+
  '<button data-testid="save-btn" aria-label="Save" style="position:absolute;left:400px;top:100px">Save</button>'+
  '<output id="log"></output><script>'+
  'const log=[];const out=()=>{document.getElementById("log").textContent=log.join(";");};'+
  'const pad=document.getElementById("pad");'+
  'pad.addEventListener("click",e=>{log.push("click@"+e.clientX+","+e.clientY);out();});'+
  'pad.addEventListener("mousedown",e=>{log.push("down@"+e.clientX+","+e.clientY);out();});'+
  'pad.addEventListener("mouseup",e=>{log.push("up@"+e.clientX+","+e.clientY);out();});'+
  'window.addEventListener("scroll",()=>{log.push("scrolled");out();},{once:true});'+
  'document.modelContext={getTools:async()=>[{name:"add",description:"Adds two numbers",inputSchema:JSON.stringify({type:"object",properties:{a:{type:"number"},b:{type:"number"}}})}],'+
  'executeTool:async(tool,json)=>{const i=JSON.parse(json);return JSON.stringify({sum:i.a+i.b});}};'+
  '</script></body>';

test('isolated browser coordinate mouse, locator generation, WebMCP and session recording',{timeout:180_000},async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-browser-extras2-')),project=join(root,'project');mkdirSync(join(project,'out'),{recursive:true});
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);});
  site.listen(0,'127.0.0.1');await once(site,'listening');const origin='http://127.0.0.1:'+(site.address() as any).port;
  t.after(async()=>{await browser.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  browser.allow(origin);
  const effective=browser.resolvedConfig();
  assert.deepEqual(effective.allowed_origins,[origin]);
  assert.equal(effective.signed_in_profile_available,false);
  assert.ok(effective.supported_actions.includes('assert'));
  assert.ok(!JSON.stringify(effective).includes(project),'private paths are never returned by browser_get_config');
  const task=engine.create(project,'extras2','browser extras 2',['echo ok'],true);
  const run=(id:string,args:any)=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const refuse=async(id:string,args:any,pattern:RegExp)=>{await assert.rejects(run(id,args),pattern);noIntent(id);};
  const log=async(id:string)=>{const s=await run(id,{action:'evaluate',expression:'document.getElementById("log").textContent',revision:(await run(id+'-i',{action:'inspect'})).revision});return JSON.parse(s.result) as string;};

  await refuse('rec-bad',{action:'inspect',record_video:true},/record_video is only valid/);
  const recording=videoRecorderAvailable();
  if(!recording)await refuse('rec-missing',{action:'open',url:origin,record_video:true},/ffmpeg component/);
  let s=await run('open',{action:'open',url:origin,...(recording?{record_video:true}:{})});
  const found=await run('find-fruits',{action:'find',text:'fruits'});
  assert.ok(found.match_count>0);assert.match(found.snippets,/Fruits/);
  const foundRegex=await run('find-regex',{action:'find',regex:'/banana/i'});
  assert.ok(foundRegex.match_count>0);assert.match(foundRegex.snippets,/Banana/);
  assert.equal((await run('find-missing',{action:'find',text:'unfindable-value'})).match_count,0);
  await refuse('find-ambiguous',{action:'find',text:'fruit',regex:'banana'},/exactly one/);
  await refuse('find-unsafe',{action:'find',regex:'(a+)+$'},/unsafe/);
  await refuse('wait-empty',{action:'wait_for'},/requires time, text or text_gone/);
  const livePage=(browser as any).sessions.get(task.task_id).page;
  await livePage.evaluate(()=>setTimeout(()=>{const e=document.createElement('p');e.id='async-text';e.textContent='After delay';document.body.append(e);},150));
  const waited=await run('wait-visible',{action:'wait_for',text:'After delay'});
  assert.match(waited.text,/After delay/);assert.ok(waited.revision);
  await livePage.evaluate(()=>setTimeout(()=>document.getElementById('async-text')?.remove(),150));
  const gone=await run('wait-hidden',{action:'wait_for',text_gone:'After delay'});
  assert.equal(gone.text.includes('After delay'),false);assert.ok(gone.revision);
  s=gone;
  const list=s.controls.find((c:any)=>c.tag==='UL'&&c.label==='Fruits');
  assert.ok(list,'semantic list must be represented by a pinned snapshot ref');
  const listArgs={action:'assert',assertion:'list_visible',ref:list.ref,revision:s.revision};
  assert.equal((await run('list-good',{...listArgs,items:['Apple','Cherry']})).passed,true);
  assert.equal((await run('list-good',{...listArgs,items:['Apple','Cherry']})).passed,true,'read receipt replay');
  assert.equal((await run('list-order',{...listArgs,items:['Cherry','Apple']})).passed,false,'actual order is checked');
  assert.equal((await run('list-hidden-item',{...listArgs,items:['Invisible Kiwi']})).passed,false,'hidden content cannot satisfy visibility');
  const hiddenList=s.controls.find((c:any)=>c.tag==='OL'&&c.label==='Hidden list');
  assert.equal((await run('list-hidden',{...listArgs,ref:hiddenList.ref,items:['Apple']})).passed,false,'hidden list cannot pass');
  await refuse('list-invalid',{...listArgs,items:[]},/requires 1\.\.100/);
  await refuse('list-wrong-node',{...listArgs,ref:s.controls.find((c:any)=>c.tag==='BUTTON').ref,items:['Save']},/captured ul\/ol/);
  await refuse('resize-invalid',{action:'resize',width:0,height:600,revision:s.revision},/width/);
  const resized=await run('resize',{action:'resize',width:1000,height:700,revision:s.revision});
  assert.deepEqual(resized.viewport,{width:1000,height:700});
  assert.deepEqual(await run('resize',{action:'resize',width:1000,height:700,revision:s.revision}),resized);
  await refuse('resize-stale',{action:'resize',width:900,height:600,revision:s.revision},/Stale/);
  s=await run('size-inspect',{action:'inspect'});
  const size=await run('size-check',{action:'evaluate',expression:'({width:innerWidth,height:innerHeight})',revision:s.revision});
  assert.deepEqual(JSON.parse(size.result),{width:1000,height:700});
  s=await run('offline-inspect',{action:'inspect'});
  await run('offline',{action:'network_state_set',offline:true,revision:s.revision});
  s=await run('offline-check-inspect',{action:'inspect'});
  const offline=await run('offline-check',{action:'evaluate',expression:'navigator.onLine',revision:s.revision});
  assert.equal(JSON.parse(offline.result),false);
  s=await run('online-inspect',{action:'inspect'});
  await run('online',{action:'network_state_set',offline:false,revision:s.revision});
  s=await run('online-check-inspect',{action:'inspect'});
  const online=await run('online-check',{action:'evaluate',expression:'navigator.onLine',revision:s.revision});
  assert.equal(JSON.parse(online.result),true);
  s=await run('resized-inspect',{action:'inspect'});
  await run('state-seed',{action:'storage_set',kind:'local',storage_key:'restored',value:'yes',revision:s.revision});
  await run('state-export',{action:'storage_state',path:'out/state.json'});
  s=await run('state-inspect',{action:'inspect'});
  await run('state-clear',{action:'storage_clear',kind:'local',revision:s.revision});
  s=await run('state-import-inspect',{action:'inspect'});
  await run('state-import',{action:'set_storage_state',path:'out/state.json',revision:s.revision});
  s=await run('state-before-reload',{action:'inspect'});
  s=await run('state-reload',{action:'reload',revision:s.revision});
  const restored=await run('state-read',{action:'storage',kind:'local'});
  assert.ok(JSON.stringify(restored).includes('restored'));
  assert.ok(JSON.stringify(restored).includes('yes'));
  await refuse('state-overwrite',{action:'storage_state',path:'out/state.json'},/exists/);
  await refuse('outside',{action:'mouse_click',x:5000,y:10,revision:s.revision},/inside the page viewport/);
  await refuse('stale',{action:'mouse_click',x:150,y:150,revision:'old'},/Stale/);
  const clicked=await run('click',{action:'mouse_click',x:150,y:150,revision:s.revision});assert.equal(clicked.revision_invalidated,true);
  assert.match(await log('log-1'),/click@150,150/);
  s=await run('inspect-2',{action:'inspect'});
  await run('drag',{action:'mouse_drag',x:120,y:120,to_x:280,to_y:180,revision:s.revision});
  assert.match(await log('log-2'),/down@120,120.*up@280,180/);
  s=await run('inspect-3',{action:'inspect'});
  const curve=[{x:110,y:110},{x:160,y:125},{x:205,y:143},{x:250,y:170}];
  await refuse('stroke-bad-points',{action:'mouse_stroke',revision:s.revision,points:[{x:110,y:110},{x:5000,y:2}]},/inside the page viewport/);
  await refuse('stroke-too-far',{action:'mouse_stroke',revision:s.revision,points:[{x:110,y:110},{x:900,y:600}]},/250 CSS pixels apart/);
  await refuse('stroke-other-input',{action:'mouse_move',revision:s.revision,x:110,y:110,points:curve},/Gesture points require mouse_stroke/);
  const stroked=await run('stroke',{action:'mouse_stroke',points:curve,revision:s.revision});
  assert.equal(stroked.points,4);assert.equal(stroked.revision_invalidated,true);
  assert.deepEqual(await run('stroke',{action:'mouse_stroke',points:curve,revision:s.revision}),stroked,'gesture replays its receipt without another mouse stroke');
  assert.match(await log('stroke-log'),/down@110,110.*up@250,170/);
  s=await run('hold-inspect',{action:'inspect'});
  await refuse('hold-no-active',{action:'mouse_up',hold_id:'00000000-0000-4000-8000-000000000000'},/No matching active pointer hold/);
  const down=await run('hold-down',{action:'mouse_down',x:120,y:120,revision:s.revision});
  assert.match(down.hold_id,/^[0-9a-f-]{36}$/);assert.equal(down.button,'left');
  assert.equal((await run('hold-state',{action:'mouse_state'})).hold_id,down.hold_id,'inspect a pending hold without reissuing a gesture');
  assert.deepEqual(await run('hold-down',{action:'mouse_down',x:120,y:120,revision:s.revision}),down,'replaying mouse_down must not press twice');
  await refuse('hold-second',{action:'mouse_down',x:130,y:130,revision:s.revision},/pointer is held/i);
  await refuse('hold-wrong-action',{action:'mouse_click',x:150,y:150,revision:s.revision},/pointer is held/i);
  s=await run('hold-inspect-active',{action:'inspect'});
  await refuse('hold-wrong-id',{action:'mouse_move',x:150,y:130,hold_id:'00000000-0000-4000-8000-000000000000',revision:s.revision},/active hold_id/);
  await refuse('hold-path-outside',{action:'mouse_path',hold_id:down.hold_id,points:[{x:110,y:110},{x:9999,y:130}]},/inside the page viewport/);
  const traveled=await run('hold-path',{action:'mouse_path',hold_id:down.hold_id,points:[{x:125,y:125},{x:145,y:135},{x:165,y:140}]});
  assert.equal(traveled.points,3);assert.equal(traveled.hold_id,down.hold_id);
  assert.deepEqual(await run('hold-path',{action:'mouse_path',hold_id:down.hold_id,points:[{x:125,y:125},{x:145,y:135},{x:165,y:140}]}),traveled,'path must replay without another gesture');
  const heldMove=await run('hold-move',{action:'mouse_move',x:180,y:150,hold_id:down.hold_id});
  assert.equal(heldMove.hold_id,down.hold_id);
  const released=await run('hold-up',{action:'mouse_up',hold_id:down.hold_id});
  assert.equal(released.released,true);
  assert.deepEqual(await run('hold-up',{action:'mouse_up',hold_id:down.hold_id}),released,'release replays without a second mouseup');
  assert.equal((await run('hold-state-released',{action:'mouse_state'})).held,false);
  assert.match(await log('hold-log'),/down@120,120.*up@180,150/);
  s=await run('hold-cancel-inspect',{action:'inspect'});
  const cancelDown=await run('hold-cancel-down',{action:'mouse_down',x:140,y:140,revision:s.revision,button:'right'});
  await refuse('hold-cancel-mismatch',{action:'mouse_cancel',hold_id:cancelDown.hold_id,button:'left'},/must match/);
  assert.equal((await run('hold-cancel',{action:'mouse_cancel',hold_id:cancelDown.hold_id})).cancelled,true);
  await refuse('hold-released-token',{action:'mouse_up',hold_id:cancelDown.hold_id},/No matching active pointer hold/);
  s=await run('hold-frame-before',{action:'inspect'});
  await livePage.evaluate(async()=>{
    const frame=document.createElement('iframe');frame.id='unapproved';
    frame.src='http://127.0.0.1:9/unapproved';
    await new Promise<void>(resolve=>{frame.addEventListener('load',()=>resolve(),{once:true});document.body.append(frame);});
  });
  assert.ok(livePage.frames().some((frame:any)=>frame.url().includes('127.0.0.1:9')||frame.url().startsWith('chrome-error:')),
    JSON.stringify(livePage.frames().map((frame:any)=>frame.url())));
  await refuse('hold-unapproved-frame',{action:'mouse_down',x:130,y:130,revision:s.revision},/origin grant/);
  await livePage.evaluate(()=>document.getElementById('unapproved')?.remove());
  s=await run('stroke-inspect',{action:'inspect'});
  await run('wheel',{action:'mouse_wheel',x:200,y:300,delta_y:400,revision:s.revision});
  assert.match(await log('log-3'),/scrolled/);

  s=await run('inspect-4',{action:'inspect'});
  const save=s.controls.find((c:any)=>c.test_id==='save-btn');
  const located=await run('locator',{action:'locator',ref:save.ref,revision:s.revision});
  assert.ok(located.locators.includes('getByTestId("save-btn")'));assert.ok(located.locators.includes('getByRole("button", { name: "Save" })'));assert.equal(located.css_matches,1);

  await run('highlight-save',{action:'highlight',ref:save.ref,revision:s.revision});
  s=await run('highlight-inspect',{action:'inspect'});
  const freshSave=s.controls.find((c:any)=>c.test_id==='save-btn');
  await run('hide-save',{action:'hide_highlight',ref:freshSave.ref,revision:s.revision});
  const outline=await run('outline-check',{action:'evaluate',expression:'document.querySelector("button").style.outline',revision:s.revision});
  assert.equal(JSON.parse(outline.result),'');
  s=await run('caption-inspect',{action:'inspect'});
  await run('caption',{action:'annotate',text:'Chapter one',revision:s.revision});
  const caption=await run('caption-check',{action:'evaluate',expression:'document.body.parentElement.textContent.includes("Chapter one")',revision:s.revision});
  assert.equal(JSON.parse(caption.result),true);
  s=await run('caption-clear-inspect',{action:'inspect'});
  await run('caption-clear',{action:'clear_annotations',revision:s.revision});
  const listed=await run('webmcp-list',{action:'webmcp_list'});
  assert.equal(listed.webmcp_available,true);assert.equal(listed.tools[0].name,'add');assert.equal(listed.tools[0].input_schema.type,'object');
  await refuse('webmcp-bad-json',{action:'webmcp_call',tool_name:'add',input_json:'{oops'},/valid JSON/);
  const called=await run('webmcp-call',{action:'webmcp_call',tool_name:'add',input_json:JSON.stringify({a:2,b:3})});
  assert.deepEqual(JSON.parse(called.result),{sum:5});
  const missing=await run('webmcp-missing',{action:'webmcp_call',tool_name:'nope'});assert.equal(missing.called,false);assert.match(missing.error,/Unknown WebMCP tool/);

  if(recording){
    const closed=await run('close',{action:'close',path:'out/session.webm'});
    assert.equal(closed.video.path,'out/session.webm');assert.ok(closed.video.size>0);
    assert.deepEqual([...readFileSync(join(project,'out/session.webm')).subarray(0,4)],[0x1a,0x45,0xdf,0xa3]);
  }else{
    await refuse('close-unrecorded',{action:'close',path:'out/session.webm'},/record_video first/);
    await run('close',{action:'close'});
    t.diagnostic('Playwright ffmpeg not installed: recording refused before intent; video save not exercised');
  }
  await run('open-plain',{action:'open',url:origin});
  await refuse('close-no-rec',{action:'close',path:'out/other.webm'},/record_video first/);
  await run('close-plain',{action:'close'});
});
