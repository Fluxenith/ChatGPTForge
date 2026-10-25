import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";
import { DurableTasks, snapshot, digest, failureOutputEvidence, isTestEvidencePath } from "./durable-tasks.js";

function fixture(t: {after:(fn:()=>void)=>void}) {
  const root = mkdtempSync(join(tmpdir(), "forge-durable-"));
  const project = join(root,"中文 專案"); mkdirSync(project);
  writeFileSync(join(project,"check.test.cjs"),"console.log('PASS');\n");
  const state = join(root,"state");
  const engine = new DurableTasks(state);
  t.after(() => { if (engine.db.open) engine.close(); rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); });
  return {root,project,state,engine};
}
const nodeCommand = (script:string) => process.platform === "win32"
  ? `& '${process.execPath.replaceAll("'","''")}' ${script}` : `'${process.execPath}' ${script}`;
async function finished(engine: DurableTasks, task: string, op: string) {
  const until = Date.now()+20000;
  while (Date.now()<until) {
    const value = engine.result(task,op);
    if (!["prepared","running"].includes(value.state)) return value;
    await delay(100);
  }
  throw new Error("Worker did not complete within test deadline");
}

test('unchanged failing Node TAP tests pause after three attempts despite timing noise', async t => {
  const f=fixture(t);
  writeFileSync(join(f.project,'failure.test.cjs'),"const test=require('node:test'); const assert=require('node:assert/strict'); test('fixed assertion',()=>assert.equal(1,2));\n");
  // A subprocess test runner must not inherit this harness's internal context.
  const cmd=(process.platform==='win32'?'$env:NODE_TEST_CONTEXT=$null; ':'unset NODE_TEST_CONTEXT; ')+nodeCommand('--test --test-reporter=tap failure.test.cjs');
  const task=f.engine.create(f.project,'tap-retry','Detect an unchanged failure',[cmd]);
  const outputs:string[]=[];
  for(let i=0;i<3;i++) {
    f.engine.exec(task.task_id,'attempt-'+i,cmd,task.fingerprint,20000,'verify');
    const result=await finished(f.engine,task.task_id,'attempt-'+i);
    assert.equal(result.exit_code,1,result.output);
    outputs.push(result.output);
  }
  assert.ok(outputs.every(output=>output.includes('duration_ms:')));
  assert.equal(f.engine.status(task.task_id).retry_blocked,true);
  assert.throws(()=>f.engine.exec(task.task_id,'attempt-4',cmd,task.fingerprint,20000,'verify'),/Three identical/);
});

test('retry evidence retains changed assertions and non-TAP numeric output',()=>{
  const tap=(actual:number,time:number)=>`TAP version 13\nnot ok 1 - fixed\n  ---\n  duration_ms: ${time}\n  expected: 2\n  actual: ${actual}\n  ...\n# duration_ms ${time+1}\n`;
  assert.equal(failureOutputEvidence(tap(1,0.25)),failureOutputEvidence(tap(1,8.3)));
  assert.notEqual(failureOutputEvidence(tap(1,0.25)),failureOutputEvidence(tap(3,0.25)));
  assert.equal(failureOutputEvidence('duration_ms: 10\nerror count 12'),'duration_ms: 10\nerror count 12');
});

test('test reduction review covers Python, Go and runner configuration',t=>{
  const {engine,project}=fixture(t);
  const paths=['test_billing.py','billing_test.go','vitest.config.ts','pytest.ini','pyproject.toml','conftest.py'];
  for(const path of paths)writeFileSync(join(project,path),'original test evidence');
  const task=engine.create(project,'test-review-formats','Do not silently reduce tests',['echo ok']);
  for(const path of paths)writeFileSync(join(project,path),'disabled or reduced');
  const current=engine.status(task.task_id);
  assert.deepEqual(current.tests_require_review.sort(),paths.sort());
  assert.throws(()=>engine.complete(task.task_id),/independent review/);
  for(const path of ['Specs/Example.cs','Package.JSON','app.spec.ts','.mocharc.json','WidgetTests.cs'])assert.equal(isTestEvidencePath(path),true,path);
  for(const path of ['src/main.ts','readme.md','assets/latest.png'])assert.equal(isTestEvidencePath(path),false,path);
});

test("abrupt coordinator death: independent worker finishes once and restarted journal recovers output", async t => {
  const f = fixture(t);
  writeFileSync(join(f.project,"once.cjs"),"const fs=require('node:fs'); fs.appendFileSync('count.txt','x'); setTimeout(()=>console.log('SURVIVED_RESTART'),2000);\n");
  const task = f.engine.create(f.project,"restart","resume",[nodeCommand("check.test.cjs")]);
  const cmd = nodeCommand("once.cjs");
  const harness = join(f.root,"coordinator.mjs");
  writeFileSync(harness, `import {DurableTasks} from ${JSON.stringify(new URL("./durable-tasks.ts",import.meta.url).href)};
    const e=new DurableTasks(${JSON.stringify(f.state)});
    e.exec(${JSON.stringify(task.task_id)},'once',${JSON.stringify(cmd)},${JSON.stringify(task.fingerprint)});
    console.log('DISPATCHED'); setInterval(()=>{},1000);`);
  const parent = spawn(process.execPath,["--import","tsx",harness],{stdio:["ignore","pipe","pipe"],windowsHide:true});
  t.after(()=>{ if (parent.exitCode === null) parent.kill(); });
  let errors=""; parent.stderr.on("data",data=>errors+=data);
  await Promise.race([once(parent.stdout,"data"),once(parent,"exit").then(()=>{throw new Error(errors);}),delay(10000).then(()=>{throw new Error("No dispatch");})]);
  parent.kill("SIGKILL"); await once(parent,"exit");
  f.engine.close();
  const recovered = new DurableTasks(f.state);
  try {
    const replay = recovered.exec(task.task_id,"once",cmd,task.fingerprint);
    assert.equal(replay.id,"once");
    const result = await finished(recovered,task.task_id,"once");
    assert.equal(result.exit_code,0,JSON.stringify(result));
    assert.match(result.output,/SURVIVED_RESTART/);
    assert.equal(readFileSync(join(f.project,"count.txt"),"utf8"),"x");
    assert.throws(()=>recovered.exec(task.task_id,"once","different",task.fingerprint),/different input/);
    const resumed = recovered.status(task.task_id);
    assert.equal(resumed.checkpoint_matches,false);
    assert.ok(resumed.changed_files.includes("count.txt"));
    recovered.checkpoint(task.task_id,resumed.fingerprint,"Continue with acceptance");
    recovered.exec(task.task_id,"verify",nodeCommand("check.test.cjs"),resumed.fingerprint,300000,"verify");
    assert.equal((await finished(recovered,task.task_id,"verify")).exit_code,0);
    assert.equal(recovered.complete(task.task_id).status,"complete");
    writeFileSync(join(f.project,"outside.txt"),"edit after completion");
    assert.equal(recovered.status(task.task_id).status,"completion_stale");
  } finally { recovered.close(); }
});

test("unknown launch windows and heartbeat gaps never replay or free workspace ownership", async t => {
  const {engine,project} = fixture(t);
  const task=engine.create(project,"unknown","unknown",[nodeCommand("check.test.cjs")]);
  engine.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?,?,'prepared',0,0,1000,?)")
    .run(task.task_id,"lost","request","echo dangerous","command",task.fingerprint);
  assert.equal(engine.result(task.task_id,"lost").recovery,"unknown_outcome_do_not_repeat");
  assert.throws(()=>engine.exec(task.task_id,"new","echo repeat",task.fingerprint),/Outstanding operation/);
  assert.throws(()=>engine.create(project,"other","other",["echo ok"]),/owned/);
  assert.equal(engine.cancel(task.task_id).status,"cancelling");
  assert.throws(()=>engine.create(project,"other","other",["echo ok"]),/owned/);
});

test("verification invalidates on outside edits and changes to tests cannot produce completion", async t => {
  const {engine,project}=fixture(t);
  const cmd=nodeCommand("check.test.cjs");
  const task=engine.create(project,"verify","verify",[cmd]);
  assert.equal(engine.create(project,"verify","verify",[cmd]).task_id,task.task_id);
  assert.throws(()=>engine.create(project,"verify","changed",[cmd]),/different/);
  engine.exec(task.task_id,"v1",cmd,task.fingerprint,300000,"verify");
  assert.equal((await finished(engine,task.task_id,"v1")).exit_code,0);
  writeFileSync(join(project,"source.cjs"),"external edit");
  assert.throws(()=>engine.complete(task.task_id),/stale/);
  assert.throws(()=>engine.exec(task.task_id,"old",cmd,task.fingerprint),/Workspace changed/);
  writeFileSync(join(project,"check.test.cjs"),"// removed assertions\n");
  const state=engine.status(task.task_id);
  engine.exec(task.task_id,"v2",cmd,state.fingerprint,300000,"verify");
  await finished(engine,task.task_id,"v2");
  assert.throws(()=>engine.complete(task.task_id),/independent review/);
});

test("cancellation and timeout leave persisted results and do not retry", async t => {
  const {engine,project}=fixture(t);
  writeFileSync(join(project,"wait.cjs"),"console.log('STARTED');setInterval(()=>{},1000)");
  const task=engine.create(project,"cancel","cancel",[nodeCommand("check.test.cjs")]);
  engine.exec(task.task_id,"cancel-op",nodeCommand("wait.cjs"),task.fingerprint);
  for(let n=0;n<100 && !engine.result(task.task_id,"cancel-op").output.includes("STARTED");n++) await delay(100);
  engine.cancel(task.task_id);
  assert.equal((await finished(engine,task.task_id,"cancel-op")).state,"cancelled");
  assert.equal(engine.status(task.task_id).status,"cancelled");
  const next=engine.create(project,"timeout","timeout",[nodeCommand("check.test.cjs")]);
  engine.exec(next.task_id,"timeout",nodeCommand("wait.cjs"),next.fingerprint,800);
  assert.equal((await finished(engine,next.task_id,"timeout")).state,"timed_out");
});

test("Windows worker death closes its job, stops descendants and preserves an unresolved receipt", {skip:process.platform !== "win32"}, async t => {
  const {engine,project,state}=fixture(t);
  writeFileSync(join(project,"pulse.cjs"),"const fs=require('node:fs');setInterval(()=>fs.appendFileSync('pulse.txt','x'),60)");
  const task=engine.create(project,"worker-crash","crash",[nodeCommand("check.test.cjs")]);
  engine.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?,?,'prepared',?,?,30000,?)")
    .run(task.task_id,"crash","test-injected",nodeCommand("pulse.cjs"),"command",Date.now(),Date.now(),task.fingerprint);
  const worker=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./durable-worker.ts",import.meta.url)),state,task.task_id,"crash"],{stdio:"ignore",windowsHide:true});
  t.after(()=>{if(worker.exitCode === null) worker.kill();});
  for(let n=0;n<100 && !existsSync(join(project,"pulse.txt"));n++) await delay(100);
  assert.ok(existsSync(join(project,"pulse.txt")),JSON.stringify(engine.result(task.task_id,"crash")));
  await assert.rejects(engine.reconcile(task.task_id,"crash",engine.status(task.task_id).fingerprint,"Inspected pulse file","tester"),/still running/);
  worker.kill("SIGKILL"); await once(worker,"exit");
  await delay(300);
  const before=readFileSync(join(project,"pulse.txt"),"utf8");
  await delay(500);
  assert.equal(readFileSync(join(project,"pulse.txt"),"utf8"),before);
  engine.db.prepare("UPDATE operations SET heartbeat=0 WHERE task_id=?").run(task.task_id);
  assert.equal(engine.result(task.task_id,"crash").recovery,"unknown_outcome_do_not_repeat");
  assert.throws(()=>engine.exec(task.task_id,"repeat",nodeCommand("pulse.cjs"),engine.status(task.task_id).fingerprint),/Outstanding/);
  const current=engine.status(task.task_id).fingerprint;
  await assert.rejects(engine.reconcile(task.task_id,"crash",task.fingerprint,"Inspected pulse file","tester"),/Workspace changed/);
  const receipt=await engine.reconcile(task.task_id,"crash",current,"Pulse stopped; only the expected pulse file changed","tester");
  assert.equal(receipt.state,"reconciled");
  assert.equal(receipt.exit_code,null);
  assert.equal((await engine.reconcile(task.task_id,"crash",current,"Pulse stopped; only the expected pulse file changed","tester")).state,"reconciled");
  await assert.rejects(engine.reconcile(task.task_id,"crash",current,"different","tester"),/different evidence/);
  assert.throws(()=>engine.complete(task.task_id),/verification/);
  engine.exec(task.task_id,"fresh-verification",nodeCommand("check.test.cjs"),current,300000,"verify");
  assert.equal((await finished(engine,task.task_id,"fresh-verification")).exit_code,0);
  assert.equal(engine.complete(task.task_id).status,"complete");
});

test("reconciliation fences a delayed worker and invalidates earlier acceptance even without file changes", async t => {
  const {engine,project,state}=fixture(t);
  const cmd=nodeCommand("check.test.cjs");
  const task=engine.create(project,"fence","fence delayed dispatch",[cmd]);
  engine.exec(task.task_id,"old-verify",cmd,task.fingerprint,300000,"verify");
  assert.equal((await finished(engine,task.task_id,"old-verify")).exit_code,0);
  engine.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?,?,'prepared',0,0,1000,?)")
    .run(task.task_id,"late","intent",nodeCommand(`-e 'require(\"fs\").writeFileSync(\"BAD\",\"duplicate\")'`),"command",task.fingerprint);
  await engine.reconcile(task.task_id,"late",task.fingerprint,"No command launched; inspected source and external effects","tester");
  const worker=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./durable-worker.ts",import.meta.url)),state,task.task_id,"late"],{stdio:"ignore",windowsHide:true});
  assert.equal((await once(worker,"exit"))[0],0);
  assert.equal(existsSync(join(project,"BAD")),false);
  assert.equal(engine.operation(task.task_id,"old-verify").state,"verification_invalidated");
  assert.throws(()=>engine.complete(task.task_id),/verification/);
  assert.equal(engine.cancel(task.task_id).status,"cancelled");
});

test("legacy schema migrates without inventing worker identities or releasing unresolved leases", async t => {
  const {engine,project,state}=fixture(t);
  const task=engine.create(project,"migration","legacy receipt",[nodeCommand("check.test.cjs")]);
  engine.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash,worker_pid) VALUES(?,?,?,?,?,'running',0,0,1000,?,?)")
    .run(task.task_id,"legacy","legacy","echo legacy","command",task.fingerprint,process.pid);
  engine.close();
  const old=new Database(join(state,"forge-tasks.sqlite"));
  for(const name of ["worker_creation","job_name","reconciliation"]) old.exec(`ALTER TABLE operations DROP COLUMN ${name}`);
  old.close();
  const migrated=new DurableTasks(state);
  try {
    assert.equal(migrated.operation(task.task_id,"legacy").worker_creation,null);
    await assert.rejects(migrated.reconcile(task.task_id,"legacy",task.fingerprint,"Inspected","tester"),/Missing Windows/);
    assert.equal(migrated.cancel(task.task_id).status,"cancelling");
    assert.throws(()=>migrated.create(project,"other","other",["echo ok"]),/owned/);
  } finally {migrated.close();}
});

test("Windows identity distinguishes a reused PID and refuses a live job with remaining descendants", {skip:process.platform !== "win32"}, async t => {
  const {project,root}=fixture(t);
  const {windowsProcessIdentity,assertWindowsJobStopped,startWindowsJob}=await import("./durable-windows-job.js");
  const name=`Global\\ChatGPTForge-test-${process.pid}-${Date.now()}`;
  const identity=windowsProcessIdentity(process.pid)!;
  assert.ok(identity);
  assert.throws(()=>assertWindowsJobStopped(process.pid,identity,name),/still running/);
  assert.doesNotThrow(()=>assertWindowsJobStopped(process.pid,"0",name));
  const job=startWindowsJob("Start-Sleep -Seconds 30",project,join(root,"job.log"),name);
  try {
    assert.throws(()=>assertWindowsJobStopped(process.pid,"0",name),/still contains processes/);
    job.stop();
    for(let n=0;n<100 && job.poll() === null;n++) await delay(50);
    assert.doesNotThrow(()=>assertWindowsJobStopped(process.pid,"0",name));
  } finally {job.close();}
});

test('Windows durable stdin survives coordinator reopening and deduplicates delivery', {skip:process.platform!=='win32'},async t=>{
  const {engine,project,state}=fixture(t);
  writeFileSync(join(project,'input.cjs'),"let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>console.log('RECEIVED:'+data));console.log('READY');");
  const task=engine.create(project,'stdin','stdin',['echo ok']);
  engine.exec(task.task_id,'read',nodeCommand('input.cjs'),task.fingerprint,15000);
  for(let n=0;n<100&&!engine.result(task.task_id,'read').output.includes('READY');n++)await delay(100);
  assert.match(engine.result(task.task_id,'read').output,/READY/);
  engine.close();const reopened=new DurableTasks(state);
  try {
    reopened.input(task.task_id,'read','one','hello\n',true);
    reopened.input(task.task_id,'read','one','hello\n',true);
    assert.throws(()=>reopened.input(task.task_id,'read','one','different',true),/different/);
    const result=await finished(reopened,task.task_id,'read');
    assert.equal(result.exit_code,0,JSON.stringify(result));
    assert.match(result.output,/RECEIVED:hello/);
    assert.equal((result.output.match(/hello/g)??[]).length,1);
    assert.equal((result.inputs[0] as {state:string}).state,'written');
  }finally{reopened.close();}
});


test('snapshot limits fail closed, stream identical hashes, and leave diagnostics accessible',t=>{
  const f=fixture(t);
  const task=f.engine.create(f.project,'limits','test',['echo ok']);
  const old=process.env.FORGE_SNAPSHOT_MAX_BYTES;
  t.after(()=>{if(old===undefined)delete process.env.FORGE_SNAPSHOT_MAX_BYTES;else process.env.FORGE_SNAPSHOT_MAX_BYTES=old;});
  process.env.FORGE_SNAPSHOT_MAX_BYTES='1';
  assert.throws(()=>snapshot(f.project),/No partial fingerprint/);
  assert.equal(f.engine.diagnostics(task.task_id).verification,'not_performed');
  assert.ok(!('lease_token' in f.engine.diagnostics(task.task_id)));
  assert.throws(()=>f.engine.assertRootUnowned(f.project),/owned/);
  process.env.FORGE_SNAPSHOT_MAX_BYTES='4000000';
  const data=Buffer.alloc(2100000,42);writeFileSync(join(f.project,'big.bin'),data);
  assert.equal(snapshot(f.project).files['big.bin'],digest(data));
  process.env.FORGE_SNAPSHOT_MAX_BYTES='NaN';
  assert.throws(()=>snapshot(f.project),/Invalid positive integer/);
});
