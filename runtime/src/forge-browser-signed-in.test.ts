import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

test('signed-in profile is opt-in, persists sign-in state across sessions and stays origin-scoped',{timeout:180_000},async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-signed-in-')),project=join(root,'project'),profile=join(root,'profile');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  const signedIn=new ForgeBrowser(engine,[project],{userDataDir:profile,headless:true}),plain=new ForgeBrowser(engine,[project]);
  const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body><h1>Signed-in fixture</h1></body>');});
  site.listen(0,'127.0.0.1');await once(site,'listening');const origin='http://127.0.0.1:'+(site.address() as any).port;
  t.after(async()=>{await signedIn.close();await plain.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  signedIn.allow(origin);plain.allow(origin);
  const task=engine.create(project,'signed-in','signed-in profile',['echo ok'],true);
  const run=(browser:ForgeBrowser,id:string,args:any)=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  await assert.rejects(run(plain,'not-enabled',{action:'open',url:origin,profile:'signed_in'}),/not enabled/);noIntent('not-enabled');
  await assert.rejects(run(signedIn,'bad-profile',{action:'inspect',profile:'signed_in'}),/only valid for open/);noIntent('bad-profile');
  await assert.rejects(run(signedIn,'foreign',{action:'open',url:'http://example.com/',profile:'signed_in'}),/授權/);noIntent('foreign');
  const opened=await run(signedIn,'open-1',{action:'open',url:origin,profile:'signed_in'});assert.equal(opened.profile,'signed_in');
  await run(signedIn,'login',{action:'cookie_set',url:origin+'/',name:'session',value:'signed',expires:Math.floor(Date.now()/1000)+3600});
  await run(signedIn,'close-1',{action:'close'});
  // A new session on the same dedicated profile still has the sign-in cookie.
  await run(signedIn,'open-2',{action:'open',url:origin,profile:'signed_in'});
  assert.ok((await run(signedIn,'cookies-2',{action:'cookies'})).cookies.some((c:any)=>c.name==='session'&&c.value==='signed'));
  await run(signedIn,'close-2',{action:'close'});
  // The isolated profile never sees it.
  const isolated=await run(signedIn,'open-iso',{action:'open',url:origin});assert.equal(isolated.profile,'isolated');
  assert.equal((await run(signedIn,'cookies-iso',{action:'cookies'})).cookies.length,0);
  await assert.rejects(run(signedIn,'mix',{action:'open',url:origin,profile:'signed_in'}),/Close the isolated session/);noIntent('mix');
  await run(signedIn,'close-iso',{action:'close'});
});
