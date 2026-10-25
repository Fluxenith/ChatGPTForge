import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DurableTasks} from './durable-tasks.js';
import {createForgeManager} from './forge-manager.js';
import {chromium} from 'playwright-core';
import {TaskFileBatches} from './task-file-batches.js';
import {digest} from './durable-tasks.js';
import {ForgeDesktop} from './forge-desktop.js';

test('manager requires authenticated local consent for all-screen capture and renders its scope',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-screen-manager-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));let grants=0;
  const desktop=new ForgeDesktop(engine,[project]);
  desktop.grantScreen=()=>{grants++;return {scope:'all_screens',expires_in_minutes:15};};
  const manager=createForgeManager(engine,[project],undefined,{desktop});
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=listener.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url+'/api/screen-grant',{method:'POST'})).status,401);
  assert.equal((await fetch(url+'/api/screen-grant',{method:'POST',headers:{Authorization:'Bearer '+manager.token,Origin:'https://foreign.example'}})).status,403);
  assert.equal(grants,0);
  const page=await browser.newPage({locale:'zh-TW'});await page.goto(url+'/#'+manager.token);
  await page.getByText('設定（需要時再打開）',{exact:true}).click();
  await page.getByText('Windows 桌面操作（預覽）',{exact:true}).click();
  await page.getByText('整個桌面截圖會包含所有螢幕與其他可見應用程式內容。這項授權僅允許截圖，不允許全桌面輸入。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'授權所有螢幕截圖 15 分鐘',exact:true}).click();
  await page.locator('#desktop-status').filter({hasText:'all_screens'}).waitFor();assert.equal(grants,1);
});
test('manager denies unauthenticated and foreign-origin actions and rotates lost write lease',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-manager-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),manager=createForgeManager(engine,[project]);
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(async()=>{listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=listener.address();assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url+'/api/tasks')).status,401);
  const headers={Authorization:'Bearer '+manager.token,'Content-Type':'application/json'};
  assert.equal((await fetch(url+'/api/tasks',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const task=engine.create(project,'lost','recover',['echo ok'],true);
  const recovered=await fetch(url+'/api/tasks/'+task.task_id+'/recover',{method:'POST',headers,body:JSON.stringify({fingerprint:task.fingerprint,evidence:'Lost conversation; inspected source'})});
  assert.equal(recovered.status,200);
  const receipt=await recovered.json() as {lease_token:string};
  assert.notEqual(receipt.lease_token,task.lease_token);
  assert.throws(()=>engine.cancel(task.task_id,task.lease_token!),/lease/);
  assert.equal(engine.cancel(task.task_id,receipt.lease_token).status,'cancelled');
});

test('browser recovery endpoints require the browser token, preserve terminal claims and exclude revoked roots',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-manager-delivery-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),roots=[project],manager=createForgeManager(engine,roots,'fixture-browser-token');
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(async()=>{listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=listener.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/api/browser/`;
  const version=JSON.parse(readFileSync(new URL('../browser-extension/manifest.json',import.meta.url),'utf8')).version;
  const call=(path:string,body:object={},token='fixture-browser-token',extension=version)=>fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Forge-Extension-Version':extension},body:JSON.stringify(body)});
  assert.equal((await call('pending',{},manager.token)).status,401);
  const task=engine.create(project,'delivery','delivery',['echo ok'],true),h=engine.prepareHandoff(task.task_id,'next',task.fingerprint,'continue',task.lease_token!);
  engine.queueContinuation(task.task_id,h.handoff_id,task.lease_token!);
  const stale=await call('take',{},'fixture-browser-token','0.4.3');assert.equal(stale.status,409);assert.match((await stale.json() as any).error,/reload the unpacked extension/);
  const job=await (await call('take')).json() as any;
  assert.ok(job.delivery_id);
  assert.equal((engine.db.prepare('SELECT worker_version FROM continuation_receipts').get() as any).worker_version,version);const pending=await (await call('pending')).json() as any[];
  assert.equal(pending.length,1);assert.ok(!JSON.stringify(pending).includes(h.claim_token));
  assert.equal((await call('status',{...job,delivery_id:'wrong'})).status,400);
  engine.claimHandoff(task.task_id,h.handoff_id,h.claim_token,'receiver',task.fingerprint);
  const late=await (await call('update',{...job,state:'unknown',url:'https://chatgpt.com/',note:'late'})).json() as any;
  assert.equal(late.state,'claimed');
  const status=await (await call('status',job)).json() as any;assert.equal(status.state,'claimed');
  roots.splice(0);assert.equal((await call('status',job)).status,400);
  assert.deepEqual(await (await call('pending')).json(),[]);
});

test('manager browser retains auth on reload and accepts a link added to an open tab',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-manager-ui-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),manager=createForgeManager(engine,[project]);
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=listener.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`,page=await browser.newPage({locale:'zh-TW'});
  await page.goto(url);await page.getByText('此分頁沒有管理驗證資訊',{exact:false}).waitFor();
  assert.equal(await page.locator('#grant-screen').isEnabled(),false);
  assert.equal(await page.locator('#auth-help').isVisible(),true);
  // Same-document fragment navigation used to leave the old empty token active.
  await page.goto(url+'/#'+manager.token);await page.getByText('本機連線正常 · 0 個任務',{exact:true}).waitFor();
  assert.equal(await page.locator('#grant-screen').isEnabled(),true);
  assert.equal(await page.locator('#auth-help').isVisible(),false);
  await page.reload();await page.getByText('本機連線正常 · 0 個任務',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).hash,'');
  await page.goto(url+'/#expired');await page.getByText('管理連結已過期',{exact:false}).waitFor();
  assert.equal(await page.locator('#grant-screen').isEnabled(),false);
  assert.equal(await page.locator('#auth-help').isVisible(),true);
  await page.goto(url+'/#'+manager.token);await page.getByText('本機連線正常 · 0 個任務',{exact:true}).waitFor();
});

test('manager renders batch recovery controls and restores a partial batch using local operator authority',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-manager-batch-')),project=join(root,'project');mkdirSync(project);
  writeFileSync(join(project,'a.txt'),'before-a');writeFileSync(join(project,'b.txt'),'before-b');
  const engine=new DurableTasks(join(root,'state')),manager=createForgeManager(engine,[project]);
  const task=engine.create(project,'batch','Recover interrupted batch',['echo ok'],true);
  const batches=new TaskFileBatches(engine,(phase)=>{if(phase==='replaced')throw new Error('Fixture interrupted');});
  assert.equal(batches.write(task.task_id,'partial',[
    {path:'a.txt',content:'after-a',expected_hash:digest('before-a')},
    {path:'b.txt',content:'after-b',expected_hash:digest('before-b')},
  ],task.fingerprint,task.lease_token!).state,'unknown');
  const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const address=listener.address();assert.ok(address&&typeof address!=='string');
  const page=await browser.newPage({locale:'zh-TW',viewport:{width:1280,height:960}});
  await page.goto(`http://127.0.0.1:${address.port}/#${manager.token}`);
  assert.equal(await page.locator('#tasks').isVisible(),false);
  assert.equal(await page.locator('#operation').isVisible(),false);
  await page.getByText('任務紀錄與疑難排解',{exact:true}).click();
  await page.getByRole('button',{name:'Recover interrupted batch · active',exact:true}).click();
  await page.getByText('變更與驗收',{exact:true}).click();
  await page.getByText('人工處理（排除問題時使用）',{exact:true}).click();
  await page.locator('#changes').filter({hasText:'partial'}).waitFor();
  await page.locator('#operation').fill('partial');
  const restore=page.getByRole('button',{name:'還原中斷的整批修改',exact:true});
  await restore.scrollIntoViewIfNeeded();
  if(process.env.FORGE_BATCH_EVIDENCE_DIR)await page.screenshot({path:join(process.env.FORGE_BATCH_EVIDENCE_DIR,'manager-before-recovery.png')});
  await restore.click();await page.getByText('請填寫調查紀錄及新的回復識別碼',{exact:false}).waitFor();
  await page.locator('#handoff').fill('restore-1');await page.locator('#evidence').fill('Writer stopped; both files inspected, restore original contents.');
  await restore.click();await page.locator('#result').filter({hasText:'rolled_back'}).waitFor();
  assert.equal(readFileSync(join(project,'a.txt'),'utf8'),'before-a');assert.equal(readFileSync(join(project,'b.txt'),'utf8'),'before-b');
  assert.equal(engine.status(task.task_id).checkpoint_matches,true);
  assert.ok(engine.status(task.task_id).events.some(event=>event && typeof event==='object' && 'kind' in event && event.kind==='operator_batch_recovery'));
  await restore.scrollIntoViewIfNeeded();
  if(process.env.FORGE_BATCH_EVIDENCE_DIR)await page.screenshot({path:join(process.env.FORGE_BATCH_EVIDENCE_DIR,'manager-after-recovery.png')});
});

test('folder mapping edits preserve other plugins and general mode',async t=>{
 const {ForgeProjectBindings}=await import('./project-bindings.js');const {realpathSync}=await import('node:fs');const {parse}=await import('node:path');
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'forge-mapping-'))),a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b);
 const engine=new DurableTasks(join(root,'state')),bindings=new ForgeProjectBindings(engine,[root]);
 for(const id of ['general','a','b'])bindings.seen(id,'ChatGPT');await bindings.set('a','Forge A',a);await bindings.set('b','Forge B',b);
 const manager=createForgeManager(engine,[root,parse(root).root],undefined,{projectBindings:bindings});const listener=manager.app.listen(0,'127.0.0.1');await once(listener,'listening');const browser=await chromium.launch({channel:'chrome',headless:true});
 t.after(async()=>{await browser.close();listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
 const url='http://127.0.0.1:'+(listener.address() as any).port;
 const listing=await (await fetch(url+'/api/project-bindings',{headers:{Authorization:'Bearer '+manager.token}})).json() as any;assert.ok(listing.projects.every((p:any)=>p.name.trim()));
 const page=await browser.newPage({locale:'zh-TW'});await page.goto(url+'/#'+manager.token);await page.getByText('設定（需要時再打開）',{exact:true}).click();await page.getByText('外掛名稱 → 資料夾',{exact:true}).click();
 const card=page.locator('.binding-row').filter({has:page.getByRole('heading',{name:'Forge A',exact:true})});await card.waitFor();assert.equal(await page.locator('.binding-row').count(),3);assert.equal(await page.locator('#binding-list select').count(),0);
 await card.getByText('修改資料夾',{exact:true}).click();await card.getByLabel('資料夾完整路徑').fill(b);await card.getByRole('button',{name:'儲存資料夾'}).click();await page.locator('#binding-status').filter({hasText:'已設定預設專案'}).waitFor();
 assert.equal(bindings.list().find(r=>r.client_id==='a')!.root,b);assert.equal(bindings.list().find(r=>r.client_id==='b')!.root,b);assert.equal(bindings.list().find(r=>r.client_id==='general')!.root,null);
 await page.reload();await page.getByText('設定（需要時再打開）',{exact:true}).click();await page.getByText('外掛名稱 → 資料夾',{exact:true}).click();await card.getByText('→ '+b,{exact:true}).waitFor();
});

