// Operator-run live smoke test. Run start, restart MCP, then run resume.
// Uses only the explicitly supplied allowed test fixture; no model/API calls.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../dist/config.js';
import {DurableTasks} from '../dist/durable-tasks.js';
import {resolveCanonicalAllowedPath} from '../dist/roots.js';

const config=loadConfig({...process.env,DEVSPACE_CONFIG_DIR:process.env.CHATGPTFORGE_CONFIG_DIR ?? join(homedir(),'.chatgptforge')});
const mode=process.argv[2];
if(!['start','resume'].includes(mode) || !process.argv[3]) throw new Error('Usage: node scripts/accept-restart.mjs start|resume ABSOLUTE_FIXTURE_PATH');
const root=await resolveCanonicalAllowedPath(process.argv[3],process.cwd(),config.allowedRoots);
const engine=new DurableTasks(config.stateDir);
const receipt=join(config.stateDir,'restart-acceptance.json');
try {
  if(mode==='start') {
    const key='live-restart-'+Date.now();
    const file=key+'.txt';
    const task=engine.create(root,key,'Live MCP restart acceptance',['node sum.test.cjs']);
    const command=`Start-Sleep -Seconds 20; Add-Content -LiteralPath '${file}' -Value 'once'; Write-Output 'DURABLE_RESTART_PASS'`;
    const args={task:task.task_id,op:'once',command,fingerprint:task.fingerprint,file,root};
    writeFileSync(receipt,JSON.stringify(args,null,2));
    engine.exec(args.task,args.op,args.command,args.fingerprint);
    for(let n=0;n<100;n++) {
      if(engine.status(args.task).events.some(event=>event.kind==='process_started')) break;
      await delay(100);
    }
    assert.ok(engine.status(args.task).events.some(event=>event.kind==='process_started'),'Shell did not start');
    console.log(JSON.stringify({task_id:task.task_id,state:engine.result(args.task,args.op).state,receipt}));
  } else {
    const args=JSON.parse(readFileSync(receipt,'utf8'));
    assert.equal(args.root,root);
    // Repeat the identical dispatch after MCP restart; this must NOT launch twice.
    engine.exec(args.task,args.op,args.command,args.fingerprint);
    let result;
    for(let n=0;n<400;n++) {
      result=engine.result(args.task,args.op);
      if(!['prepared','running'].includes(result.state)) break;
      await delay(100);
    }
    assert.equal(result.exit_code,0,JSON.stringify(result));
    assert.match(result.output,/DURABLE_RESTART_PASS/);
    assert.equal(readFileSync(join(root,args.file),'utf8').trim(),'once');
    const resumed=engine.status(args.task);
    assert.equal(resumed.checkpoint_matches,false);
    engine.checkpoint(args.task,resumed.fingerprint,'Restart confirmed; side effect occurred once');
    engine.exec(args.task,'verify','node sum.test.cjs',resumed.fingerprint,300000,'verify');
    for(let n=0;n<200;n++) {
      if(!['prepared','running'].includes(engine.result(args.task,'verify').state)) break;
      await delay(100);
    }
    assert.equal(engine.complete(args.task).status,'complete');
    console.log(JSON.stringify({task_id:args.task,state:'complete',side_effect_count:1,output:result.output,verification:engine.result(args.task,'verify').output},null,2));
  }
} finally {engine.close();}
