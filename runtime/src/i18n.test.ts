import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {chromium} from 'playwright-core';
import {DurableTasks} from './durable-tasks.js';
import {createForgeManager} from './forge-manager.js';
import {SingleUserOAuthProvider} from './oauth-provider.js';
import {languageScript, locales, markLocalizedHtml, resolveLocale, translate} from './i18n.js';
import {messages} from './i18n-messages.js';
import {workspaceAppHtml} from './server.js';

test('five-language catalogs are complete and preserve interpolation fields', () => {
  assert.deepEqual(['zh-TW','en-US','zh-CN','ja-JP','ko-KR','zh-HK','zh_SG','de-DE'].map(resolveLocale), ['zh-Hant','en','zh-Hans','ja','ko','zh-Hant','zh-Hans',undefined]);
  for (const [key, row] of Object.entries(messages)) {
    assert.equal(row.length, 5, key);
    const fields = (text:string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const copy of row) { assert.ok(copy.trim(), key); assert.deepEqual(fields(copy), fields(row[1]), key); }
  }
  assert.equal(translate('Check connection','ja'), '接続を確認');
  assert.equal(translate('Show {count} more files','ko',{count:4}), '파일 4개 더 보기');
  assert.equal(translate('C:\\Projects\\unchanged.ts','en'), 'C:\\Projects\\unchanged.ts');
  assert.doesNotMatch(languageScript(), /__name\(/, 'HTML bootstrap must run independently of the TS loader');
});

test('manager switches all five languages, remembers choice, syncs tabs and preserves draft input', async t => {
  const root=mkdtempSync(join(tmpdir(),'forge-i18n-'));
  const engine=new DurableTasks(join(root,'state'));
  const manager=createForgeManager(engine,[root]);
  const server=manager.app.listen(0,'127.0.0.1'); await once(server,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const context=await browser.newContext({locale:'zh-TW'});
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const url=`http://127.0.0.1:${address.port}`;
  await page.goto(url+'/#'+manager.token);
  await page.locator('#message').filter({hasText:'本機連線正常'}).waitFor();
  await page.locator('#new-plugin').evaluate((node:HTMLDetailsElement)=>{node.open=true;});
  await page.locator('#new-plugin-name').fill('My project 日本語');
  await page.locator('#new-plugin-path').fill('C:\\Projects\\我的專案');
  for (const locale of locales) {
    await page.locator('[data-language-select]').selectOption(locale);
    assert.equal(await page.locator('html').getAttribute('lang'),locale);
    assert.equal(await page.locator('#refresh').textContent(),translate('Check connection',locale));
    assert.equal(await page.locator('#new-plugin-name').inputValue(),'My project 日本語');
    assert.equal(await page.locator('#new-plugin-path').inputValue(),'C:\\Projects\\我的專案');
    assert.equal(await page.locator('#new-plugin-name').getAttribute('placeholder'),translate('e.g. ChatGPTForge_MyWebsite',locale));
    assert.equal(await page.locator('#desktop-window').getAttribute('aria-label'),translate('Window to authorize',locale));
    if(locale==='en') {
      const untranslated=await page.evaluate(()=>{
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const found:string[]=[];
        while(walker.nextNode()) {const node=walker.currentNode;if(node.parentElement?.closest('script,style,option,[data-language-select]'))continue;if(/[\u3400-\u9fff]/.test(node.textContent??''))found.push(node.textContent??'');}
        return found;
      });
      assert.deepEqual(untranslated,[], 'All static manager copy must have an English translation');
    }
  }
  await page.reload();
  assert.equal(await page.locator('[data-language-select]').inputValue(),'ko');
  const other=await context.newPage();await other.goto(url+'/#'+manager.token);
  await page.locator('[data-language-select]').selectOption('ja');
  await other.waitForFunction(()=>document.documentElement.lang==='ja');
  // Verify the packaged page, its auth help, and all inline status messages.
  const screenshot=new URL('../docs/assets/i18n-manager-ja.png',import.meta.url);
  await page.screenshot({path:screenshot.pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
  assert.deepEqual(errors,[]);
});

test('plain HTML works without storage and leaves code and unmarked content untouched', async t => {
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({locale:'ja-JP'});
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('denied','SecurityError');}}));
  await page.goto('about:blank');
  await page.setContent(markLocalizedHtml('<html><body><main><button>Check connection</button><pre id="code" data-no-i18n>Check connection</pre><input value="Check connection"></main></body></html>').replace('<pre id="code" data-i18n>','<pre id="code" data-no-i18n>'));
  await page.addScriptTag({content:languageScript()});
  assert.equal(await page.locator('button').textContent(),'接続を確認');
  await page.locator('[data-language-select]').selectOption('ko');
  assert.equal(await page.locator('button').textContent(),'연결 확인');
  assert.equal(await page.locator('#code').textContent(),'Check connection');
  assert.equal(await page.locator('input').inputValue(),'Check connection');
});

test('OAuth preserves password and hidden authorization fields while switching languages', async t => {
  const root=mkdtempSync(join(tmpdir(),'forge-oauth-i18n-'));
  const provider=new SingleUserOAuthProvider({ownerToken:'test-owner',accessTokenTtlSeconds:3600,refreshTokenTtlSeconds:7200,scopes:['devspace'],allowedResourceUrls:[],allowedRedirectHosts:['chatgpt.com']},new URL('https://forge.example'),root);
  const app=express();
  app.get('/',(req,res)=>{void provider.authorize({client_id:'test',client_name:'User project 日本語',redirect_uris:['https://chatgpt.com/redirect']},{redirectUri:'https://chatgpt.com/redirect',codeChallenge:'challenge',resource:new URL('https://forge.example/mcp'),scopes:['devspace'],state:'unchanged-state'},res);});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));provider.close();rmSync(root,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const page=await browser.newPage({locale:'en-US'});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('#owner_token').fill('password-draft');
  for(const locale of locales){
    await page.locator('[data-language-select]').selectOption(locale);
    assert.equal(await page.locator('button[type=submit]').textContent(),translate('Authorize ChatGPTForge',locale));
    assert.equal(await page.locator('#owner_token').inputValue(),'password-draft');
    assert.equal(await page.locator('input[name=state]').inputValue(),'unchanged-state');
    assert.match(await page.locator('dl').textContent()??'',/User project 日本語/);
  }
  assert.deepEqual(errors,[]);
});

test('extension uses the shared catalog and preserves unsaved pairing configuration',async t=>{
  const app=express();const extension=new URL('../browser-extension/',import.meta.url);
  app.get('/',(_req,res)=>res.type('html').send(readFileSync(new URL('options.html',extension),'utf8')));
  app.get('/language.js',(_req,res)=>res.type('js').send(readFileSync(new URL('language.js',extension),'utf8')));
  app.get('/options.js',(_req,res)=>res.type('js').send(readFileSync(new URL('options.js',extension),'utf8')));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const page=await browser.newPage({locale:'en-US'});
  await page.addInitScript(()=>{(window as any).chrome={storage:{local:{get:async()=>({token:'saved-code',enabled:true})}}};});
  const address=server.address();assert.ok(address&&typeof address!=='string');await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('#token').fill('unsaved-secret');
  for(const locale of locales){await page.locator('[data-language-select]').selectOption(locale);assert.equal(await page.locator('#save').textContent(),translate('Save settings',locale));assert.equal(await page.locator('#token').inputValue(),'unsaved-secret');}
  await page.reload();assert.equal(await page.locator('[data-language-select]').inputValue(),'ko');
});

test('packaged workspace card renders and switches five languages without translating instruction content',async t=>{
  const app=express();
  app.get('/card',(_req,res)=>res.type('html').send(workspaceAppHtml()));
  app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><script>
    window.addEventListener('message',event=>{
      const message=event.data;
      if(message.method==='ui/initialize') event.source.postMessage({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'test-host',version:'1'},hostCapabilities:{},hostContext:{theme:'dark',displayMode:'inline'}}},'*');
      if(message.method==='ui/notifications/initialized') event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],structuredContent:{workspace_id:'ws_test',root:'C:/Projects/日本語',mode:'checkout',agents_files:[{path:'AGENTS.md',content:'Check connection'}],skills:[{name:'User skill'}]}}},'*');
    });
    </script><iframe id="card" src="/card" style="width:900px;height:700px"></iframe>`));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const page=await browser.newPage({locale:'en-US'});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const address=server.address();assert.ok(address&&typeof address!=='string');await page.goto(`http://127.0.0.1:${address.port}`);
  const frame=page.frameLocator('#card');
  await frame.locator('.tool-title').waitFor();
  for(const locale of locales){
    await frame.locator('[data-language-select]').selectOption(locale);
    assert.equal(await frame.locator('.tool-title').textContent(),translate('Workspace',locale));
    assert.equal(await frame.locator('.tool-label').textContent(),'C:/Projects/日本語');
  }
  await frame.locator('.workspace-instruction-header.interactive').click();
  assert.equal(await frame.locator('.workspace-instruction-preview').textContent(),'Check connection');
  await page.evaluate(()=>{
    const target=(document.querySelector('#card') as HTMLIFrameElement).contentWindow!;
    target.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],structuredContent:{files:[{path:'example.ts',type:'change'}],patch:'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;\n'}}},'*');
  });
  for(const locale of locales){
    await frame.locator('[data-language-select]').selectOption(locale);
    await frame.locator('.review-header').waitFor();
    assert.equal(await frame.locator('.tool-title').textContent(),translate('Edited {count} file',locale,{count:1}));
    assert.equal(await frame.locator('.stats').getAttribute('aria-label'),translate('Diff statistics',locale));
  }
  assert.deepEqual(errors,[]);
});
