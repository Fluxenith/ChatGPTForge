import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks} from './durable-tasks.js';
import {ForgeDesktop} from './forge-desktop.js';

test('cross-app session targets exact handles, preserves grants, rejects revoked/ambiguous targets and replays focus once',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-session-')),project=join(root,'project');mkdirSync(project);
  const engine=new DurableTasks(join(root,'state'));
  const windows=[{pid:12,creation:'1',hwnd:'42',app:'a',title:'one'},{pid:12,creation:'1',hwnd:'43',app:'a',title:'two'},{pid:13,creation:'2',hwnd:'44',app:'b',title:'three'}];
  let focused:string[]=[];
  const desktop=new ForgeDesktop(engine,[project],async (input:any)=>{
    if(input.action==='list')return windows.filter(w=>!input.pid||w.pid===input.pid);
    if(input.action==='focus'){focused.push(input.hwnd);return {state:'performed',hwnd:input.hwnd};}
    return {controls:[]};
  });
  t.after(()=>{desktop.close();engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10});});
  const task=engine.create(project,'session','session',['echo ok'],true);
  const run=(id:string,pid:number,hwnd?:string)=>desktop.run(task.task_id,id,task.lease_token!,{action:'focus',pid,hwnd});
  await desktop.grant(12,'42');await desktop.grant(12,'43');
  await run('one',12,'42');await run('two',12,'43');
  await assert.rejects(run('ambiguous',12),/hwnd/);
  await assert.rejects(run('not-granted',13,'44'),/授權/);
  await desktop.grantSession();
  await run('cross-app',13,'44');await run('cross-app',13,'44');
  assert.deepEqual(focused,['42','43','44']);
  await assert.rejects(run('bad-handle',13,'999'),/exact available/);
  windows.push({pid:14,creation:'3',hwnd:'45',app:'c',title:'new'});
  await run('new-app',14,'45');
  desktop.revoke();await assert.rejects(run('revoked',13,'44'),/授權/);
});
