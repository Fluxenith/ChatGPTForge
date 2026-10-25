import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DurableTasks, snapshot } from "./durable-tasks.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const [stateDir, taskId, operationId] = process.argv.slice(2);
if (!stateDir || !taskId || !operationId) throw new Error("Missing worker journal identity");
const engine = new DurableTasks(stateDir);
let logFd: number | undefined;
try {
  const identity = process.platform === "win32" ? (await import("./durable-windows-job.js")).windowsProcessIdentity(process.pid) : null;
  const jobName = process.platform === "win32" ? `Global\\ChatGPTForge-${randomUUID()}` : null;
  const claimed = engine.db.prepare("UPDATE operations SET state='running',heartbeat=?,worker_pid=?,worker_creation=?,job_name=?,stdin_supported=? WHERE task_id=? AND id=? AND state='prepared' AND kind IN ('command','verify','desktop_app')")
    .run(Date.now(), process.pid, identity, jobName,Number(process.platform==='win32'),taskId, operationId).changes;
  if (!claimed) { engine.close(); process.exit(0); }
  const op = engine.operation(taskId, operationId);
  const task = engine.task(taskId);
  const log = engine.logPath(taskId, operationId);
  mkdirSync(dirname(log), {recursive:true});
  logFd = openSync(log, "a");
  if (op.cancel || snapshot(task.root).fingerprint !== op.before_hash) {
    engine.db.prepare("UPDATE operations SET state='rejected',error=?,heartbeat=? WHERE task_id=? AND id=?")
      .run(op.cancel ? "Cancelled before launch" : "Workspace changed before launch", Date.now(), taskId, operationId);
    engine.event(taskId, "rejected", {operation_id: operationId});
  } else {
    let stopping: string | null = null;
    let outcome: {code:number|null;error:string|null};
    if(process.platform === "win32") {
      const {startWindowsJob}=await import("./durable-windows-job.js");
      const job=startWindowsJob(op.cmd,task.root,log,op.job_name!);
      let pendingInput:Promise<void>|null=null;
      try {
        engine.event(taskId,"process_started",{operation_id:operationId,pid:job.pid,creation_time:job.creation_time});
        const deadline=Date.now()+op.timeout_ms;
        let code:number|null;
        while((code=job.poll()) === null) {
          if(stopping==='unknown')job.stop();
          if(!pendingInput && !stopping) {
            const input=engine.db.prepare("SELECT * FROM operation_inputs WHERE task_id=? AND operation_id=? AND state='queued' ORDER BY rowid LIMIT 1").get(taskId,operationId) as {id:string;data:string;eof:number}|undefined;
            if(input) {
              engine.db.prepare("UPDATE operation_inputs SET state='sending' WHERE task_id=? AND operation_id=? AND id=?").run(taskId,operationId,input.id);
              pendingInput=job.input(input.data,Boolean(input.eof)).then(()=>{
                engine.db.prepare("UPDATE operation_inputs SET state='written' WHERE task_id=? AND operation_id=? AND id=?").run(taskId,operationId,input.id);
              },()=>{
                engine.db.prepare("UPDATE operation_inputs SET state='unknown' WHERE task_id=? AND operation_id=? AND id=?").run(taskId,operationId,input.id);
                stopping='unknown';
              }).finally(()=>{pendingInput=null;});
            }
          }
          engine.db.prepare("UPDATE operations SET heartbeat=? WHERE task_id=? AND id=?").run(Date.now(),taskId,operationId);
          if(!stopping && (engine.operation(taskId,operationId).cancel || Date.now()>=deadline)) {
            stopping=Date.now()>=deadline ? "timed_out" : "cancelled";
            job.stop();
          }
          await delay(100);
        }
        outcome={code,error:null};
        if(pendingInput)await pendingInput;
        engine.db.prepare("UPDATE operation_inputs SET state='not_delivered' WHERE task_id=? AND operation_id=? AND state='queued'").run(taskId,operationId);
        if(engine.db.prepare("SELECT 1 FROM operation_inputs WHERE task_id=? AND operation_id=? AND state='unknown'").get(taskId,operationId))stopping='unknown';
      } finally {
        try {if(pendingInput){job.stop();await pendingInput;}} finally {job.close();}
      }
    } else {
    const shell = resolveShellCommand(op.cmd);
    const child = spawn(shell.executable, shell.args, { cwd: task.root, windowsHide: true,
      detached: true, stdio: ["ignore", logFd, logFd] });
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = reason;
      terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
    };
    const interval = setInterval(() => {
      try {
        engine.db.prepare("UPDATE operations SET heartbeat=? WHERE task_id=? AND id=?").run(Date.now(),taskId,operationId);
        if (engine.operation(taskId,operationId).cancel) stop("cancelled");
      } catch { stop("journal_unavailable"); }
    }, 500);
    const timer = setTimeout(() => stop("timed_out"), op.timeout_ms);
    outcome = await new Promise<{code: number | null; error: string | null}>(resolve => {
      child.once("error", error => resolve({code:null,error:error.message}));
      child.once("close", (code, signal) => resolve({code,error:signal ? `Signal: ${signal}` : null}));
    });
    clearInterval(interval); clearTimeout(timer);
    }
    fsyncSync(logFd);
    const after = snapshot(task.root).fingerprint;
    engine.db.transaction(() => {
      engine.db.prepare("UPDATE operations SET state=?,exit_code=?,error=?,after_hash=?,heartbeat=? WHERE task_id=? AND id=?")
        .run(stopping ?? (outcome.error ? "failed" : "completed"),outcome.code,outcome.error,after,Date.now(),taskId,operationId);
      engine.event(taskId,"command_result",{operation_id:operationId,exit_code:outcome.code,state:stopping ?? "completed",fingerprint:after});
    }).immediate();
  }
  engine.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=? AND status='cancelling' AND NOT EXISTS (SELECT 1 FROM operations WHERE task_id=? AND state IN ('prepared','running','unknown'))").run(taskId,taskId);
} catch (error) {
  engine.db.prepare("UPDATE operations SET state='unknown',error=?,heartbeat=? WHERE task_id=? AND id=? AND state='running'")
    .run(error instanceof Error ? error.message : String(error),Date.now(),taskId,operationId);
  engine.event(taskId,"unknown_outcome",{operation_id:operationId});
} finally {
  if (logFd !== undefined) closeSync(logFd);
  engine.close();
}
