import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {DurableTasks} from './durable-tasks.js';
import {createForgeManager} from './forge-manager.js';
test('inventory search and status filters work through the authenticated Manager UI',async()=>{
 const root=mkdtempSync(join(tmpdir(),'forge-inventory-')),project=join(root,'project');mkdirSync(project);
 const engine=new DurableTasks(join(root,'state'));let calls=0,doctorCalls=0;
 const gateway={list:async()=>{calls++;return {servers:[{id:'ready-alpha',approved:true,tools:[{name:'echo'}]},{id:'pending-beta',approved:false},{id:'broken-gamma',approved:true,error:'Fixture offline'}]};},
  doctor:async()=>{doctorCalls++;return {ok:false,checks:[{id:'ready-alpha',status:'ready',safe_call:'success'},{id:'pending-beta',status:'unapproved'},{id:'broken-gamma',status:'unavailable',next:'Check transport'}]};}};
 const manager=createForgeManager(engine,[project],undefined,{gateway:gateway as any}),server=manager.app.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const url='http://127.0.0.1:'+(server.address() as any).port;
 assert.equal((await fetch(url+'/api/mcp-doctor')).status,401);
 const page=await browser.newPage();await page.goto(url+'/#'+manager.token);
 await page.locator('#mcp-inventory').evaluate((el:any)=>el.open=true);await page.locator('#mcp-refresh').click();await page.locator('#mcp-count').filter({hasText:'3 / 3'}).waitFor();
 for(const [value,expected]of [['ready','ready-alpha'],['pending','pending-beta'],['error','broken-gamma']]){await page.locator('#mcp-filter').selectOption(value!);assert.equal(await page.locator('#mcp-rows pre').count(),1);assert.match(await page.locator('#mcp-rows').innerText(),new RegExp(expected!));}
 await page.locator('#mcp-filter').selectOption('all');await page.locator('#mcp-search').fill('echo');assert.equal(await page.locator('#mcp-rows pre').count(),1);
 await page.locator('#mcp-search').fill('missing');assert.equal(await page.locator('#mcp-count').innerText(),'0 / 3');await page.locator('#mcp-search').fill('');assert.equal(await page.locator('#mcp-rows pre').count(),3);assert.ok(calls>=1);
 await page.locator('#mcp-search').focus();await page.keyboard.type('echo');assert.equal(await page.locator('#mcp-rows pre').count(),1);await page.keyboard.press('ControlOrMeta+A');await page.keyboard.press('Backspace');assert.equal(await page.locator('#mcp-rows pre').count(),3);
 await page.locator('#mcp-doctor').click();await page.locator('#mcp-doctor-status').filter({hasText:'需要診斷'}).waitFor();
 assert.equal(doctorCalls,1);assert.equal(await page.locator('#mcp-doctor-rows pre').count(),3);
 assert.match(await page.locator('#mcp-doctor-rows').innerText(),/Check transport/);
 if(process.env.FORGE_ACCEPTANCE_ARTIFACTS)await page.locator('#mcp-inventory').screenshot({path:resolve(process.env.FORGE_ACCEPTANCE_ARTIFACTS,'manager-inventory.png')});
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));engine.close();rmSync(root,{recursive:true,force:true,maxRetries:5});}
});
