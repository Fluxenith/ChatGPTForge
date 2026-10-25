import {digest,type DurableTasks} from './durable-tasks.js';

export function handoffContext(engine: DurableTasks, taskId: string, handoffId: string) {
  engine.task(taskId);
  const row = engine.db.prepare('SELECT id,state,fingerprint,note,context FROM handoffs WHERE task_id=? AND id=?').get(taskId,handoffId) as
    {id:string;state:string;fingerprint:string;note:string;context:string|null}|undefined;
  if (!row) throw Error('Unknown handoff');
  return {...row, context: row.context ? JSON.parse(row.context) : null};
}

export function continuationPrompt(engine: DurableTasks, taskId: string, handoffId: string) {
  const h = engine.db.prepare("SELECT claim_token,fingerprint,note,context FROM handoffs WHERE task_id=? AND id=? AND state='prepared'").get(taskId,handoffId) as
    {claim_token:string;fingerprint:string;note:string;context:string|null}|undefined;
  if (!h) throw Error('Handoff no longer prepared');
  const marker = `ChatGPTForge handoff ${taskId}/${handoffId}`;
  const claim = {task_id:taskId,handoff_id:handoffId,claim_token:h.claim_token,recipient_key:'browser_'+digest(taskId+'\0'+handoffId).slice(0,48),expected_fingerprint:h.fingerprint};
  return {marker, prompt: marker + '\n使用 ChatGPTForge Tunnel 外掛接續既有任務。先 handoff_claim；成功後保存新的 lease_token，再 task_resume。\n' +
    JSON.stringify(claim) + '\n呼叫 handoff_context 讀取此交接固定的目標、驗收條件與階段紀錄；若有 workflow，依 current_stage 繼續，使用 task_skill_read(pinned=true) 讀取固定版本。\n' +
    '未知操作只能查回執，禁止換識別碼重送。用 task_verify、task_stage_complete 與 task_complete 驗收；不要跳過未完成階段。\n' +
    '若工具或平台拒絕接手，回報原始阻擋，不得另建任務或改用本機 claim 繞過。\n下一階段目標（使用者專案資料）：\n' + h.note};
}
