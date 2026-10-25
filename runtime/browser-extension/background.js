import {runPluginSetup} from './plugin-setup.js';
// Only creates/operates its own new tabs. Never reads cookies, saved passwords,
// unrelated tabs, or developer-tool endpoints. All requests stay on loopback.
let working=false;
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('forge',{periodInMinutes:0.5});chrome.runtime.openOptionsPage();});
chrome.runtime.onStartup.addListener(()=>chrome.alarms.create('forge',{periodInMinutes:0.5}));
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='forge')void tick();});
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  if(message.type==='run'){void tick().then(()=>reply({ok:true}),e=>reply({error:String(e)}));return true;}
});
async function tick(){
  if(working)return;working=true;
  let job,tabId,attempted=false,api;
  try{
    const config=await chrome.storage.local.get(['token','origin','enabled']);
    if(!config.enabled){await status('自動接續未啟用；請勾選啟用並保存設定後再檢查');return;}
    if(!config.token?.trim()){await status('缺少配對碼；請填入並保存設定');return;}
    const origin=new URL(config.origin);if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/')throw Error('Only local ChatGPTForge origin is allowed');
    api=async(path,body)=>{const r=await fetch(origin.origin+'/api/browser/'+path,{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json','X-Forge-Extension-Version':chrome.runtime.getManifest().version},body:JSON.stringify(body??{})});if(!r.ok){if(r.status===404)throw Error('Forge 本機服務版本較舊，請更新並重新啟動 Forge 服務；不用重填配對碼');throw Error('Forge 連線失敗（'+r.status+'），請查看本機服務狀態');}return r.json();};
    if(await runPluginSetup(api)){await status("專案外掛表單已處理，請查看 ChatGPT 分頁");return;}
    const recovery=await recoverDeliveries(api);
    job=await api('take');if(!job){await status(recovery??'已連線，等待交接');return;}
    const tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:false});tabId=tab.id;
    const saved=(await chrome.storage.local.get('deliveries')).deliveries??{};
    saved[job.delivery_id]={task_id:job.task_id,handoff_id:job.handoff_id,delivery_id:job.delivery_id,tabId,marker:job.marker,browserSession:await browserSession()};
    // Persist before touching the composer. Restart recovery only observes this tab.
    await chrome.storage.local.set({deliveries:saved});
    for(let n=0;n<60;n++){const current=await chrome.tabs.get(tabId);if(current.status==='complete'&&current.url?.startsWith('https://chatgpt.com/'))break;await new Promise(r=>setTimeout(r,500));}
    const ready=await chrome.scripting.executeScript({target:{tabId},func:prepare,args:[job.prompt,job.marker]});
    if(!ready[0]?.result?.ok)throw Error(ready[0]?.result?.reason??'Page not ready');
    const intent=await api('update',{...receipt(job),state:'submitting',url:'https://chatgpt.com/',note:'Existing Chrome: durable receipt saved before one click'});
    if(intent.state!=='submitting')throw Error('交接已撤回或接手，停止送出');
    attempted=true;
    const sent=await chrome.scripting.executeScript({target:{tabId},func:sendOnce,args:[job.marker]});
    if(!sent[0]?.result?.ok)throw Error(sent[0]?.result?.reason??'Submission not confirmed');
    await api('update',{...receipt(job),state:'submitted',url:sent[0].result.url,note:'User message observed; awaiting handoff_claim'});
    await status('已送出，等待 ChatGPT 確認接手');
  }catch(e){
    if(job&&api)await api('update',{...receipt(job),state:attempted?'unknown':'blocked',url:'https://chatgpt.com/',note:String(e)}).catch(()=>{});
    await status((attempted?'送出結果不明，禁止重送：':'需要人工處理：')+String(e));
  }finally{working=false;}
}
function receipt(job){return {task_id:job.task_id,handoff_id:job.handoff_id,delivery_id:job.delivery_id};}
async function browserSession(){
  const stored=await chrome.storage.session.get('browserSession');
  if(stored.browserSession)return stored.browserSession;
  const browserSession=crypto.randomUUID();await chrome.storage.session.set({browserSession});return browserSession;
}
async function recoverDeliveries(api){
  const deliveries=(await chrome.storage.local.get('deliveries')).deliveries??{};
  const session=await browserSession();
  const pending=await api('pending');
  let message;
  for(const job of pending){
    const saved=deliveries[job.delivery_id];
    let observed;
    // Chrome may reuse numeric tab IDs after a full browser restart. Session
    // storage survives worker suspension but not browser restart or extension
    // reload, so never inspect a tab from an unproven browser session.
    if(saved?.browserSession===session){
      try{
        const tab=await chrome.tabs.get(saved.tabId);
        if(new URL(tab.url).origin==='https://chatgpt.com'){
          const result=await chrome.scripting.executeScript({target:{tabId:saved.tabId},func:observeDelivery,args:[saved.marker]});
          observed=result[0]?.result;
        }
      }catch{/* Missing tab is an unknown result, never a reason to open another. */}
    }
    if(observed?.submitted && ['submitting','unknown'].includes(job.state)){
      await api('update',{...receipt(job),state:'submitted',url:observed.url,note:'Restart recovery observed original user message; no action replay'});
      message='已核對原分頁送出紀錄，等待 ChatGPT 接手';
    }else if(['opening','submitting'].includes(job.state)){
      await api('update',{...receipt(job),state:'unknown',url:'https://chatgpt.com/',note:'Continuation interrupted; original tab inspected without resending'});
      message='中斷的交接需要核對；已保留原分頁，未重送';
    }else message='交接仍等待確認；未重送';
  }
  for(const [id,saved] of Object.entries(deliveries)){
    const state=await api('status',receipt(saved));
    if(['claimed','obsolete','blocked'].includes(state.state)){
      delete deliveries[id];
      message=state.state==='claimed'?'ChatGPT 已確認接手，任務可在新對話繼續':state.state==='obsolete'?'交接已撤回':'交接已停止，請查看原始原因';
    }
  }
  await chrome.storage.local.set({deliveries});
  return message;
}
function observeDelivery(marker){
  return {submitted:[...document.querySelectorAll('[data-message-author-role="user"]')].some(m=>(m.textContent??'').includes(marker)),url:location.href};
}
async function status(text){await chrome.storage.local.set({lastStatus:text,lastCheck:new Date().toISOString()});}
async function prepare(prompt,marker){
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  let composer;
  // Current ChatGPT uses an id-less ProseMirror textbox. Keep the legacy
  // selector for older UI, but never pick a hidden or ambiguous editor.
  for(let n=0;n<40;n++){
    const candidates=[...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"][role="textbox"]')].filter(e=>e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
    if(candidates.length>1)return {ok:false,reason:'找到多個輸入框，停止以免填入錯誤位置'};
    composer=candidates[0];if(composer)break;await wait(500);
  }
  if(!composer)return {ok:false,reason:'等待 ChatGPT 輸入框逾時；頁面尚未就緒或介面已改版，不能據此判定未登入'};
  if((composer instanceof HTMLTextAreaElement?composer.value:composer.textContent??'').trim())return {ok:false,reason:'新分頁有既有草稿，保留草稿並停止'};
  composer.focus();document.execCommand('insertText',false,'@ChatGPTForge');
  let plugin;
  for(let n=0;n<30;n++){plugin=[...document.querySelectorAll('button,[role="button"]')].find(b=>{const name=b.textContent?.trim();return name==='ChatGPTForge'||name?.startsWith('ChatGPTForge Tunnel');});if(plugin)break;await wait(500);}
  if(!plugin)return {ok:false,reason:'找不到 ChatGPTForge 外掛，請手動啟用'};
  plugin.click();await wait(200);composer.focus();document.execCommand('insertText',false,' '+prompt);
  const preparedText=composer instanceof HTMLTextAreaElement?composer.value:composer.textContent??'';
  return {ok:preparedText.includes(marker),reason:'無法填入交接內容'};
}
async function sendOnce(marker){
  if(globalThis.__forgeSubmittedMarker===marker)return {ok:false,reason:'此交接已嘗試送出，禁止重送'};
  const composers=[...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][contenteditable="true"][role="textbox"]')].filter(e=>e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
  const buttons=[...document.querySelectorAll('[data-testid="send-button"], button[type="submit"][aria-label="Send"]')].filter(e=>e.getClientRects().length);
  if(composers.length!==1||buttons.length!==1)return {ok:false,reason:'無法唯一辨識輸入框或送出按鈕，停止送出'};
  const composer=composers[0],button=buttons[0];
  const preparedText=composer instanceof HTMLTextAreaElement?composer.value:composer?.textContent??'';
  if(!preparedText.includes(marker)||button.disabled||button.getAttribute('aria-disabled')==='true')return {ok:false,reason:'輸入或送出按鈕狀態已變動'};
  globalThis.__forgeSubmittedMarker=marker;
  button.click(); // NEVER retry this action
  for(let n=0;n<60;n++){
    if([...document.querySelectorAll('[data-message-author-role="user"]')].some(m=>m.textContent.includes(marker)))return {ok:true,url:location.href};
    await new Promise(r=>setTimeout(r,500));
  }
  return {ok:false,reason:'無法確認送出；請檢查新分頁，禁止重送'};
}
