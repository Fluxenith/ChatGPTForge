import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

test('isolated browser cookies, storage, request mocks, trace, PDF, evaluate and assertions stay inside granted origins',{timeout:180_000},async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-browser-extras-')),project=join(root,'project');mkdirSync(join(project,'out'),{recursive:true});
  writeFileSync(join(project,'existing.pdf'),'keep');
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  let apiHits=0;
  const site=createServer((req,res)=>{
    if(req.url?.startsWith('/api/data')){apiHits++;res.setHeader('Content-Type','text/plain');res.end('real');return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><body><h1>Hello extras</h1><input aria-label="Name" value="initial"><button aria-label="Load">Load</button><output id="out"></output><script>document.querySelector("button").onclick=async()=>{document.getElementById("out").textContent=await (await fetch("/api/data")).text();};</script></body>');
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');const origin='http://127.0.0.1:'+(site.address() as any).port;
  t.after(async()=>{await browser.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  browser.allow(origin);
  const task=engine.create(project,'extras','browser extras',['echo ok'],true);
  const run=(id:string,args:any)=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const refuse=async(id:string,args:any,pattern:RegExp)=>{await assert.rejects(run(id,args),pattern);noIntent(id);};
  let s=await run('open',{action:'open',url:origin});

  // Cookies: only authorized origins; exact replay returns the receipt.
  await refuse('cookie-foreign',{action:'cookie_set',url:'http://example.com/',name:'x',value:'y'},/not authorized/);
  const set={action:'cookie_set',url:origin+'/',name:'session',value:'abc'};
  const cookie=await run('cookie',set);assert.deepEqual(await run('cookie',set),cookie);
  const cookies=await run('cookies',{action:'cookies'});assert.ok(cookies.cookies.some((c:any)=>c.name==='session'&&c.value==='abc'));
  s=await run('inspect-1',{action:'inspect'});
  assert.equal((await run('eval-cookie',{action:'evaluate',expression:'document.cookie',revision:s.revision})).result,'"session=abc"');
  await refuse('eval-stale',{action:'evaluate',expression:'1',revision:s.revision},/Stale/);
  await run('cookie-clear',{action:'cookie_clear',name:'session'});assert.equal((await run('cookies-2',{action:'cookies'})).cookies.length,0);

  // Web Storage.
  s=await run('inspect-2',{action:'inspect'});
  const stored=await run('storage-set',{action:'storage_set',kind:'local',storage_key:'k',value:'v',revision:s.revision});
  assert.deepEqual(stored.entries,[{key:'k',value:'v',value_truncated:false}]);assert.equal(stored.revision_invalidated,true);
  assert.equal((await run('storage-read',{action:'storage',kind:'local'})).length,1);
  s=await run('inspect-3',{action:'inspect'});
  assert.equal((await run('storage-clear',{action:'storage_clear',kind:'local',revision:s.revision})).length,0);

  // Request mocking never reaches the site; unroute restores real responses.
  await refuse('route-foreign',{action:'route',url_pattern:'http://example.com/**',status:200,body:'x'},/authorized origin/);
  const mocked=await run('route',{action:'route',url_pattern:origin+'/api/**',status:200,body:'mocked',content_type:'text/plain'});
  const click=async(id:string)=>{const snap=await run('inspect-'+id,{action:'inspect'});const button=snap.controls.find((c:any)=>c.label==='Load');await run(id,{action:'click',ref:button.ref,revision:snap.revision});};
  await click('click-mocked');
  let passed=false;for(let i=0;i<40&&!passed;i++){passed=(await run('assert-mocked-'+i,{action:'assert',assertion:'text_visible',text:'mocked'})).passed;if(!passed)await delay(50);}
  assert.equal(passed,true);assert.equal(apiHits,0);
  assert.equal((await run('routes',{action:'routes'})).routes[0].hits,1);
  await run('unroute',{action:'unroute',route_id:mocked.route.route_id});
  await click('click-real');
  passed=false;for(let i=0;i<40&&!passed;i++){passed=(await run('assert-real-'+i,{action:'assert',assertion:'text_visible',text:'real'})).passed;if(!passed)await delay(50);}
  assert.equal(passed,true);assert.equal(apiHits,1);
  assert.equal((await run('assert-missing',{action:'assert',assertion:'text_visible',text:'not on the page'})).passed,false);
  s=await run('inspect-4',{action:'inspect'});const name=s.controls.find((c:any)=>c.label==='Name');
  assert.equal((await run('assert-value',{action:'assert',assertion:'value',ref:name.ref,revision:s.revision,value:'initial'})).passed,true);

  // Trace and PDF are new task files only.
  await run('trace-start',{action:'trace_start'});
  await run('inspect-traced',{action:'inspect'});
  const trace=await run('trace-stop',{action:'trace_stop',path:'out/trace.zip'});
  assert.equal(readFileSync(join(project,'out/trace.zip')).subarray(0,2).toString(),'PK');assert.ok(trace.trace.size>0);
  await refuse('pdf-existing',{action:'pdf',path:'existing.pdf'},/already exists/);
  await refuse('pdf-escape',{action:'pdf',path:'../outside.pdf'},/outside|task-relative/);
  await run('pdf',{action:'pdf',path:'out/page.pdf'});
  assert.equal(readFileSync(join(project,'out/page.pdf')).subarray(0,4).toString(),'%PDF');
  assert.equal(readFileSync(join(project,'existing.pdf'),'utf8'),'keep');
  await run('close',{action:'close'});
});
