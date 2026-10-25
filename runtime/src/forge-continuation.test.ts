import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {submitContinuation} from './forge-continuation.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
// The extension is now an ES module with plugin-setup imports. Bundle its real
// module graph for isolated DOM/VM fixtures, retaining the same production code.
const extensionFixture=buildSync({stdin:{contents:readFileSync(new URL('../browser-extension/background.js',import.meta.url),'utf8')+'\nexport {prepare,sendOnce,recoverDeliveries};',resolveDir:fileURLToPath(new URL('../browser-extension',import.meta.url)),sourcefile:'background.js'},bundle:true,write:false,format:'iife',globalName:'forgeExtensionFixture',platform:'browser'}).outputFiles[0]!.text;
test('browser adapter records intent before one click and does not retry an ambiguous submission',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();let receipts=0;
    await page.setContent('<p>Sign in required</p>');
    await assert.rejects(submitContinuation(page,'marker',()=>receipts++),/登入/);
    assert.equal(receipts,0);
    await page.setContent('<textarea id="prompt-textarea">keep draft</textarea>');
    await assert.rejects(submitContinuation(page,'marker',()=>receipts++),/草稿/);
    assert.equal(await page.locator('textarea').inputValue(),'keep draft');
    const fixture=(confirm:boolean)=>`<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);${confirm?"const m=document.createElement('p');m.dataset.messageAuthorRole='user';m.textContent=document.querySelector('textarea').value;document.body.append(m)":""}">Send</button>`;
    await page.setContent(fixture(true));
    await submitContinuation(page,'marker\nnext task',()=>receipts++);
    assert.equal(receipts,1);assert.equal(await page.locator('body').getAttribute('data-clicks'),'1');
    await page.setContent(fixture(false));
    await assert.rejects(submitContinuation(page,'ambiguous',()=>receipts++,150));
    assert.equal(receipts,2);assert.equal(await page.locator('body').getAttribute('data-clicks'),'1');
    await page.setContent(fixture(true));
    await assert.rejects(submitContinuation(page,'journal unavailable',()=>{throw new Error('journal unavailable');}),/journal unavailable/);
    assert.equal(await page.locator('body').getAttribute('data-clicks'),null);
  } finally {await browser.close();}
});

test('existing-Chrome extension DOM adapter preserves drafts and sends its prepared message once',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<div contenteditable="true" id="prompt-textarea"></div><button onclick="document.querySelector('#prompt-textarea').textContent=''">ChatGPTForge Tunnel</button><button data-testid="send-button" onclick="const m=document.createElement('p');m.dataset.messageAuthorRole='user';m.textContent=document.querySelector('#prompt-textarea').textContent;document.body.append(m);this.dataset.count=String(Number(this.dataset.count||0)+1)">Send</button>`);
    const mock="globalThis.chrome={action:{onClicked:{addListener(){}}},runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{onAlarm:{addListener(){}}}};\n";
    await page.addScriptTag({content:mock+extensionFixture});
    const result=await page.evaluate(async()=>{
      const api=(globalThis as any).forgeExtensionFixture as {prepare:(p:string,m:string)=>Promise<{ok:boolean}>;sendOnce:(m:string)=>Promise<{ok:boolean}>};
      const composer=document.querySelector('#prompt-textarea')!;composer.textContent='existing draft';
      const blocked=await api.prepare('forge-marker payload','forge-marker');
      const retained=composer.textContent;composer.textContent='';
      const prepared=await api.prepare('forge-marker payload','forge-marker');
      const sent=await api.sendOnce('forge-marker');
      const duplicate=await api.sendOnce('forge-marker');
      return {blocked,retained,prepared,sent,duplicate,count:document.querySelector('[data-testid="send-button"]')!.getAttribute('data-count')};
    });
    assert.equal(result.blocked.ok,false);assert.equal(result.retained,'existing draft');
    assert.equal(result.prepared.ok,true);assert.equal(result.sent.ok,true);assert.equal(result.count,'1');
    assert.equal(result.duplicate.ok,false);
  }finally{await browser.close();}
});

test('existing-Chrome extension textarea adapter preserves drafts and sends its prepared message once',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<textarea id="prompt-textarea"></textarea><button onclick="document.querySelector('#prompt-textarea').value=''">ChatGPTForge Tunnel</button><button data-testid="send-button" onclick="const m=document.createElement('p');m.dataset.messageAuthorRole='user';m.textContent=document.querySelector('#prompt-textarea').value;document.body.append(m);this.dataset.count=String(Number(this.dataset.count||0)+1)">Send</button>`);
    const mock="globalThis.chrome={action:{onClicked:{addListener(){}}},runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{onAlarm:{addListener(){}}}};\n";
    await page.addScriptTag({content:mock+extensionFixture});
    const result=await page.evaluate(async()=>{
      const api=(globalThis as any).forgeExtensionFixture as {prepare:(p:string,m:string)=>Promise<{ok:boolean}>;sendOnce:(m:string)=>Promise<{ok:boolean}>};
      const composer=document.querySelector<HTMLTextAreaElement>('#prompt-textarea')!;composer.value='existing draft';
      const blocked=await api.prepare('forge-marker payload','forge-marker');
      const retained=composer.value;composer.value='';
      const prepared=await api.prepare('forge-marker payload','forge-marker');
      const sent=await api.sendOnce('forge-marker');
      const duplicate=await api.sendOnce('forge-marker');
      return {blocked,retained,prepared,sent,duplicate,count:document.querySelector('[data-testid="send-button"]')!.getAttribute('data-count')};
    });
    assert.equal(result.blocked.ok,false);assert.equal(result.retained,'existing draft');
    assert.equal(result.prepared.ok,true);assert.equal(result.sent.ok,true);assert.equal(result.count,'1');
    assert.equal(result.duplicate.ok,false);
  }finally{await browser.close();}
});

test('current id-less ChatGPT composer preserves drafts, ignores hidden editors and sends once',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(`<div id="prompt-textarea" contenteditable="true" hidden>hidden draft</div><div contenteditable="true" role="textbox" data-composer-markdown aria-label="Ask ChatGPT"></div><button onclick="document.querySelector('[data-composer-markdown]').textContent=''">ChatGPTForge Tunnel</button><button type="submit" aria-label="Send" onclick="const m=document.createElement('p');m.dataset.messageAuthorRole='user';m.textContent=document.querySelector('[data-composer-markdown]').textContent;document.body.append(m);this.dataset.count=String(Number(this.dataset.count||0)+1)">Send</button>`);
    const mock="globalThis.chrome={action:{onClicked:{addListener(){}}},runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{onAlarm:{addListener(){}}}};\n";
    await page.addScriptTag({content:mock+extensionFixture});
    const result=await page.evaluate(async()=>{
      const api=(globalThis as any).forgeExtensionFixture as {prepare:(p:string,m:string)=>Promise<{ok:boolean}>;sendOnce:(m:string)=>Promise<{ok:boolean}>};
      const editor=document.querySelector('[data-composer-markdown]')!;
      editor.textContent='keep my draft';
      const blocked=await api.prepare('forge-marker payload','forge-marker');
      const retained=editor.textContent;editor.textContent='';
      const prepared=await api.prepare('forge-marker payload','forge-marker');
      const clone=editor.cloneNode(true);document.body.append(clone);
      const ambiguous=await api.sendOnce('forge-marker');clone.parentNode!.removeChild(clone);
      const button=document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      button.disabled=true;const disabled=await api.sendOnce('forge-marker');button.disabled=false;
      const sent=await api.sendOnce('forge-marker');const duplicate=await api.sendOnce('forge-marker');
      return {blocked,retained,prepared,ambiguous,disabled,sent,duplicate,count:button.dataset.count,hidden:document.querySelector('#prompt-textarea')!.textContent};
    });
    assert.equal(result.blocked.ok,false);assert.equal(result.retained,'keep my draft');
    assert.equal(result.prepared.ok,true);assert.equal(result.ambiguous.ok,false);assert.equal(result.disabled.ok,false);
    assert.equal(result.sent.ok,true);assert.equal(result.duplicate.ok,false);assert.equal(result.count,'1');assert.equal(result.hidden,'hidden draft');
  }finally{await browser.close();}
});

test('extension restart observes only its recorded tab and never repeats input or creates a replacement tab',async()=>{
  const job={task_id:'task',handoff_id:'handoff',delivery_id:'delivery',state:'submitting'};
  const stored:any={deliveries:{delivery:{...job,tabId:7,marker:'marker',browserSession:'current-session'}}};
  const calls:string[]=[];let state='submitting';
  const listener={addListener(){}};
  const context:any={URL,setTimeout,chrome:{action:{onClicked:listener},runtime:{onInstalled:listener,onStartup:listener,onMessage:listener},alarms:{onAlarm:listener},
    storage:{session:{async get(){return {browserSession:'current-session'};}},local:{async get(){return structuredClone(stored);},async set(value:object){Object.assign(stored,value);}}},
    tabs:{async get(id:number){assert.equal(id,7);return {url:'https://chatgpt.com/c/original'};},create(){throw Error('must not create a tab during recovery');}},
    scripting:{async executeScript(input:any){calls.push(input.func.name);assert.equal(input.target.tabId,7);return [{result:{submitted:true,url:'https://chatgpt.com/c/original'}}];}}}};
  runInNewContext(extensionFixture,context);
  const api=async(path:string,body?:any)=>{
    if(path==='pending')return state==='claimed'?[]:[{...job,state}];
    if(path==='status')return {state};
    assert.equal(path,'update');assert.equal(body.state,'submitted');state=body.state;return {state};
  };
  await context.forgeExtensionFixture.recoverDeliveries(api);
  assert.equal(state,'submitted');assert.deepEqual(calls,['observeDelivery']);
  state='claimed';const message=await context.forgeExtensionFixture.recoverDeliveries(api);
  assert.match(message,/已確認接手/);assert.equal(Object.keys(stored.deliveries).length,0);
});

test('extension recovery records lost tab as unknown and preserves the no-resend boundary',async()=>{
  const listener={addListener(){}},updates:any[]=[];
  const context:any={URL,setTimeout,chrome:{action:{onClicked:listener},runtime:{onInstalled:listener,onStartup:listener,onMessage:listener},alarms:{onAlarm:listener},
    storage:{session:{async get(){return {browserSession:'current-session'};}},local:{async get(){return {deliveries:{}};},async set(){}}},tabs:{create(){throw Error('must not create');}},scripting:{executeScript(){throw Error('must not inject');}}}};
  runInNewContext(extensionFixture,context);
  await context.forgeExtensionFixture.recoverDeliveries(async(path:string,body?:any)=>{
    if(path==='pending')return [{task_id:'task',handoff_id:'handoff',delivery_id:'lost',state:'opening'}];
    assert.equal(path,'update');updates.push(body);return {state:body.state};
  });
  assert.equal(updates.length,1);assert.equal(updates[0].state,'unknown');
});

test('full Chrome restart never inspects a recycled tab ID from the previous browser session',async()=>{
  const listener={addListener(){}},updates:any[]=[];let tabReads=0,injections=0;
  const job={task_id:'task',handoff_id:'handoff',delivery_id:'old',state:'submitting'};
  const context:any={URL,setTimeout,chrome:{action:{onClicked:listener},runtime:{onInstalled:listener,onStartup:listener,onMessage:listener},alarms:{onAlarm:listener},
    storage:{session:{async get(){return {browserSession:'new-session'};}},local:{async get(){return {deliveries:{old:{...job,tabId:7,marker:'marker',browserSession:'old-session'}}};},async set(){}}},
    tabs:{get(){tabReads++;throw Error('must not read recycled tab');}},scripting:{executeScript(){injections++;throw Error('must not inspect recycled tab');}}}};
  runInNewContext(extensionFixture,context);
  await context.forgeExtensionFixture.recoverDeliveries(async(path:string,body?:any)=>{
    if(path==='pending')return [job];if(path==='status')return {state:'unknown'};
    assert.equal(path,'update');updates.push(body);return {state:body.state};
  });
  assert.equal(updates.length,1);assert.equal(updates[0].state,'unknown');
  assert.equal(tabReads,0);assert.equal(injections,0);
});

