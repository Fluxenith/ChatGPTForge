import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomInt} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

async function listenFixture(server:ReturnType<typeof createServer>){
  for(let attempt=0;attempt<50;attempt++){
    server.listen(randomInt(49152,65535),'127.0.0.1');
    try{await once(server,'listening');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;}
  }
  throw Error('No free high fixture port');
}

async function fixture(t:any,{allowCross=true,bounded=false}={}){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-frames-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const records:URLSearchParams[]=[];let crossRequests=0,mainOrigin='',crossOrigin='';
  const form=(name:string)=>`<body><p>${name} document</p><input aria-label="Same editor"><output id="value"></output><input type="checkbox" aria-label="Approve"><select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select><input type="password" aria-label="Secret"><input type="file" aria-label="Upload"><button onclick="fetch('${mainOrigin}/record?kind=click&frame=${name}')">Record</button><div data-testid="card" draggable="true" style="background:#def;width:130px;height:60px">Card</div><div data-testid="drop" style="background:#fed;width:150px;height:65px">Drop</div><script>
    document.querySelector('input').addEventListener('input',e=>document.getElementById('value').textContent=e.target.value);
    document.querySelector('[draggable]').addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','iframe-card'));
    const drop=document.querySelector('[data-testid="drop"]');drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();fetch('${mainOrigin}/record?kind=drop&frame=${name}&trusted='+e.isTrusted+'&value='+e.dataTransfer.getData('text/plain'));});
    </script><div style="height:2500px">Scroll ${name}</div></body>`;
  const cross=createServer((_req,res)=>{crossRequests++;res.setHeader('Content-Type','text/html');res.end(form('cross')+'<iframe name="cross-inline" srcdoc="<p>cross inherited private text</p><input aria-label=\'Cross inline\'>"></iframe>');});
  await listenFixture(cross);const crossAddress=cross.address();assert.ok(crossAddress&&typeof crossAddress!=='string');crossOrigin='http://localhost:'+crossAddress.port;
  const main=createServer((req,res)=>{
    if(req.url?.startsWith('/record?')){records.push(new URL(req.url,mainOrigin).searchParams);res.end('recorded');return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url?.startsWith('/child')){res.end(form('same'));return;}
    if(req.url?.startsWith('/bounded')){res.end('<body>'+Array.from({length:160},(_,i)=>`<button>Main ${i}</button>`).join('')+'<p>'+('x'.repeat(18000))+'</p>'+Array.from({length:34},(_,i)=>`<iframe name="bounded-${i}" src="/child?i=${i}"></iframe>`).join('')+'</body>');return;}
    res.end(`<body><input aria-label="Same editor"><p>Main document</p><iframe id="same" name="same" style="width:420px;height:370px" src="/child"></iframe><iframe id="cross" name="cross" style="width:420px;height:370px" src="${crossOrigin}/cross"></iframe><iframe name="inline" srcdoc="<p>Inline document</p><input aria-label=\'Inline editor\'>"></iframe><iframe name="data" src="data:text/html,%3Cp%3EData%20document%3C/p%3E%3Cinput%20aria-label='Data%20editor'%3E"></iframe></body>`);
  });await listenFixture(main);const address=main.address();assert.ok(address&&typeof address!=='string');mainOrigin='http://127.0.0.1:'+address.port;
  t.after(async()=>{await browser.close();for(const server of [main,cross]){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}engine.close();assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true,maxRetries:10});});
  browser.allow(mainOrigin);if(allowCross)browser.allow(crossOrigin);
  const task=engine.create(project,'frames','operate owned iframe documents',['echo verified'],true);
  const run=(id:string,args:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  await run('open',{action:'open',url:mainOrigin+(bounded?'/bounded':'')});
  const page=(browser as any).sessions.get(task.task_id).page;await page.waitForLoadState('load');
  const snapshot=await run('loaded',{action:'inspect'});
  const frame=(s:any,name:string)=>{const result=s.frames.find((f:any)=>f.name===name);assert.ok(result,name);return result;};
  const control=(s:any,name:string,label:string)=>{const result=s.controls.find((c:any)=>c.frame_id===frame(s,name).frame_id&&(c.label===label||c.test_id===label));assert.ok(result,name+':'+label);return result;};
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  return {browser,engine,task,run,page,snapshot,frame,control,noIntent,records,mainOrigin,crossOrigin,crossRequests:()=>crossRequests};
}

test('iframe snapshots bind controls to same-origin, cross-origin and inherited documents',async t=>{
  const f=await fixture(t);let s=f.snapshot;
  assert.match(s.text,/Main document/);assert.match(s.text,/same document/);assert.match(s.text,/cross document/);assert.match(s.text,/Inline document/);assert.match(s.text,/Data document/);
  assert.equal(s.frames.length,6);assert.equal(s.frames_truncated,false);
  assert.equal(f.frame(s,'cross-inline').parent_id,f.frame(s,'cross').frame_id);
  assert.equal(f.frame(s,'data').url,'[inline-frame]');
  const main=s.controls.find((c:any)=>c.label==='Same editor'&&c.frame_id===s.frames[0].frame_id);
  assert.ok(main);assert.notEqual(main.ref,f.control(s,'same','Same editor').ref);
  s=await f.run('fill-cross',{action:'fill',ref:f.control(s,'cross','Same editor').ref,revision:s.revision,text:'cross filled'});
  assert.equal(await f.page.frame({name:'cross'}).locator('input').first().inputValue(),'cross filled');
  assert.equal(await f.page.frame({name:'same'}).locator('input').first().inputValue(),'');assert.equal(await f.page.locator('input').inputValue(),'');
  s=await f.run('check-inline',{action:'fill',ref:f.control(s,'inline','Inline editor').ref,revision:s.revision,text:'inline filled'});
  assert.equal(await f.page.frame({name:'inline'}).locator('input').inputValue(),'inline filled');
  s=await f.run('check-cross',{action:'check',ref:f.control(s,'cross','Approve').ref,revision:s.revision,checked:true});assert.equal(f.control(s,'cross','Approve').checked,true);
  s=await f.run('select-same',{action:'select',ref:f.control(s,'same','Choice').ref,revision:s.revision,value:'two'});assert.equal(f.control(s,'same','Choice').options[1].selected,true);
  const args={action:'click',ref:s.controls.find((c:any)=>c.frame_id===f.frame(s,'cross').frame_id&&c.tag==='BUTTON').ref,revision:s.revision};
  const clicked=await f.run('click-cross',args);assert.deepEqual(await f.run('click-cross',args),clicked);
  for(let i=0;!f.records.length&&i<20;i++)await delay(50);assert.equal(f.records.length,1);assert.equal(f.records[0].get('frame'),'cross');
  for(const label of ['Secret','Upload']){const id='secret-'+label;await assert.rejects(f.run(id,{action:'fill',ref:f.control(clicked,'same',label).ref,revision:clicked.revision,text:'rejected'}),/non-secret/);f.noIntent(id);}
});

test('revoked iframe grants exclude descendants and reject old refs and screenshots before intent',async t=>{
  const f=await fixture(t),s=f.snapshot,cross=f.frame(s,'cross'),ref=f.control(s,'cross','Same editor').ref;
  f.browser.origins.delete(f.crossOrigin);
  await assert.rejects(f.run('revoked-ref',{action:'fill',ref,revision:s.revision,text:'no'}),/origin is not authorized/);f.noIntent('revoked-ref');
  await assert.rejects(f.run('revoked-frame',{action:'inspect',frame_id:cross.frame_id}),/origin is not authorized/);f.noIntent('revoked-frame');
  await assert.rejects(f.run('revoked-image',{action:'screenshot'}),/without an origin grant/);f.noIntent('revoked-image');
  const safe=await f.run('safe-inspect',{action:'inspect'});assert.doesNotMatch(JSON.stringify(safe),/cross document|cross inherited private text|cross-inline/);
  assert.ok(!safe.controls.some((c:any)=>c.frame_id===cross.frame_id));assert.equal(safe.frames.find((v:any)=>v.frame_id===cross.frame_id).url,'[blocked-origin]');
  f.browser.allow(f.crossOrigin);const fresh=await f.run('restored',{action:'inspect',frame_id:cross.frame_id});assert.match(fresh.text,/cross document/);assert.equal(fresh.frames.find((v:any)=>v.parent_id===cross.frame_id).state,'not-selected');
});

test('ungranted iframe origins never receive requests or expose document content',async t=>{
  const f=await fixture(t,{allowCross:false});assert.equal(f.crossRequests(),0);assert.doesNotMatch(f.snapshot.text,/cross document|private text/);
  const blocked=f.snapshot.frames.find((v:any)=>!v.authorized);assert.ok(blocked);assert.equal(blocked.url,'[blocked-origin]');assert.equal(blocked.name,'');
  await assert.rejects(f.run('blocked-selection',{action:'inspect',frame_id:blocked.frame_id}),/origin is not authorized/);f.noIntent('blocked-selection');
});

test('iframe navigation and replacement cannot transfer stale refs to same-looking controls',async t=>{
  const f=await fixture(t);let s=f.snapshot;const oldFrame=f.frame(s,'same').frame_id,oldRef=f.control(s,'same','Same editor').ref;
  await f.page.frame({name:'same'}).goto(f.mainOrigin+'/child?new-document');
  await assert.rejects(f.run('old-document',{action:'fill',ref:oldRef,revision:s.revision,text:'wrong document'}),/Frame changed/);f.noIntent('old-document');
  s=await f.run('new-document',{action:'inspect',frame_id:oldFrame});assert.equal(f.frame(s,'same').frame_id,oldFrame);
  const replacedRef=f.control(s,'same','Same editor').ref;
  const attached=f.page.waitForEvent('frameattached');
  await f.page.evaluate(()=>{const old=document.getElementById('same')!;old.replaceWith(old.cloneNode(true));});
  const replacement=await attached;await replacement.waitForURL(f.mainOrigin+'/child');await replacement.waitForLoadState('load');
  await assert.rejects(f.run('old-node',{action:'fill',ref:replacedRef,revision:s.revision,text:'wrong frame'}),/Frame changed/);f.noIntent('old-node');
  await assert.rejects(f.run('old-frame',{action:'inspect',frame_id:oldFrame}),/Unknown current-tab frame/);f.noIntent('old-frame');
  const fresh=await f.run('fresh-replacement',{action:'inspect'});assert.notEqual(f.frame(fresh,'same').frame_id,oldFrame);
  assert.equal(await f.page.frame({name:'same'}).locator('input').first().inputValue(),'');
});

test('selected iframe scrolling is bounded, fresh and does not scroll the parent document',async t=>{
  const f=await fixture(t),s=f.snapshot,frame_id=f.frame(s,'same').frame_id;
  await assert.rejects(f.run('stale-scroll',{action:'scroll',frame_id,revision:'old',delta_y:400}),/Stale/);f.noIntent('stale-scroll');
  await assert.rejects(f.run('wrong-action-frame',{action:'fill',frame_id,ref:f.control(s,'same','Same editor').ref,revision:s.revision,text:'no'}),/supported only/);f.noIntent('wrong-action-frame');
  const args={action:'scroll',frame_id,revision:s.revision,delta_y:400},scrolled=await f.run('scroll-child',args);
  assert.equal(await f.page.frame({name:'same'}).evaluate(()=>window.scrollY),400);assert.equal(await f.page.evaluate(()=>window.scrollY),0);
  assert.deepEqual(await f.run('scroll-child',args),scrolled);assert.equal(await f.page.frame({name:'same'}).evaluate(()=>window.scrollY),400);
  await assert.rejects(f.run('stale-after-scroll',args),/Stale/);f.noIntent('stale-after-scroll');
  await f.run('other-tab',{action:'new_tab',url:f.mainOrigin+'/child'});
  await assert.rejects(f.run('cross-tab-frame',{action:'inspect',frame_id}),/Unknown current-tab frame/);f.noIntent('cross-tab-frame');
});

test('selected inspection reaches iframe controls beyond the global bound and keeps payloads bounded',async t=>{
  const f=await fixture(t,{bounded:true}),s=f.snapshot;
  assert.equal(s.controls.length,150);assert.equal(s.text.length,16000);assert.equal(s.frames.length,32);assert.equal(s.frames_truncated,true);
  const frame_id=f.frame(s,'bounded-0').frame_id;
  assert.ok(!s.controls.some((c:any)=>c.frame_id===frame_id));
  const child=await f.run('inspect-child',{action:'inspect',frame_id});assert.ok(child.controls.length>0);assert.ok(child.controls.every((c:any)=>c.frame_id===frame_id));assert.match(child.text,/same document/);assert.doesNotMatch(child.text,/x{200}/);
});

test('cross-origin iframe drag uses trusted native DataTransfer and never repeats the drop',async t=>{
  const f=await fixture(t),s=f.snapshot,args={action:'drag',revision:s.revision,ref:f.control(s,'same','card').ref,target_ref:f.control(s,'cross','drop').ref};
  for(const name of ['same','cross'])await f.page.frame({name}).evaluate(()=>{
    (window as any).dragEvents=[];
    for(const type of ['pointerdown','pointerup','dragstart','dragenter','dragover','drop','dragend'])document.addEventListener(type,e=>(window as any).dragEvents.push({type:e.type,target:(e.target as Element).getAttribute('data-testid'),trusted:e.isTrusted}),true);
  });
  const result=await f.run('cross-frame-drag',args);
  for(let i=0;!f.records.length&&i<20;i++)await delay(50);
  if(!f.records.length){
    t.diagnostic(JSON.stringify(await Promise.all(['same','cross'].map(async name=>({name,events:await f.page.frame({name}).evaluate(()=>(window as any).dragEvents),box:await f.page.frame({name}).locator('[data-testid="drop"]').boundingBox()})))));
    await f.page.screenshot({path:'../artifacts/browser-frames-v1/cross-drag-debug.png'});
  }
  assert.equal(f.records.length,1);assert.equal(f.records[0].get('kind'),'drop');assert.equal(f.records[0].get('frame'),'cross');assert.equal(f.records[0].get('trusted'),'true');assert.equal(f.records[0].get('value'),'iframe-card');
  assert.deepEqual(await f.run('cross-frame-drag',args),result);await delay(50);assert.equal(f.records.length,1);
});

test('navigation during frame traversal discards only the changed child document',async t=>{
  const f=await fixture(t),same=f.page.frame({name:'same'}),cross=f.page.frame({name:'cross'}),original=cross.evaluateHandle.bind(cross);
  const oldFrame=f.frame(f.snapshot,'same').frame_id;
  cross.evaluateHandle=async(...args:any[])=>{cross.evaluateHandle=original;await same.goto(f.mainOrigin+'/child?changed-during-traversal');return original(...args);};
  const result=await f.run('overlap',{action:'inspect'});assert.equal(result.state,'completed');assert.equal(result.frames.find((v:any)=>v.frame_id===oldFrame).state,'changed');
  assert.ok(!result.controls.some((c:any)=>c.frame_id===oldFrame));assert.doesNotMatch(result.text,/same document/);assert.match(result.text,/cross document/);
  const fresh=await f.run('fresh',{action:'inspect'});assert.match(fresh.text,/same document/);
});

test('navigation during a child capture publishes no old document text or controls',async t=>{
  const f=await fixture(t),same=f.page.frame({name:'same'}),original=same.evaluateHandle.bind(same),frame_id=f.frame(f.snapshot,'same').frame_id;
  same.evaluateHandle=async(...args:any[])=>{same.evaluateHandle=original;const handle=await original(...args);await same.goto(f.mainOrigin+'/child?capture-interrupted');return handle;};
  const result=await f.run('capture-interrupted',{action:'inspect'});assert.equal(result.state,'completed');
  assert.equal(result.frames.find((v:any)=>v.frame_id===frame_id).state,'changed');assert.ok(!result.controls.some((c:any)=>c.frame_id===frame_id));assert.doesNotMatch(result.text,/same document/);
  const refreshed=await f.run('refresh-child',{action:'inspect',frame_id});assert.match(refreshed.text,/same document/);
});

test('iframe navigation after mouse down aborts cross-frame drag and preserves unknown',async t=>{
  const f=await fixture(t),s=f.snapshot;
  await f.page.frame({name:'same'}).evaluate(()=>{document.querySelector('[draggable]')!.addEventListener('pointerdown',()=>location.assign('/child?drag-interrupted'),{once:true});});
  const args={action:'drag',revision:s.revision,ref:f.control(s,'same','card').ref,target_ref:f.control(s,'cross','drop').ref};
  await assert.rejects(f.run('interrupted-frame-drag',args),/Frame changed|Native iframe drag did not start|Execution context|navigation/);await delay(50);assert.equal(f.records.length,0);
  assert.equal((await f.run('interrupted-frame-drag',args)).state,'unknown');assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/Unknown browser\/desktop/);
});

for(const [source,label] of [['cross','from an out-of-process iframe'],['same','within the same document']] as const)
test(`shared-process iframe HTML5 target receives one trusted native drop ${label}`,async t=>{
  // The same-origin child shares its parent's renderer and CDP target; drag
  // events are dispatched on the page target and hit-test into the child.
  const f=await fixture(t),s=f.snapshot,args={action:'drag',revision:s.revision,ref:f.control(s,source,'card').ref,target_ref:f.control(s,'same','drop').ref};
  const result=await f.run('shared-frame-drop-'+source,args);assert.equal(result.state,'completed');
  for(let i=0;!f.records.length&&i<20;i++)await delay(50);
  assert.equal(f.records.length,1);assert.equal(f.records[0].get('kind'),'drop');assert.equal(f.records[0].get('frame'),'same');
  assert.equal(f.records[0].get('trusted'),'true');assert.equal(f.records[0].get('value'),'iframe-card');
  assert.deepEqual(await f.run('shared-frame-drop-'+source,args),result);await delay(100);assert.equal(f.records.length,1);
});

test('native HTML5 drag within an out-of-process iframe receives trusted data',async t=>{
  const f=await fixture(t),s=f.snapshot,args={action:'drag',revision:s.revision,ref:f.control(s,'cross','card').ref,target_ref:f.control(s,'cross','drop').ref};
  await f.run('iframe-internal-drag',args);
  for(let i=0;!f.records.length&&i<20;i++)await delay(50);assert.equal(f.records.length,1);assert.equal(f.records[0].get('trusted'),'true');assert.equal(f.records[0].get('value'),'iframe-card');
});

test('cancellation interrupts the native iframe drag wait and retains its unknown receipt',async t=>{
  const f=await fixture(t),s=f.snapshot,controller=new AbortController();
  await f.page.frame({name:'same'}).evaluate(()=>{
    const card=document.querySelector('[draggable]')!;
    card.addEventListener('pointerdown',()=>fetch('/record?kind=started'),{once:true});
    card.addEventListener('dragstart',e=>e.preventDefault());
  });
  const args={action:'drag',revision:s.revision,ref:f.control(s,'same','card').ref,target_ref:f.control(s,'cross','drop').ref};
  const pending=f.browser.run(f.task.task_id,'cancelled-frame-drag',f.task.lease_token!,args,controller.signal);
  const rejected=assert.rejects(pending,/cancelled/);
  for(let i=0;!f.records.some(r=>r.get('kind')==='started')&&i<100;i++)await delay(20);
  assert.ok(f.records.some(r=>r.get('kind')==='started'));const start=Date.now();controller.abort();await rejected;assert.ok(Date.now()-start<2000);
  assert.equal(f.page.isClosed(),true);assert.equal(f.records.filter(r=>r.get('kind')==='drop').length,0);
  assert.equal((await f.run('cancelled-frame-drag',args)).state,'unknown');assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/Unknown browser\/desktop/);
});
