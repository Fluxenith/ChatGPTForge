import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DurableTasks} from './durable-tasks.js';
import {continuationPrompt} from './handoff-context.js';

// The unpacked extension shipped with this Forge build. A worker reporting any
// other version runs stale code (seen in the 2026-10-15 live attempt) and is
// never handed a continuation.
export function expectedExtensionVersion():string {
  return (JSON.parse(readFileSync(new URL('../browser-extension/manifest.json',import.meta.url),'utf8')) as {version:string}).version;
}
export const WORKER_STALE_MS=120_000;
export function browserWorkerStatus(db:DurableTasks['db']) {
  db.exec('CREATE TABLE IF NOT EXISTS browser_workers(id TEXT PRIMARY KEY,version TEXT,seen INTEGER)');
  const row=db.prepare("SELECT version,seen FROM browser_workers WHERE id='chrome-extension'").get() as {version:string|null;seen:number}|undefined;
  const expected=expectedExtensionVersion(),age=row?Date.now()-row.seen:null;
  const ready=!!row&&row.version===expected&&age!==null&&age<WORKER_STALE_MS;
  return {expected_version:expected,reported_version:row?.version??null,last_seen_ms_ago:age,ready,
    reason:!row?'No continuation worker has contacted Forge; the Chrome extension must be installed, paired and enabled':
      row.version!==expected?`Installed extension ${row.version??'unknown'} is not ${expected}; reload the unpacked extension in Chrome`:
      !ready?'Continuation worker has not polled in the last 2 minutes; is Chrome running?':null};
}

export class BrowserBridge {
  constructor(private e:DurableTasks) {
    const cols=e.db.prepare('PRAGMA table_info(continuation_receipts)').all() as {name:string}[];
    if(!cols.some(c=>c.name==='delivery_id'))e.db.exec('ALTER TABLE continuation_receipts ADD COLUMN delivery_id TEXT');
    if(!cols.some(c=>c.name==='worker_version'))e.db.exec('ALTER TABLE continuation_receipts ADD COLUMN worker_version TEXT');
    e.db.exec('CREATE TABLE IF NOT EXISTS browser_workers(id TEXT PRIMARY KEY,version TEXT,seen INTEGER)');
  }
  seen(version:string|undefined){this.e.db.prepare("INSERT INTO browser_workers(id,version,seen) VALUES('chrome-extension',?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,seen=excluded.seen").run(version??null,Date.now());}
  workerStatus(){return browserWorkerStatus(this.e.db);}
  candidates(){return this.e.db.prepare("SELECT task_id,handoff_id FROM continuation_receipts WHERE state='queued' ORDER BY updated").all() as {task_id:string;handoff_id:string}[];}
  pending(){return this.e.db.prepare("SELECT task_id,handoff_id,delivery_id,state,url FROM continuation_receipts WHERE delivery_id IS NOT NULL AND state IN ('opening','submitting','submitted','unknown') ORDER BY updated LIMIT 100").all() as {task_id:string;handoff_id:string;delivery_id:string;state:string;url:string|null}[];}
  take(taskId:string,handoffId:string,workerVersion?:string) {
    if(workerVersion!==expectedExtensionVersion())throw new Error(`Extension ${workerVersion??'unknown'} is not ${expectedExtensionVersion()}; reload the unpacked extension before continuing`);
    return this.e.db.transaction(()=>{
      const h=this.e.db.prepare("SELECT * FROM handoffs WHERE task_id=? AND id=? AND state='prepared'").get(taskId,handoffId) as {claim_token:string;fingerprint:string;note:string}|undefined;
      if(!h)return null;
      const delivery=randomUUID();
      if(!this.e.db.prepare("UPDATE continuation_receipts SET state='opening',delivery_id=?,worker_version=?,updated=? WHERE task_id=? AND handoff_id=? AND state='queued'").run(delivery,workerVersion,Date.now(),taskId,handoffId).changes)return null;
      return {task_id:taskId,handoff_id:handoffId,delivery_id:delivery,...continuationPrompt(this.e,taskId,handoffId)};
    }).immediate();
  }
  status(taskId:string,handoffId:string,delivery:string) {
    const row=this.e.db.prepare('SELECT state,url,note,updated FROM continuation_receipts WHERE task_id=? AND handoff_id=? AND delivery_id=?').get(taskId,handoffId,delivery);
    if(!row)throw new Error('Invalid delivery receipt');
    return row;
  }
  update(taskId:string,handoffId:string,delivery:string,state:string,url:string,note:string) {
    if(!['submitting','submitted','unknown','blocked'].includes(state))throw new Error('Invalid delivery state');
    const u=new URL(url);if(u.origin!=='https://chatgpt.com')throw new Error('Unexpected browser destination');
    return this.e.db.transaction(()=>{
      const row=this.e.db.prepare('SELECT state,delivery_id,url,note FROM continuation_receipts WHERE task_id=? AND handoff_id=?').get(taskId,handoffId) as {state:string;delivery_id:string;url:string|null;note:string|null}|undefined;
      if(!row||row.delivery_id!==delivery)throw new Error('Invalid delivery receipt');
      // Claim can win the race with the browser acknowledgement. Never demote it.
      if(['claimed','obsolete'].includes(row.state))return {state:row.state};
      if(row.state===state && row.url===url && row.note===note.slice(0,2000))return {state};
      const allowed:Record<string,string[]>={opening:['submitting','blocked','unknown'],submitting:['submitted','unknown'],unknown:['submitted']};
      if(!allowed[row.state]?.includes(state))throw new Error('Delivery already resolved; never resend');
      if(state==='submitting'&&!this.e.db.prepare("SELECT 1 FROM handoffs WHERE task_id=? AND id=? AND state='prepared'").get(taskId,handoffId))throw new Error('Handoff withdrawn');
      this.e.db.prepare('UPDATE continuation_receipts SET state=?,url=?,note=?,updated=? WHERE task_id=? AND handoff_id=?').run(state,url,note.slice(0,2000),Date.now(),taskId,handoffId);
      return {state};
    }).immediate();
  }
}
