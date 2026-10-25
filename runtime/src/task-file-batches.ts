import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { DurableTasks, digest, snapshot, type Snapshot } from './durable-tasks.js';
import { windowsProcessIdentity } from './durable-windows-job.js';

export interface BatchChange { path: string; content: string | null; expected_hash: string | null; rename_to?: string }
type Direction = 'finish' | 'rollback';
interface Batch { task_id: string; id: string; request: string; baseline: string; direction: Direction; outcome: string | null }
interface Entry { task_id: string; id: string; ordinal: number; path: string; temp: string; before_data: Buffer | null; after_data: Buffer | null; rename_to: string | null }
const hash = (data: Buffer | null) => data === null ? null : digest(data);
const bytes = (text: string | null) => text === null ? null : Buffer.from(text, 'utf8');

// An intent journal and atomic per-file replacements, not a multi-file filesystem
// transaction. A partial batch keeps the task reserved until explicitly recovered.
export class TaskFileBatches {
  constructor(private engine: DurableTasks, private observe?: (phase: 'staged' | 'replaced' | 'case_renamed' | 'before_commit', index: number) => void) {
    engine.db.exec(`CREATE TABLE IF NOT EXISTS task_file_batches (
      task_id TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,baseline TEXT NOT NULL,
      direction TEXT NOT NULL,outcome TEXT,PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS task_batch_entries (
      task_id TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,path TEXT NOT NULL,temp TEXT NOT NULL,
      before_data BLOB,after_data BLOB,PRIMARY KEY(task_id,id,ordinal));
      CREATE TABLE IF NOT EXISTS task_batch_recoveries (
      task_id TEXT NOT NULL,operation_id TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,
      direction TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(task_id,operation_id,id));`);
    engine.db.transaction(() => {
      if (!(engine.db.prepare('PRAGMA table_info(task_batch_entries)').all() as {name:string}[]).some(column => column.name === 'rename_to'))
        engine.db.exec('ALTER TABLE task_batch_entries ADD COLUMN rename_to TEXT');
    }).immediate();
  }
  private batch(id: string, op: string) {
    return this.engine.db.prepare('SELECT * FROM task_file_batches WHERE task_id=? AND id=?').get(id, op) as Batch | undefined;
  }
  private entries(id: string, op: string) {
    return this.engine.db.prepare('SELECT * FROM task_batch_entries WHERE task_id=? AND id=? ORDER BY ordinal').all(id, op) as Entry[];
  }
  has(id: string, op: string) { return !!this.batch(id, op); }
  private path(root: string, name: string) {
    const parts = name.replaceAll('\\', '/').split('/');
    if (!name || name.length > 1024 || isAbsolute(name) || parts.some(p => !p || p === '.' || p === '..'
      || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(\.git|node_modules)$/i.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Invalid batch file path');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Batch requires existing regular parent directories; links refused');
    }
    const canonicalParent = realpathSync.native(parent), boundary = relative(root, canonicalParent);
    if (isAbsolute(boundary) || boundary === '..' || boundary.startsWith('../') || boundary.startsWith('..\\')) throw new Error('Batch parent escaped workspace');
    const target = join(canonicalParent, parts.at(-1)!);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular batch files supported');
    }
    return target;
  }
  private read(root: string, name: string) {
    const target = this.path(root, name);
    if (!existsSync(target)) return null;
    const info = lstatSync(target);
    if (info.size > 1024 * 1024) throw new Error('Batch file exceeds 1 MiB limit');
    const data = readFileSync(target), after = lstatSync(target);
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('Batch file changed while reading');
    if (!Buffer.from(data.toString('utf8')).equals(data)) throw new Error('Only UTF-8 batch files supported');
    return data;
  }
  readText(root: string, name: string) {
    const data = this.read(root, name);
    if (data === null) throw new Error('Rename source no longer exists');
    return data.toString('utf8');
  }
  // Windows lookup aliases case spellings. Use the directory's actual entry
  // name so rollback/recovery also verifies the filename, not just file bytes.
  private caseFile(root: string, path: string, renameTo: string) {
    const target = this.path(root, path); this.path(root, renameTo);
    const names = readdirSync(dirname(target)).filter(name => name.toLowerCase() === basename(path).toLowerCase());
    if (names.length !== 1 || ![basename(path), basename(renameTo)].includes(names[0]!)) throw new Error(`External batch filename conflict: ${path}`);
    const actual = path.slice(0, path.lastIndexOf('/') + 1) + names[0]!;
    return { path: actual, data: this.read(root, actual) };
  }
  replay(id: string, op: string, request: unknown, lease?: string) {
    this.engine.assertLease(this.engine.task(id), lease);
    const batch = this.batch(id, op);
    if (!batch) {
      if (this.engine.db.prepare('SELECT 1 FROM operations WHERE task_id=? AND id=?').get(id, op)) throw new Error('operation_id already used by another operation');
      return undefined;
    }
    if (batch.request !== digest(JSON.stringify(request))) throw new Error('operation_id reused with different batch input');
    return this.receipt(id, op);
  }
  private owner() {
    const creation = process.platform === 'win32' ? windowsProcessIdentity(process.pid) : null;
    if (process.platform === 'win32' && creation === null) throw new Error('Cannot establish batch writer identity');
    return { pid: process.pid, creation };
  }
  write(id: string, op: string, changes: BatchChange[], expected: string, lease?: string, request: unknown = { kind: 'edit', changes, expected }) {
    const replay = this.replay(id, op, request, lease);
    if (replay) return replay;
    if (!changes.length || changes.reduce((count, change) => count + (change.rename_to === undefined ? 1 : 2), 0) > 64) throw new Error('Batch requires 1..64 file paths');
    const e = this.engine;
    const inserted = e.db.transaction(() => {
      if (this.replay(id, op, request, lease)) return false;
      const task = e.task(id); e.assertLease(task, lease); e.assertIdle(task);
      if (e.retryBlocked(id)) throw new Error('Repair attempts paused; local operator review required');
      const baseline = snapshot(task.root);
      if (baseline.fingerprint !== expected) throw new Error('Workspace conflict before batch; inspect current fingerprint');
      const paths = new Set<string>(), identities = new Set<string>();
      let size = 0;
      const entries = changes.map((change, ordinal) => {
        const target = this.path(task.root, change.path);
        const path = relative(task.root, change.rename_to !== undefined ? target : existsSync(target) ? realpathSync.native(target) : target).replaceAll('\\', '/');
        const key = target.toLowerCase();
        if (paths.has(key)) throw new Error('Duplicate or aliased batch path');
        paths.add(key);
        const before = this.read(task.root, path), after = bytes(change.content);
        let renameTo: string | null = null;
        if (change.rename_to !== undefined) {
          const destination = this.path(task.root, change.rename_to);
          renameTo = relative(task.root, destination).replaceAll('\\', '/');
          // Only filename case changes are represented by this logical entry.
          // Other moves retain the existing journaled create/delete path pairs.
          if (renameTo === path || dirname(renameTo) !== dirname(path) || renameTo.toLowerCase() !== path.toLowerCase() || before === null || after === null)
            throw new Error('Invalid case-only batch filename move');
          if (this.caseFile(task.root, path, renameTo).path !== path) throw new Error('Case-only source filename changed before batch');
        }
        if (after && (after.length > 1024 * 1024 || after.toString('utf8') !== change.content)) throw new Error('Batch content must be valid UTF-8 and at most 1 MiB');
        if (hash(before) !== change.expected_hash) throw new Error(`File conflict before batch: ${path}`);
        if (before !== null) {
          const info = lstatSync(target, { bigint: true }), identity = `${info.dev}:${info.ino}`;
          if (identities.has(identity)) throw new Error('Hard-linked batch targets refused');
          identities.add(identity);
        }
        size += (before?.length ?? 0) + (after?.length ?? 0);
        const temp = path.slice(0, path.lastIndexOf('/') + 1) + `.forge-batch-${digest(id + '\0' + op).slice(0, 24)}-${ordinal}.tmp`;
        if (existsSync(this.path(task.root, temp))) throw new Error('Batch staging path already exists');
        return { path, temp, before, after, ordinal, renameTo };
      });
      if (size > 8 * 1024 * 1024) throw new Error('Batch before/after contents exceed 8 MiB');
      if (entries.some(entry => paths.has(this.path(task.root, entry.temp).toLowerCase()))) throw new Error('Batch target collides with staging path');
      if (snapshot(task.root).fingerprint !== expected) throw new Error('Workspace changed during batch preparation');
      const owner = this.owner(), requestHash = digest(JSON.stringify(request));
      e.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash,worker_pid,worker_creation) VALUES(?,?,?,?, 'file_batch','running',?,?,0,?,?,?)")
        .run(id, op, requestHash, `Edit ${changes.length} files`, Date.now(), Date.now(), expected, owner.pid, owner.creation);
      e.db.prepare("INSERT INTO task_file_batches VALUES(?,?,?,?,'finish',NULL)").run(id, op, requestHash, JSON.stringify(baseline));
      for (const entry of entries) e.db.prepare('INSERT INTO task_batch_entries(task_id,id,ordinal,path,temp,before_data,after_data,rename_to) VALUES(?,?,?,?,?,?,?,?)').run(id, op, entry.ordinal, entry.path, entry.temp, entry.before, entry.after, entry.renameTo);
      this.invalidate(id);
      e.event(id, 'batch_prepared', { operation_id: op, paths: entries.map(entry => entry.path), fingerprint: expected });
      return true;
    }).immediate();
    if (inserted) this.run(id, op, 'finish');
    return this.receipt(id, op);
  }
  private invalidate(id: string) {
    this.engine.db.prepare("UPDATE operations SET state='verification_invalidated' WHERE task_id=? AND kind='verify' AND state='completed'").run(id);
  }
  // Every target must still contain one of the journaled versions. Staging files
  // are accepted only at their exact persisted paths and with journaled contents.
  private inspect(id: string, op: string) {
    const task = this.engine.task(id), batch = this.batch(id, op)!;
    const baseline = JSON.parse(batch.baseline) as Snapshot, current = snapshot(task.root), remaining = { ...current.files };
    for (const entry of this.entries(id, op)) {
      const value = hash(entry.rename_to ? this.caseFile(task.root, entry.path, entry.rename_to).data : this.read(task.root, entry.path));
      if (value !== hash(entry.before_data) && value !== hash(entry.after_data)) throw new Error(`External batch file conflict: ${entry.path}`);
      delete remaining[entry.path];
      if (entry.rename_to) delete remaining[entry.rename_to];
      if (Object.hasOwn(current.files, entry.temp)) {
        const temp = hash(this.read(task.root, entry.temp));
        if (temp !== hash(entry.before_data) && temp !== hash(entry.after_data)) throw new Error(`External staging conflict: ${entry.temp}`);
        delete remaining[entry.temp];
      }
    }
    const original = { ...baseline.files };
    for (const entry of this.entries(id, op)) { delete original[entry.path]; if (entry.rename_to) delete original[entry.rename_to]; }
    if (Object.keys(remaining).length !== Object.keys(original).length || Object.entries(original).some(([path, value]) => remaining[path] !== value))
      throw new Error('External workspace conflict outside batch targets');
    return current;
  }
  private run(id: string, op: string, direction: Direction, recoveryId?: string) {
    const e = this.engine;
    try {
      this.inspect(id, op);
      const root = e.task(id).root, entries = this.entries(id, op);
      for (const entry of entries) {
        const desired = direction === 'finish' ? entry.after_data : entry.before_data;
        const temp = this.path(root, entry.temp);
        if (existsSync(temp)) {
          const value = hash(this.read(root, entry.temp));
          if (value !== hash(entry.before_data) && value !== hash(entry.after_data)) throw new Error('External staging conflict');
          unlinkSync(temp);
        }
        const actual = entry.rename_to ? this.caseFile(root, entry.path, entry.rename_to).path : entry.path;
        const target = this.path(root, actual), current = hash(this.read(root, actual));
        if (current !== hash(entry.before_data) && current !== hash(entry.after_data)) throw new Error(`External batch file conflict: ${entry.path}`);
        if (current !== hash(desired)) {
          if (desired === null) { if (existsSync(target)) unlinkSync(target); }
          else {
            writeFileSync(temp, desired, { flag: 'wx' });
            const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
            this.observe?.('staged', entry.ordinal);
            if (entry.rename_to && this.caseFile(root, entry.path, entry.rename_to).path !== actual) throw new Error('Filename changed before replacement');
            if (hash(this.read(root, actual)) !== current) throw new Error(`File conflict before replacement: ${entry.path}`);
            renameSync(temp, this.path(root, actual));
          }
          this.observe?.('replaced', entry.ordinal);
        }
        if (entry.rename_to) {
          const intended = direction === 'finish' ? entry.rename_to : entry.path;
          const present = this.caseFile(root, entry.path, entry.rename_to);
          if (hash(present.data) !== hash(desired)) throw new Error('Case-only move content conflict');
          if (present.path !== intended) {
            renameSync(this.path(root, present.path), this.path(root, intended));
            if (this.caseFile(root, entry.path, entry.rename_to).path !== intended) throw new Error('Case-only filename move did not take effect');
            this.observe?.('case_renamed', entry.ordinal);
          }
        }
        e.db.prepare('UPDATE operations SET heartbeat=? WHERE task_id=? AND id=?').run(Date.now(), id, op);
      }
      const final = this.inspect(id, op);
      for (const entry of entries) {
        const desired = direction === 'finish' ? entry.after_data : entry.before_data;
        if (entry.rename_to && this.caseFile(root, entry.path, entry.rename_to).path !== (direction === 'finish' ? entry.rename_to : entry.path)) throw new Error('Batch did not reach its intended filename');
        if (hash(entry.rename_to ? this.caseFile(root, entry.path, entry.rename_to).data : this.read(root, entry.path)) !== hash(desired) || existsSync(this.path(root, entry.temp))) throw new Error('Batch did not reach its intended contents');
      }
      this.observe?.('before_commit', entries.length);
      if (snapshot(root).fingerprint !== final.fingerprint) throw new Error('Workspace changed before batch completion');
      e.db.transaction(() => {
        e.db.prepare('UPDATE task_file_batches SET outcome=? WHERE task_id=? AND id=?').run(direction === 'finish' ? 'applied' : 'rolled_back', id, op);
        e.db.prepare("UPDATE operations SET state='completed',exit_code=?,error=?,after_hash=?,heartbeat=?,worker_pid=NULL,worker_creation=NULL WHERE task_id=? AND id=?")
          .run(direction === 'finish' ? 0 : 1, direction === 'finish' ? null : 'Interrupted batch restored; run fresh acceptance', final.fingerprint, Date.now(), id, op);
        if (recoveryId) e.db.prepare("UPDATE task_batch_recoveries SET state='completed' WHERE task_id=? AND operation_id=? AND id=?").run(id, op, recoveryId);
        if (e.task(id).status === 'cancelling') e.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(id);
        e.event(id, 'batch_completed', { operation_id: op, outcome: direction, fingerprint: final.fingerprint, recovery_id: recoveryId });
      }).immediate();
    } catch (error) {
      // A returned synchronous failure has no remaining writer. A killed process
      // never reaches this release and recovery must prove its recorded PID dead.
      e.db.transaction(() => {
        e.db.prepare("UPDATE operations SET state='unknown',error=?,worker_pid=NULL,worker_creation=NULL,heartbeat=? WHERE task_id=? AND id=?").run(String(error), Date.now(), id, op);
        if (recoveryId) e.db.prepare("UPDATE task_batch_recoveries SET state='unknown' WHERE task_id=? AND operation_id=? AND id=?").run(id, op, recoveryId);
        e.event(id, 'batch_unknown', { operation_id: op, error: String(error), direction, recovery_id: recoveryId });
      }).immediate();
    }
  }
  private assertStopped(id: string, op: string) {
    const row = this.engine.operation(id, op);
    if (row.worker_pid === null) return;
    if (process.platform === 'win32') {
      if (!row.worker_creation) throw new Error('Missing batch writer identity; cannot recover');
      if (windowsProcessIdentity(row.worker_pid) === row.worker_creation) throw new Error('Batch writer is still running; wait for or stop its service');
    } else {
      try { process.kill(row.worker_pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      throw new Error('Batch writer is still running');
    }
  }
  recover(id: string, op: string, recoveryId: string, direction: Direction, expected: string, lease?: string) {
    if (!['finish', 'rollback'].includes(direction)) throw new Error('Invalid batch recovery direction');
    const e = this.engine, request = digest(JSON.stringify({ direction, expected }));
    const inserted = e.db.transaction(() => {
      const task = e.task(id); e.assertLease(task, lease);
      const previous = e.db.prepare('SELECT request FROM task_batch_recoveries WHERE task_id=? AND operation_id=? AND id=?').get(id, op, recoveryId) as { request: string } | undefined;
      if (previous) { if (previous.request !== request) throw new Error('recovery_id reused with different input'); return false; }
      if (!this.has(id, op) || !['running', 'prepared', 'unknown'].includes(e.operation(id, op).state)) throw new Error('Only an unresolved file batch can be recovered');
      if (!['active', 'cancelling'].includes(task.status) || (task.status === 'cancelling' && direction !== 'rollback')) throw new Error('Cancelling batch must be restored');
      if (e.interactionBusy.has(id)) throw new Error('Interaction is still running');
      for (const table of ['browser_operations', 'desktop_operations', 'skills_manager_operations', 'mcp_gateway_operations']) {
        if (e.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
          && e.db.prepare(`SELECT 1 FROM ${table} WHERE task_id=? AND state IN ('unknown','waiting_dialog','waiting_upload','waiting_download')`).get(id)) throw new Error('Unknown or pending interaction must be investigated first');
      }
      this.assertStopped(id, op);
      if (this.inspect(id, op).fingerprint !== expected) throw new Error('Workspace changed since recovery inspection');
      const owner = this.owner();
      e.db.prepare("UPDATE task_batch_recoveries SET state='interrupted' WHERE task_id=? AND operation_id=? AND state='running'").run(id, op);
      e.db.prepare("INSERT INTO task_batch_recoveries VALUES(?,?,?,?,?,'running')").run(id, op, recoveryId, request, direction);
      e.db.prepare('UPDATE task_file_batches SET direction=? WHERE task_id=? AND id=?').run(direction, id, op);
      e.db.prepare("UPDATE operations SET state='running',worker_pid=?,worker_creation=?,heartbeat=? WHERE task_id=? AND id=?").run(owner.pid, owner.creation, Date.now(), id, op);
      this.invalidate(id);
      e.event(id, 'batch_recovery_prepared', { operation_id: op, recovery_id: recoveryId, direction, fingerprint: expected });
      return true;
    }).immediate();
    if (inserted) this.run(id, op, direction, recoveryId);
    return { recovery: e.db.prepare('SELECT id,direction,state FROM task_batch_recoveries WHERE task_id=? AND operation_id=? AND id=?').get(id, op, recoveryId), operation: this.receipt(id, op) };
  }
  rollback(id: string, original: string, op: string, lease?: string) {
    const request = { kind: 'rollback', original }, replay = this.replay(id, op, request, lease);
    if (replay) return replay;
    if (this.batch(id, original)?.outcome !== 'applied' || this.engine.operation(id, original).state !== 'completed') throw new Error('Only a confirmed applied batch can be rolled back');
    return this.write(id, op, this.entries(id, original).map(entry => ({ path: entry.rename_to ?? entry.path, ...(entry.rename_to ? {rename_to:entry.path} : {}), content: entry.before_data?.toString('utf8') ?? null, expected_hash: hash(entry.after_data) })), snapshot(this.engine.task(id).root).fingerprint, lease, request);
  }
  receipt(id: string, op: string) {
    const batch = this.batch(id, op)!;
    return { ...this.engine.result(id, op), batch: { direction: batch.direction, outcome: batch.outcome, files: this.entries(id, op).map(entry => ({ path: entry.path, ...(entry.rename_to ? {rename_to:entry.rename_to} : {}), before_hash: hash(entry.before_data), after_hash: hash(entry.after_data) })) } };
  }
  list(id: string) {
    return (this.engine.db.prepare('SELECT * FROM task_batch_entries WHERE task_id=? ORDER BY rowid').all(id) as Entry[]).map(entry => ({
      operation_id: entry.id, path: entry.path, ...(entry.rename_to ? {rename_to:entry.rename_to} : {}), batch: true, before_hash: hash(entry.before_data), after_hash: hash(entry.after_data),
      before: entry.before_data?.toString('utf8').slice(0, 16000) ?? null, after: entry.after_data?.toString('utf8').slice(0, 16000) ?? null,
      state: this.engine.operation(id, entry.id).state, outcome: this.batch(id, entry.id)!.outcome,
    }));
  }
}
