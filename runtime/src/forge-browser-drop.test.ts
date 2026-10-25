import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomInt,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';

async function listen(server:ReturnType<typeof createServer>){
  for(let attempt=0;attempt<50;attempt++){
    server.listen(randomInt(49152,65535),'127.0.0.1');
    try{await once(server,'listening');return;}catch(e){if((e as NodeJS.ErrnoException).code!=='EADDRINUSE')throw e;}
  }
  throw Error('No fixture port');
}

async function fixture(t:any){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-drop-')),project=join(root,'task');mkdirSync(project);
  const content=Buffer.from('File bytes: 你好\n');writeFileSync(join(project,'text.txt'),content);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]);
  const events:any[]=[];
  const html=`<html><body><div role="region" aria-label="External drop target" style="width:300px;height:160px;border:1px solid black">Drop here</div><output id="result">none</output><script>
    const target=document.querySelector('[role=region]');
    target.addEventListener('dragover',event=>event.preventDefault());
    target.addEventListener('drop',async event=>{
      event.preventDefault();
      const files=await Promise.all([...event.dataTransfer.files].map(async file=>({name:file.name,type:file.type,hex:[...new Uint8Array(await file.arrayBuffer())].map(b=>b.toString(16).padStart(2,'0')).join('')})));
      const data={};for(const type of event.dataTransfer.types){if(type!=='Files')data[type]=event.dataTransfer.getData(type);}
      await fetch('/drop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files,data,trusted:event.isTrusted})});
      document.getElementById('result').textContent='dropped '+files.length;
    });
  </script></body></html>`;
  const server=createServer((req,res)=>{
    if(req.url==='/drop'){
      let body='';req.on('data',(part:Buffer)=>body+=part.toString());req.on('end',()=>{events.push(JSON.parse(body));res.end('recorded');});return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
  });
  await listen(server);
  t.after(async()=>{
    await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});
  });
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;browser.allow(origin);
  const task=engine.create(project,'drop','test native external drops',['echo verified'],true);
  const run=(id:string,input:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,input) as Promise<any>;
  const opened=await run('open',{action:'open',url:origin});
  const target=(snapshot:any)=>{const element=snapshot.controls.find((c:any)=>c.label==='External drop target');assert.ok(element);return element.ref as string;};
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const wait=async(count:number)=>{for(let i=0;events.length<count&&i<50;i++)await delay(20);assert.equal(events.length,count);};
  return {browser,engine,task,run,opened,target,noIntent,events,content,origin,wait};
}

test('external native drop delivers pinned files and MIME data, returns metadata and is replay-safe',async t=>{
  const f=await fixture(t);
  const args={action:'drop',ref:f.target(f.opened),revision:f.opened.revision,paths:['text.txt'],mime_data:{'text/plain':'hello drop','text/uri-list':'https://example.org/'}};
  const result=await f.run('drop',args);await f.wait(1);
  assert.equal(result.state,'completed');
  assert.equal(result.dropped_files[0].sha256,createHash('sha256').update(f.content).digest('hex'));
  assert.deepEqual(result.dropped_mime_types,['text/plain','text/uri-list']);
  // Playwright's drop API synthesizes the DataTransfer event in the page.
  assert.equal(f.events[0].trusted,false);
  assert.deepEqual(f.events[0].files,[{name:'text.txt',type:'text/plain',hex:f.content.toString('hex')}]);
  assert.equal(f.events[0].data['text/plain'],'hello drop');
  assert.equal(f.events[0].data['text/uri-list'],'https://example.org/');
  assert.deepEqual(await f.run('drop',args),result);
  assert.equal(f.events.length,1);
  const next=await f.run('inspect',{action:'inspect'});
  assert.match(next.text,/dropped 1/);
});

test('drop supports data-only and refuses invalid, stale or revoked targets before writing intent',async t=>{
  const f=await fixture(t),ref=f.target(f.opened),revision=f.opened.revision;
  for(const [id,args,expected] of [
    ['empty',{action:'drop',ref,revision},/requires paths or MIME/],
    ['traversal',{action:'drop',ref,revision,paths:['../outside']},/task-relative path/],
    ['invalid-type',{action:'drop',ref,revision,mime_data:{'not a mime':'hello'}},/MIME data exceeds/],
  ] as [string,Parameters<ForgeBrowser['run']>[3],RegExp][]){await assert.rejects(f.run(id,args),expected);f.noIntent(id);}
  const good={action:'drop',ref,revision,mime_data:{'text/plain':'data only'}};
  const result=await f.run('data',good);await f.wait(1);
  assert.equal(result.dropped_files.length,0);
  assert.equal(f.events[0].data['text/plain'],'data only');
  await assert.rejects(f.run('stale',good),/Stale/);f.noIntent('stale');
  const latest=await f.run('inspect-new',{action:'inspect'});
  f.browser.origins.delete(f.origin);
  await assert.rejects(f.run('revoked',{action:'drop',ref:f.target(latest),revision:latest.revision,mime_data:{'text/plain':'secret'}}),/not authorized/);
  f.noIntent('revoked');assert.equal(f.events.length,1);
});
