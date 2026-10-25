// Prepare/read receipts for real ChatGPT conversation acceptance. Browser sending
// is separate, so this script never fabricates a model's claim or verification.
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {writeFileSync,readFileSync} from 'node:fs';
import {loadConfig} from '../dist/config.js';
import {DurableTasks} from '../dist/durable-tasks.js';
import {resolveCanonicalAllowedPath} from '../dist/roots.js';

const [mode,path]=process.argv.slice(2),env={...process.env,DEVSPACE_CONFIG_DIR:process.env.CHATGPTFORGE_CONFIG_DIR??join(homedir(),'.chatgptforge')};delete env.DEVSPACE_OAUTH_OWNER_TOKEN;
const config=loadConfig(env),e=new DurableTasks(config.stateDir),record=join(config.stateDir,'handoff-acceptance.json');
try {
  if(mode==='start') {
    const root=await resolveCanonicalAllowedPath(path,process.cwd(),config.allowedRoots);
    const prefix='handoff-'+Date.now();
    const verify=`node -e "const f=require('node:fs');for(let n=1;n<=3;n++){if(f.readFileSync('${prefix}-'+n+'.txt','utf8')!=='stage-'+n)process.exit(1);}console.log('HANDOFF_ACCEPTANCE_PASS')"`;
    const task=e.create(root,prefix,'三個真實 ChatGPT 對話接手驗收',['node sum.test.cjs',verify],true);
    const note=`這是已授權的三階段實機驗收。目前是第 1 階段。每階段只以 task_write 新增 ${prefix}-N.txt（N 是目前階段 1/2/3），內容精確為 stage-N，不含換行，expected_hash=null，使用穩定 operation_id。不要更改其他檔案。第 1、2 階段寫入後呼叫 task_resume 取得指紋，再 handoff_prepare 交給下一階段，note 完整保留本流程及檔名前綴 ${prefix} 並更新階段，然後 handoff_submit。交接送出後停止寫入並回報等待接手。第 3 階段新增檔案後，task_resume 讀取 acceptance 並逐一 task_verify，輪詢 task_operation 確認成功，再 task_complete。所有寫入都附新 lease_token；未知結果不可換 operation_id 重跑。不呼叫 Codex 或付費模型。`;
    const h=e.prepareHandoff(task.task_id,'initial',task.fingerprint,note,task.lease_token);
    writeFileSync(record,JSON.stringify({task_id:task.task_id,prefix},null,2));
    writeFileSync(resolve('../artifacts/live-handoff-prompt.txt'),'請用 ChatGPTForge Tunnel 外掛執行以下已授權驗收。先 handoff_claim 接手以下回執，recipient_key 固定為 live-stage-1；成功後保存 lease_token，再 task_resume 核對狀態。\n'+JSON.stringify(h)+'\n'+note);
    console.log(JSON.stringify({task_id:task.task_id,prefix,state:'prepared'}));
  } else if(mode==='mark-sending') {
    const saved=JSON.parse(readFileSync(record,'utf8'));
    e.db.transaction(()=>{
      const h=e.db.prepare("SELECT id FROM handoffs WHERE task_id=? AND state='prepared'").get(saved.task_id);
      if(!h)throw Error('No pending handoff');
      const existing=e.db.prepare('SELECT state FROM continuation_receipts WHERE task_id=? AND handoff_id=?').get(saved.task_id,h.id);
      if(existing && existing.state!=='queued')throw Error('Submission already attempted; inspect before any action');
      e.db.prepare("INSERT INTO continuation_receipts(task_id,handoff_id,state,note,updated) VALUES(?,?,'submitting','Assisted Chrome acceptance: receipt committed before click',?) ON CONFLICT(task_id,handoff_id) DO UPDATE SET state='submitting',updated=excluded.updated").run(saved.task_id,h.id,Date.now());
      console.log(JSON.stringify({handoff_id:h.id,state:'submitting'}));
    }).immediate();
  } else if(mode==='record-block') {
    const saved=JSON.parse(readFileSync(record,'utf8'));
    const note='ChatGPT reported OpenAI safety checks blocked handoff_claim. Local journal has no claim or writes. User/platform resolution required; do not bypass.';
    e.db.prepare("UPDATE continuation_receipts SET state='submitted',note=?,updated=? WHERE task_id=? AND handoff_id='initial'").run(note,Date.now(),saved.task_id);
    e.event(saved.task_id,'external_acceptance_blocked',{action:'handoff_claim',reason:note});
    console.log(JSON.stringify({task_id:saved.task_id,result:'BLOCKED_NOT_PASSED'}));
  } else if(mode==='status') {
    const saved=JSON.parse(readFileSync(record,'utf8'));console.log(JSON.stringify(e.status(saved.task_id),null,2));
  } else if(mode==='next') {
    const saved=JSON.parse(readFileSync(record,'utf8'));
    const h=e.db.prepare("SELECT * FROM handoffs WHERE task_id=? AND state='prepared'").get(saved.task_id);
    if(!h)throw Error('No pending handoff');
    writeFileSync(resolve('../artifacts/live-handoff-prompt.txt'),'請用 ChatGPTForge Tunnel 外掛接手。先 handoff_claim，recipient_key 固定為 '+h.id+'-receiver；核對成功後保存 lease_token 再 task_resume。\n'+JSON.stringify({task_id:h.task_id,handoff_id:h.id,claim_token:h.claim_token,expected_fingerprint:h.fingerprint})+'\n'+h.note);
    console.log(JSON.stringify({task_id:h.task_id,handoff_id:h.id,state:h.state}));
  } else throw Error('Usage: accept-handoff.mjs start FIXTURE | status | next');
}finally{e.close();}
