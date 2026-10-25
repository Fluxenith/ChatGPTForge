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

async function fixture(t:any,onload=false,mode:'main'|'iframe'|'oopif'='main'){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-dialog-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]),records:URLSearchParams[]=[],requests:string[]=[];
  const html=`<!doctype html><body><button aria-label="Alert" onclick="begin();alert('Owned alert');record('alert','done')">Alert</button><button aria-label="Confirm" onclick="begin();record('confirm',confirm('Owned confirmation'))">Confirm</button><button aria-label="Prompt" onclick="begin();record('prompt',prompt('Owned prompt','Default value'))">Prompt</button><button aria-label="Chain" onclick="begin();const a=confirm('First dialog');const b=prompt('Second dialog','Second default');record('chain',JSON.stringify([a,b]))">Chain</button><button aria-label="Arm unload" onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue='leave?';}">Arm unload</button><button aria-label="Hide" style="display:none">Hidden</button><output id="result">No decision</output><script>
  const begin=()=>fetch('/record?kind=opened');
  const record=(kind,value)=>{document.getElementById('result').textContent=kind+': '+String(value);fetch('/record?kind='+kind+'&value='+encodeURIComponent(String(value)));};
  ${onload?"record('onload',confirm('Onload confirmation'));":''}
  </script></body>`;
  let crossOrigin='';
  const record=(url:string|undefined,res:any)=>{if(!url?.startsWith('/record?'))return false;records.push(new URL(url,'http://fixture').searchParams);res.end('recorded');return true;};
  const cross=createServer((req,res)=>{if(record(req.url,res))return;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
  if(mode==='oopif'){await listenFixture(cross);const a=cross.address();assert.ok(a&&typeof a!=='string');crossOrigin='http://localhost:'+a.port;browser.allow(crossOrigin);}
  const server=createServer((req,res)=>{if(record(req.url,res))return;requests.push(req.url??'');if(req.url==='/redirect'){res.writeHead(302,{Location:'/redirected'});res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(mode!=='main'&&req.url==='/'?`<!doctype html><body>Parent document<iframe name="dialog-frame" src="${mode==='oopif'?crossOrigin:''}/child" style="width:850px;height:500px"></iframe></body>`:html);});await listenFixture(server);
  t.after(async()=>{await browser.close();for(const fixtureServer of [server,...(mode==='oopif'?[cross]:[])]){fixtureServer.closeAllConnections();await new Promise<void>(r=>fixtureServer.close(()=>r()));}await delay(10);engine.close();assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;browser.allow(origin);
  const task=engine.create(project,'dialog','operate owned dialogs',['echo verified'],true);
  const run=(id:string,args:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  let opened=await run('open',{action:'open',url:origin});
  if(mode!=='main'&&!onload){const page=(browser as any).sessions.get(task.task_id).page;await page.waitForLoadState('load');opened=await run('loaded',{action:'inspect'});}
  const ref=(s:any,label:string)=>{const c=s.controls.find((c:any)=>c.label===label);assert.ok(c,label);return c.ref;};
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const decisions=()=>records.filter(r=>r.get('kind')!=='opened');
  return {root,project,engine,browser,task,run,opened,origin,crossOrigin,records,requests,ref,noIntent,decisions};
}

test('native confirm suspends once, fences task writes and resumes after an explicit decision',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Confirm'),revision:f.opened.revision};
  const pending=await f.run('confirm-click',args);assert.equal(pending.state,'dialog_pending');assert.equal(pending.dialogs.length,1);
  const dialog=pending.dialogs[0];assert.equal(dialog.type,'confirm');assert.equal(dialog.authorized,true);assert.equal(dialog.message,'Owned confirmation');assert.equal(f.decisions().length,0);
  assert.deepEqual(await f.run('confirm-click',args),pending);
  assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/pending dialog/);
  assert.throws(()=>f.engine.exec(f.task.task_id,'during-dialog','echo no',f.task.fingerprint,1000,'command',f.task.lease_token!),/pending dialog/);
  const observed=await f.run('modal-inspect',{action:'inspect'});assert.equal(observed.state,'dialog_pending');assert.deepEqual(observed.controls,[]);assert.equal(observed.dialogs[0].dialog_id,dialog.dialog_id);
  const choice={action:'dialog',dialog_id:dialog.dialog_id,accept:true};
  const completed=await f.run('accept-confirm',choice);assert.equal(completed.state,'completed');assert.match(completed.text,/confirm: true/);assert.equal(completed.handled_dialog.accepted,true);
  assert.deepEqual(await f.run('accept-confirm',choice),completed);assert.equal((await f.run('confirm-click',args)).state,'completed');
  for(let i=0;f.decisions().length<1&&i<20;i++)await delay(50);assert.equal(f.decisions().length,1);assert.equal(f.decisions()[0].get('value'),'true');assert.equal(f.records.filter(r=>r.get('kind')==='opened').length,1);
  await assert.rejects(f.run('old-dialog',{...choice,accept:false}),/already handled/);f.noIntent('old-dialog');
});

test('native prompt supports Unicode and empty text, and dismissal yields null',async t=>{
  const f=await fixture(t);let s=f.opened;
  for(const [index,accept,text,value] of [[0,true,'你好 "quoted"','你好 "quoted"'],[1,true,'',''],[2,false,undefined,'null'],[3,true,undefined,'Default value']] as const){
    const pending=await f.run('prompt-click-'+index,{action:'click',ref:f.ref(s,'Prompt'),revision:s.revision});
    assert.equal(pending.dialogs[0].default_value,'Default value');
    s=await f.run('prompt-handle-'+index,{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept,...(text===undefined?{}:{text})});assert.equal(s.state,'completed');assert.match(s.text,/prompt:/);
    for(let i=0;f.decisions().length<=index&&i<20;i++)await delay(50);assert.equal(f.decisions()[index].get('value'),value);
  }
});

test('multiple dialogs keep separate IDs and do not repeat their originating click',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Chain'),revision:f.opened.revision};
  const first=await f.run('chain-click',args),firstID=first.dialogs[0].dialog_id;
  const next=await f.run('chain-first',{action:'dialog',dialog_id:firstID,accept:false});assert.equal(next.state,'dialog_pending');assert.equal(next.dialogs.length,1);assert.notEqual(next.dialogs[0].dialog_id,firstID);assert.equal(next.dialogs[0].message,'Second dialog');
  await assert.rejects(f.run('chain-old',{action:'dialog',dialog_id:firstID,accept:true}),/already handled/);f.noIntent('chain-old');
  const result=await f.run('chain-second',{action:'dialog',dialog_id:next.dialogs[0].dialog_id,accept:true,text:'Next answer'});assert.equal(result.state,'completed');assert.match(result.text,/Next answer/);
  for(let i=0;!f.decisions().length&&i<20;i++)await delay(50);assert.equal(f.decisions().length,1);assert.deepEqual(JSON.parse(f.decisions()[0].get('value')!),[false,'Next answer']);assert.equal(f.records.filter(r=>r.get('kind')==='opened').length,1);
  assert.equal((await f.run('chain-click',args)).state,'completed');
});

test('an onload dialog returns before DOMContentLoaded and resumes the original navigation',async t=>{
  const f=await fixture(t,true),pending=f.opened;assert.equal(pending.state,'dialog_pending');assert.equal(pending.dialogs[0].authorized,true);
  const result=await f.run('onload-choice',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:false});assert.equal(result.state,'completed');assert.match(result.text,/onload: false/);
  assert.equal((await f.run('open',{action:'open',url:f.origin})).state,'completed');
});

test('invalid dialog decisions and revoked origins are rejected before an intent',async t=>{
  const f=await fixture(t),pending=await f.run('alert-click',{action:'click',ref:f.ref(f.opened,'Alert'),revision:f.opened.revision}),id=pending.dialogs[0].dialog_id;
  for(const [operation,args] of [['wrong-text',{action:'dialog',dialog_id:id,accept:true,text:'not a prompt'}],['missing-choice',{action:'dialog',dialog_id:id}],['unknown-dialog',{action:'dialog',dialog_id:'00000000-0000-0000-0000-000000000000',accept:true}],['wrong-action',{action:'inspect',dialog_id:id,accept:true}]] as const){
    await assert.rejects(f.run(operation,args),/Text is supported|boolean accept|Unknown|parameters require/);f.noIntent(operation);
  }
  f.browser.origins.delete(f.origin);
  await assert.rejects(f.run('revoked-choice',{action:'dialog',dialog_id:id,accept:true}),/origin or document/);f.noIntent('revoked-choice');
  f.browser.allow(f.origin);const result=await f.run('dismiss-alert',{action:'dialog',dialog_id:id,accept:false});assert.equal(result.state,'completed');assert.match(result.text,/alert: done/);
});

test('human modal time does not consume the native action deadline',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Confirm'),revision:f.opened.revision};
  const pending=await f.run('long-decision',args);await delay(9000);
  assert.equal(f.decisions().length,0);assert.equal((await f.run('long-decision',args)).state,'dialog_pending');
  const result=await f.run('late-decision',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:true});assert.equal(result.state,'completed');assert.match(result.text,/confirm: true/);
});

test('same-origin and out-of-process iframe dialogs expose authorized native initiators',async t=>{
  for(const mode of ['iframe','oopif'] as const)await t.test(mode,async sub=>{
    const f=await fixture(sub,false,mode),pending=await f.run('frame-confirm',{action:'click',ref:f.ref(f.opened,'Confirm'),revision:f.opened.revision});
    assert.equal(pending.state,'dialog_pending');assert.equal(pending.dialogs[0].authorized,true);assert.equal(pending.dialogs[0].source_url,(mode==='oopif'?f.crossOrigin:f.origin)+'/child');
    const result=await f.run('frame-choice',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:true});assert.equal(result.state,'completed');assert.match(result.text,/confirm: true/);
  });
});

test('unrelated unknown receipts cannot be bypassed by a dialog decision',async t=>{
  const f=await fixture(t),pending=await f.run('confirm-click',{action:'click',ref:f.ref(f.opened,'Confirm'),revision:f.opened.revision});
  f.engine.db.prepare('INSERT INTO browser_operations VALUES(?,?,?,?,NULL)').run(f.task.task_id,'unrelated-unknown','{}','unknown');
  await assert.rejects(f.run('cannot-bypass',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:true}),/Unknown browser\/desktop/);f.noIntent('cannot-bypass');assert.equal(f.decisions().length,0);
  await f.run('close',{action:'close'});
  assert.equal((await f.run('confirm-click',{action:'click',ref:f.ref(f.opened,'Confirm'),revision:f.opened.revision})).state,'unknown');
});

test('owned-session close and restart preserve pending decisions as unknown without replay',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Confirm'),revision:f.opened.revision};
  const pending=await f.run('lost-dialog',args);await f.browser.close();await delay(20);
  const fresh=new ForgeBrowser(f.engine,[f.project]);t.after(()=>fresh.close());
  assert.equal((await fresh.run(f.task.task_id,'lost-dialog',f.task.lease_token!,args) as any).state,'unknown');
  await assert.rejects(fresh.run(f.task.task_id,'old-choice',f.task.lease_token!,{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:true}),/Unknown browser\/desktop/);f.noIntent('old-choice');
  assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/Unknown browser\/desktop/);
});

test('an invisible target has an active deadline and cannot click after the owned context closes',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Hide'),revision:f.opened.revision},started=Date.now();
  await assert.rejects(f.run('invisible',args),/timed out/);assert.ok(Date.now()-started<10000);
  assert.equal((await f.run('invisible',args)).state,'unknown');assert.equal((f.browser as any).sessions.has(f.task.task_id),false);assert.equal(f.records.length,0);
});

test('background dialogs in an inactive owned tab are handled without switching the active tab',async t=>{
  const f=await fixture(t),session=(f.browser as any).sessions.get(f.task.task_id),first=session.page,firstTab=f.opened.tabs[0].tab_id;
  const second=await f.run('new-tab',{action:'new_tab',url:f.origin+'/second'}),secondTab=second.tabs.find((t:any)=>t.active).tab_id;
  await first.evaluate(()=>{setTimeout(()=>confirm('Inactive tab confirmation'),10);});
  for(let i=0;!session.dialogs.hasPending&&i<100;i++)await delay(20);
  const observed=await f.run('background-inspect',{action:'inspect'});assert.equal(observed.state,'dialog_pending');assert.equal(observed.dialogs[0].tab_id,firstTab);assert.equal(observed.tabs.find((t:any)=>t.active).tab_id,secondTab);
  const result=await f.run('background-choice',{action:'dialog',dialog_id:observed.dialogs[0].dialog_id,accept:false});assert.equal(result.state,'completed');assert.equal(result.tabs.find((t:any)=>t.active).tab_id,secondTab);
});

test('beforeunload accepts navigation or explicitly cancels it without fetching a second document',async t=>{
  for(const accept of [false,true])await t.test(String(accept),async sub=>{
    const f=await fixture(sub);await f.run('arm-unload',{action:'click',ref:f.ref(f.opened,'Arm unload'),revision:f.opened.revision});
    const pending=await f.run('navigate',{action:'open',url:f.origin+'/next'});assert.equal(pending.state,'dialog_pending');assert.equal(pending.dialogs[0].type,'beforeunload');
    const result=await f.run('unload-choice',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept});
    assert.equal(result.state,accept?'completed':'navigation_cancelled');assert.equal(new URL(result.url).pathname,accept?'/next':'/');
    assert.equal(f.requests.filter(url=>url==='/next').length,accept?1:0);
  });
});

test('beforeunload cancellation keeps reload and history at their original document',async t=>{
  for(const action of ['reload','back'] as const)await t.test(action,async sub=>{
    const f=await fixture(sub);let s=f.opened;
    if(action==='back')s=await f.run('second-document',{action:'open',url:f.origin+'/second'});
    s=await f.run('arm-unload',{action:'click',ref:f.ref(s,'Arm unload'),revision:s.revision});
    const requestCount=f.requests.length,url=s.url;
    const pending=await f.run('blocked-navigation',{action,revision:s.revision});assert.equal(pending.dialogs[0].type,'beforeunload');
    const result=await f.run('deny-navigation',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:false});assert.equal(result.state,'navigation_cancelled');assert.equal(result.url,url);
    await delay(50);assert.equal(f.requests.length,requestCount);
  });
});

test('accepting beforeunload follows a granted redirect without resending navigation',async t=>{
  const f=await fixture(t);await f.run('arm-unload',{action:'click',ref:f.ref(f.opened,'Arm unload'),revision:f.opened.revision});
  const pending=await f.run('redirect-navigation',{action:'open',url:f.origin+'/redirect'});
  assert.equal(pending.dialogs[0].type,'beforeunload');
  const result=await f.run('leave',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:true});
  assert.equal(result.state,'completed');assert.equal(result.url,f.origin+'/redirected');
  assert.equal(f.requests.filter(url=>url==='/redirect').length,1);assert.equal(f.requests.filter(url=>url==='/redirected').length,1);
});
