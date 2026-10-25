// Isolated built-package smoke test: exercises the actual local operator CLI.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DurableTasks} from '../dist/durable-tasks.js';
import {defaultDevspaceConfig} from '../dist/config-schema.js';
import {writeDevspaceConfig,writeDevspaceAuth} from '../dist/user-config.js';

const root=mkdtempSync(join(tmpdir(),'forge-reconcile-cli-'));
const project=join(root,'中文 專案'); mkdirSync(project);
const configDir=join(root,'config'),state=join(root,'state');
const config=defaultDevspaceConfig();
config.storage.stateDir=state;
config.workspaces.allowedRoots=[project];
writeDevspaceConfig(config,{DEVSPACE_CONFIG_DIR:configDir});
writeDevspaceAuth({ownerToken:'isolated-smoke-test-owner-token-only'},{DEVSPACE_CONFIG_DIR:configDir});
const engine=new DurableTasks(state);
try {
  const task=engine.create(project,'cli','operator CLI acceptance',['echo accepted']);
  engine.db.prepare("INSERT INTO operations(task_id,id,request,cmd,kind,state,created,heartbeat,timeout_ms,before_hash) VALUES(?,?,?,?,?,'prepared',0,0,1000,?)")
    .run(task.task_id,'lost','injected','echo MUST_NOT_EXECUTE','command',task.fingerprint);
  const cli=fileURLToPath(new URL('./reconcile-task.mjs',import.meta.url));
  const run=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,...args],{
    env:{...process.env,CHATGPTFORGE_CONFIG_DIR:configDir},windowsHide:true,encoding:'utf8'}));
  assert.equal(run('inspect',task.task_id).operations[0].recovery,'unknown_outcome_do_not_repeat');
  const evidence=join(root,'investigation.txt');
  writeFileSync(evidence,'Injected unclaimed operation; no command launched, workspace unchanged.');
  const result=run('resolve',task.task_id,'lost',task.fingerprint,evidence);
  assert.equal(result.state,'reconciled'); assert.equal(result.exit_code,null);
  assert.equal(run('resolve',task.task_id,'lost',task.fingerprint,evidence).state,'reconciled');
  assert.equal(engine.cancel(task.task_id).status,'cancelled');
  console.log(JSON.stringify({status:'PASS',task_id:task.task_id,receipt_state:result.state,exit_code:result.exit_code,fixture:root},null,2));
} finally {engine.close();}
