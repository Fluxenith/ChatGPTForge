import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DurableTasks, digest, snapshot } from './durable-tasks.js';
import { TaskFileBatches, type BatchChange } from './task-file-batches.js';
import { TaskFiles } from './task-files.js';
import { renameTask } from './task-rename.js';

function fixture(t: { after: (fn: () => void) => void }, seed: Record<string,string> = {}, acceptance = ['echo ok']) {
  const root = mkdtempSync(join(tmpdir(), 'forge-batch-')), project = join(root, '中文 專案'), state = join(root, 'state');
  mkdirSync(project); writeFileSync(join(project, 'a.txt'), 'before-a'); writeFileSync(join(project, 'b.txt'), 'before-b');
  for(const [path,content] of Object.entries(seed))writeFileSync(join(project,path),content);
  const engine = new DurableTasks(state), batches = new TaskFileBatches(engine);
  const task = engine.create(project, 'batch', 'recover multi-file edits', acceptance, true), lease = task.lease_token!;
  const changes: BatchChange[] = [{ path: 'a.txt', content: 'after-a', expected_hash: digest('before-a') }, { path: 'b.txt', content: 'after-b', expected_hash: digest('before-b') }];
  t.after(() => { if (engine.db.open) engine.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, project, state, engine, batches, task, lease, changes };
}
function child(f: ReturnType<typeof fixture>, extras: Record<string, unknown> = {}) {
  const config = join(f.root, `child-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(config, JSON.stringify({ state: f.state, task_id: f.task.task_id, operation_id: 'crash', expected: f.task.fingerprint, lease: f.lease, changes: f.changes, phase: 'replaced', index: 0, ...extras }));
  const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../test/fixtures/batch-writer.mjs', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; worker.stderr.on('data', data => errors += data);
  const exited = once(worker, 'exit').then(([code]) => { assert.equal(code, extras.exit_code ?? 71, errors); });
  return { worker, exited };
}
const text = (f: ReturnType<typeof fixture>, path: string) => readFileSync(join(f.project, path), 'utf8');

test('unresolved browser transfers and Skills Manager effects fence an interrupted batch recovery', t=>{
  for(const [table,state] of [['browser_operations','waiting_dialog'],['browser_operations','waiting_upload'],['browser_operations','waiting_download'],['skills_manager_operations','unknown']]){
    const f=fixture(t),interrupted=new TaskFileBatches(f.engine,(phase,index)=>{if(phase==='replaced'&&index===0)throw Error('Owned fixture interruption');});assert.equal(interrupted.write(f.task.task_id,'interrupted',f.changes,f.task.fingerprint,f.lease).state,'unknown');
    f.engine.db.exec(`CREATE TABLE ${table}(task_id TEXT,id TEXT,state TEXT)`);f.engine.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(f.task.task_id,'native-pending',state);const expected=snapshot(f.project).fingerprint;
    assert.throws(()=>f.batches.recover(f.task.task_id,'interrupted','blocked','rollback',expected,f.lease),/pending interaction/);assert.equal(snapshot(f.project).fingerprint,expected);assert.equal(f.engine.db.prepare('SELECT 1 FROM task_batch_recoveries WHERE id=?').get('blocked'),undefined);
    // Only this isolated fake notice is resolved; production unknown receipts
    // have no corresponding automatic clearing mechanism.
    f.engine.db.prepare(`UPDATE ${table} SET state='completed' WHERE task_id=?`).run(f.task.task_id);assert.equal(f.batches.recover(f.task.task_id,'interrupted','restore','rollback',expected,f.lease).operation.state,'completed');assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
  }
});

test('batch edits create/delete UTF-8 files, deduplicate and roll back without overwriting conflicts', t => {
  const f = fixture(t), files = new TaskFiles(f.engine);
  const changes = [...f.changes, { path: '新檔.txt', content: '你好', expected_hash: null }, { path: 'b.txt', content: null, expected_hash: digest('before-b') }];
  changes.splice(1, 1);
  const result = f.batches.write(f.task.task_id, 'edit', changes, f.task.fingerprint, f.lease);
  assert.equal(result.state, 'completed'); assert.equal(result.batch.outcome, 'applied'); assert.equal(existsSync(join(f.project, 'b.txt')), false);
  assert.equal(text(f, '新檔.txt'), '你好'); assert.equal(files.list(f.task.task_id).length, 3);
  assert.equal(f.batches.write(f.task.task_id, 'edit', changes, f.task.fingerprint, f.lease).state, 'completed');
  assert.throws(() => f.batches.write(f.task.task_id, 'edit', f.changes, f.task.fingerprint, f.lease), /different batch/);
  writeFileSync(join(f.project, '新檔.txt'), 'external');
  assert.equal(f.batches.write(f.task.task_id, 'edit', changes, f.task.fingerprint, f.lease).state, 'completed');
  assert.equal(text(f, '新檔.txt'), 'external', 'receipt replay must not reapply');
  assert.throws(() => files.rollback(f.task.task_id, 'edit', 'undo', f.lease), /conflict/);
  assert.equal(text(f, 'a.txt'), 'after-a', 'last-file conflict must prevent all rollback writes');
  writeFileSync(join(f.project, '新檔.txt'), '你好');
  assert.equal(files.rollback(f.task.task_id, 'edit', 'undo', f.lease).state, 'completed');
  assert.equal(snapshot(f.project).fingerprint, f.task.fingerprint);
  assert.equal(files.rollback(f.task.task_id, 'edit', 'undo', f.lease).state, 'completed');
});

test('batch preflight rejects stale hashes, unsafe paths, aliases and content limits before any mutation', t => {
  const f = fixture(t), run = (changes: BatchChange[], expected = f.task.fingerprint, lease = f.lease) => f.batches.write(f.task.task_id, 'invalid', changes, expected, lease);
  assert.throws(() => run([{ ...f.changes[0]! }, { ...f.changes[1]!, expected_hash: digest('stale') }]), /conflict/);
  assert.throws(() => run(f.changes, digest('stale')), /Workspace conflict/);
  assert.throws(() => run(f.changes, f.task.fingerprint, 'old'), /lease/);
  for (const path of ['../outside', '/outside', '.git/config', 'node_modules/x', 'a.txt:stream', 'CON.txt', 'trailing.', 'a/../b.txt'])
    assert.throws(() => run([{ path, content: 'bad', expected_hash: null }]), /Invalid/);
  assert.throws(() => run([f.changes[0]!, { ...f.changes[0]!, path: 'A.TXT' }]), /Duplicate/);
  assert.throws(() => run([{ path: 'large.txt', content: 'x'.repeat(1024 * 1024 + 1), expected_hash: null }]), /1 MiB/);
  assert.throws(() => run([{ path: 'invalid.txt', content: '\ud800', expected_hash: null }]), /UTF-8/);
  assert.throws(() => run(Array.from({ length: 65 }, (_, i) => ({ path: `${i}.txt`, content: 'x', expected_hash: null }))), /64/);
  assert.throws(() => run(Array.from({ length: 9 }, (_, i) => ({ path: `${i}.txt`, content: 'x'.repeat(1024 * 1024), expected_hash: null }))), /8 MiB/);
  assert.equal(snapshot(f.project).fingerprint, f.task.fingerprint); assert.equal(f.engine.status(f.task.task_id).operations.length, 0);
  linkSync(join(f.project, 'a.txt'), join(f.project, 'alias.txt'));
  assert.throws(() => run([f.changes[0]!, { path: 'alias.txt', content: 'x', expected_hash: digest('before-a') }], snapshot(f.project).fingerprint), /Hard-linked/);
  writeFileSync(join(f.project, 'binary.txt'), Buffer.from([255]));
  assert.throws(() => run([{ path: 'binary.txt', content: 'x', expected_hash: digest(Buffer.from([255])) }], snapshot(f.project).fingerprint), /UTF-8/);
});

test('real writer exit at staging, replacement or commit is recoverable in both directions after reopening SQLite', async t => {
  for (const phase of ['staged', 'replaced', 'before_commit']) for (const mode of ['finish', 'rollback'] as const) {
    const f = fixture(t);
    await child(f, { phase, index: phase === 'before_commit' ? 2 : 0 }).exited;
    f.engine.close();
    const reopened = new DurableTasks(f.state), batches = new TaskFileBatches(reopened);
    try {
      assert.ok(['running', 'unknown'].includes(reopened.status(f.task.task_id).operations[0]!.state));
      assert.throws(() => reopened.complete(f.task.task_id, f.lease), /Outstanding operation/);
      await assert.rejects(reopened.reconcile(f.task.task_id, 'crash', snapshot(f.project).fingerprint, 'inspect', 'tester'), /task_edit_recover/);
      assert.throws(() => batches.recover(f.task.task_id, 'crash', 'recover', mode, digest('stale'), f.lease), /changed/);
      const expected = snapshot(f.project).fingerprint;
      const receipt = batches.recover(f.task.task_id, 'crash', 'recover', mode, expected, f.lease);
      assert.equal(receipt.operation.state, 'completed'); assert.equal(receipt.operation.batch.outcome, mode === 'finish' ? 'applied' : 'rolled_back');
      assert.equal(text(f, 'a.txt'), mode === 'finish' ? 'after-a' : 'before-a'); assert.equal(text(f, 'b.txt'), mode === 'finish' ? 'after-b' : 'before-b');
      assert.ok(!readdirSync(f.project).some(path => path.endsWith('.tmp')));
      assert.equal(batches.recover(f.task.task_id, 'crash', 'recover', mode, expected, f.lease).operation.state, 'completed');
      assert.throws(() => batches.recover(f.task.task_id, 'crash', 'recover', mode, digest('different'), f.lease), /different input/);
    } finally { reopened.close(); }
  }
});

test('an interrupted rollback can itself be recovered and old recovery identifiers never replay edits', async t => {
  const f = fixture(t); await child(f, { phase: 'before_commit', index: 2 }).exited;
  const firstExpected=snapshot(f.project).fingerprint;
  await child(f, { action: 'recover', recovery_id: 'undo-1', mode: 'rollback', expected: firstExpected }).exited;
  assert.equal(text(f, 'a.txt'), 'before-a'); assert.equal(text(f, 'b.txt'), 'after-b');
  const receipt = f.batches.recover(f.task.task_id, 'crash', 'undo-2', 'rollback', snapshot(f.project).fingerprint, f.lease);
  assert.equal(receipt.operation.batch.outcome, 'rolled_back'); assert.equal(snapshot(f.project).fingerprint, f.task.fingerprint);
  writeFileSync(join(f.project, 'b.txt'), 'external');
  const replay=f.batches.recover(f.task.task_id,'crash','undo-1','rollback',firstExpected,f.lease);
  assert.equal((replay.recovery as {state:string}).state,'interrupted');
  assert.equal(text(f,'b.txt'),'external','old interrupted recovery receipt must never rerun after later edits');
  const old = f.engine.db.prepare('SELECT request FROM task_batch_recoveries WHERE id=?').get('undo-1'); assert.ok(old);
  const expected = digest(JSON.stringify({}));
  assert.throws(() => f.batches.recover(f.task.task_id, 'crash', 'undo-1', 'rollback', expected, f.lease), /different input/);
  assert.equal(text(f, 'b.txt'), 'external');
});

test('case-only filename journal survives real writer exits before and after metadata rename in both recovery directions',async t=>{
  for(const phase of ['staged','replaced','case_renamed','before_commit'])for(const mode of ['finish','rollback'] as const){
    const f=fixture(t);f.changes=[{path:'a.txt',rename_to:'A.txt',content:'after-a',expected_hash:digest('before-a')},f.changes[1]!];
    await child(f,{phase,index:phase==='before_commit'?2:0}).exited;f.engine.close();const engine=new DurableTasks(f.state),batches=new TaskFileBatches(engine);
    try{assert.throws(()=>engine.complete(f.task.task_id,f.lease),/Outstanding/);const expected=snapshot(f.project).fingerprint,receipt=batches.recover(f.task.task_id,'crash','recover',mode,expected,f.lease);assert.equal(receipt.operation.state,'completed');
      const desired=mode==='finish'?'A.txt':'a.txt';assert.deepEqual(readdirSync(f.project).sort(),[desired,'b.txt'].sort());assert.equal(text(f,desired),mode==='finish'?'after-a':'before-a');assert.equal(text(f,'b.txt'),mode==='finish'?'after-b':'before-b');
      assert.deepEqual(batches.recover(f.task.task_id,'crash','recover',mode,expected,f.lease),receipt);if(mode==='rollback')assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
    }finally{engine.close();}
  }
});

test('case-only moves refuse alias collisions, changed filenames and external bytes before rollback writes',t=>{
  const f=fixture(t),move={path:'a.txt',rename_to:'A.txt',content:'after-a',expected_hash:digest('before-a')};
  for(const change of [{...move,rename_to:'other.txt'},{...move,rename_to:'a.txt'},{...move,content:null},{...move,path:'A.txt',rename_to:'a.txt'}])assert.throws(()=>f.batches.write(f.task.task_id,'invalid',[change],f.task.fingerprint,f.lease),/case-only|filename/);
  assert.throws(()=>f.batches.write(f.task.task_id,'duplicate',[move,{path:'A.txt',content:'bad',expected_hash:digest('before-a')}],f.task.fingerprint,f.lease),/Duplicate/);assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
  assert.equal(f.batches.write(f.task.task_id,'move',[move,f.changes[1]!],f.task.fingerprint,f.lease).state,'completed');
  renameSync(join(f.project,'A.txt'),join(f.project,'a.TXT'));assert.throws(()=>f.batches.rollback(f.task.task_id,'move','undo',f.lease),/filename conflict/);assert.equal(text(f,'b.txt'),'after-b');assert.ok(readdirSync(f.project).includes('a.TXT'));
  renameSync(join(f.project,'a.TXT'),join(f.project,'A.txt'));writeFileSync(join(f.project,'A.txt'),'external');assert.throws(()=>f.batches.rollback(f.task.task_id,'move','undo',f.lease),/conflict/);assert.equal(text(f,'A.txt'),'external');assert.equal(text(f,'b.txt'),'after-b');
});

test('case-only rollback interrupted after filename restoration can itself finish or restore the applied rename',async t=>{
  for(const direction of ['finish','rollback'] as const){
    const f=fixture(t),changes=[{path:'a.txt',rename_to:'A.txt',content:'after-a',expected_hash:digest('before-a')},f.changes[1]!];assert.equal(f.batches.write(f.task.task_id,'original',changes,f.task.fingerprint,f.lease).state,'completed');
    await child(f,{action:'rollback',original_id:'original',phase:'case_renamed',index:0}).exited;f.engine.close();const engine=new DurableTasks(f.state),batches=new TaskFileBatches(engine);
    try{const recovered=batches.recover(f.task.task_id,'crash','restore-undo',direction,snapshot(f.project).fingerprint,f.lease);assert.equal(recovered.operation.state,'completed');const expected=direction==='finish'?'a.txt':'A.txt';assert.deepEqual(readdirSync(f.project).sort(),[expected,'b.txt'].sort());assert.equal(text(f,expected),direction==='finish'?'before-a':'after-a');assert.equal(text(f,'b.txt'),direction==='finish'?'before-b':'after-b');if(direction==='finish')assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
    }finally{engine.close();}
  }
});

test('case-only metadata moves work without content changes and old journal rows migrate unchanged',t=>{
  const f=fixture(t),legacy=f.batches.write(f.task.task_id,'legacy',f.changes,f.task.fingerprint,f.lease);assert.equal(legacy.state,'completed');
  f.engine.db.exec('ALTER TABLE task_batch_entries DROP COLUMN rename_to');const before=f.engine.db.prepare('SELECT * FROM task_batch_entries ORDER BY ordinal').all(),migrated=new TaskFileBatches(f.engine);
  const after=f.engine.db.prepare('SELECT task_id,id,ordinal,path,temp,before_data,after_data FROM task_batch_entries ORDER BY ordinal').all();assert.deepEqual(after,before);assert.deepEqual(migrated.receipt(f.task.task_id,'legacy'),legacy);
  assert.equal(migrated.rollback(f.task.task_id,'legacy','undo-legacy',f.lease).state,'completed');
  const changed=migrated.write(f.task.task_id,'case-only',[{path:'a.txt',rename_to:'A.txt',content:'before-a',expected_hash:digest('before-a')}],f.task.fingerprint,f.lease);assert.equal(changed.state,'completed');assert.deepEqual(readdirSync(f.project).sort(),['A.txt','b.txt']);
  assert.equal(migrated.rollback(f.task.task_id,'case-only','undo-case',f.lease).state,'completed');assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
});

test('concurrent requests with the same operation identifier produce one batch intent', async t => {
  const f=fixture(t);
  await Promise.all([child(f,{phase:'none',exit_code:0}).exited,child(f,{phase:'none',exit_code:0}).exited]);
  assert.equal(text(f,'a.txt'),'after-a');assert.equal(text(f,'b.txt'),'after-b');
  assert.equal((f.engine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='batch_prepared'").get() as {n:number}).n,1);
  assert.equal(f.engine.status(f.task.task_id).operations.length,1);
});

test('interrupted file creation/deletion can be restored while cancellation retains ownership',async t=>{
  const f=fixture(t);
  const changes:BatchChange[]=[{path:'a.txt',content:null,expected_hash:digest('before-a')},{path:'新檔.txt',content:'你好',expected_hash:null},f.changes[1]!];
  await child(f,{changes,index:1}).exited;
  assert.equal(existsSync(join(f.project,'a.txt')),false);assert.equal(text(f,'新檔.txt'),'你好');
  assert.equal(f.engine.cancel(f.task.task_id,f.lease).status,'cancelling');
  assert.throws(()=>f.batches.recover(f.task.task_id,'crash','finish','finish',snapshot(f.project).fingerprint,f.lease),/must be restored/);
  const result=f.batches.recover(f.task.task_id,'crash','restore','rollback',snapshot(f.project).fingerprint,f.lease);
  assert.equal(result.operation.batch.outcome,'rolled_back');assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
  assert.equal(f.engine.status(f.task.task_id).status,'cancelled');
});

test('an external edit during staging is detected before replacement and is never overwritten',t=>{
  const f=fixture(t),batches=new TaskFileBatches(f.engine,(phase,index)=>{if(phase==='staged' && index===0)writeFileSync(join(f.project,'a.txt'),'external');});
  const result=batches.write(f.task.task_id,'race',f.changes,f.task.fingerprint,f.lease);
  assert.equal(result.state,'unknown');assert.equal(text(f,'a.txt'),'external');assert.equal(text(f,'b.txt'),'before-b');
  assert.throws(()=>batches.recover(f.task.task_id,'race','restore','rollback',snapshot(f.project).fingerprint,f.lease),/file conflict/);
});

test('recovery refuses a live writer and leaves the partial batch reserved', async t => {
  const f = fixture(t), { worker, exited } = child(f, { hold: true });
  // This fixture is held inside its synchronous replacement callback.
  await Promise.race([once(worker.stdout, 'data'), delay(10000).then(() => { throw new Error('Writer did not reach hold'); })]);
  try {
    assert.throws(() => f.batches.recover(f.task.task_id, 'crash', 'too-soon', 'finish', snapshot(f.project).fingerprint, f.lease), /still running/);
    assert.throws(() => f.engine.exec(f.task.task_id, 'other', 'echo bypass', snapshot(f.project).fingerprint, 1000, 'command', f.lease), /Outstanding operation/);
  } finally {
    // Kill only the exact child handle created for this disposable fixture.
    worker.kill(); await exited.catch(() => {});
  }
  assert.equal(f.batches.recover(f.task.task_id, 'crash', 'after-stop', 'finish', snapshot(f.project).fingerprint, f.lease).operation.state, 'completed');
});

test('external target or staging edits after a crash are preserved and block recovery', async t => {
  const f = fixture(t); await child(f, { phase: 'staged' }).exited;
  const temp = readdirSync(f.project).find(path => path.endsWith('.tmp'))!;
  writeFileSync(join(f.project, temp), 'external-temp');
  assert.throws(() => f.batches.recover(f.task.task_id, 'crash', 'temp-conflict', 'finish', snapshot(f.project).fingerprint, f.lease), /staging conflict/);
  assert.equal(text(f, temp), 'external-temp'); assert.equal(text(f, 'a.txt'), 'before-a');
  writeFileSync(join(f.project, temp), 'after-a'); writeFileSync(join(f.project, 'b.txt'), 'external-b');
  assert.throws(() => f.batches.recover(f.task.task_id, 'crash', 'file-conflict', 'rollback', snapshot(f.project).fingerprint, f.lease), /file conflict/);
  assert.equal(text(f, 'b.txt'), 'external-b');
  writeFileSync(join(f.project, 'b.txt'), 'before-b'); writeFileSync(join(f.project, 'foreign.txt'), 'external');
  assert.throws(() => f.batches.recover(f.task.task_id, 'crash', 'workspace-conflict', 'finish', snapshot(f.project).fingerprint, f.lease), /outside batch/);
});

test('journaled semantic rename preserves aliases and shorthand behavior and requires fresh acceptance after rollback', async t => {
  const cmd = process.platform === 'win32' ? `& '${process.execPath.replaceAll("'", "''")}' main.mjs` : `'${process.execPath}' main.mjs`;
  const f = fixture(t,{
    'math.mjs':'export function double(n) { return n * 2; }\nexport const bag = { double };\n',
    'main.mjs':"import { double as twice, bag } from './math.mjs';\nconsole.log([twice(3), bag.double(4)].join(','));\n",
  },[cmd]);
  const expected = f.task.fingerprint;
  async function verify(op: string) {
    f.engine.exec(f.task.task_id, op, cmd, snapshot(f.project).fingerprint, 20000, 'verify', f.lease);
    for (let n = 0; n < 200; n++) {
      const result = f.engine.result(f.task.task_id, op);
      if (result.state === 'completed') { assert.equal(result.exit_code, 0, result.output); assert.match(result.output, /6,8/); return; }
      await delay(100);
    }
    throw new Error('Acceptance command did not finish');
  }
  await verify('before');
  const input = { task_id: f.task.task_id, operation_id: 'rename', expected_fingerprint: expected, lease_token: f.lease, file: 'math.mjs', line: 1, column: 18, new_name: 'scale' };
  const result = await renameTask(f.engine, f.batches, input, [f.project]);
  assert.equal(result.state, 'completed'); assert.equal(result.batch.files.length, 2);
  assert.match(text(f, 'math.mjs'), /double: scale/); assert.match(text(f, 'main.mjs'), /scale as twice/);
  assert.equal(execFileSync(process.execPath, ['main.mjs'], { cwd: f.project, encoding: 'utf8' }).trim(), '6,8');
  assert.equal((await renameTask(f.engine, f.batches, input, [f.project])).state, 'completed');
  assert.throws(() => f.engine.complete(f.task.task_id, f.lease), /stale/);
  assert.equal(new TaskFiles(f.engine).rollback(f.task.task_id, 'rename', 'undo', f.lease).state, 'completed');
  assert.equal(snapshot(f.project).fingerprint, expected);
  assert.throws(() => f.engine.complete(f.task.task_id, f.lease), /stale/, 'matching old bytes must not resurrect old verification');
  await verify('after'); assert.equal(f.engine.complete(f.task.task_id, f.lease).status, 'complete');
});

test('semantic rename refuses changed dependency declarations before persisting a write intent', async t => {
  const source="import { multiply as twice } from 'typed-math';\ntwice(3);\n";
  const f=fixture(t,{'main.ts':source,'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',types:[]},include:['main.ts']})});
  const dependency=join(f.project,'node_modules','typed-math');mkdirSync(dependency,{recursive:true});
  writeFileSync(join(dependency,'package.json'),JSON.stringify({name:'typed-math',types:'index.d.ts'}));
  writeFileSync(join(dependency,'index.d.ts'),'export declare function multiply(value:number):number;');
  const read=f.batches.readText.bind(f.batches);
  f.batches.readText=(root,path)=>{
    const content=read(root,path);
    writeFileSync(join(dependency,'index.d.ts'),'export declare function multiply(value:string):number;');
    return content;
  };
  await assert.rejects(renameTask(f.engine,f.batches,{task_id:f.task.task_id,operation_id:'stale-types',expected_fingerprint:f.task.fingerprint,lease_token:f.lease,file:'main.ts',line:2,column:2,new_name:'scale'},[f.project]),/environment changed/);
  assert.equal(text(f,'main.ts'),source);assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
  assert.equal(f.engine.status(f.task.task_id).operations.length,0);
});
