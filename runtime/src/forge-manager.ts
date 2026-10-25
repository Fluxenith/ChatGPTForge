import type {ForgeMcpGateway} from './forge-mcp-gateway.js';
import {languageScript, markLocalizedHtml} from './i18n.js';
import type {ForgePluginSetup} from './forge-plugin-setup.js';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';
import {realpath} from 'node:fs/promises';
import {DurableTasks} from './durable-tasks.js';
import {TaskFiles} from './task-files.js';
import {BrowserBridge} from './browser-bridge.js';
import {resolveCanonicalAllowedPath} from './roots.js';
import {projectDirectory} from './project-access.js';
import type {ForgeBrowser} from './forge-browser.js';
import type {ForgeDesktop} from './forge-desktop.js';
import type {ForgeSkillsManager} from './forge-skills-manager.js';
import type {ForgeProjectBindings} from './project-bindings.js';
import {basename} from 'node:path';

export function createForgeManager(engine:DurableTasks,allowedRoots:string[],browserToken:string=randomUUID(),options:{gateway?:ForgeMcpGateway,pluginSetup?:ForgePluginSetup,saveRoots?:(roots:string[])=>void,browser?:ForgeBrowser,desktop?:ForgeDesktop,skillsManager?:ForgeSkillsManager,projectBindings?:ForgeProjectBindings}={}) {
  const app=express(), token=randomUUID();
  const files=new TaskFiles(engine);
  const bridge=new BrowserBridge(engine);
  let pendingRoots=[...allowedRoots];
  const pendingProjectGrants=new Set<string>();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const origin=`http://127.0.0.1:${req.socket.localPort}`;
    if(req.headers.host!==new URL(origin).host || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')) {res.sendStatus(403);return;}
    const extension=req.path.startsWith('/api/browser/') && /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin??'');
    if(req.headers.origin && req.headers.origin!==origin && !extension) {res.sendStatus(403);return;}
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if(extension){res.setHeader('Access-Control-Allow-Origin',req.headers.origin!);res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Forge-Extension-Version');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');if(req.method==='OPTIONS'){res.sendStatus(204);return;}}
    if(req.path.startsWith('/api/') && req.headers.authorization!==`Bearer ${req.path.startsWith('/api/browser/')?browserToken:token}`) {res.sendStatus(401);return;}
    if(req.path.startsWith('/api/browser/'))bridge.seen(req.get('x-forge-extension-version'));
    next();
  });
  app.use(express.json({limit:'32kb'}));
  app.get('/api/mcp-inventory',async(_req,res)=>{try{res.json(await options.gateway?.list()??{servers:[]});}catch{res.status(502).json({error:'MCP inventory unavailable'});}});
  app.get('/api/mcp-doctor',async(_req,res)=>{try{res.json(await options.gateway?.doctor()??{ok:true,checks:[]});}catch{res.status(502).json({error:'MCP Doctor unavailable'});}});
  app.get('/api/access',(_req,res)=>res.json({projects:allowedRoots,origins:[...(options.browser?.origins??[])]}));
  app.post('/api/browser/plugin-setup-take',(_req,res)=>res.json(options.pluginSetup?.take()??null));
  app.post('/api/browser/plugin-setup-report',(req,res)=>{try{res.json(options.pluginSetup?.report(req.body.id,req.body.state,req.body.note));}catch(e){res.status(409).json({error:String(e)});}});
  app.post('/api/plugin-setups/:id/open',(req,res)=>{try{const worker=bridge.workerStatus();if(!worker.ready)throw Error('Chrome 擴充功能尚未就緒，請先在 Chrome 啟用並更新 Forge 擴充功能');res.json(options.pluginSetup?.queue(req.params.id));}catch(e){res.status(400).json({error:e instanceof Error?e.message:String(e)});}});
  app.get('/api/plugin-setups/:id',(req,res)=>{try{res.json(options.pluginSetup?.status(req.params.id));}catch(e){res.status(400).json({error:String(e)});}});
  app.post('/api/plugin-setups',async(req,res)=>{try{if(!options.pluginSetup)throw Error('新增外掛功能尚未啟用');res.json(await options.pluginSetup.prepare(req.body.name,req.body.path));}catch(e){res.status(400).json({error:e instanceof Error?e.message:String(e)});}});
  app.get('/api/plugin-setups',(_req,res)=>res.json(options.pluginSetup?.list()??[]));
  app.get('/api/plugin-setups/:id/archive',(req,res)=>{try{if(!options.pluginSetup)throw Error('新增外掛功能尚未啟用');const a=options.pluginSetup.archive(req.params.id);res.setHeader('Content-Disposition','attachment; filename="'+a.filename+'"');res.type('application/gzip').send(a.bytes);}catch(e){res.status(400).json({error:e instanceof Error?e.message:String(e)});}});
  app.get('/api/project-bindings',(_req,res)=>res.json({connections:options.projectBindings?.list()??[],projects:pendingRoots.map(path=>({name:basename(path)||path,path,pending:!allowedRoots.includes(path)}))}));
  app.post('/api/project-bindings',async(req,res)=>{try{
    if(!options.projectBindings)throw Error('Project bindings unavailable');
    let restartRequired=false;
    const approveProject=req.body.approve_project===true||pendingProjectGrants.has(req.body.path)?(root:string)=>{
      if(!options.saveRoots)throw Error('Project selection unavailable');
      const roots=[...new Set([...pendingRoots,root])];
      options.saveRoots(roots);pendingRoots=roots;pendingProjectGrants.add(root);restartRequired=true;
    }:undefined;
    const connection=req.body.unbind===true?options.projectBindings.unbind(req.body.client_id):await options.projectBindings.set(req.body.client_id,req.body.name,req.body.path,approveProject);
    res.json({connection,message:restartRequired?'自訂預設專案已保存，重啟 Forge 後生效':connection.root?'已設定預設專案；未指定路徑時使用，仍可操作其他目錄':'已設為通用入口',restart_required:restartRequired});
  }catch(e){res.status(400).json({error:e instanceof Error?e.message:String(e)});}});
  app.get('/api/windows',async(_req,res)=>{try{res.json(await options.desktop?.windows()??[]);}catch(e){res.status(500).json({error:String(e)});}});
  app.post('/api/access', (req,res)=>{try{
    if(req.body.kind==='project'){
      if(!options.saveRoots)throw Error('Project selection unavailable');
      const path=projectDirectory(req.body.value);
      const roots=[...new Set([...pendingRoots,path])];options.saveRoots(roots);pendingRoots=roots;pendingProjectGrants.add(path);
      res.json({message:'專案已保存，重啟 Forge 後生效',projects:roots,restart_required:true});
    }else if(req.body.kind==='origin'){
      if(!options.browser)throw Error('Browser unavailable');
      res.json({message:'網站已授權，本次服务有效',origins:options.browser.allow(req.body.value)});
    }else if(req.body.kind==='desktop-revoke'){options.desktop?.revoke();res.json({message:'已撤回所有桌面與視窗授權'});
    }else throw Error('Unknown access kind');
  }catch(e){res.status(400).json({error:String(e)});}});
  app.post('/api/window-grant',async(req,res)=>{try{if(!options.desktop)throw Error('Desktop unavailable');if(req.body.hwnd!==undefined&&(typeof req.body.hwnd!=='string'||!/^\d+$/.test(req.body.hwnd)))throw Error('Invalid window handle');res.json(await options.desktop.grant(Number(req.body.pid),req.body.hwnd));}catch(e){res.status(400).json({error:String(e)});}});
  app.post('/api/desktop-session-grant',async(_req,res)=>{try{if(!options.desktop)throw Error('Desktop unavailable');res.json(await options.desktop.grantSession());}catch(e){res.status(400).json({error:String(e)});}});
  app.post('/api/screen-grant',(_req,res)=>{try{if(!options.desktop)throw Error('Desktop unavailable');res.json(options.desktop.grantScreen());}catch(e){res.status(400).json({error:String(e)});}});
  const allowed=async(id:string)=>{
    const root=engine.task(id).root;
    await resolveCanonicalAllowedPath(root,root,await Promise.all(allowedRoots.map(r=>realpath(r))));
  };
  app.get('/api/pairing',(_req,res)=>res.json({token:browserToken,origin:`http://127.0.0.1:${_req.socket.localPort}`}));
  app.post('/api/browser/take',async(req,res)=>{
    try {const version=req.get('x-forge-extension-version');for(const row of bridge.candidates()){try{await allowed(row.task_id);}catch{continue;}const job=bridge.take(row.task_id,row.handoff_id,version);if(job){res.json(job);return;}}res.json(null);}
    catch(e){res.status(409).json({error:String(e)});}
  });
  app.post('/api/browser/update',async(req,res)=>{
    try {const b=req.body;await allowed(b.task_id);res.json(bridge.update(b.task_id,b.handoff_id,b.delivery_id,b.state,b.url,b.note??''));}
    catch(e){res.status(409).json({error:String(e)});}
  });
  app.post('/api/browser/status',async(req,res)=>{
    try {const b=req.body;await allowed(b.task_id);res.json(bridge.status(b.task_id,b.handoff_id,b.delivery_id));}
    catch(e){res.status(400).json({error:String(e)});}
  });
  app.post('/api/browser/pending',async(_req,res)=>{
    try {const rows=[];for(const row of bridge.pending()){try{await allowed(row.task_id);rows.push(row);}catch{/* revoked root */}}res.json(rows);}
    catch(e){res.status(400).json({error:String(e)});}
  });
  app.get('/api/tasks',async(_req,res)=>{
    const rows=[];for(const row of engine.list()) {try{await allowed(row.id);rows.push(row);}catch{}}
    res.json(rows);
  });
  app.get('/api/tasks/:id',async(req,res)=>{try{await allowed(req.params.id);res.json({...engine.status(req.params.id),file_changes:files.list(req.params.id)});}catch(e){res.status(400).json({error:String(e)});}});
  app.post('/api/tasks/:id/:action',async(req,res)=>{
    try {
      const id=req.params.id;await allowed(id);
      const b=req.body as Record<string,string>; const row=engine.task(id);let result:unknown;
      if(typeof b.fingerprint!=='string' || engine.status(id).fingerprint!==b.fingerprint) throw new Error('檔案已變動，請重新讀取後核對。');
      const lease=row.lease_token??undefined;
      switch(req.params.action) {
        case 'review-skills-manager':
          if(!options.skillsManager)throw Error('Skills Manager 未設定，請先恢復原服務端點');
          if(typeof b.operation_id!=='string'||typeof b.evidence!=='string'||(b.manager_run_id!==undefined&&typeof b.manager_run_id!=='string')||(b.manager_run_not_created!==undefined&&typeof b.manager_run_not_created!=='boolean'))throw Error('請填寫技能操作識別碼、調查紀錄及核對後的流程紀錄');
          result=await options.skillsManager.reconcile(id,b.operation_id,b.fingerprint,b.evidence,userInfo().username,b.manager_run_id||undefined,b.manager_run_not_created===true);break;
        case 'review-interaction':
          if(engine.interactionBusy.has(id)||!b.evidence?.trim())throw Error('請等待操作停止，並填寫人工核對紀錄');
          for(const table of ['browser_operations','desktop_operations','mcp_gateway_operations'])if(engine.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))engine.db.prepare(`UPDATE ${table} SET state='reviewed' WHERE task_id=? AND state='unknown'`).run(id);
          engine.event(id,'interaction_reviewed',{evidence:b.evidence,operator:userInfo().username});result={message:'未知操作已人工核對；原操作仍不可重送，請重新驗收'};break;
        case 'cancel': result=engine.cancel(id,lease);break;
        case 'recover-batch':
          if(!['finish','rollback'].includes(b.mode??''))throw new Error('請指定 finish 或 rollback');
          if(!b.evidence?.trim() || !b.recovery_id?.trim())throw new Error('請填寫調查紀錄及新的回復識別碼');
          result=files.batches.recover(id,b.operation_id!,b.recovery_id!,b.mode as 'finish'|'rollback',b.fingerprint,lease);
          engine.event(id,'operator_batch_recovery',{operation_id:b.operation_id,recovery_id:b.recovery_id,mode:b.mode,evidence:b.evidence,operator:userInfo().username});break;
        case 'reconcile': result=await engine.reconcile(id,b.operation_id!,b.fingerprint,b.evidence??'',userInfo().username);break;
        case 'recover': result=engine.recoverLease(id,b.fingerprint,b.evidence??'');break;
        case 'review-tests':result=engine.operatorReview(id,b.fingerprint,b.evidence??'',userInfo().username,'tests');break;
        case 'review-retry':result=engine.operatorReview(id,b.fingerprint,b.evidence??'',userInfo().username,'retry');break;
        case 'prepare':result=engine.prepareHandoff(id,b.handoff_id!,b.fingerprint,b.evidence??'',lease??'');break;
        case 'withdraw':result=engine.withdrawHandoff(id,b.handoff_id!,lease??'');break;
        case 'rollback':result=files.rollback(id,b.operation_id!,b.handoff_id!,lease);break;
        case 'submit':result=engine.queueContinuation(id,b.handoff_id!,lease??'');break;
        default:throw new Error('Unknown action');
      }
      res.json(result);
    } catch(e) {res.status(409).json({error:e instanceof Error?e.message:String(e)});}
  });
  app.get('/',(_req,res)=>res.type('html').send(markLocalizedHtml(html)));
  app.get('/manager.js',(_req,res)=>res.type('js').send(script));
  return {app,token};
}

const html=`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ChatGPTForge 管理</title>
<style>body{margin:0;background:#111820;color:#e5edf5;font:16px system-ui}header{padding:24px 32px;border-bottom:1px solid #35424e}h1{margin:0 0 8px;font-size:26px}main{max-width:920px;margin:auto;padding:28px}.binding-row{border-bottom:1px solid #35424e;padding:12px 0}.binding-folder{overflow-wrap:anywhere}.binding-row input{width:100%;box-sizing:border-box}summary{cursor:pointer;font-weight:600}details{border:1px solid #35424e;border-radius:10px;padding:16px}details details{border:0;padding:8px 0}a{color:#8acbff}.welcome{padding:24px;background:#18232d;border-radius:12px;margin-bottom:24px}.welcome li{margin:14px 0;line-height:1.6}#tasks{max-height:340px;overflow:auto}#tasks button{display:block;width:100%;text-align:left;margin:8px 0}button,select,input,textarea{font:inherit;padding:10px;background:#21303e;color:inherit;border:1px solid #567082;border-radius:6px}button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}button:hover{background:#365367}aside button{display:block;width:100%;text-align:left;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#18232d;padding:16px;border-radius:8px}textarea{width:95%;height:90px}label{display:block;margin:12px 0}#message{color:#ffd58a}details{margin:16px 0}small{color:#aabfce}.actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:750px){main{display:block}}</style>
<header><h1>ChatGPTForge</h1><small>讓 ChatGPT 幫你操作本機專案</small><p id="message" role="status">正在連線…</p><p id="auth-help" role="alert" hidden>管理驗證尚未完成，授權與任務操作已停用。請從 Forge 啟動器開啟管理頁，或在專案中執行 scripts/Open-ForgeManager.ps1；只輸入 localhost 網址不會取得管理權限。</p></header>
<main><section class="welcome" aria-labelledby="shared-entry-title"><h2 id="shared-entry-title">開始使用</h2><p id="shared-entry-status" role="status">正在確認本機連線…</p><ol><li>打開 <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT Web</a>。</li><li>在輸入框選擇 <strong>ChatGPTForge</strong>，或你要用的專案外掛。</li><li>直接說要做什麼，例如：「幫我看看這個專案」。通用外掛請一起提供資料夾路徑。</li></ol><p>平常在 ChatGPT 操作就好，這個頁面可以關掉。</p><button id="refresh">檢查連線</button></section><details id="new-plugin"><summary>新增專案外掛</summary><p>填兩個欄位，Forge 會在 Chrome 填好 ChatGPT 外掛表單。你只要確認建立並連接，資料夾就會自動對應。</p><label>外掛名稱<input id="new-plugin-name" maxlength="80" placeholder="例如 ChatGPTForge_我的網站"></label><label>專案資料夾<input id="new-plugin-path" placeholder="貼上資料夾完整路徑"></label><button id="prepare-plugin">新增到 ChatGPT</button><p id="new-plugin-status" role="status"></p><div id="new-plugin-result" hidden><p>請到新開啟的 ChatGPT 分頁，按 Create，再按 Connect。連接時確認外掛名稱與資料夾即可。</p></div></details><details id="settings"><summary>設定（需要時再打開）</summary><p>所有外掛共用一個入口。只有要更改預設專案或設定瀏覽器、桌面操作時，才需要這裡。</p><details><summary>Chrome 擴充功能配對</summary><button id="pair">複製 Chrome 配對碼</button></details><details id="advanced-bindings"><summary>外掛名稱 → 資料夾</summary><p>在 ChatGPT Web 選哪個外掛，就使用那一列的資料夾。通用外掛請在對話中指定路徑。</p><button id="refresh-bindings">重新讀取</button><div id="binding-list"></div><p id="binding-status" role="status"></p></details>
<details><summary>專案與瀏覽器授權</summary><p>新增的專案可由已連線的 ChatGPT 工具讀寫。命令以你的 Windows 權限執行，並非沙箱。</p><label>專案完整路徑<input id="project-path" placeholder="C:\\Projects\\my-app"></label><button id="add-project">授權此專案（重啟後生效）</button><label>驗收網站來源<input id="browser-origin" placeholder="http://127.0.0.1:3000"></label><button id="add-origin">允許瀏覽器操作此網站</button><pre id="access"></pre></details>
<details><summary>Windows 桌面操作（預覽）</summary><p>支援可存取性按鈕、文字欄位、核取方塊、選項與捲動容器，以及所選視窗截圖。授權後 ChatGPT 可操作所選視窗 15 分鐘；不支援瀏覽器、終端機或密碼欄位。操作期間，真人鍵鼠輸入會使舊觀察失效；按實體 Escape 可緊急停止，需在此重新授權才會恢復。</p><button id="list-windows">讀取可用視窗</button><select id="desktop-window" aria-label="授權視窗"></select><button id="grant-window">授權所選視窗 15 分鐘</button><button id="revoke-windows">撤回所有桌面授權</button><p>整個桌面截圖會包含所有螢幕與其他可見應用程式內容。這項授權僅允許截圖，不允許全桌面輸入。</p><button id="grant-screen">授權所有螢幕截圖 15 分鐘</button><p>跨應用工作階段允許所有螢幕截圖、桌面／工作列定位與實體點擊，以及兩個支援應用視窗間的實體拖放，持續 15 分鐘。操作後回傳新觀察；拖放會移動真實滑鼠。瀏覽器、終端機、ChatGPT 與安全視窗仍不支援。真人輸入會使觀察失效；實體 Escape 可緊急停止。</p><button id="grant-desktop-session">授權跨應用桌面操作 15 分鐘</button><pre id="desktop-status"></pre></details>
</details><details id="mcp-inventory"><summary>MCP 工具伺服器</summary><button id="mcp-refresh">重新讀取</button><button id="mcp-doctor">檢查 MCP 連線與驗收</button><p id="mcp-doctor-status" role="status"></p><div id="mcp-doctor-rows"></div><label>搜尋<input id="mcp-search" type="search"></label><label>狀態<select id="mcp-filter"><option value="all">全部</option><option value="ready">已核准</option><option value="pending">未核准</option><option value="error">連線異常</option></select></label><p id="mcp-count" role="status"></p><div id="mcp-rows"></div></details><details id="task-history"><summary>任務紀錄與疑難排解</summary><p>這裡是以前執行過的工作與測試紀錄，平常不用操作。紀錄會保留，不影響你在 ChatGPT 開始新工作。</p><div id="tasks"></div><h2 id="title">選擇要查看的紀錄</h2><pre id="summary">選取紀錄後可查看執行結果。</pre><details><summary>變更與驗收</summary><pre id="changes"></pre></details><details><summary>命令與測試輸出</summary><pre id="operations"></pre></details><details><summary>事件時間線</summary><pre id="events"></pre></details>
<details id="manual-recovery"><summary>人工處理（排除問題時使用）</summary><small>先讀取狀態並調查副作用，再填寫處理依據。恢復寫入權會讓舊對話的權限失效。</small>
<label>操作識別碼 <input id="operation" placeholder="operation_id"></label><label>Skills Manager 復原 run ID（建立紀錄的回應遺失時填寫） <input id="manager-run"></label><label><input id="manager-run-not-created" type="checkbox"> 我已查核 Skills Manager 的紀錄，確認這次操作沒有建立新 run</label><label>交接／新回復識別碼 <input id="handoff" placeholder="例如 stage-2 或 restore-1"></label><label>調查紀錄／下一階段目標<textarea id="evidence"></textarea></label>
<div class="actions"><button data-action="rollback">回復已完成的檔案修改</button><button data-action="recover-batch" data-mode="finish">完成中斷的整批修改</button><button data-action="recover-batch" data-mode="rollback">還原中斷的整批修改</button><button data-action="review-interaction">確認未知瀏覽器／桌面操作</button><button data-action="review-skills-manager">核對未知技能流程操作</button><button data-action="cancel">取消任務</button><button data-action="reconcile">核對未知結果</button><button data-action="recover">恢復寫入權</button><button data-action="prepare">建立接續內容</button><button data-action="submit">排入自動接續</button><button data-action="withdraw">撤回未接手交接</button><button data-action="review-tests">確認測試變更</button><button data-action="review-retry">允許繼續修復</button></div>
<pre id="result"></pre><button id="copy">複製接續內容／處理結果</button></details></details></main><script src="/manager.js"></script></html>`;

const script=languageScript()+`const t=forgeLanguage.t;let token=sessionStorage.getItem('forge-manager-token')||'';function readLink(){const incomingToken=location.hash.slice(1);if(incomingToken){token=incomingToken;sessionStorage.setItem('forge-manager-token',token);history.replaceState(null,'',location.pathname);}}readLink();let state;
const el=id=>document.getElementById(id);const show=(id,value)=>{const node=el(id);delete node.dataset.i18n;delete node.dataset.i18nMessage;if(typeof value==='string'&&id!=='title'&&id!=='result'){node.dataset.i18nMessage=value;node.textContent=t(value);}else node.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);};
function managementReady(ready){el('auth-help').hidden=ready;for(const b of document.querySelectorAll('button'))if(b.id!=='refresh'&&b.id!=='copy')b.disabled=!ready;}managementReady(false);
let inventory=[];
function renderInventory(){const q=el('mcp-search').value.toLocaleLowerCase(),filter=el('mcp-filter').value;const rows=inventory.filter(r=>(filter==='all'||filter==='error'&&r.error||filter==='pending'&&!r.approved||filter==='ready'&&r.approved&&!r.error)&&JSON.stringify(r).toLocaleLowerCase().includes(q));el('mcp-rows').replaceChildren();for(const row of rows){const item=document.createElement('pre');item.textContent=JSON.stringify(row,null,2);el('mcp-rows').append(item);}el('mcp-count').textContent=rows.length+' / '+inventory.length;}
el('mcp-search').oninput=renderInventory;el('mcp-filter').onchange=renderInventory;
el('mcp-refresh').onclick=async()=>{try{inventory=(await api('mcp-inventory')).servers;renderInventory();}catch(e){show('mcp-count',e.message);}};
el('mcp-doctor').onclick=async()=>{const button=el('mcp-doctor');button.disabled=true;try{
 const report=await api('mcp-doctor');el('mcp-doctor-rows').replaceChildren();
 for(const check of report.checks){const row=document.createElement('pre');row.textContent=JSON.stringify(check,null,2);el('mcp-doctor-rows').append(row);}
 show('mcp-doctor-status',report.ok?'MCP Doctor：已核准的服務無已知問題':'MCP Doctor：有服務需要診斷或執行唯讀探測');
 }catch(e){show('mcp-doctor-status',e.message);}finally{button.disabled=false;}};
let preparedPlugin;
el('prepare-plugin').onclick=async()=>{el('prepare-plugin').disabled=true;el('new-plugin-result').hidden=true;try{preparedPlugin=await api('plugin-setups',{name:el('new-plugin-name').value,path:el('new-plugin-path').value});await api('plugin-setups/'+preparedPlugin.id+'/open',{});show('new-plugin-status',t('正在準備 ChatGPT 表單，請稍候…'));el('new-plugin-result').hidden=false;void watchPlugin();}catch(e){show('new-plugin-status',e.message);}finally{el('prepare-plugin').disabled=false;}};
async function watchPlugin(){const id=preparedPlugin.id;for(let n=0;n<120&&preparedPlugin?.id===id;n++){try{const s=await api('plugin-setups/'+id);show('new-plugin-status',s.connected?t('已連接：')+s.name+' → '+s.root:s.note||t('等待 Chrome'));if(s.connected){await loadBindings();return;}if(s.state==='blocked'){el('new-plugin-result').hidden=true;return;}}catch(e){show('new-plugin-status',e.message);return;}await new Promise(r=>setTimeout(r,2000));}}
async function loadBindings(){
 const data=await api('project-bindings');const list=el('binding-list');list.replaceChildren();
 for(const row of [...data.connections].sort((a,b)=>Number(!!a.root)-Number(!!b.root))){
  const card=document.createElement('section');card.className='binding-row';
  const name=document.createElement('h3');name.textContent=row.name||(row.client_name==='ChatGPT'?t('ChatGPTForge (general · {id})',{id:row.client_id.slice(-8)}):row.client_name)||t('Forge 外掛');
  const folder=document.createElement('p');folder.className='binding-folder';if(!row.root)folder.dataset.i18nMessage='→ General: specify a folder in chat';folder.textContent='→ '+(row.root||t('通用：在對話中指定資料夾'));card.append(name,folder);
  const edit=document.createElement('details');const summary=document.createElement('summary');summary.dataset.i18n='';summary.textContent='修改資料夾';edit.append(summary);
  const label=document.createElement('label');label.dataset.i18n='';label.textContent='資料夾完整路徑';const input=document.createElement('input');input.value=row.root||'';input.dataset.i18nPlaceholder='貼上專案資料夾的完整路徑';input.placeholder=t('貼上專案資料夾的完整路徑');label.append(input);edit.append(label);
  const actions=document.createElement('div');actions.className='actions';const save=document.createElement('button');save.dataset.i18n='';save.textContent='儲存資料夾';const clear=document.createElement('button');clear.dataset.i18n='';clear.textContent='改為通用';actions.append(save,clear);edit.append(actions);
  const receipt=document.createElement('p');receipt.setAttribute('role','status');edit.append(receipt);
  const update=async(unbind)=>{save.disabled=true;clear.disabled=true;try{if(!unbind&&!input.value.trim())throw Error(t('請貼上資料夾完整路徑'));const result=await api('project-bindings',{client_id:row.client_id,name:row.name||row.client_name||t('Forge 外掛'),path:input.value.trim(),approve_project:true,unbind});await loadBindings();show('binding-status',result.message);}catch(e){receipt.dataset.i18nMessage=e.message;receipt.textContent=t(e.message);}finally{save.disabled=false;clear.disabled=false;}};
  save.onclick=()=>update(false);clear.onclick=()=>update(true);card.append(edit);list.append(card);
 }
 forgeLanguage.apply();show('binding-status',data.connections.length?'':t('尚無外掛紀錄。請先在 ChatGPT 使用 Forge，再按重新讀取。'));
}
el('refresh-bindings').onclick=()=>loadBindings().catch(e=>show('binding-status',e.message));
for(const [button,kind,field] of [['add-project','project','project-path'],['add-origin','origin','browser-origin']])el(button).onclick=async()=>{try{const result=await api('access',{kind,value:el(field).value});show('access',result.message||result);}catch(e){show('access',e.message);}};
el('list-windows').onclick=async()=>{try{const rows=await api('windows');el('desktop-window').replaceChildren();for(const w of rows){const o=document.createElement('option');o.value=JSON.stringify({pid:w.pid,hwnd:w.hwnd});o.textContent=w.app+' · '+w.title;el('desktop-window').append(o);}show('desktop-status',t('請選擇要授權的視窗'));}catch(e){show('desktop-status',e.message);}};
el('grant-desktop-session').onclick=async()=>{try{show('desktop-status',await api('desktop-session-grant',{}));}catch(e){show('desktop-status',e.message);}};
el('grant-screen').onclick=async()=>{try{show('desktop-status',await api('screen-grant',{}));}catch(e){show('desktop-status',e.message);}};
el('grant-window').onclick=async()=>{try{if(!el('desktop-window').value)throw Error(t('請先讀取並選擇視窗'));show('desktop-status',await api('window-grant',JSON.parse(el('desktop-window').value)));}catch(e){show('desktop-status',e.message);}};
el('revoke-windows').onclick=async()=>{try{const result=await api('access',{kind:'desktop-revoke'});show('desktop-status',result.message||result);}catch(e){show('desktop-status',e.message);}};
async function api(path,body){if(!token)throw Error(t('此分頁沒有管理驗證資訊，請在這個瀏覽器開啟啟動器產生的完整管理連結。'));let r;try{r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});}catch{throw Error(t('無法連到本機服務，請確認 ChatGPTForge 正在執行。'));}const data=await r.json().catch(()=>({}));if(r.status===401)managementReady(false);if(!r.ok)throw Error(r.status===401?t('管理連結已過期，請重新開啟啟動器產生的連結。'):r.status===403?t('管理請求來源不符，請使用本機 127.0.0.1 的管理連結。'):data.error||t('管理請求失敗：HTTP ')+r.status);return data;}
async function load(id){state=await api('tasks/'+encodeURIComponent(id));show('title',state.goal);show('summary',{task_id:state.task_id,status:state.status,retry_blocked:state.retry_blocked,checkpoint_matches:state.checkpoint_matches,note:state.note,lease_epoch:state.lease_epoch,handoffs:state.handoffs,continuation:state.continuation});show('changes',{changed_files:state.changed_files,tests_require_review:state.tests_require_review,fingerprint:state.fingerprint,file_changes:state.file_changes});show('operations',{commands:state.operations,skills_manager:state.skills_manager_operations,runs:state.skills_manager_runs});show('events',state.events);show('message',t('已讀取本機狀態'));}
async function refresh(){managementReady(false);show('shared-entry-status',t('正在確認本機連線…'));try{const rows=await api('tasks');el('tasks').replaceChildren();for(const row of rows){const b=document.createElement('button');b.textContent=row.goal+' · '+row.status;b.onclick=()=>load(row.id).catch(e=>show('message',e.message));el('tasks').append(b);}if(state)await load(state.task_id);await loadBindings();managementReady(true);show('shared-entry-status',t('共用入口 · 本機連線正常'));show('message',t('Local connection ready · {count} tasks',{count:rows.length}));}catch(e){show('shared-entry-status',t('共用入口 · 尚未連線，請查看頁首提示'));show('message',e.message);}}
el('pair').onclick=async()=>{try{const data=await api('pairing');await navigator.clipboard.writeText(data.token);show('message',t('已複製配對碼，請貼到 ChatGPTForge Chrome 擴充功能設定。'));}catch(e){show('message',e.message);}};el('refresh').onclick=refresh;for(const b of document.querySelectorAll('[data-action]'))b.onclick=async()=>{if(!state)return;try{const data=await api('tasks/'+encodeURIComponent(state.task_id)+'/'+b.dataset.action,{fingerprint:state.fingerprint,operation_id:el('operation').value,manager_run_id:el('manager-run').value,manager_run_not_created:el('manager-run-not-created').checked,handoff_id:el('handoff').value,recovery_id:el('handoff').value,mode:b.dataset.mode,evidence:el('evidence').value});show('result',b.dataset.action==='prepare'?t('Claim this task with ChatGPTForge handoff_claim, then read task_resume. Retry with the same recipient_key and save the new lease_token after claiming.')+String.fromCharCode(10)+JSON.stringify(data,null,2):data);await load(state.task_id);}catch(e){show('message',e.message);}};
  el('copy').onclick=()=>navigator.clipboard.writeText(el('result').textContent).then(()=>show('message',t('已複製')),()=>show('message',t('請手動選取並複製結果')));window.addEventListener('hashchange',()=>{readLink();void refresh();});refresh();`;


