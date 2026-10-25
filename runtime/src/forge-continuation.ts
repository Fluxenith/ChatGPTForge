import {chromium,type Page} from 'playwright-core';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.js';
import {DurableTasks} from './durable-tasks.js';
import {resolveCanonicalAllowedPath} from './roots.js';
import {realpath} from 'node:fs/promises';
import {continuationPrompt} from './handoff-context.js';

// Deliberately small DOM adapter. Unknown submission never falls back to Enter,
// retries a click, or opens a second conversation. No model API is used.
export async function submitContinuation(page:Page,text:string,beforeClick:()=>void,confirmationTimeout=20000) {
  const composer=page.locator('#prompt-textarea');
  if(await composer.count()!==1 || !await composer.isVisible()) throw new Error('登入未完成或 ChatGPT 輸入介面已變更；請手動處理。');
  const draft=await composer.evaluate(e=>e instanceof HTMLTextAreaElement ? e.value : e.textContent??'');
  if(draft.trim())throw new Error('輸入介面已有草稿；保留草稿並停止');
  await composer.fill(text,{timeout:10000});
  const send=page.locator('[data-testid="send-button"]');
  if(await send.count()!==1 || !await send.isEnabled()) throw new Error('送出按鈕不可用；可能需要登入、等待額度或更新介面。');
  beforeClick(); // durable receipt BEFORE the one and only click
  await send.click({timeout:10000});
  const marker=text.split('\n')[0]!;
  await page.locator('[data-message-author-role="user"]').filter({hasText:marker}).first().waitFor({state:'visible',timeout:confirmationTimeout});
}

export async function runContinuation(mode:string) {
  const configDir=process.env.CHATGPTFORGE_CONFIG_DIR??join(homedir(),'.chatgptforge');
  const env:NodeJS.ProcessEnv={...process.env,DEVSPACE_CONFIG_DIR:configDir};delete env.DEVSPACE_OAUTH_OWNER_TOKEN;
  const config=loadConfig(env),engine=new DurableTasks(config.stateDir);
  const channel=process.env.CHATGPTFORGE_BROWSER??'chrome';
  if(!['chrome','msedge'].includes(channel))throw new Error('CHATGPTFORGE_BROWSER must be chrome or msedge');
  const context=await chromium.launchPersistentContext(join(configDir,channel+'-profile'),{channel,headless:false,chromiumSandbox:true});
  try {
    if(mode==='login') {
      const page=context.pages()[0]??await context.newPage();await page.goto('https://chatgpt.com/');
      console.log(`請在專用 ${channel==='chrome'?'Chrome':'Edge'} 視窗登入 ChatGPT 並確認 ChatGPTForge 工具可用；關閉視窗後完成。`);
      await new Promise<void>(r=>context.once('close',()=>r()));return;
    }
    engine.db.prepare("UPDATE continuation_receipts SET state='unknown',note='Continuation process restarted during submission; inspect the dedicated browser, do not resend',updated=? WHERE state IN ('opening','submitting')").run(Date.now());
    do {
      const rows=engine.db.prepare("SELECT r.*,h.claim_token,h.fingerprint,h.note AS next_goal,h.state AS handoff_state FROM continuation_receipts r JOIN handoffs h ON h.task_id=r.task_id AND h.id=r.handoff_id WHERE r.state='queued'").all() as {task_id:string;handoff_id:string;claim_token:string;fingerprint:string;next_goal:string;handoff_state:string}[];
      for(const row of rows) {
        if(row.handoff_state!=='prepared') {engine.db.prepare("UPDATE continuation_receipts SET state='obsolete',updated=? WHERE task_id=? AND handoff_id=?").run(Date.now(),row.task_id,row.handoff_id);continue;}
        if(!engine.db.prepare("UPDATE continuation_receipts SET state='opening',updated=? WHERE task_id=? AND handoff_id=? AND state='queued'").run(Date.now(),row.task_id,row.handoff_id).changes)continue;
        let clicked=false;let page:Page|undefined;
        const update=(state:string,note:string)=>engine.db.prepare("UPDATE continuation_receipts SET state=?,url=?,note=?,updated=? WHERE task_id=? AND handoff_id=? AND state NOT IN ('claimed','obsolete')").run(state,page?.url()??null,note,Date.now(),row.task_id,row.handoff_id);
        try {
          const root=engine.task(row.task_id).root;
          await resolveCanonicalAllowedPath(root,root,await Promise.all(config.allowedRoots.map(r=>realpath(r))));
          page=await context.newPage();await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:30000});
          update('opening','等待專用 ChatGPT 介面');
          const {prompt}=continuationPrompt(engine,row.task_id,row.handoff_id);
          await submitContinuation(page,prompt,()=>{
            if(!(engine.db.prepare("SELECT 1 FROM handoffs WHERE task_id=? AND id=? AND state='prepared'").get(row.task_id,row.handoff_id)))throw new Error('交接已撤回');
            update('submitting','送出結果尚未確認，禁止重送');clicked=true;
          });
          update('submitted','已在頁面確認送出；等待 handoff_claim，尚未轉移寫入權');
        } catch(error) {update(clicked?'unknown':'blocked',String(error));}
      }
      // Only the MCP claim transfers ownership; a visible message is not a claim.
      engine.db.prepare("UPDATE continuation_receipts SET state='claimed',updated=? WHERE state IN ('submitted','unknown','opening','submitting') AND EXISTS(SELECT 1 FROM handoffs h WHERE h.task_id=continuation_receipts.task_id AND h.id=continuation_receipts.handoff_id AND h.state='claimed')").run(Date.now());
      if(mode==='watch')await delay(5000);
    } while(mode==='watch');
  } finally {await context.close();engine.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const mode=process.argv[2];if(!['login','once','watch'].includes(mode??''))throw new Error('Usage: forge-continuation.js login|once|watch');
  await runContinuation(mode!);
}
