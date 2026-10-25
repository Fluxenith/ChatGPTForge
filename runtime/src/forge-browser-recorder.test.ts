import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

test('authorized interactive Chrome actions become replayable redacted Playwright code with frame selectors and durable receipts',{timeout:70_000},async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-codegen-')),project=join(root,'site');
  mkdirSync(join(project,'out'),{recursive:true});
  const site=createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    if(request.url?.startsWith('/child'))return response.end('<button id="inside">Inside iframe</button>');
    response.end(`<!doctype html><body><label for="name">Name</label><input id="name" type="text">
      <input id="password" type="password"><input id="agree" type="checkbox">
      <select id="fruit"><option value="">Choose</option><option value="banana">Banana</option></select>
      <button id="save">Save</button><button id="secret_access_token_2468">Private selector</button>
      <iframe id="child" src="/child"></iframe><a id="next" href="/next">Next</a></body>`);
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  const origin='http://127.0.0.1:'+(site.address() as {port:number}).port;
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  t.after(async()=>{await browser.close();site.closeAllConnections();await new Promise<void>(resolve=>site.close(()=>resolve()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  browser.allow(origin);
  const task=engine.create(project,'rec','record code',['echo ok'],true);
  const run=(id:string,input:any)=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT * FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const open=await run('open',{action:'open',url:origin+'/?access_token=should_never_appear'});
  assert.equal(open.state,'completed');
  const page=(browser as any).sessions.get(task.task_id).page;
  const started=await run('start',{action:'record_start'});
  assert.equal(started.recording,true);
  assert.equal((await run('status',{action:'record_status'})).record_id,started.record_id);
  await assert.rejects(run('start-twice',{action:'record_start'}),/already active/i);noIntent('start-twice');
  await assert.rejects(run('wrong-suffix',{action:'record_stop',path:'out/flow.txt'}),/filename must end/);noIntent('wrong-suffix');

  await page.locator('#save').click();
  await page.locator('#secret_access_token_2468').click();
  await page.locator('#name').fill('private-name@example.test');
  await page.locator('#name').press('Tab');
  await page.locator('#agree').check();
  await page.locator('#fruit').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#fruit').inputValue(),'banana');
  await page.locator('#password').fill('top_secret_password_999');
  await page.locator('#password').press('Tab');
  await page.frameLocator('#child').locator('#inside').click();
  await Promise.all([page.waitForURL(origin+'/next'),page.locator('#next').click()]);
  // Pause long enough for exposed-binding callbacks to reach the local recorder.
  await page.waitForTimeout(110);
  const state=await run('status-updated',{action:'record_status'});
  assert.ok(state.actions>=5,JSON.stringify(state));
  for(const [language,extension,expected] of [
    ['python','py',/\.set_checked\(True\)/],
    ['java','java',/\.setChecked\(true\)/],
    ['csharp','cs',/\.SetCheckedAsync\(true\)/]
  ] as const){
    const snapshot=await run('export-'+language,{action:'record_export',path:'out/flow.'+extension});
    assert.equal(snapshot.recording,true,'export snapshots must not stop recording');
    assert.equal(snapshot.code_language,language);
    assert.equal(snapshot.record_id,started.record_id);
    const source=readFileSync(join(project,'out/flow.'+extension),'utf8');
    assert.match(source,expected);assert.ok(!source.includes('should_never_appear'));
    assert.ok(!source.includes('secret_access_token_2468'));
    if(language==='python'){
      assert.match(source,/page\.frame_locator\("#child"\)\.locator\("#inside"\)\.click\(\)/);
      // Python syntax must compile; optional on machines without Python.
      const python=spawnSync(process.platform==='win32'?'python':'python3',
        ['-c','import ast,sys; ast.parse(sys.stdin.read())'],
        {input:source,encoding:'utf8',timeout:5000});
      if(!python.error)assert.equal(python.status,0,python.stderr);
    }
    if(language==='csharp')assert.match(source,/page\.FrameLocator\("#child"\)\.Locator\("#inside"\)\.ClickAsync\(\)/);
    assert.ok(!source.includes('private-name@example.test'));
    assert.ok(!source.includes('top_secret_password_999'));
  }
  // Closing another tab is allowed, but closing the recorded tab must not
  // silently destroy an unfinished demonstration while a different tab is active.
  const recordedTab=(await run('tabs-before',{action:'tabs'})).tabs.find((tab:any)=>tab.active).tab_id;
  await run('other-tab',{action:'new_tab',url:origin+'/child'});
  const otherTab=(await run('tabs-after',{action:'tabs'})).tabs.find((tab:any)=>tab.active).tab_id;
  await assert.rejects(run('close-recorded-tab',{action:'close_tab',tab_id:recordedTab}),/Stop code recording/);
  noIntent('close-recorded-tab');
  await run('close-other-tab',{action:'close_tab',tab_id:otherTab});
  const stopped=await run('stop',{action:'record_stop',path:'out/flow.ts'});
  assert.equal(stopped.recording,false);
  assert.equal(stopped.dropped,0);
  assert.equal(stopped.script.path,'out/flow.ts');
  const code=readFileSync(join(project,'out/flow.ts'),'utf8');
  assert.equal(stopped.inputs_required,2);
  assert.match(code,/import \{ chromium \} from 'playwright-core'/);
  assert.match(code,/page\.goto\(/);
  assert.match(code,/#save/);
  assert.match(code,/\.locator\("#next"\)\.click\(\)/);
  assert.match(code,/page\.goto\("http:\/\/127\.0\.0\.1:\d+\/next"\)/);
  assert.ok(code.indexOf('.locator("#next").click()')<code.indexOf('/next"'),
    'navigation must replay after the click that triggered it');
  assert.match(code,/\.setChecked\(true\)/);
  assert.match(code,/\.selectOption\(required\("FORGE_INPUT_2"\)\)/);
  assert.match(code,/frameLocator\("#child"\)\.locator\("#inside"\)\.click/);
  assert.match(code,/FORGE_INPUT_1/);
  assert.ok(!code.includes('private-name@example.test'));
  assert.ok(!code.includes('top_secret_password_999'));
  assert.ok(!code.includes('secret_access_token_2468'));
  assert.ok(!code.includes('should_never_appear'));
  assert.ok(!code.includes('banana'));
  assert.deepEqual(await run('stop',{action:'record_stop',path:'out/flow.ts'}),stopped,'finished record_stop returns its receipt without rewriting');
  assert.equal((await run('status-finished',{action:'record_status'})).recording,false);
  await assert.rejects(run('stop-no-record',{action:'record_stop',path:'out/other.ts'}),/Start code recording/);noIntent('stop-no-record');
  await run('close',{action:'close'});
});
