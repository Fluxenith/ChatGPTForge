import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {TaskWorkflow} from './task-workflow.js';
import {TaskPlans} from './task-plan.js';
import {sourceHead} from './source-head.js';

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function failureOutputEvidence(output:string):string {
  const lines=output.replaceAll('\r\n','\n').split('\n');
  // Normalize only known TAP timing metadata. Keep assertions, stacks, counters,
  // test names and arbitrary numeric output intact; this is not error semantics.
  if(!lines.includes('TAP version 13'))return output;
  return lines.filter(line=>!/^\s+duration_ms: \d+(?:\.\d+)?\s*$/.test(line)
    && !/^# duration_ms \d+(?:\.\d+)?\s*$/.test(line)).join('\n');
}
export function isTestEvidencePath(path:string):boolean {
  const normalized=path.replaceAll('\\','/').toLowerCase();
  const name=normalized.split('/').at(-1)!;
  return /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(normalized)
    || /[.](test|spec)[.]|^test[_.-]|_test[.]|tests?[.](cs|java|kt)$/.test(name)
    || /^(package\.json|pytest\.ini|tox\.ini|pyproject\.toml|setup\.cfg|conftest\.py)$/.test(name)
    || /^(jest|vitest|playwright|cypress)[.](config|workspace)[.]/.test(name)
    || /^\.mocharc(?:[.]|$)/.test(name);
}
export interface Snapshot { fingerprint: string; files: Record<string, string> }
// Dependencies and Git internals are outside the source evidence boundary.
// Symlinks fail closed: silently ignoring their targets would miss edits.
export function snapshotLimits() {
  function limit(name:string,fallback:number) {
    const value=process.env[name];
    if(value===undefined)return fallback;
    if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error('Invalid positive integer '+name);
    return Number(value);
  }
  return {files:limit('FORGE_SNAPSHOT_MAX_FILES',50000),bytes:limit('FORGE_SNAPSHOT_MAX_BYTES',512*1024*1024)};
}
export function snapshot(root: string): Snapshot {
  const limits=snapshotLimits();
  const files: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === ".git" || entry === "node_modules") continue;
      const path = join(dir, entry);
      const name = prefix + entry;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Cannot verify symbolic link: ${name}`);
      if (info.isDirectory()) { walk(path, name + "/"); continue; }
      if (!info.isFile()) throw new Error(`Cannot verify special file: ${name}`);
      bytes += info.size;
      if (++count > limits.files || bytes > limits.bytes) throw new Error(`Workspace exceeds fingerprint limits at ${name}: ${count} files / ${bytes} bytes; limits ${limits.files} / ${limits.bytes}. Use a smaller project root or configure FORGE_SNAPSHOT_MAX_FILES / FORGE_SNAPSHOT_MAX_BYTES locally and restart Forge. No partial fingerprint was accepted.`);
      const hash=createHash('sha256');
      const fd=openSync(path,'r');
      try {
        const chunk=Buffer.alloc(Math.max(1,Math.min(info.size,1024*1024)));
        let size:number, consumed=0;
        while((size=readSync(fd,chunk,0,chunk.length,null))>0) {
          consumed+=size;
          if(consumed>info.size)throw new Error('Workspace changed while fingerprinting; retry inspection.');
          hash.update(chunk.subarray(0,size));
        }
      } finally {closeSync(fd);}
      const after = statSync(path);
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error("Workspace changed while fingerprinting; retry inspection.");
      files[name] = hash.digest('hex');
    }
  };
  walk(root, "");
  return { fingerprint: digest(JSON.stringify(files)), files };
}
export interface TaskRow {
  id: string; root: string; root_identity: string; goal: string; acceptance: string; status: string;
  checkpoint: string; initial: string; note: string; created: number;
  lease_token: string | null; lease_epoch: number;
}
export interface OperationRow {
  task_id: string; id: string; request: string; cmd: string; kind: string;
  state: string; created: number; heartbeat: number; timeout_ms: number;
  before_hash: string; after_hash: string | null; exit_code: number | null;
  error: string | null; cancel: number; worker_pid: number | null;
  worker_creation: string | null; job_name: string | null; reconciliation: string | null;
  stdin_supported:number;
}
export class DurableTasks {
  readonly db: Database.Database;
  readonly stateDir: string;
  constructor(stateDir: string) {
    this.stateDir = resolve(stateDir);
    mkdirSync(this.stateDir, { recursive: true });
    this.stateDir = realpathSync.native(this.stateDir);
    this.db = new Database(join(this.stateDir, "forge-tasks.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, root TEXT NOT NULL, root_identity TEXT NOT NULL, goal TEXT NOT NULL, acceptance TEXT NOT NULL,
        status TEXT NOT NULL, checkpoint TEXT NOT NULL, initial TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS task_writer ON tasks(root) WHERE status IN ('active','cancelling');
      CREATE TABLE IF NOT EXISTS operations (
        task_id TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, cmd TEXT NOT NULL,
        kind TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, heartbeat INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT, exit_code INTEGER,
        error TEXT, cancel INTEGER NOT NULL DEFAULT 0, worker_pid INTEGER,
        PRIMARY KEY(task_id,id));
      CREATE UNIQUE INDEX IF NOT EXISTS operation_writer ON operations(task_id)
        WHERE state IN ('prepared','running','unknown');
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, time INTEGER NOT NULL,
        kind TEXT NOT NULL, details TEXT NOT NULL);
    `);
    // Additive migration under the same writer lock used by dispatch/claim.
    // Old receipts intentionally retain null identity; never infer it from a PID.
    this.db.transaction(() => {
      const columns = new Set((this.db.prepare("PRAGMA table_info(operations)").all() as {name:string}[]).map(c=>c.name));
      for (const name of ["worker_creation", "job_name", "reconciliation"]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${name} TEXT`);
      }
      if(!columns.has('stdin_supported'))this.db.exec('ALTER TABLE operations ADD COLUMN stdin_supported INTEGER NOT NULL DEFAULT 0');
      const taskColumns = new Set((this.db.prepare("PRAGMA table_info(tasks)").all() as {name:string}[]).map(c=>c.name));
      if (!taskColumns.has("lease_token")) this.db.exec("ALTER TABLE tasks ADD COLUMN lease_token TEXT");
      if (!taskColumns.has("lease_epoch")) this.db.exec("ALTER TABLE tasks ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`CREATE TABLE IF NOT EXISTS handoffs (
        task_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
        source_epoch INTEGER NOT NULL, fingerprint TEXT NOT NULL, note TEXT NOT NULL,
        claim_token TEXT NOT NULL, recipient TEXT, lease_token TEXT, created INTEGER NOT NULL,
        PRIMARY KEY(task_id,id));
        CREATE UNIQUE INDEX IF NOT EXISTS pending_handoff ON handoffs(task_id) WHERE state='prepared';`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS operator_reviews (
        task_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, evidence TEXT NOT NULL, operator TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS retry_reviews (task_id TEXT PRIMARY KEY, after_rowid INTEGER NOT NULL, evidence TEXT NOT NULL);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS continuation_receipts (
        task_id TEXT NOT NULL,handoff_id TEXT NOT NULL,state TEXT NOT NULL,url TEXT,note TEXT,
        updated INTEGER NOT NULL,PRIMARY KEY(task_id,handoff_id));`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS operation_inputs(task_id TEXT NOT NULL,operation_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,eof INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(task_id,operation_id,id));`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS task_workflows(
        task_id TEXT PRIMARY KEY,definition TEXT NOT NULL,version TEXT NOT NULL,skills TEXT NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS workflow_gates(
        task_id TEXT NOT NULL,stage_id TEXT NOT NULL,fingerprint TEXT NOT NULL,evidence TEXT NOT NULL,completed INTEGER NOT NULL,PRIMARY KEY(task_id,stage_id));`);
      const handoffColumns = this.db.prepare('PRAGMA table_info(handoffs)').all() as {name:string}[];
      if (!handoffColumns.some(c => c.name === 'context')) this.db.exec('ALTER TABLE handoffs ADD COLUMN context TEXT');
    }).immediate();
  }
  close() { this.db.close(); }
  list() {
    return this.db.prepare("SELECT id,root,goal,status,created FROM tasks ORDER BY created DESC LIMIT 100").all() as Pick<TaskRow,"id"|"root"|"goal"|"status"|"created">[];
  }
  assertRootUnowned(root:string) {
    const owners = this.db.prepare("SELECT root FROM tasks WHERE status IN ('active','cancelling')").all() as {root:string}[];
    const normalized = realpathSync.native(root).toLowerCase().replaceAll("\\", "/");
    if (owners.some(owner => {
      const other = owner.root.toLowerCase().replaceAll("\\", "/");
      return other === normalized || other.startsWith(normalized + "/") || normalized.startsWith(other + "/");
    })) throw new Error("Workspace already owned by a durable task (including overlapping roots). Use task_exec.");
  }
  private identity(root:string) {
    const info=statSync(root,{bigint:true});
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  }
  event(task: string, kind: string, details: unknown) {
    this.db.prepare("INSERT INTO events(task_id,time,kind,details) VALUES(?,?,?,?)").run(task, Date.now(), kind, JSON.stringify(details));
  }
  task(id: string): TaskRow {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;
    if (!row) throw new Error("Unknown task_id");
    if (realpathSync.native(row.root) !== row.root) throw new Error("Workspace identity changed");
    if (row.root_identity !== this.identity(row.root)) throw new Error("Workspace directory was replaced; refusing to resume");
    return row;
  }
  operation(task: string, id: string): OperationRow {
    const row = this.db.prepare("SELECT * FROM operations WHERE task_id=? AND id=?").get(task, id) as OperationRow | undefined;
    if (!row) throw new Error("Unknown operation_id");
    return row;
  }
  create(root: string, key: string, goal: string, acceptance: string[], leased = false) {
    root = realpathSync.native(root);
    const statePath=this.stateDir.toLowerCase().replaceAll("\\","/");
    const rootPath=root.toLowerCase().replaceAll("\\","/");
    if (statePath === rootPath || statePath.startsWith(rootPath + "/")) throw new Error("Task state must be outside the workspace");
    const id = "task_" + digest(root + "\0" + key).slice(0, 24);
    this.db.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;
      if (previous) {
        if (leased && previous.lease_epoch > 0) throw new Error("Task ownership already transferred; use the handoff receipt");
        if (previous.goal !== goal || previous.acceptance !== JSON.stringify(acceptance)) throw new Error("Idempotency key reused with different task input");
        return;
      }
      this.assertRootUnowned(root);
      const current = JSON.stringify(snapshot(root));
      this.db.prepare("INSERT INTO tasks(id,root,root_identity,goal,acceptance,status,checkpoint,initial,created) VALUES(?,?,?,?,?, 'active',?,?,?)")
        .run(id, root, this.identity(root), goal, JSON.stringify(acceptance), current, current, Date.now());
      this.event(id, "created", { goal, acceptance });
      if (leased) this.db.prepare("UPDATE tasks SET lease_token=? WHERE id=?").run(randomUUID(),id);
    }).immediate();
    return {...this.status(id), ...(leased ? {lease_token:this.task(id).lease_token} : {})};
  }
  logPath(task: string, operation: string) {
    return join(this.stateDir, "command-output", digest(task + "\0" + operation) + ".log");
  }
  result(task: string, operation: string) {
    const row = this.operation(task, operation);
    const path = this.logPath(task, operation);
    let output = "";
    let size = 0;
    if (existsSync(path)) {
      const fd = openSync(path, "r");
      try {
        size = statSync(path).size;
        const buffer = Buffer.alloc(Math.min(size, 16000));
        const read = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        output = buffer.subarray(0, read).toString("utf8");
      } finally { closeSync(fd); }
    }
    const stale = ["prepared", "running"].includes(row.state) && Date.now() - row.heartbeat > 15000;
    return { ...row, recovery: stale || row.state === "unknown" ? "unknown_outcome_do_not_repeat" : row.state,
      inputs:this.db.prepare('SELECT id,eof,state FROM operation_inputs WHERE task_id=? AND operation_id=? ORDER BY rowid').all(task,operation),
      output, output_truncated: size > 16000, output_file: path };
  }
  diagnostics(id:string) {
    const task=this.task(id);
    return {task_id:id,root:task.root,status:task.status,limits:snapshotLimits(),
      checkpoint_fingerprint:(JSON.parse(task.checkpoint) as Snapshot).fingerprint,
      verification:'not_performed',
      operations:this.db.prepare('SELECT id,state,kind,error FROM operations WHERE task_id=? ORDER BY created DESC LIMIT 100').all(id),
      next:'Use read/search tools for source inspection; task_operation for output. Writes and shell execution still require the task lease and a complete fingerprint.'};
  }
  status(id: string) {
    const task = this.task(id);
    const current = snapshot(task.root);
    const checkpoint = JSON.parse(task.checkpoint) as Snapshot;
    const initial = JSON.parse(task.initial) as Snapshot;
    const testFilesChanged = Object.keys(initial.files).filter(path => isTestEvidencePath(path)
      && initial.files[path] !== current.files[path]);
    const ids = this.db.prepare("SELECT id FROM operations WHERE task_id=? ORDER BY created").all(id) as {id: string}[];
    return { task_id: id, root: task.root, goal: task.goal, acceptance: JSON.parse(task.acceptance),
      status: task.status === "complete" && current.fingerprint !== checkpoint.fingerprint ? "completion_stale" : task.status,
      note: task.note, fingerprint: current.fingerprint, checkpoint_fingerprint: checkpoint.fingerprint,
      lease_epoch:task.lease_epoch,
      workflow: new TaskWorkflow(this).inspect(id),
      handoffs:this.db.prepare("SELECT id,state,source_epoch,fingerprint,note,created FROM handoffs WHERE task_id=? ORDER BY created").all(id),
      continuation:this.db.prepare('SELECT * FROM continuation_receipts WHERE task_id=?').all(id),
      checkpoint_matches: current.fingerprint === checkpoint.fingerprint,
      changed_files: [...new Set([...Object.keys(current.files), ...Object.keys(checkpoint.files)])].filter(p => current.files[p] !== checkpoint.files[p]),
      tests_require_review: testFilesChanged, operations: ids.map(op => this.result(id, op.id)),
      retry_blocked:this.retryBlocked(id),
      skills_manager_operations:this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skills_manager_operations'").get()
        ?this.db.prepare('SELECT id,endpoint,tool,state,substr(result,1,8000) AS result_preview,length(result)>8000 AS result_truncated FROM skills_manager_operations WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(id):[],
      skills_manager_runs:this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skills_manager_runs'").get()
        ?this.db.prepare('SELECT endpoint,run_id FROM skills_manager_runs WHERE task_id=? ORDER BY rowid').all(id):[],
      events: this.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY seq DESC LIMIT 100").all(id) };
  }
  checkpoint(id: string, expected: string, note: string, lease?: string) {
    this.db.transaction(() => {
      const task = this.task(id);
      this.assertLease(task,lease);
      this.assertIdle(task);
      const current = snapshot(task.root);
      if (current.fingerprint !== expected) throw new Error("Workspace changed; inspect task_resume before checkpointing");
      this.db.prepare("UPDATE tasks SET checkpoint=?,note=? WHERE id=?").run(JSON.stringify(current), note, id);
      this.event(id, "checkpoint", { fingerprint: expected, note });
    }).immediate();
    return this.status(id);
  }
  readonly interactionBusy=new Set<string>();
  assertIdle(task: TaskRow,allowInteractionUnknown=false,allowedBrowserWaiting:readonly string[]=[],allowDesktopApp=false,sharedOperation?:string) {
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='global_memory_participants'").get()
      &&this.db.prepare("SELECT 1 FROM global_memory_participants p JOIN global_memory_operations o ON o.id=p.operation_id WHERE p.root=? AND o.state='pending' AND o.id<>?").get(task.root,sharedOperation??''))
      throw new Error('Pending shared memory transaction; inspect and use global_memory_recover before further writes');
    if(allowedBrowserWaiting.length>48)throw new Error('Too many pending browser operations');
    if(this.interactionBusy.has(task.id))throw new Error('Browser or desktop interaction in progress');
    if(!allowInteractionUnknown&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skills_manager_operations'").get()
      &&this.db.prepare("SELECT 1 FROM skills_manager_operations WHERE task_id=? AND state='unknown'").get(task.id))throw new Error('Unknown Skills Manager result; inspect and resolve in the local manager before further writes');
    if(!allowInteractionUnknown)for(const table of ['browser_operations','desktop_operations','mcp_gateway_operations']){
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)){
        const waiting=table==='browser_operations'?allowedBrowserWaiting:[];
        const exclusion=waiting.length?` AND NOT (state IN ('waiting_dialog','waiting_upload','waiting_download') AND id IN (${waiting.map(()=>'?').join(',')}))`:'';
        if(this.db.prepare(`SELECT 1 FROM ${table} WHERE task_id=? AND state IN ('unknown','waiting_dialog','waiting_upload','waiting_download')${exclusion}`).get(task.id,...waiting))throw new Error('Unknown browser/desktop result or pending dialog/file transfer; inspect then resolve before further writes');
      }
    }
    if (task.status !== "active") throw new Error("Task is not active");
    // Only desktop interaction can coexist with an explicitly declared GUI
    // command. Prepared/unknown commands, all other commands and all file writes
    // still retain the ordinary single-operation fence.
    if (this.db.prepare("SELECT 1 FROM operations WHERE task_id=? AND state IN ('prepared','running','unknown')"+(allowDesktopApp?" AND NOT (kind='desktop_app' AND state='running')":"")).get(task.id))
      throw new Error("Outstanding operation: poll its operation_id. Unknown outcomes must not be repeated.");
  }
  assertLease(task: TaskRow, lease?: string, allowPending=false) {
    if (task.lease_token !== null && task.lease_token !== lease) throw new Error("Stale or missing write lease; recover the handoff receipt");
    if (!allowPending && this.db.prepare("SELECT 1 FROM handoffs WHERE task_id=? AND state='prepared'").get(task.id)) throw new Error("Handoff awaiting claim; writes are frozen");
  }
  exec(id: string, operationId: string, cmd: string, expected: string, timeout = 300000, kind = "command", lease?: string) {
    if(!['command','verify','desktop_app'].includes(kind))throw new Error('Unsupported command kind');
    if(kind==='desktop_app'&&process.platform!=='win32')throw new Error('Desktop app sessions require Windows');
    if (!operationId || operationId.length > 160 || !cmd || cmd.length > 65536) throw new Error("Invalid operation input");
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3600000) throw new Error("Timeout must be 100..3600000 ms");
    const request = digest(JSON.stringify({cmd, expected, timeout, kind}));
    const inserted = this.db.transaction(() => {
      const task = this.task(id);
      this.assertLease(task,lease);
      const previous = this.db.prepare("SELECT * FROM operations WHERE task_id=? AND id=?").get(id, operationId) as OperationRow | undefined;
      if (previous) {
        if (previous.request !== request) throw new Error("operation_id reused with different input");
        return false;
      }
      this.assertIdle(task);
      if (kind === "verify" && !(JSON.parse(task.acceptance) as string[]).includes(cmd)) throw new Error("Verification command is not in task acceptance criteria");
      if(this.retryBlocked(id)) throw new Error("Three identical failures without source progress; local operator review required");
      if (snapshot(task.root).fingerprint !== expected) throw new Error("Workspace changed; inspect task_resume before dispatch");
      this.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?,?,'prepared',?,?,?,?)")
        .run(id, operationId, request, cmd, kind, Date.now(), Date.now(), timeout, expected);
      this.event(id, "prepared", { operation_id: operationId, cmd, kind });
      return true;
    }).immediate();
    if (inserted) {
      const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./durable-worker.ts" : "./durable-worker.js", import.meta.url));
      const args = [...(worker.endsWith(".ts") ? ["--import", "tsx"] : []), worker, this.stateDir, id, operationId];
      const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: "ignore" });
      child.on("error", error => {
        // No retry even here: the journal is the authority, never process-local state.
        if (this.db.open) {
          this.db.prepare("UPDATE operations SET state='unknown',error=? WHERE task_id=? AND id=? AND state='prepared'").run(error.message, id, operationId);
          this.event(id, "dispatch_error", { operation_id: operationId, error: error.message });
        }
      });
      child.unref();
    }
    return this.result(id, operationId);
  }
  cancel(id: string, lease?: string) {
    this.db.transaction(() => {
      const task = this.task(id);
      this.assertLease(task,lease);
      if (task.status === "complete" || task.status === "cancelled") return;
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='global_memory_participants'").get()
        &&this.db.prepare("SELECT 1 FROM global_memory_participants p JOIN global_memory_operations o ON o.id=p.operation_id WHERE p.root=? AND o.state='pending'").get(task.root))throw new Error('Recover pending shared memory transaction before cancelling');
      this.db.prepare("UPDATE operations SET cancel=1 WHERE task_id=? AND state IN ('prepared','running','unknown')").run(id);
      // Retain workspace ownership until the worker acknowledges termination.
      const pending = this.db.prepare("SELECT 1 FROM operations WHERE task_id=? AND state IN ('prepared','running','unknown')").get(id);
      this.db.prepare("UPDATE tasks SET status=?,note='Cancellation requested; inspect operation receipt before releasing workspace' WHERE id=?").run(pending ? "cancelling" : "cancelled",id);
      this.event(id, "cancel_requested", {});
    }).immediate();
    return this.status(id);
  }
  input(id:string,opId:string,inputId:string,data:string,eof:boolean,lease?:string) {
    return this.db.transaction(()=>{
      this.assertLease(this.task(id),lease);
      const previous=this.db.prepare('SELECT * FROM operation_inputs WHERE task_id=? AND operation_id=? AND id=?').get(id,opId,inputId) as {data:string;eof:number;state:string}|undefined;
      if(previous){if(previous.data!==data || previous.eof!==Number(eof))throw new Error('input_id reused with different data');return {input_id:inputId,state:previous.state};}
      const op=this.operation(id,opId);
      if(op.state!=='running'||!op.stdin_supported||op.cancel||Date.now()-op.heartbeat>15000)throw new Error('Operation is not accepting input; inspect its receipt');
      if(Buffer.byteLength(data)>4096)throw new Error('Input limit is 4096 UTF-8 bytes');
      if(this.db.prepare('SELECT 1 FROM operation_inputs WHERE task_id=? AND operation_id=? AND eof=1').get(id,opId))throw new Error('EOF already requested');
      const pending=this.db.prepare("SELECT COUNT(*) AS n FROM operation_inputs WHERE task_id=? AND operation_id=? AND state IN ('queued','sending','unknown')").get(id,opId) as {n:number};
      if(pending.n>=32)throw new Error('Input queue is full');
      this.db.prepare("INSERT INTO operation_inputs VALUES(?,?,?,?,?,'queued')").run(id,opId,inputId,data,Number(eof));
      this.event(id,'input_queued',{operation_id:opId,input_id:inputId,eof});return {input_id:inputId,state:'queued'};
    }).immediate();
  }
  // Local operator entrypoint, deliberately not an MCP tool. Shell access is
  // user authority, so this is a workflow boundary, not an authentication sandbox.
  async reconcile(id: string, operationId: string, expected: string, evidence: string, operator: string) {
    if (!evidence.trim() || evidence.length > 16000 || !operator.trim()) throw new Error("Operator and side-effect investigation evidence are required");
    const windows = process.platform === "win32" ? await import("./durable-windows-job.js") : null;
    const receipt = JSON.stringify({fingerprint:expected,evidence,operator});
    this.db.transaction(() => {
      const task = this.task(id);
      const op = this.operation(id,operationId);
      if (op.kind === 'file_batch') throw new Error('File batches require task_edit_recover; generic reconciliation cannot release partial file edits');
      if (op.state === "reconciled") {
        if (op.reconciliation !== receipt) throw new Error("Operation already reconciled with different evidence");
        return;
      }
      if (!["prepared","running","unknown"].includes(op.state)) throw new Error("Only unresolved operations can be reconciled");
      if (!['active','cancelling'].includes(task.status)) throw new Error("Task no longer owns the workspace");
      if (op.worker_pid !== null) {
        if (!windows || !op.worker_creation || (op.kind!=='file' && !op.job_name)) throw new Error("Missing Windows worker/job identity; cannot safely release this legacy operation");
        if(op.kind==='file') {
          if(windows.windowsProcessIdentity(op.worker_pid)===op.worker_creation) throw new Error('File writer is still running; restart its service before reconciliation');
        } else windows.assertWindowsJobStopped(op.worker_pid,op.worker_creation,op.job_name!);
      } else if (op.state === "running") {
        throw new Error("Missing worker identity; cannot safely reconcile running operation");
      }
      // The immediate transaction fences delayed claims before releasing ownership.
      const current = snapshot(task.root);
      if (current.fingerprint !== expected) throw new Error("Workspace changed since investigation; inspect again");
      this.db.prepare("UPDATE operations SET state='reconciled',reconciliation=?,after_hash=?,heartbeat=? WHERE task_id=? AND id=?")
        .run(receipt,expected,Date.now(),id,operationId);
      this.event(id,"operator_reconciled",{operation_id:operationId,previous_state:op.state,...JSON.parse(receipt)});
      // All earlier acceptance evidence is invalid after an unknown outcome,
      // including when source bytes happen to match their old values.
      this.db.prepare("UPDATE operations SET state='verification_invalidated' WHERE task_id=? AND kind='verify' AND state='completed'").run(id);
      this.db.prepare("UPDATE tasks SET checkpoint=?,note=?,status=? WHERE id=?")
        .run(JSON.stringify(current),"Operator reconciled unknown outcome; run fresh acceptance checks",task.status === "cancelling" ? "cancelled" : "active",id);
    }).immediate();
    return this.result(id,operationId);
  }
  prepareHandoff(id:string, handoffId:string, expected:string, note:string, lease:string) {
    return this.db.transaction(()=>{
      const task=this.task(id);
      this.assertLease(task,lease,true);
      if (!task.lease_token) throw new Error("Legacy task has no transferable write lease; finish it or use local adoption");
      this.assertIdle(task);
      const old=this.db.prepare("SELECT * FROM handoffs WHERE task_id=? AND id=?").get(id,handoffId) as {fingerprint:string;note:string;claim_token:string;state:string;context:string|null}|undefined;
      if(old) {
        if(old.fingerprint!==expected || old.note!==note || old.state!=="prepared") throw new Error("Handoff identifier already used");
        return {task_id:id,handoff_id:handoffId,claim_token:old.claim_token,expected_fingerprint:expected,note,context:old.context ? JSON.parse(old.context) : null};
      }
      if(snapshot(task.root).fingerprint!==expected) throw new Error("Workspace changed before handoff");
      const token=randomUUID();
      const context = {source_head:sourceHead(task.root),goal:task.goal,acceptance_commands:JSON.parse(task.acceptance),checkpoint_note:task.note,
        next_objective:note,workflow:new TaskWorkflow(this).inspect(id),plan:new TaskPlans(this).status(id)};
      this.db.prepare("INSERT INTO handoffs(task_id,id,state,source_epoch,fingerprint,note,claim_token,created,context) VALUES(?,?,'prepared',?,?,?,?,?,?)")
        .run(id,handoffId,task.lease_epoch,expected,note,token,Date.now(),JSON.stringify(context));
      this.event(id,"handoff_prepared",{handoff_id:handoffId,fingerprint:expected,source_epoch:task.lease_epoch});
      return {task_id:id,handoff_id:handoffId,claim_token:token,expected_fingerprint:expected,note,context};
    }).immediate();
  }
  retryBlocked(id:string) {
    const rows=this.db.prepare("SELECT * FROM operations WHERE task_id=? AND kind='verify' AND rowid>COALESCE((SELECT after_rowid FROM retry_reviews WHERE task_id=?),0) ORDER BY rowid DESC LIMIT 3").all(id,id) as OperationRow[];
    if(rows.length!==3 || rows.some(r=>r.state!=="completed" || r.exit_code===0 || r.exit_code===null)) return false;
    const signature=(r:OperationRow)=>digest(JSON.stringify([r.cmd,r.exit_code,r.before_hash,r.after_hash,failureOutputEvidence(this.result(id,r.id).output)]));
    return rows.every(r=>signature(r)===signature(rows[0]!));
  }
  operatorReview(id:string,expected:string,evidence:string,operator:string,kind:'tests'|'retry') {
    if(!evidence.trim() || !operator.trim()) throw new Error("Review evidence is required");
    this.db.transaction(()=>{
      const task=this.task(id); this.assertIdle(task);
      if(snapshot(task.root).fingerprint!==expected) throw new Error("Workspace changed before review");
      if(kind==='tests') this.db.prepare("INSERT OR REPLACE INTO operator_reviews VALUES(?,?,?,?)").run(id,expected,evidence,operator);
      else this.db.prepare("INSERT OR REPLACE INTO retry_reviews VALUES(?,(SELECT COALESCE(MAX(rowid),0) FROM operations WHERE task_id=?),?)").run(id,id,evidence);
      this.event(id,"operator_review",{kind,fingerprint:expected,evidence,operator});
    }).immediate();
    return this.status(id);
  }
  recoverLease(id:string,expected:string,evidence:string) {
    return this.db.transaction(()=>{
      const task=this.task(id); this.assertIdle(task);
      if(!evidence.trim()) throw new Error("Recovery explanation required");
      if(snapshot(task.root).fingerprint!==expected) throw new Error("Workspace changed before recovery");
      const token=randomUUID();
      this.db.prepare("UPDATE handoffs SET state='withdrawn' WHERE task_id=? AND state='prepared'").run(id);
      this.db.prepare("UPDATE continuation_receipts SET state='obsolete',updated=? WHERE task_id=? AND state!='claimed'").run(Date.now(),id);
      this.db.prepare("UPDATE tasks SET lease_token=?,lease_epoch=lease_epoch+1 WHERE id=?").run(token,id);
      this.event(id,"operator_lease_recovered",{evidence,lease_epoch:task.lease_epoch+1});
      return {task_id:id,lease_token:token,lease_epoch:task.lease_epoch+1};
    }).immediate();
  }
  claimHandoff(id:string,handoffId:string,token:string,recipient:string,expected:string) {
    return this.db.transaction(()=>{
      const task=this.task(id);
      const h=this.db.prepare("SELECT * FROM handoffs WHERE task_id=? AND id=?").get(id,handoffId) as {state:string;claim_token:string;fingerprint:string;source_epoch:number;recipient:string;lease_token:string;note:string}|undefined;
      if(!h || h.claim_token!==token || h.fingerprint!==expected) throw new Error("Invalid handoff receipt");
      const continuity=()=>{
        const row=this.db.prepare("SELECT context,created FROM handoffs WHERE task_id=? AND id=?").get(id,handoffId) as {context:string|null;created:number};
        const events=this.db.prepare("SELECT kind FROM events WHERE task_id=? AND time>=? ORDER BY rowid").all(id,row.created) as {kind:string}[];
        return {workspace_fingerprint:expected,workspace_matches:snapshot(task.root).fingerprint===expected,context_sha256:digest(row.context??''),
          operations_since_prepare:(this.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE task_id=? AND created>=?").get(id,row.created) as {n:number}).n,
          events_since_prepare:events.map(e=>e.kind)};
      };
      if(h.state==='claimed') {
        if(h.recipient!==recipient || task.lease_token!==h.lease_token) throw new Error("Handoff already claimed or superseded");
        return {task_id:id,lease_token:h.lease_token,lease_epoch:task.lease_epoch,continuity:continuity()};
      }
      if(h.state!=='prepared' || task.lease_epoch!==h.source_epoch) throw new Error("Handoff no longer claimable");
      this.assertIdle(task);
      const saved=this.db.prepare('SELECT context FROM handoffs WHERE task_id=? AND id=?').get(id,handoffId) as {context:string|null};
      const context=saved.context?JSON.parse(saved.context):{};
      if('source_head' in context && context.source_head!==sourceHead(task.root))throw Error('Source HEAD changed; withdraw and prepare a new handoff');
      if(snapshot(task.root).fingerprint!==expected) throw new Error("Workspace changed; source owner must withdraw and prepare a new handoff");
      const lease=randomUUID();
      this.db.prepare("UPDATE handoffs SET state='claimed',recipient=?,lease_token=? WHERE task_id=? AND id=?").run(recipient,lease,id,handoffId);
      this.db.prepare("UPDATE tasks SET lease_token=?,lease_epoch=lease_epoch+1,note=? WHERE id=?").run(lease,h.note,id);
      this.db.prepare("UPDATE continuation_receipts SET state='claimed',updated=? WHERE task_id=? AND handoff_id=?").run(Date.now(),id,handoffId);
      this.event(id,"handoff_claimed",{handoff_id:handoffId,recipient,lease_epoch:task.lease_epoch+1});
      return {task_id:id,lease_token:lease,lease_epoch:task.lease_epoch+1,continuity:continuity()};
    }).immediate();
  }
  withdrawHandoff(id:string,handoffId:string,lease:string) {
    return this.db.transaction(()=>{
      this.assertLease(this.task(id),lease,true);
      const changed=this.db.prepare("UPDATE handoffs SET state='withdrawn' WHERE task_id=? AND id=? AND state='prepared'").run(id,handoffId).changes;
      if(!changed) throw new Error("Handoff is not pending; inspect receipt before proceeding");
      this.db.prepare("UPDATE continuation_receipts SET state='obsolete',updated=? WHERE task_id=? AND handoff_id=?").run(Date.now(),id,handoffId);
      this.event(id,"handoff_withdrawn",{handoff_id:handoffId});
      return this.status(id);
    }).immediate();
  }
  queueContinuation(id:string,handoffId:string,lease:string) {
    return this.db.transaction(()=>{
      this.assertLease(this.task(id),lease,true);
      if(!this.db.prepare("SELECT 1 FROM handoffs WHERE task_id=? AND id=? AND state='prepared'").get(id,handoffId))throw new Error('No pending handoff');
      this.db.prepare("INSERT OR IGNORE INTO continuation_receipts(task_id,handoff_id,state,updated) VALUES(?,?,'queued',?)").run(id,handoffId,Date.now());
      return this.db.prepare('SELECT * FROM continuation_receipts WHERE task_id=? AND handoff_id=?').get(id,handoffId);
    }).immediate();
  }
  complete(id: string, lease?:string) {
    this.db.transaction(() => {
      const task = this.task(id);
      this.assertLease(task,lease);
      this.assertIdle(task);
      const state = this.status(id);
      if (state.workflow?.current_stage) throw new Error('Workflow stages remain; pass every stage gate before completing');
      const plan=new TaskPlans(this).status(id);
      if(plan.defined&&!plan.complete)throw Error('Plan steps remain; finish the plan before completing');
      new TaskPlans(this).assertClosed(id);
      const review=this.db.prepare("SELECT fingerprint FROM operator_reviews WHERE task_id=?").get(id) as {fingerprint:string}|undefined;
      if (state.tests_require_review.length && review?.fingerprint!==state.fingerprint) throw new Error("Existing tests or test configuration changed; independent review required");
      const commands = JSON.parse(task.acceptance) as string[];
      if (!commands.length) throw new Error("No acceptance commands");
      for (const cmd of commands) {
        const op = this.db.prepare("SELECT * FROM operations WHERE task_id=? AND kind='verify' AND cmd=? ORDER BY created DESC, rowid DESC LIMIT 1").get(id, cmd) as OperationRow | undefined;
        if (!op || op.state !== "completed" || op.exit_code !== 0 || op.before_hash !== state.fingerprint || op.after_hash !== state.fingerprint)
          throw new Error("Missing or stale successful verification for current workspace");
      }
      const finalSnapshot = snapshot(task.root);
      if (finalSnapshot.fingerprint !== state.fingerprint) throw new Error("Workspace changed during completion");
      this.db.prepare("UPDATE tasks SET status='complete',checkpoint=? WHERE id=?").run(JSON.stringify(finalSnapshot),id);
      this.event(id, "complete", { fingerprint: state.fingerprint });
    }).immediate();
    return this.status(id);
  }
}
