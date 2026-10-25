import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

test('authorized multi-frame accessibility audit reports bounded issues, respects grants and keeps revision', {timeout:90000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-a11y-')),project=join(root,'project');
  mkdirSync(project);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const outsider=createServer((_req,res)=>{
    res.setHeader('content-type','text/html');
    res.end('<html lang="en"><title>Unapproved</title><body>BLOCKED-SENSITIVE-TEXT<img></body></html>');
  });
  outsider.listen(0,'127.0.0.1');await once(outsider,'listening');
  const external='http://127.0.0.1:'+(outsider.address() as {port:number}).port;
  const site=createServer((req,res)=>{
    res.setHeader('content-type','text/html');
    if(req.url==='/child'){
      res.end('<!doctype html><html lang="en"><head><title>Child</title></head><body><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs"></body></html>');
      return;
    }
    if(req.url==='/clean'){
      res.end('<!doctype html><html lang="en"><head><title>Clean fixture</title></head><body>'+
        '<main><h1>Clean</h1><label for="search">Search</label><input id="search">'+
        '<button aria-label="Save"></button><a href="/next">Next</a><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs"></main>'+
        '</body></html>');
      return;
    }
    res.end('<!doctype html><html><head><title>Main</title></head><body>'+
      '<h1>Example</h1><h3>Skipped heading</h3>'+
      '<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs">'+
      '<input id="search" placeholder="Find"><input id="search" type="password" value="NEVER-REVEAL">'+
      '<button aria-label="Save" id="save"></button><button></button>'+
      '<a href="/next"></a><div aria-labelledby="unknown-target"></div>'+
      '<div aria-hidden="true"><button tabindex="0">Hidden from screen readers</button></div>'+
      '<iframe title="Child content" src="/child"></iframe>'+
      '<iframe title="External content" src="'+external+'/unapproved?token=NEVER-REVEAL"></iframe>'+
      '</body></html>');
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');
  const origin='http://127.0.0.1:'+(site.address() as {port:number}).port;browser.allow(origin);
  t.after(async()=>{
    await browser.close();
    site.closeAllConnections();outsider.closeAllConnections();
    await Promise.all([new Promise<void>(r=>site.close(()=>r())),new Promise<void>(r=>outsider.close(()=>r()))]);
    engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const task=engine.create(project,'a11y','inspect accessibility candidates',['echo ok'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url:origin});
  const page=(browser as any).sessions.get(task.task_id).page;
  for(let attempt=0;attempt<30&&page.frames().length<3;attempt++)await new Promise(r=>setTimeout(r,50));
  assert.equal(page.frames().length,3,'both authorized and blocked iframes should exist');
  const inspected=await run('inspect',{action:'inspect'});
  const result=await run('audit',{action:'accessibility_audit',max_issues:3});
  assert.equal(result.state,'completed');
  assert.equal(result.scope,'current_tab');
  assert.equal(result.frames_scanned,2);
  assert.equal(result.frames_blocked,1);
  assert.equal(result.complete_evidence,false);
  assert.equal(result.passed,false);
  assert.equal(result.issues.length,3);
  assert.equal(result.issues_omitted,result.findings_total-3);
  for(const rule of ['document-lang','image-alt','button-name','link-name','form-label','broken-aria-reference','duplicate-id','focusable-aria-hidden','heading-order'])
    assert.ok(result.by_rule[rule]>=1,rule);
  assert.equal(result.by_rule['image-alt'],2,'both authorized frames are included');
  assert.ok(result.frames.some((f:any)=>f.status==='blocked'));
  assert.equal(JSON.stringify(result).includes('NEVER-REVEAL'),false,'secret values and blocked frame URL must be omitted');
  assert.equal(JSON.stringify(result).includes(external),false,'unapproved origin must not appear');
  assert.deepEqual(await run('audit',{action:'accessibility_audit',max_issues:3}),result,'read-only audit replays exact result');
  const saved=inspected.controls.find((c:any)=>c.label==='Save');assert.ok(saved);
  const clicked=await run('click-after-audit',{action:'click',ref:saved.ref,revision:inspected.revision});
  assert.equal(clicked.state,'completed','audit preserves pre-existing browser DOM references');
  const child=inspected.frames.find((f:any)=>f.authorized&&f.url.endsWith('/child'));
  assert.ok(child);
  const childOnly=await run('child-audit',{action:'accessibility_audit',frame_id:child.frame_id});
  assert.equal(childOnly.scope,'frame');
  assert.equal(childOnly.frames_scanned,1);
  assert.equal(childOnly.frames_blocked,0);
  assert.equal(childOnly.by_rule['image-alt'],1);
  assert.equal(childOnly.by_rule['document-lang'],undefined);
  const blockedFrame=inspected.frames.find((f:any)=>!f.authorized);
  assert.ok(blockedFrame);
  await assert.rejects(run('blocked-audit',{action:'accessibility_audit',frame_id:blockedFrame.frame_id}),/not authorized/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'blocked-audit'),undefined);
  await assert.rejects(run('invalid-limit',{action:'accessibility_audit',max_issues:0}),/max_issues/);
  await assert.rejects(run('wrong-limit',{action:'inspect',max_issues:3}),/only valid/);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'invalid-limit'),undefined);
  assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,'wrong-limit'),undefined);
  await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<span></span>'.repeat(2100)));
  const incomplete=await run('bounded',{action:'accessibility_audit',max_issues:1});
  assert.equal(incomplete.nodes_truncated,true);
  assert.equal(incomplete.complete_evidence,false);
  assert.equal(incomplete.passed,false);
  await run('clean-tab',{action:'new_tab',url:origin+'/clean'});
  const clean=await run('clean-audit',{action:'accessibility_audit'});
  assert.equal(clean.complete_evidence,true);
  assert.equal(clean.findings_total,0);
  assert.equal(clean.passed,true);
});
