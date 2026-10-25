import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync,lstatSync,symlinkSync,linkSync,truncateSync,readdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomInt,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DurableTasks} from './durable-tasks.js';
import {ForgeBrowser} from './forge-browser.js';
import {PreparedUpload} from './forge-browser-files.js';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function listen(server:ReturnType<typeof createServer>){for(let i=0;i<50;i++){server.listen(randomInt(49152,65535),'127.0.0.1');try{await once(server,'listening');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;}}throw Error('No free fixture port');}
async function fixture(t:any,mode:'main'|'oopif'='main'){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-browser-files-')),project=join(root,'project');mkdirSync(project);
  const text=Buffer.from('你好 "uploaded"\n'),binary=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');writeFileSync(join(project,'你好.txt'),text);writeFileSync(join(project,'image.bin'),binary);
  mkdirSync(join(project,'folder'));mkdirSync(join(project,'folder/nested'));writeFileSync(join(project,'folder/a.txt'),'directory a');writeFileSync(join(project,'folder/nested/b.bin'),binary);
  const engine=new DurableTasks(join(root,'state')),browser=new ForgeBrowser(engine,[project]),uploads:any[]=[],requests:string[]=[];
  const html=`<!doctype html><body><input id="single" type="file" aria-label="Single" onchange="recordFiles(this,event)"><input id="multi" type="file" multiple aria-label="Multiple" onchange="recordFiles(this,event)"><input id="directory" type="file" webkitdirectory aria-label="Directory" onchange="recordFiles(this,event)"><input id="hidden" type="file" multiple style="display:none" onchange="recordFiles(this,event)"><button aria-label="Choose" onclick="document.getElementById('hidden').click()">Choose</button><input id="modal" type="file" aria-label="Modal upload" onchange="alert('Upload selected');recordFiles(this,event)"><a aria-label="Download" href="/download" download>Download</a><a aria-label="Slow" href="/slow" download>Slow</a><a aria-label="Huge" href="/huge" download>Huge</a><button aria-label="Blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['owned blob']));a.download='blob.txt';a.click()">Blob</button><a aria-label="Data" href="data:application/octet-stream;base64,AAEC/w==" download="data.bin">Data</a><output id="result">No upload</output><script>
  async function recordFiles(input,event){const selected=[];for(const file of input.files){selected.push({name:file.name,path:file.webkitRelativePath,type:file.type,hex:Array.from(new Uint8Array(await file.arrayBuffer())).map(b=>b.toString(16).padStart(2,'0')).join('')});}document.getElementById('result').textContent=JSON.stringify(selected);await fetch('/uploads',{method:'POST',body:JSON.stringify({input:input.id,trusted:event.isTrusted,files:selected})});}
  </script></body>`;
  let crossOrigin='';const redirect={target:''};
  const handler=(req:any,res:any)=>{
    if(req.url==='/redirect-download'){requests.push(req.url);res.writeHead(302,{Location:redirect.target});res.end();return;}
    if(req.url==='/uploads'){let body='';req.on('data',(b:Buffer)=>body+=b.toString());req.on('end',()=>{uploads.push(JSON.parse(body));res.end('recorded');});return;}
    if(req.url==='/download'){requests.push(req.url);res.writeHead(200,{'Content-Type':'image/png','Content-Disposition':'attachment; filename="../../outside.png"'});res.end(binary);return;}
    if(req.url==='/slow'||req.url==='/huge'){requests.push(req.url);res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="large.csv"','Content-Length':String((req.url==='/huge'?33:4)*1024*1024)});res.write(Buffer.alloc(1024,97));return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(mode==='oopif'&&req.url==='/'?`<!doctype html><body>Parent<iframe name="cross" src="${crossOrigin}/child" style="width:900px;height:600px"></iframe></body>`:html);
  };
  const cross=createServer(handler);if(mode==='oopif'){await listen(cross);crossOrigin='http://localhost:'+(cross.address() as any).port;browser.allow(crossOrigin);}
  const server=createServer(handler);await listen(server);const origin='http://127.0.0.1:'+(server.address() as any).port;browser.allow(origin);
  t.after(async()=>{await browser.close();for(const s of [server,...(mode==='oopif'?[cross]:[])]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}await delay(10);engine.close();assert.equal(realpathSync(root),root);try{const path=join(project,'link.txt');if(lstatSync(path).isSymbolicLink())unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const task=engine.create(project,'files','upload and download owned files',['echo accepted'],true),run=(id:string,args:Parameters<ForgeBrowser['run']>[3])=>browser.run(task.task_id,id,task.lease_token!,args) as Promise<any>;
  let opened=await run('open',{action:'open',url:origin});if(mode==='oopif'){await (browser as any).sessions.get(task.task_id).page.waitForLoadState('load');opened=await run('loaded',{action:'inspect'});}
  const ref=(s:any,label:string)=>{const c=s.controls.find((c:any)=>c.label===label);assert.ok(c,label);return c.ref;};
  const noIntent=(id:string)=>assert.equal(engine.db.prepare('SELECT 1 FROM browser_operations WHERE task_id=? AND id=?').get(task.task_id,id),undefined);
  const waitUploads=async(n:number)=>{for(let i=0;uploads.length<n&&i<100;i++)await delay(20);assert.equal(uploads.length,n);};
  const waitDownload=async(state:string)=>{let list:any;for(let i=0;i<100;i++){list=(await run('downloads-'+state+'-'+i,{action:'downloads'})).downloads;if(list.some((d:any)=>d.state===state))return list.find((d:any)=>d.state===state);await delay(20);}const diagnostics=await run('download-diagnostics-'+state,{action:'console'});throw Error('Missing '+state+' download: '+JSON.stringify({list,console:diagnostics.entries}));};
  return {root,project,text,binary,engine,browser,task,run,opened,origin,crossOrigin,uploads,requests,ref,noIntent,waitUploads,waitDownload,redirect};
}

test('uploads native single/multiple files, clears selection, preserves bytes and replays without a second change',async t=>{
  const f=await fixture(t),args={action:'upload',ref:f.ref(f.opened,'Multiple'),revision:f.opened.revision,paths:['你好.txt','image.bin']};
  let s=await f.run('upload',args);assert.equal(s.state,'completed');assert.deepEqual(s.uploaded_files.map((v:any)=>v.sha256),[hash(f.text),hash(f.binary)]);await f.waitUploads(1);
  assert.equal(f.uploads[0].trusted,true);assert.deepEqual(f.uploads[0].files.map((v:any)=>[v.name,v.hex]),[['你好.txt',f.text.toString('hex')],['image.bin',f.binary.toString('hex')]]);
  assert.deepEqual(await f.run('upload',args),s);assert.equal(f.uploads.length,1);
  s=await f.run('clear',{action:'upload',ref:f.ref(s,'Multiple'),revision:s.revision,paths:[]});await f.waitUploads(2);assert.deepEqual(f.uploads[1].files,[]);
  await f.run('close',{action:'close'});assert.deepEqual(readdirSync(join(f.engine.stateDir,'browser-uploads')),[]);
});

test('a captured native chooser can upload or cancel without changing an existing selection',async t=>{
  const f=await fixture(t);let s=await f.run('choose',{action:'click',ref:f.ref(f.opened,'Choose'),revision:f.opened.revision});assert.equal(s.file_choosers.length,1);
  const id=s.file_choosers[0].chooser_id;assert.equal(s.file_choosers[0].authorized,true);
  assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/pending dialog\/file/);
  s=await f.run('chosen',{action:'upload',chooser_id:id,paths:['image.bin']});await f.waitUploads(1);assert.equal(s.file_choosers.length,0);assert.equal(f.uploads[0].files[0].hex,f.binary.toString('hex'));
  await assert.rejects(f.run('old-chooser',{action:'upload',chooser_id:id,paths:['你好.txt']}),/already handled/);f.noIntent('old-chooser');
  s=await f.run('choose-again',{action:'click',ref:f.ref(s,'Choose'),revision:s.revision});
  s=await f.run('cancel-chooser',{action:'upload',chooser_id:s.file_choosers[0].chooser_id});assert.equal(s.chooser_cancelled,true);assert.equal(f.uploads.length,1);
  const selected=await (f.browser as any).sessions.get(f.task.task_id).page.locator('#hidden').evaluate((e:HTMLInputElement)=>Array.from(e.files!).map(f=>f.name));assert.deepEqual(selected,['image.bin']);
});

test('directory uploads use owned staging and native relative paths',async t=>{
  const f=await fixture(t),s=await f.run('directory',{action:'upload',ref:f.ref(f.opened,'Directory'),revision:f.opened.revision,paths:['folder']});assert.equal(s.state,'completed');await f.waitUploads(1);
  assert.equal(f.uploads[0].trusted,true);assert.deepEqual(f.uploads[0].files.map((v:any)=>v.path).sort(),['folder/a.txt','folder/nested/b.bin']);assert.equal(f.uploads[0].files.find((v:any)=>v.name==='b.bin').hex,f.binary.toString('hex'));
});

test('upload rejects outside paths, links, hardlinks, directories and changed captured controls before intent',async t=>{
  const f=await fixture(t);writeFileSync(join(f.root,'outside.txt'),'outside');symlinkSync(join(f.root,'outside.txt'),join(f.project,'link.txt'));linkSync(join(f.root,'outside.txt'),join(f.project,'hard.txt'));
  for(const [id,paths] of [['outside',['../outside.txt']],['absolute',[join(f.root,'outside.txt')]],['link',['link.txt']],['hard',['hard.txt']],['directory',['folder']],['multiple',['你好.txt','image.bin']]] as [string,string[]][]){await assert.rejects(f.run(id,{action:'upload',ref:f.ref(f.opened,'Single'),revision:f.opened.revision,paths}),/relative path|regular file|multiple files/);f.noIntent(id);}
  const session=(f.browser as any).sessions.get(f.task.task_id);await session.page.locator('#single').evaluate((e:HTMLInputElement)=>e.replaceWith(e.cloneNode(true)));
  await assert.rejects(f.run('replaced',{action:'upload',ref:f.ref(f.opened,'Single'),revision:f.opened.revision,paths:['你好.txt']}),/Page changed/);f.noIntent('replaced');assert.equal(f.uploads.length,0);
});

test('an upload-triggered native modal resumes the same selection once',async t=>{
  const f=await fixture(t),args={action:'upload',ref:f.ref(f.opened,'Modal upload'),revision:f.opened.revision,paths:['image.bin']};
  const pending=await f.run('modal-upload',args);assert.equal(pending.state,'dialog_pending');const result=await f.run('modal-choice',{action:'dialog',dialog_id:pending.dialogs[0].dialog_id,accept:true});assert.equal(result.state,'completed');await f.waitUploads(1);assert.equal(f.uploads[0].files[0].hex,f.binary.toString('hex'));assert.equal((await f.run('modal-upload',args)).state,'completed');
});

test('native downloads retain an immutable hash and save binary bytes without overwriting',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Download'),revision:f.opened.revision},s=await f.run('download-click',args);assert.equal(s.state,'completed');assert.deepEqual(await f.run('download-click',args),s);
  const download=await f.waitDownload('completed');assert.equal(download.sha256,hash(f.binary));assert.equal(download.size,f.binary.length);assert.equal(readFileSync(download.artifact_path).equals(f.binary),true);assert.equal(f.requests.filter(v=>v==='/download').length,1);
  const save={action:'download_save',download_id:download.download_id,path:'received.bin'},saved=await f.run('save',save);assert.equal(saved.saved_download.sha256,hash(f.binary));assert.equal(readFileSync(join(f.project,'received.bin')).equals(f.binary),true);assert.deepEqual(await f.run('save',save),saved);
  await assert.rejects(f.run('overwrite',save),/already exists/);f.noIntent('overwrite');await assert.rejects(f.run('outside-save',{...save,path:'../outside.bin'}),/relative path/);f.noIntent('outside-save');
  await f.run('close',{action:'close'});await f.run('XforgeYdownload:fake',{action:'downloads'});const afterClose=await f.run('after-close',{action:'downloads'});assert.equal(afterClose.downloads.length,1);assert.equal(afterClose.downloads[0].sha256,hash(f.binary));
});

test('pending downloads fence task writes and explicit cancellation does not request a second transfer',async t=>{
  const f=await fixture(t);await f.run('slow',{action:'click',ref:f.ref(f.opened,'Slow'),revision:f.opened.revision});const pending=await f.waitDownload('pending');assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/pending dialog\/file/);
  const args={action:'download_cancel',download_id:pending.download_id},cancelled=await f.run('cancel',args);assert.equal(cancelled.download.state,'cancelled');assert.deepEqual(await f.run('cancel',args),cancelled);assert.equal(f.requests.filter(v=>v==='/slow').length,1);
});

test('a native declared oversize download is cancelled and never published',async t=>{
  const f=await fixture(t);await f.run('huge',{action:'click',ref:f.ref(f.opened,'Huge'),revision:f.opened.revision});const result=await f.waitDownload('cancelled');assert.match(result.reason,/size limit/);assert.equal(result.artifact_path,undefined);assert.equal(f.requests.filter(v=>v==='/huge').length,1);
});

test('blob and data downloads retain native bytes from an authorized document',async t=>{
  for(const label of ['Blob','Data'])await t.test(label,async sub=>{const f=await fixture(sub);await f.run('click',{action:'click',ref:f.ref(f.opened,label),revision:f.opened.revision});const result=await f.waitDownload('completed');assert.equal(readFileSync(result.artifact_path).equals(label==='Blob'?Buffer.from('owned blob'):Buffer.from([0,1,2,255])),true);});
});

test('out-of-process iframe upload and download use their captured source documents',async t=>{
  const f=await fixture(t,'oopif');let s=await f.run('frame-upload',{action:'upload',ref:f.ref(f.opened,'Single'),revision:f.opened.revision,paths:['image.bin']});await f.waitUploads(1);assert.equal(f.uploads[0].files[0].hex,f.binary.toString('hex'));
  await f.run('frame-download',{action:'click',ref:f.ref(s,'Download'),revision:s.revision});const download=await f.waitDownload('completed');assert.equal(download.sha256,hash(f.binary));
});

test('prepared bytes reject source mutation and bounded sizes without dispatch',async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-upload-capture-'));t.after(()=>{assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true});});writeFileSync(join(root,'a.txt'),'original');const prepared=new PreparedUpload(root,['a.txt'],false);writeFileSync(join(root,'a.txt'),'changed');assert.throws(()=>prepared.revalidate(),/changed/);
  writeFileSync(join(root,'large.bin'),'');truncateSync(join(root,'large.bin'),33*1024*1024);assert.throws(()=>new PreparedUpload(root,['large.bin'],false),/32 MiB/);
});

test('native download redirects never contact an ungranted destination',async t=>{
  const f=await fixture(t);let hits=0;const outside=createServer((_req,res)=>{hits++;res.writeHead(200,{'Content-Type':'image/png','Content-Disposition':'attachment; filename="outside.png"'});res.end(f.binary);});await listen(outside);
  t.after(async()=>{outside.closeAllConnections();await new Promise<void>(r=>outside.close(()=>r()));});
  f.redirect.target='http://127.0.0.1:'+(outside.address() as any).port+'/file';
  const page=(f.browser as any).sessions.get(f.task.task_id).page;await page.locator('a[aria-label="Download"]').evaluate((a:HTMLAnchorElement)=>a.href='/redirect-download');
  const s=await f.run('redirect-inspect',{action:'inspect'}),args={action:'click',ref:f.ref(s,'Download'),revision:s.revision};try{await f.run('redirect-click',args);}catch(error){assert.match(String(error),/Execution context was destroyed|origin is not authorized|Frame changed/);}await delay(200);
  assert.equal(f.requests.filter(v=>v==='/redirect-download').length,1);assert.equal(hits,0);assert.equal((await f.run('redirect-list',{action:'downloads'})).downloads.some((d:any)=>d.state==='completed'),false);
  await f.run('redirect-click',args);assert.equal(f.requests.filter(v=>v==='/redirect-download').length,1);assert.equal(hits,0);
});

test('selected File bytes stay available until context close even after the task source changes',async t=>{
  const f=await fixture(t),page=(f.browser as any).sessions.get(f.task.task_id).page;
  await page.locator('#single').evaluate((input:HTMLInputElement)=>input.removeAttribute('onchange'));
  let s=await f.run('deferred-inspect',{action:'inspect'});s=await f.run('deferred-upload',{action:'upload',ref:f.ref(s,'Single'),revision:s.revision,paths:['你好.txt']});assert.equal(s.state,'completed');writeFileSync(join(f.project,'你好.txt'),'replacement source');
  await delay(150);await page.locator('#single').evaluate((input:HTMLInputElement)=>(window as any).recordFiles(input,{isTrusted:false}));await f.waitUploads(1);assert.equal(f.uploads[0].files[0].hex,f.text.toString('hex'));
  assert.equal(readdirSync(join(f.engine.stateDir,'browser-uploads')).length,1);await f.run('deferred-close',{action:'close'});assert.deepEqual(readdirSync(join(f.engine.stateDir,'browser-uploads')),[]);
});

test('revoked or detached captured choosers reject before upload intent',async t=>{
  const f=await fixture(t,'oopif'),s=await f.run('choose',{action:'click',ref:f.ref(f.opened,'Choose'),revision:f.opened.revision}),id=s.file_choosers[0].chooser_id;
  f.browser.origins.delete(f.crossOrigin);const redacted=await f.run('revoked-inspect',{action:'inspect'});assert.equal(redacted.file_choosers[0].authorized,false);assert.equal(redacted.file_choosers[0].source_url,'[unavailable-origin]');
  await assert.rejects(f.run('revoked-upload',{action:'upload',chooser_id:id,paths:['你好.txt']}),/not authorized/);f.noIntent('revoked-upload');f.browser.allow(f.crossOrigin);
  await (f.browser as any).sessions.get(f.task.task_id).page.frame({name:'cross'}).locator('#hidden').evaluate((e:HTMLInputElement)=>e.remove());
  await assert.rejects(f.run('detached-upload',{action:'upload',chooser_id:id,paths:['你好.txt']}),/input or document changed/);f.noIntent('detached-upload');assert.equal(f.uploads.length,0);
});

test('tampered download artifacts cannot be imported into the task',async t=>{
  const f=await fixture(t);await f.run('download',{action:'click',ref:f.ref(f.opened,'Download'),revision:f.opened.revision});const d=await f.waitDownload('completed');writeFileSync(d.artifact_path,Buffer.alloc(d.size,7));
  await assert.rejects(f.run('tampered',{action:'download_save',download_id:d.download_id,path:'bad.bin'}),/hash changed/);f.noIntent('tampered');assert.throws(()=>lstatSync(join(f.project,'bad.bin')),/ENOENT/);
});

test('closing a pending transfer retains unknown and prevents replay or task completion',async t=>{
  const f=await fixture(t),args={action:'click',ref:f.ref(f.opened,'Slow'),revision:f.opened.revision};await f.run('slow',args);const pending=await f.waitDownload('pending');await f.run('close',{action:'close'});
  assert.equal((await f.run('unknown-list',{action:'downloads'})).downloads.find((d:any)=>d.download_id===pending.download_id).state,'unknown');await f.run('slow',args);assert.equal(f.requests.filter(v=>v==='/slow').length,1);
  assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/Unknown browser/);await assert.rejects(f.run('cancel-lost',{action:'download_cancel',download_id:pending.download_id}),/Unknown browser/);f.noIntent('cancel-lost');
  const restarted=new ForgeBrowser(f.engine,[f.project]);assert.equal((await restarted.run(f.task.task_id,'restarted-list',f.task.lease_token!,{action:'downloads'}) as any).downloads[0].state,'unknown');await restarted.close();
});

test('directory revalidation detects new files before native dispatch',async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'forge-upload-directory-'));t.after(()=>{assert.equal(realpathSync(root),root);rmSync(root,{recursive:true,force:true});});mkdirSync(join(root,'folder'));writeFileSync(join(root,'folder/a.txt'),'a');const prepared=new PreparedUpload(root,['folder'],true);writeFileSync(join(root,'folder/b.txt'),'b');assert.throws(()=>prepared.revalidate(),/changed/);
});
