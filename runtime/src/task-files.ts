import {readFileSync,lstatSync,writeFileSync,renameSync,unlinkSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,relative,dirname,join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DurableTasks,digest,snapshot} from './durable-tasks.js';
import {windowsProcessIdentity} from './durable-windows-job.js';
import {TaskFileBatches} from './task-file-batches.js';

interface Change {task_id:string;id:string;path:string;before_data:Buffer|null;after_data:Buffer|null;request:string}
export class TaskFiles {
  readonly batches:TaskFileBatches;
  constructor(private engine:DurableTasks) {
    this.batches=new TaskFileBatches(engine);
    engine.db.exec(`CREATE TABLE IF NOT EXISTS task_files(task_id TEXT NOT NULL,id TEXT NOT NULL,path TEXT NOT NULL,before_data BLOB,after_data BLOB,request TEXT NOT NULL,PRIMARY KEY(task_id,id))`);
  }
  private path(root:string,name:string) {
    if(isAbsolute(name))throw new Error('Invalid task file path: use a relative path');
    const rel=relative(root,resolve(root,name)),target=join(root,rel);
    if(!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('..\\') || rel.startsWith('../') || /(^|[\\/])(\.git|node_modules)([\\/]|$)/i.test(rel) || /[:]/.test(rel)) throw new Error('Invalid task file path');
    let parent=dirname(target);
    while(parent!==root) {if(lstatSync(parent).isSymbolicLink())throw new Error('Symlink parent refused');parent=dirname(parent);}
    if(existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error('Only regular files supported');
    return target;
  }
  list(id:string) {
    return (this.engine.db.prepare('SELECT * FROM task_files WHERE task_id=? ORDER BY rowid').all(id) as Change[]).map(c=>({
      operation_id:c.id,path:c.path,before_hash:c.before_data===null?null:digest(c.before_data),after_hash:c.after_data===null?null:digest(c.after_data),
      before:c.before_data?.toString('utf8').slice(0,16000)??null,after:c.after_data?.toString('utf8').slice(0,16000)??null,
      state:this.engine.operation(id,c.id).state,
    })).concat(this.batches.list(id));
  }
  write(id:string,opId:string,path:string,content:string|null,expectedHash:string|null,lease?:string) {
    if(content!==null && Buffer.byteLength(content)>1024*1024)throw new Error('File exceeds 1 MiB write limit');
    const e=this.engine,request=digest(JSON.stringify({path,content,expectedHash}));
    const inserted=e.db.transaction(()=>{
      const task=e.task(id);e.assertLease(task,lease);
      const old=e.db.prepare('SELECT request FROM task_files WHERE task_id=? AND id=?').get(id,opId) as {request:string}|undefined;
      if(old){if(old.request!==request)throw new Error('operation_id reused with different file input');return false;}
      e.assertIdle(task);
      if(e.retryBlocked(id))throw new Error('Repair attempts paused; local operator review required');
      const target=this.path(task.root,path), before=existsSync(target)?readFileSync(target):null;
      if(before && before.length>1024*1024)throw new Error('Original file exceeds 1 MiB rollback limit');
      if(before && !Buffer.from(before.toString('utf8')).equals(before))throw new Error('Only UTF-8 files support reversible edits');
      if((before===null?null:digest(before))!==expectedHash)throw new Error('File conflict: contents changed');
      e.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?, 'file','prepared',?,?,0,?)")
        .run(id,opId,request,`Write ${path}`,Date.now(),Date.now(),snapshot(task.root).fingerprint);
      e.db.prepare('INSERT INTO task_files VALUES(?,?,?,?,?,?)').run(id,opId,path,before,content===null?null:Buffer.from(content),request);
      e.db.prepare('UPDATE operations SET worker_pid=?,worker_creation=? WHERE task_id=? AND id=?').run(process.pid,process.platform==='win32'?windowsProcessIdentity(process.pid):null,id,opId);
      e.event(id,'file_prepared',{operation_id:opId,path});return true;
    }).immediate();
    if(!inserted)return e.result(id,opId);
    try {
      const task=e.task(id),target=this.path(task.root,path);
      const current=existsSync(target)?digest(readFileSync(target)):null;
      if(current!==expectedHash)throw new Error('File conflict before write; inspect before resolving');
      if(content===null) {if(existsSync(target))unlinkSync(target);}
      else {
        const temp=join(dirname(target),`.forge-${randomUUID()}.tmp`);
        try {
          writeFileSync(temp,content,{flag:'wx'});
          const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
          if((existsSync(target)?digest(readFileSync(target)):null)!==expectedHash)throw new Error('File conflict before replacement');
          renameSync(temp,target);
        } finally {if(existsSync(temp))unlinkSync(temp);}
      }
      e.db.transaction(()=>{
        e.db.prepare("UPDATE operations SET state='completed',exit_code=0,after_hash=?,heartbeat=? WHERE task_id=? AND id=?").run(snapshot(task.root).fingerprint,Date.now(),id,opId);
        e.event(id,'file_completed',{operation_id:opId,path});
      }).immediate();
    } catch(error) {
      e.db.prepare("UPDATE operations SET state='unknown',error=? WHERE task_id=? AND id=?").run(String(error),id,opId);
      e.event(id,'file_unknown',{operation_id:opId,path});
    }
    return e.result(id,opId);
  }
  rollback(id:string,changeId:string,opId:string,lease?:string) {
    if(this.batches.has(id,changeId))return this.batches.rollback(id,changeId,opId,lease);
    const change=this.engine.db.prepare('SELECT * FROM task_files WHERE task_id=? AND id=?').get(id,changeId) as Change|undefined;
    if(!change || this.engine.operation(id,changeId).state!=='completed')throw new Error('Only a confirmed task file change can be rolled back');
    return this.write(id,opId,change.path,change.before_data===null?null:change.before_data.toString('utf8'),change.after_data===null?null:digest(change.after_data),lease);
  }
}
