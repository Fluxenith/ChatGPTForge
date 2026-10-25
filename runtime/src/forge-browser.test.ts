import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,parse} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomInt} from 'node:crypto';

async function listen(server:ReturnType<typeof createServer>){for(let i=0;i<50;i++){server.listen(randomInt(49152,65535),'127.0.0.1');try{await once(server,'listening');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;}}throw Error('No free fixture port');}

import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';
import {projectDirectory} from './project-access.js';
import {setTimeout as delay} from 'node:timers/promises';
import type {ServerResponse} from 'node:http';

const dragHtml=`<style>[data-testid]{display:block;width:140px;height:70px;background:#eee;margin:20px} #destination{margin-left:340px} #pointer-destination{margin-left:340px}</style>
<body><div id="source" data-testid="source" draggable="true" aria-label="Card">Card 42</div>
<div id="destination" data-testid="destination" aria-label="Drop zone">Drop zone</div>
<div id="pointer-source" data-testid="pointer-source" role="slider" aria-label="Pointer source">Move handle</div>
<div id="pointer-destination" data-testid="pointer-destination" aria-label="Pointer zone">Pointer zone</div>
<output id="result">Drops: 0</output><script>
let drops=0,active=false;window.buttons=0;
const source=document.getElementById('source'),destination=document.getElementById('destination'),pointerSource=document.getElementById('pointer-source'),pointerDestination=document.getElementById('pointer-destination');
const record=(kind,trusted,value)=>{document.getElementById('result').textContent='Drops: '+(++drops);fetch('/drop?kind='+kind+'&trusted='+trusted+'&value='+value);};
source.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','card-42'));
destination.addEventListener('dragover',e=>e.preventDefault());
destination.addEventListener('drop',e=>{e.preventDefault();destination.append(source);record('html',e.isTrusted,e.dataTransfer.getData('text/plain'));});
pointerSource.addEventListener('pointerdown',e=>{active=true;window.downTrusted=e.isTrusted;});
document.addEventListener('pointermove',e=>{window.buttons=e.buttons;});
document.addEventListener('pointerup',e=>{if(!active)return;active=false;const r=pointerDestination.getBoundingClientRect();if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)record('pointer',window.downTrusted&&e.isTrusted,'handle');});
document.addEventListener('keydown',e=>{if(e.key==='Escape')active=false;});
</script></body>`;
async function dragFixture(t:any){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-drag-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]),drops:URLSearchParams[]=[];
  const server=createServer((req,res)=>{if(req.url?.startsWith('/drop?')){drops.push(new URL(req.url,'http://fixture').searchParams);res.end('recorded');return;}res.setHeader('Content-Type','text/html');res.end(dragHtml);});
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;browser.allow(origin);
  const task=engine.create(project,'drag','drag owned controls',['echo verified'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url:origin});
  const ref=(snapshot:any,label:string)=>{const control=snapshot.controls.find((c:any)=>c.label===label);assert.ok(control,label);return control.ref;};
  return {engine,browser,task,run,opened,ref,drops,page:(browser as any).sessions.get(task.task_id).page};
}

test('native HTML5 and custom pointer drags produce trusted drops and exact replay never drops twice',async t=>{
  const f=await dragFixture(t);
  assert.equal(f.opened.controls.find((c:any)=>c.label==='Card').draggable,true);
  assert.equal(f.opened.controls.find((c:any)=>c.label==='Card').test_id,'source');
  const input={action:'drag',revision:f.opened.revision,ref:f.ref(f.opened,'Card'),target_ref:f.ref(f.opened,'Drop zone')};
  const dragged=await f.run('html-drag',input);assert.match(dragged.text,/Drops: 1/);
  for(let i=0;!f.drops.length&&i<20;i++)await delay(50);
  assert.equal(f.drops.length,1);assert.equal(f.drops[0].get('trusted'),'true');assert.equal(f.drops[0].get('value'),'card-42');
  assert.deepEqual(await f.run('html-drag',input),dragged);await delay(50);assert.equal(f.drops.length,1);
  await assert.rejects(f.run('stale-drag',input),/Stale/);
  const pointer=await f.run('pointer-drag',{action:'drag',revision:dragged.revision,ref:f.ref(dragged,'Pointer source'),target_ref:f.ref(dragged,'Pointer zone')});
  assert.match(pointer.text,/Drops: 2/);
  for(let i=0;f.drops.length<2&&i<20;i++)await delay(50);
  assert.equal(f.drops.length,2);assert.equal(f.drops[1].get('kind'),'pointer');assert.equal(f.drops[1].get('trusted'),'true');
  await assert.rejects(f.run('html-drag',{...input,target_ref:f.ref(dragged,'Pointer zone')}),/different arguments/);
  await f.run('other-tab',{action:'new_tab',url:f.opened.url});
  await assert.rejects(f.run('cross-tab-drag',{action:'drag',revision:pointer.revision,ref:f.ref(pointer,'Card'),target_ref:f.ref(pointer,'Drop zone')}),/Stale/);
});

test('an unlabeled empty drop zone can be discovered by its test ID and receive a native drop',async t=>{
  const f=await dragFixture(t);
  await f.page.evaluate(()=>{const target=document.getElementById('destination')!;target.removeAttribute('aria-label');target.textContent='';});
  const snapshot=await f.run('inspect-empty',{action:'inspect'}),target=snapshot.controls.find((c:any)=>c.test_id==='destination');
  assert.ok(target);assert.equal(target.label,'');assert.equal(target.text,'');
  const result=await f.run('empty-target-drag',{action:'drag',revision:snapshot.revision,ref:f.ref(snapshot,'Card'),target_ref:target.ref});
  assert.match(result.text,/Drops: 1/);
  for(let i=0;!f.drops.length&&i<20;i++)await delay(50);
  assert.equal(f.drops.length,1);assert.equal(f.drops[0].get('trusted'),'true');assert.equal(f.drops[0].get('value'),'card-42');
});

test('drag rejects invalid targets and secret inputs before recording an intent',async t=>{
  const f=await dragFixture(t),ref=f.ref(f.opened,'Card');
  for(const [id,target_ref] of [['missing',undefined],['unknown','99999'],['same',ref]]){
    await assert.rejects(f.run(id!,{action:'drag',ref,target_ref,revision:f.opened.revision}),/distinct target_ref/);
    assert.equal(f.engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(f.task.task_id,id),undefined);
  }
  await f.page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<input type="PASSWORD" aria-label="Secret"><input type="file" aria-label="Upload">');});
  const current=await f.run('inspect',{action:'inspect'});
  for(const label of ['Secret','Upload'])for(const side of ['source','target']){
    const id=label+'-'+side;
    await assert.rejects(f.run(id,{action:'drag',revision:current.revision,ref:f.ref(current,side==='source'?label:'Card'),target_ref:f.ref(current,side==='target'?label:'Drop zone')}),/manual handling/);
    assert.equal(f.engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(f.task.task_id,id),undefined);
  }
  assert.equal(f.drops.length,0);
});

test('same-looking replaced drag sources or targets cannot inherit captured handles',async t=>{
  for(const id of ['source','destination'])await t.test(id,async sub=>{
    const f=await dragFixture(sub),input={action:'drag',revision:f.opened.revision,ref:f.ref(f.opened,'Card'),target_ref:f.ref(f.opened,'Drop zone')};
    await f.page.evaluate((id:string)=>{const node=document.getElementById(id)!;node.replaceWith(node.cloneNode(true));},id);
    await assert.rejects(f.run('changed-drag',input),/Page changed/);
    assert.equal(f.drops.length,0);assert.equal((await f.run('changed-drag',input)).state,'unknown');
    await assert.rejects(f.run('new-id',input),/Unknown browser\/desktop/);
  });
});

test('drag cancels a replaced destination during dragenter, releases the pointer and retains unknown receipt',async t=>{
  const f=await dragFixture(t);
  await f.page.evaluate(()=>{
    const destination=document.getElementById('destination')!;
    destination.addEventListener('dragenter',()=>{
      const replacement=destination.cloneNode(true);destination.replaceWith(replacement);
      replacement.addEventListener('dragover',e=>e.preventDefault());
      replacement.addEventListener('drop',()=>fetch('/drop?kind=wrong-replacement&trusted=true&value=bad'));
    },{once:true});
  });
  const input={action:'drag',revision:f.opened.revision,ref:f.ref(f.opened,'Card'),target_ref:f.ref(f.opened,'Drop zone')};
  await assert.rejects(f.run('interrupted-drag',input),/changed|not attached|detached/);
  await delay(100);assert.equal(f.drops.length,0);
  await f.page.mouse.move(10,10);assert.equal(await f.page.evaluate(()=>(window as any).buttons),0);
  assert.equal((await f.run('interrupted-drag',input)).state,'unknown');assert.equal(f.drops.length,0);
  assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/Unknown browser\/desktop/);
  const observed=await f.run('after-unknown',{action:'inspect'});assert.match(observed.text,/Drops: 0/);
  await f.run('close',{action:'close'});
  const receipt=f.engine.db.prepare('SELECT state FROM browser_operations WHERE task_id=? AND id=?').get(f.task.task_id,'interrupted-drag') as {state:string};assert.equal(receipt.state,'unknown');
});

test('pre-cancelled drags do not dispatch and cancellation after mouse-down closes the owned session',async t=>{
  const f=await dragFixture(t),input={action:'drag',revision:f.opened.revision,ref:f.ref(f.opened,'Card'),target_ref:f.ref(f.opened,'Drop zone')};
  const before=new AbortController();before.abort();
  await assert.rejects(f.browser.run(f.task.task_id,'pre-cancelled',f.task.lease_token!,input,before.signal),/cancelled/);
  assert.equal(f.engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(f.task.task_id,'pre-cancelled'),undefined);
  const during=new AbortController(),down=f.page.mouse.down.bind(f.page.mouse);
  f.page.mouse.down=async(...args:any[])=>{await down(...args);during.abort();};
  await assert.rejects(f.browser.run(f.task.task_id,'during-drag',f.task.lease_token!,input,during.signal),/cancelled/);
  assert.equal(f.drops.length,0);assert.equal(f.page.isClosed(),true);
  assert.equal((f.browser as any).sessions.has(f.task.task_id),false);
  assert.equal((await f.run('during-drag',input)).state,'unknown');
  await f.run('close',{action:'close'});
  const receipt=f.engine.db.prepare('SELECT state FROM browser_operations WHERE task_id=? AND id=?').get(f.task.task_id,'during-drag') as {state:string};assert.equal(receipt.state,'unknown');
});

test('project grants reject whole-machine scopes and files',()=>{
  assert.throws(()=>projectDirectory(homedir()),/單一專案/);
  assert.throws(()=>projectDirectory(parse(process.cwd()).root),/單一專案/);
  assert.throws(()=>projectDirectory(new URL(import.meta.url).pathname));
});

test('browser history traverses documents and SPA entries, reloads once and fences stale refs',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-history-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const hits=new Map<string,number>();
  const server=createServer((req,res)=>{
    const path=req.url!;hits.set(path,(hits.get(path)??0)+1);
    res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
    res.end(`<body><h1>${path}</h1><input aria-label="Editor"><button onclick="history.pushState({},'', '/spa');document.querySelector('h1').textContent='SPA'">SPA</button></body>`);
  });
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;browser.allow(origin);
  const task=engine.create(project,'history','history',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const first=await run('open-a',{action:'open',url:origin+'/a'});
  await assert.rejects(run('no-forward',{action:'forward',revision:first.revision}),/No forward history/);
  await assert.rejects(run('blank-back',{action:'back',revision:first.revision}),/No back history|origin is not authorized/);
  for(const id of ['no-forward','blank-back'])assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const second=await run('open-b',{action:'open',url:origin+'/b'});
  const back=await run('back',{action:'back',revision:second.revision});assert.equal(back.url,origin+'/a');assert.match(back.text,/\/a/);
  assert.deepEqual(await run('back',{action:'back',revision:second.revision}),back);
  await assert.rejects(run('old-fill',{action:'fill',revision:second.revision,ref:'1',text:'stale'}),/Stale/);
  const forward=await run('forward',{action:'forward',revision:back.revision});assert.equal(forward.url,origin+'/b');
  const beforeReload=hits.get('/b')!;
  const reloadInput={action:'reload',revision:forward.revision};
  const reloaded=await run('reload',reloadInput);assert.equal(hits.get('/b'),beforeReload+1);
  assert.deepEqual(await run('reload',reloadInput),reloaded);assert.equal(hits.get('/b'),beforeReload+1,'replay must not reload again');
  const spa=await run('spa',{action:'click',ref:'2',revision:reloaded.revision});assert.equal(spa.url,origin+'/spa');
  const fromSpa=await run('spa-back',{action:'back',revision:spa.revision});assert.equal(fromSpa.url,origin+'/b');
  const toSpa=await run('spa-forward',{action:'forward',revision:fromSpa.revision});assert.equal(toSpa.url,origin+'/spa');
  const other=await run('other-tab',{action:'new_tab',url:origin+'/other'});
  await assert.rejects(run('cross-tab-back',{action:'back',revision:toSpa.revision}),/Stale/);
  const returnTab=await run('return',{action:'switch_tab',tab_id:first.tabs[0].tab_id});
  assert.equal(returnTab.url,origin+'/spa');assert.equal(other.tabs.length,2);
  const final=await run('back-on-returned-tab',{action:'back',revision:returnTab.revision});assert.equal(final.url,origin+'/b');
});

test('browser refuses revoked history destinations and rechecks a lease after asynchronous history inspection',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-history-authority-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const servers=[createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<body>First</body>');}),createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<body>Second</body>');})];
  for(const server of servers){await listen(server);}
  t.after(async()=>{await browser.close();for(const server of servers){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}engine.close();assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const origins=servers.map(server=>{const address=server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;});origins.forEach(origin=>browser.allow(origin));
  const task=engine.create(project,'history-authority','history authority',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  await run('first',{action:'open',url:origins[0]});const second=await run('second',{action:'open',url:origins[1]});
  browser.origins.delete(origins[0]);
  await assert.rejects(run('revoked-back',{action:'back',revision:second.revision}),/origin is not authorized/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'revoked-back'),undefined);
  const observed=await run('inspect-after-rejection',{action:'inspect'});assert.equal(observed.url,origins[1]+'/');
  browser.allow(origins[0]);
  const bridge=browser as any,original=bridge.historyEntry.bind(browser);
  bridge.historyEntry=async(...args:any[])=>{const entry=await original(...args);engine.prepareHandoff(task.task_id,'during-history',task.fingerprint,'next owner',task.lease_token!);return entry;};
  await assert.rejects(run('handoff-back',{action:'back',revision:observed.revision}),/handoff|lease/i);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'handoff-back'),undefined);
  assert.equal(bridge.sessions.get(task.task_id).page.url(),origins[1]+'/');
});

test('a failed browser reload leaves an unknown receipt and retry cannot resend the request',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-history-unknown-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);let fail=false,hits=0;
  const server=createServer((_req,res)=>{hits++;if(fail){res.destroy();return;}res.setHeader('Content-Type','text/html');res.end('<body><input aria-label="Editor"></body>');});
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;browser.allow(origin);
  const task=engine.create(project,'history-unknown','unknown reload',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url:origin});fail=true;
  const input={action:'reload',revision:opened.revision};
  await assert.rejects(run('reload-failed',input),/ERR_EMPTY_RESPONSE|net::|Navigation|Timeout/);
  const afterFailure=hits;
  assert.equal((await run('reload-failed',input)).state,'unknown');assert.equal(hits,afterFailure);
  await assert.rejects(run('reload-new-id',input),/Unknown browser\/desktop/);
  assert.throws(()=>engine.complete(task.task_id,task.lease_token!),/Unknown browser\/desktop/);
  assert.equal((browser as any).sessions.get(task.task_id).revision,'');
  await run('close',{action:'close'});
  const receipt=engine.db.prepare('SELECT state FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'reload-failed') as {state:string};
  assert.equal(receipt.state,'unknown');
});

test('browser owns multiple tabs, preserves rich text, exposes dropdown options and fences cross-tab refs',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-tabs-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<body><div contenteditable="true" aria-label="Editor"></div><select><option value="first">First</option><option value="second">Second</option></select></body>');});
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}`;browser.allow(url);
  const task=engine.create(project,'tabs','tabs',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const first=await run('open',{action:'open',url});const firstId=first.tabs[0].tab_id;
  assert.equal(first.controls[0].editable,true);assert.equal(first.controls[1].options[1].value,'second');
  const filled=await run('fill',{action:'fill',revision:first.revision,ref:'1',text:'Saved editor text'});
  assert.match(filled.text,/Saved editor text/);
  const second=await run('second',{action:'new_tab',url});assert.equal(second.tabs.length,2);
  assert.deepEqual(await run('second',{action:'new_tab',url}),second);
  await assert.rejects(run('old',{action:'fill',revision:filled.revision,ref:'1',text:'wrong tab'}),/Stale/);
  const returned=await run('return',{action:'switch_tab',tab_id:firstId});assert.match(returned.text,/Saved editor text/);
  const secondId=second.tabs.find((tab:any)=>tab.active).tab_id;
  const closed=await run('close-second',{action:'close_tab',tab_id:secondId});assert.equal(closed.tabs.length,1);
  await assert.rejects(run('last',{action:'close_tab',tab_id:firstId}),/final tab/);
  assert.equal(engine.db.prepare('SELECT * FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'last'),undefined);
});

test('same-looking replacement controls cannot inherit a stale action reference',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-element-identity-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);let stream:ServerResponse|undefined,hits=0;
  const server=createServer((req,res)=>{
    if(req.url==='/events'){stream=res;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': ready\n\n');return;}
    if(req.url==='/hit'){hits++;res.end('ok');return;}
    res.setHeader('Content-Type','text/html');res.end('<body><button onclick="fetch(\'/hit\')">Same</button><script>new EventSource("/events").onmessage=()=>{document.querySelector("button").outerHTML="<button onclick=\\"fetch(\'/hit\')\\">Same</button>"}</script></body>');
  });
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}`;browser.allow(url);
  const task=engine.create(project,'identity','identity',['echo ok'],true);
  const opened=await browser.run(task.task_id,'open',task.lease_token!,{action:'open',url}) as any;
  for(let i=0;i<30&&!stream;i++)await delay(100);assert.ok(stream);
  stream.write('data: replace\n\n');await delay(300);
  await assert.rejects(browser.run(task.task_id,'click',task.lease_token!,{action:'click',ref:'1',revision:opened.revision}),/Page changed/);
  assert.equal(hits,0);
});

test('explicit tabs remain open while unsolicited noopener popups are closed',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-popups-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/popup'?'<body>popup</body>':'<body><button onclick="window.open(\'/popup\',\'_blank\',\'noopener\')">Popup</button></body>');});
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}`;browser.allow(url);
  const task=engine.create(project,'popup','popup',['echo ok'],true);
  const first=await browser.run(task.task_id,'open',task.lease_token!,{action:'open',url}) as any;
  await browser.run(task.task_id,'popup',task.lease_token!,{action:'click',ref:'1',revision:first.revision});
  await delay(200);
  const session=(browser as any).sessions.get(task.task_id);
  assert.equal(session.context.pages().length,1,'unowned noopener popup must close');
  const second=await browser.run(task.task_id,'new-tab',task.lease_token!,{action:'new_tab',url}) as any;
  await delay(200);assert.equal(session.context.pages().length,2);assert.equal(second.tabs.length,2);
});

test('browser accepts only local grants, deduplicates click and rejects stale references',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-browser-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<body><button onclick="document.querySelector(\'p\').textContent=String(++window.count)">Increment</button><p>0</p><input placeholder="Name"><script>window.count=0;console.error("fixture-error")</script></body>');});
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  const task=engine.create(project,'browser','browser test',['echo ok'],true);
  const run=(id:string,args:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  await assert.rejects(run('denied',{action:'open',url}),/授權/);
  browser.allow(url);
  const opened=await run('open',{action:'open',url});assert.ok(opened.errors.includes('fixture-error'));
  const args={action:'click',ref:'1',revision:opened.revision};
  const clicked=await run('click',args);assert.match(clicked.text,/1/);
  assert.deepEqual(await run('click',args),clicked);
  await assert.rejects(run('stale',args),/Stale/);
  await assert.rejects(run('stale',args),/Stale/);
  const state=await run('inspect',{action:'inspect'});assert.match(state.text,/1/);
  const image=await run('screen',{action:'screenshot'});assert.ok(image.image.length>100);
  await assert.rejects(run('blocked',{action:'open',url:'https://example.com/'}),/授權/);
});

test('failed navigation can be closed without erasing unknown receipts, including after session loss',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-browser-recovery-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((_req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:1/blocked'});res.end();});
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  const task=engine.create(project,'recovery','failed navigation',['echo ok'],true);
  browser.allow(url);
  await assert.rejects(browser.run(task.task_id,'navigate',task.lease_token!,{action:'open',url}));
  assert.deepEqual(await browser.run(task.task_id,'cleanup',task.lease_token!,{action:'close'}),{state:'closed'});
  assert.deepEqual(await browser.run(task.task_id,'cleanup-again',task.lease_token!,{action:'close'}),{state:'closed'});
  assert.equal((await browser.run(task.task_id,'navigate',task.lease_token!,{action:'open',url})).state,'unknown');
  assert.throws(()=>engine.assertIdle(engine.task(task.task_id)),/Unknown browser/);
});

test('browser select, keyboard input and scrolling use fresh page snapshots and single-execution receipts',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-browser-controls-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((_req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end('<body><select onchange="document.querySelector(\'#selected\').textContent=this.value"><option value="a">A</option><option value="b">B</option></select><input onkeydown="document.querySelector(\'#pressed\').textContent=event.key"><p id="selected">a</p><p id="pressed"></p><div style="height:2500px">Long page</div></body>');
  });
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  browser.allow(url);
  const task=engine.create(project,'browser-controls','test additional browser actions',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url});
  const select={action:'select',revision:opened.revision,ref:'1',value:'b'};
  const selected=await run('select',select);
  assert.match(selected.text,/b/);
  assert.deepEqual(await run('select',select),selected);
  await assert.rejects(run('stale',select),/Stale/);
  const pressed=await run('press',{action:'press',revision:selected.revision,ref:'2',key:'ArrowDown'});
  assert.match(pressed.text,/ArrowDown/);
  await assert.rejects(run('press-stale',{action:'press',revision:selected.revision,ref:'2',key:'Enter'}),/Stale/);
  const scrolled=await run('scroll',{action:'scroll',delta_y:750});
  assert.equal(scrolled.state,'completed');
  assert.deepEqual(await run('scroll',{action:'scroll',delta_y:750}),scrolled);
  await assert.rejects(run('bad-scroll',{action:'scroll',delta_y:3000}),/Scroll delta/);
  await assert.rejects(run('bad-key',{action:'press',revision:scrolled.revision,ref:'2',key:'Control+A'}),/Unsupported browser key/);
});

test('browser checkbox state is idempotent and hover uses authorized fresh references',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-browser-check-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((_req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end('<body><input type="checkbox" aria-label="Approve" onchange="document.querySelector(\'#counter\').textContent=String(++window.changes)"><button onmouseenter="document.querySelector(\'#menu\').textContent=\'Visible\'">Menu</button><p id="counter">0</p><p id="menu">Hidden</p><script>window.changes=0</script></body>');
  });
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  browser.allow(url);
  const task=engine.create(project,'browser-check','checkbox and hover actions',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url});assert.equal(opened.controls[0].checked,false);
  const args={action:'check',revision:opened.revision,ref:'1',checked:true};
  const checked=await run('check',args);
  assert.equal(checked.controls[0].checked,true);assert.match(checked.text,/1/);
  assert.deepEqual(await run('check',args),checked);
  const repeated=await run('check-again',{...args,revision:checked.revision});
  assert.equal(repeated.controls[0].checked,true);assert.match(repeated.text,/1/);
  const unchecked=await run('uncheck',{...args,revision:repeated.revision,checked:false});
  assert.equal(unchecked.controls[0].checked,false);assert.match(unchecked.text,/2/);
  await assert.rejects(run('wrong-target',{...args,revision:unchecked.revision,ref:'2'}),/checkbox input/);
  await assert.rejects(run('wrong-boolean',{action:'check',revision:unchecked.revision,ref:'1'}),/boolean checked/);
  const hovered=await run('hover',{action:'hover',revision:unchecked.revision,ref:'2'});
  assert.match(hovered.text,/Visible/);
  await assert.rejects(run('old-ref',{action:'hover',revision:unchecked.revision,ref:'2'}),/Stale/);
});

test('browser rejects mixed-case secret input types and invalid targets before creating receipts',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-browser-secret-types-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((_req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end('<body><input type="PASSWORD"><input type="FILE"><input placeholder="Safe"><button onclick="document.querySelector(\'#counter\').textContent=\'1\'">Increment</button><p id="counter">0</p></body>');
  });
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  browser.allow(url);
  const task=engine.create(project,'browser-secret-types','reject sensitive inputs',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url});
  assert.equal(opened.controls[0].type,'password');assert.equal(opened.controls[1].type,'file');
  const bad=[
    {id:'password-fill',action:'fill',ref:'1',text:'reject'},
    {id:'file-fill',action:'fill',ref:'2',text:'reject'},
    {id:'password-press',action:'press',ref:'1',key:'Tab'},
    {id:'file-press',action:'press',ref:'2',key:'Tab'},
    {id:'button-fill',action:'fill',ref:'4',text:'reject'},
    {id:'button-press',action:'press',ref:'4',key:'Tab'},
  ];
  for(const item of bad){
    const {id,...input}=item;
    await assert.rejects(run(id,{...input,revision:opened.revision}),/non-secret form control/);
    assert.equal(engine.db.prepare('SELECT state FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  }
  await assert.rejects(run('wrong-select',{action:'select',revision:opened.revision,ref:'4',value:'no'}),/accessible dropdown/);
  await assert.rejects(run('unsupported',{action:'invalid'}),/Unsupported browser action/);
  for(const id of ['wrong-select','unsupported'])
    assert.equal(engine.db.prepare('SELECT state FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const filled=await run('safe-fill',{action:'fill',ref:'3',revision:opened.revision,text:'allowed'});
  assert.equal(filled.state,'completed');
  const clicked=await run('safe-click',{action:'click',ref:'4',revision:filled.revision});
  assert.match(clicked.text,/1/);
});

test('browser diagnostics preserve DOM references, redact network secrets and isolate tabs',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-browser-diagnostics-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const server=createServer((req,res)=>{
    if(req.url?.startsWith('/api?')){res.writeHead(418,{'Content-Type':'application/json'});res.end('{"hidden":"response-body-secret"}');return;}
    if(req.url==='/public-data'){
      const data='{"answer":42,"label":"public-match-value","access_token":"private-api-token"}';
      res.writeHead(200,{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data))});res.end(data);return;
    }
    if(req.url==='/public-copy'){
      const data='{"answer":42,"label":"different-value","access_token":"different-private-token"}';
      res.writeHead(200,{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(data))});res.end(data);return;
    }
    res.setHeader('Content-Type','text/html');
    if(req.url==='/burst'){res.end('<body><script>for(let i=0;i<75;i++)console.log("burst-"+i)</script></body>');return;}
    if(req.url==='/second'){res.end('<body><script>console.log("tab-two-only")</script>Second page</body>');return;}
    res.end('<body><input placeholder="Safe editor"><script>console.log("first-tab-ready");console.warn("first-tab-warning");fetch("/api?access_token=query-secret",{method:"POST",headers:{"Authorization":"Bearer header-secret"},body:"post-body-secret"}).catch(()=>{});fetch("/public-data").then(()=>fetch("/public-copy")).catch(()=>{});fetch("http://127.0.0.1:1/blocked?access_token=blocked-secret").catch(()=>{});</script></body>');
  });
  await listen(server);
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url='http://127.0.0.1:'+address.port;browser.allow(url);
  const task=engine.create(project,'diagnostics','readonly browser diagnostics',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url});
  const firstId=opened.tabs[0].tab_id;
  const log=await run('console',{action:'console'});
  assert.ok(log.entries.some((entry:any)=>entry.type==='log'&&entry.text==='first-tab-ready'));
  assert.ok(log.entries.some((entry:any)=>entry.type==='warning'&&entry.text==='first-tab-warning'));
  let net:any;
  for(let i=0;i<20;i++){
    net=await run('network-'+i,{action:'network'});
    if(net.entries.some((entry:any)=>entry.status===418)&&net.entries.some((entry:any)=>entry.url==='[blocked-origin]')&&net.entries.some((entry:any)=>entry.url===url+'/public-data'&&entry.state==='completed')&&net.entries.some((entry:any)=>entry.url===url+'/public-copy'&&entry.state==='completed'))break;
    await delay(50);
  }
  assert.ok(net.entries.some((entry:any)=>entry.method==='POST'&&entry.url===url+'/api'&&entry.status===418));
  assert.ok(net.entries.some((entry:any)=>entry.url==='[blocked-origin]'&&entry.state==='failed'));
  assert.doesNotMatch(JSON.stringify(net),/query-secret|blocked-secret|header-secret|post-body-secret|response-body-secret/);
  assert.ok(net.entries.every((entry:any)=>!('started_ms' in entry)&&!('headers' in entry)&&!('body' in entry)));
  const apiRequest=net.entries.find((entry:any)=>entry.status===418);
  assert.ok(Number.isInteger(apiRequest.index));
  const apiDetail=await run('request-detail',{action:'network_request',index:apiRequest.index});
  assert.equal(apiDetail.url,url+'/api');assert.equal(apiDetail.status,418);
  assert.equal(apiDetail.request_headers.authorization,'[redacted]');
  assert.doesNotMatch(JSON.stringify(apiDetail),/query-secret|header-secret|post-body-secret|response-body-secret/);
  const apiBody=await run('request-body',{action:'network_request',index:apiRequest.index,part:'request-body'});
  assert.doesNotMatch(JSON.stringify(apiBody),/post-body-secret/);
  const responseBody=await run('response-body',{action:'network_request',index:apiRequest.index,part:'response-body'});
  assert.doesNotMatch(JSON.stringify(responseBody),/response-body-secret/);
  const publicIndex=net.entries.find((entry:any)=>entry.url===url+'/public-data').index;
  const publicBody=await run('safe-response-body',{action:'network_request',index:publicIndex,part:'response-body'});
  assert.equal(publicBody.body.redacted,true);
  assert.deepEqual(JSON.parse(publicBody.body.text),{answer:42,label:'public-match-value',access_token:'[redacted]'});
  const contract={action:'network_assert',index:publicIndex,expected_status:200,expected_method:'GET',expected_path:'/public-data',max_duration_ms:60000,
    json_checks:[{pointer:'/answer',equals:42},{pointer:'/label',equals:'public-match-value'},{pointer:'/access_token',type:'string'}]} as const;
  const verdict=await run('verified-response',{...contract,json_checks:[...contract.json_checks]});
  assert.equal(verdict.passed,true);
  assert.equal(verdict.state,'completed');
  assert.equal(verdict.network_state,'completed');
  assert.ok(verdict.checks.every((check:any)=>check.passed));
  assert.doesNotMatch(JSON.stringify(verdict),/private-api-token|public-match-value|query-secret|header-secret/);
  const persisted=engine.db.prepare('SELECT request FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'verified-response') as {request:string};
  assert.doesNotMatch(persisted.request,/private-api-token|public-match-value/,'only an expected-value digest belongs in the durable receipt');
  assert.match(persisted.request,/equals_digest/);
  assert.deepEqual(await run('verified-response',{...contract,json_checks:[...contract.json_checks]}),verdict,'replay matches the same assertion');
  const copyIndex=net.entries.find((entry:any)=>entry.url===url+'/public-copy').index;
  const filtered=await run('list-public',{action:'network_list',list:{path_prefix:'/public-',method:'GET',status_min:200,status_max:299}});
  assert.deepEqual(filtered.entries.map((entry:any)=>entry.index),[publicIndex,copyIndex],'filtered indexes retain original identities');
  assert.ok(filtered.excluded_unapproved>=1);
  assert.ok(filtered.hidden_static>=1);
  assert.doesNotMatch(JSON.stringify(filtered),/query-secret|blocked-secret|private-api-token/);
  const filteredStored=engine.db.prepare('SELECT request FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'list-public') as {request:string};
  assert.match(filteredStored.request,/path_prefix_digest/);
  assert.doesNotMatch(filteredStored.request,/public-/);
  const firstPage=await run('list-public-page-one',{action:'network_list',list:{path_prefix:'/public-',limit:1}});
  assert.equal(firstPage.has_more,true);
  assert.equal(firstPage.entries[0].index,publicIndex);
  const nextPage=await run('list-public-page-two',{action:'network_list',list:{path_prefix:'/public-',after_index:firstPage.next_after_index,limit:1}});
  assert.deepEqual(nextPage.entries.map((entry:any)=>entry.index),[copyIndex]);
  await assert.rejects(run('invalid-list-filter',{action:'network_list',list:{path_prefix:'/public?access_token=secret'}}),/Invalid network list filter/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'invalid-list-filter'),undefined);
  const flow={action:'network_flow_assert',flow:{
    steps:[
      {index:publicIndex,expected_status:200,expected_path:'/public-data',json_checks:[{pointer:'/label',equals:'public-match-value'}]},
      {index:copyIndex,expected_status:200,expected_path:'/public-copy',json_checks:[{pointer:'/answer',equals:42}]},
    ],links:[{from_index:publicIndex,from_pointer:'/answer',to_index:copyIndex,to_pointer:'/answer'}],
    max_start_gap_ms:60000,max_start_span_ms:60000,
  }};
  const flowResult=await run('flow-verified',{...flow,flow:{...flow.flow,steps:[...flow.flow.steps],links:[...flow.flow.links]}});
  assert.equal(flowResult.passed,true,JSON.stringify(flowResult));
  assert.equal(flowResult.steps.length,2);assert.equal(flowResult.links[0].passed,true);
  assert.doesNotMatch(JSON.stringify(flowResult),/private-api-token|different-private-token|public-match-value/);
  const flowStored=engine.db.prepare('SELECT request FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'flow-verified') as {request:string};
  assert.match(flowStored.request,/equals_digest/);
  assert.doesNotMatch(flowStored.request,/public-match-value/);
  assert.deepEqual(await run('flow-verified',{...flow,flow:{...flow.flow,steps:[...flow.flow.steps],links:[...flow.flow.links]}}),flowResult);
  const apiAudit={action:'network_audit',audit:{path_prefix:'/public-',min_completed:2,max_failed:0,max_http_errors:0,max_p95_ms:60000,max_duration_ms:60000}};
  const audit=await run('audit-public',{...apiAudit,audit:{...apiAudit.audit}});
  assert.equal(audit.passed,true,JSON.stringify(audit));
  assert.equal(audit.matched,2);
  assert.equal(audit.completed,2);
  assert.equal(audit.latency_ms.samples,2);
  assert.ok(audit.excluded_unapproved>=1,'off-origin requests remain outside the authorized cohort');
  assert.doesNotMatch(JSON.stringify(audit),/private-api-token|different-private-token|query-secret|blocked-secret/);
  const auditStored=engine.db.prepare('SELECT request FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'audit-public') as {request:string};
  assert.match(auditStored.request,/path_prefix_digest/);
  assert.doesNotMatch(auditStored.request,/public-/);
  assert.deepEqual(await run('audit-public',{...apiAudit,audit:{...apiAudit.audit}}),audit);
  const failingAudit=await run('audit-http-errors',{action:'network_audit',audit:{path_prefix:'/api',min_completed:1,max_http_errors:0}});
  assert.equal(failingAudit.passed,false);
  assert.equal(failingAudit.http_errors,1);
  assert.equal(failingAudit.checks.find((check:any)=>check.check==='max_http_errors')?.passed,false);
  const outOfOrder=await run('flow-wrong-order',{action:'network_flow_assert',flow:{steps:[
    {index:copyIndex,expected_status:200},{index:publicIndex,expected_status:200},
  ]}});
  assert.equal(outOfOrder.passed,false);assert.equal(outOfOrder.checks[0].check,'request_order');
  const secretLink=await run('flow-masked-secret',{action:'network_flow_assert',flow:{steps:[
    {index:publicIndex,expected_status:200},{index:copyIndex,expected_status:200},
  ],links:[{from_index:publicIndex,from_pointer:'/access_token',to_index:copyIndex,to_pointer:'/access_token'}]}});
  assert.equal(secretLink.passed,false);assert.equal(secretLink.links[0].reason,'redacted_data');
  assert.doesNotMatch(JSON.stringify(secretLink),/private-api-token|different-private-token/);
  const wrongStatus=await run('wrong-status',{action:'network_assert',index:publicIndex,expected_status:201});
  assert.equal(wrongStatus.passed,false);assert.equal(wrongStatus.checks.find((c:any)=>c.check==='status').reason,'mismatch');
  const wrongPath=await run('wrong-path',{action:'network_assert',index:publicIndex,expected_status:200,expected_path:'/other-path'});
  assert.equal(wrongPath.passed,false);assert.equal(wrongPath.checks.find((c:any)=>c.check==='path').reason,'mismatch');
  const wrongJson=await run('wrong-json',{action:'network_assert',index:publicIndex,json_checks:[{pointer:'/answer',type:'string'},{pointer:'/missing',exists:false}]});
  assert.equal(wrongJson.passed,false);assert.equal(wrongJson.checks.find((c:any)=>c.check==='json_1').reason,'wrong_type');assert.equal(wrongJson.checks.find((c:any)=>c.check==='json_2').passed,true);
  const hiddenSecret=await run('secret-compare',{action:'network_assert',index:publicIndex,json_checks:[{pointer:'/access_token',equals:'private-api-token'}]});
  assert.equal(hiddenSecret.passed,false,'a secret field cannot be probed through JSON equality');
  assert.doesNotMatch(JSON.stringify(hiddenSecret),/private-api-token/);
  const noLength=await run('unknown-json-length',{action:'network_assert',index:apiRequest.index,expected_status:418,json_checks:[{pointer:'/hidden',exists:true}]});
  assert.equal(noLength.passed,false);assert.equal(noLength.checks[noLength.checks.length-1].reason,'json_size_unknown_or_too_large');
  for(const [id,input,pattern] of [
    ['assert-without-check',{action:'network_assert',index:publicIndex},/requires a state/],
    ['assert-conflict',{action:'network_assert',index:publicIndex,expected_status:200,status_min:200},/cannot be combined/],
    ['assert-unsafe-path',{action:'network_assert',index:publicIndex,expected_status:200,expected_path:'/api?token=secret'},/exact URL pathname/],
    ['assert-invalid-pointer',{action:'network_assert',index:publicIndex,json_checks:[{pointer:'/answer~2',exists:true}]},/Invalid network JSON checks/],
  ] as const){
    await assert.rejects(run(id,input as any),pattern);
    assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined,'invalid contract does not create unknown receipt');
  }
  const blockedIndex=net.entries.find((entry:any)=>entry.url==='[blocked-origin]').index;
  await assert.rejects(run('request-blocked',{action:'network_request',index:blockedIndex}),/not authorized/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'request-blocked'),undefined);
  await assert.rejects(run('assert-blocked',{action:'network_assert',index:blockedIndex,expected_state:'failed'}),/not authorized/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'assert-blocked'),undefined);
  await assert.rejects(run('flow-blocked',{action:'network_flow_assert',flow:{steps:[{index:publicIndex,expected_status:200},{index:blockedIndex,expected_state:'failed'}]}}),/not authorized/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'flow-blocked'),undefined);
  await assert.rejects(run('request-invalid-index',{action:'network_request',index:999999}),/Unknown or expired/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'request-invalid-index'),undefined);
  assert.deepEqual(await run('console',{action:'console'}),log,'read-only diagnostics must be idempotent');
  const cleared=await run('clear-first',{action:'network_clear'});
  assert.equal(cleared.cleared,net.entries.length);
  assert.deepEqual(await run('clear-first',{action:'network_clear'}),cleared,'clear replays without erasing subsequent traffic');
  assert.deepEqual((await run('list-after-clear',{action:'network_list',list:{include_static:true}})).entries,[]);
  assert.equal((await run('audit-after-clear',{action:'network_audit',audit:{path_prefix:'/public-'}})).passed,false);
  await assert.rejects(run('stale-index-after-clear',{action:'network_request',index:publicIndex}),/Unknown or expired/);
  const filled=await run('fill-after-diagnostics',{action:'fill',revision:opened.revision,ref:'1',text:'kept'});
  assert.equal(filled.controls[0].label,'Safe editor');
  await run('reload-after-clear',{action:'reload',revision:filled.revision});
  let repopulated:any;
  for(let attempt=0;attempt<30;attempt++){
    repopulated=await run('list-reloaded-'+attempt,{action:'network_list',list:{path_prefix:'/public-',status_min:200,status_max:299}});
    if(repopulated.entries.length===2&&repopulated.entries.every((entry:any)=>entry.state==='completed'))break;
    await delay(50);
  }
  assert.equal(repopulated.entries.length,2);
  assert.ok(repopulated.entries.every((entry:any)=>entry.index>cleared.last_index),'cleared indexes are never reused');
  const cohort=await run('audit-after-refill',{action:'network_audit',audit:{path_prefix:'/public-',min_completed:2,max_http_errors:0,max_pending:0}});
  assert.equal(cohort.passed,true,JSON.stringify(cohort));
  const second=await run('new-second',{action:'new_tab',url:url+'/second'});
  const secondLog=await run('console-second',{action:'console'});
  assert.ok(secondLog.entries.some((entry:any)=>entry.text==='tab-two-only'));
  assert.ok(!secondLog.entries.some((entry:any)=>entry.text==='first-tab-ready'));
  const secondNet=await run('network-second',{action:'network'});
  assert.ok(secondNet.entries.every((entry:any)=>entry.url!==url+'/api'));
  await run('clear-second',{action:'network_clear'});
  assert.equal((await run('list-second-empty',{action:'network_list',list:{include_static:true}})).entries.length,0);
  await assert.rejects(run('assert-other-tab',{action:'network_assert',index:publicIndex,expected_status:200}),/Unknown or expired/);
  await assert.rejects(run('flow-other-tab',{action:'network_flow_assert',flow:{steps:[{index:publicIndex,expected_status:200},{index:copyIndex,expected_status:200}]}}),/Unknown or expired/);
  await run('return-first',{action:'switch_tab',tab_id:firstId});
  assert.ok((await run('list-first-preserved',{action:'network_list',list:{path_prefix:'/public-'}})).entries.length>=2,
    'clearing the second tab must not erase the first tab history');
  const firstLog=await run('console-return',{action:'console'});
  assert.ok(firstLog.entries.some((entry:any)=>entry.text==='first-tab-ready'));
  await run('burst',{action:'new_tab',url:url+'/burst'});
  const bounded=await run('console-bounded',{action:'console'});
  assert.equal(bounded.entries.length,60);
  assert.equal(bounded.dropped,15);
  assert.equal(bounded.truncated,true);
  assert.equal(second.tabs.length,2);
});

