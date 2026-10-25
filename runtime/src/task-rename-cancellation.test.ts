import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {registerDurableTools} from './durable-tools.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';

type Response={isError?:boolean;content:{type:string;text:string}[]};
type Handler=(input:unknown,extra:{signal:AbortSignal})=>Promise<Response>;
function fixture(t:{after:(cleanup:()=>void)=>void}) {
  const root=mkdtempSync(join(tmpdir(),'forge-rename-cancel-')),project=join(root,'project');
  mkdirSync(project);const source='export function double(n:number) { return n * 2; }\nexport const bag = { double };\n';
  writeFileSync(join(project,'math.ts'),source);
  const engine=new DurableTasks(join(root,'state')),batches=new TaskFileBatches(engine);
  const task=engine.create(project,'rename-cancel','inspect rename cancellation',['echo ok'],true);
  const handlers=new Map<string,Handler>();
  const target={registerTool:(name:string,_definition:unknown,handler:Handler)=>handlers.set(name,handler)} as unknown as McpRegistrationTarget;
  registerDurableTools(target,engine,[project]);
  const input={task_id:task.task_id,operation_id:'cancelled-rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,files:['math.ts'],file:'math.ts',line:1,column:18,new_name:'scale'};
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {engine,batches,task,project,source,input,handler:handlers.get('task_rename')!};
}

test('MCP rename cancellation before or during analysis creates no file change or write intent',async t=>{
  for(const phase of ['before','during'] as const) {
    const f=fixture(t),controller=new AbortController();
    if(phase==='before')controller.abort();
    const query=f.handler(f.input,{signal:controller.signal});
    const timer=phase==='during'?setTimeout(()=>controller.abort(),30):undefined;
    const result=await query;clearTimeout(timer);
    assert.equal(result.isError,true,`${phase}: cancelled MCP request must reject`);
    assert.match(JSON.stringify(result.content),/cancelled/i);
    assert.equal(readFileSync(join(f.project,'math.ts'),'utf8'),f.source);
    assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
    assert.equal(f.engine.status(f.task.task_id).operations.length,0,'no persisted write intent after cancellation');
    const next=await f.handler({...f.input,operation_id:'after-cancellation'},{signal:new AbortController().signal});
    assert.equal(next.isError,undefined,JSON.stringify(next));
    assert.match(readFileSync(join(f.project,'math.ts'),'utf8'),/function scale/);
  }
});

test('cancellation after analysis still fences writes while a confirmed receipt can be inspected',async t=>{
  const f=fixture(t),controller=new AbortController();
  const originalRead=TaskFileBatches.prototype.readText;
  TaskFileBatches.prototype.readText=function(root,path){
    const content=originalRead.call(this,root,path);controller.abort();return content;
  };
  try {
    const result=await f.handler(f.input,{signal:controller.signal});
    assert.equal(result.isError,true,'cancellation before journal commit must reject');
    assert.match(JSON.stringify(result.content),/cancelled/i);
    assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
    assert.equal(f.engine.status(f.task.task_id).operations.length,0);
  }finally{TaskFileBatches.prototype.readText=originalRead;}
  const input={...f.input,operation_id:'confirmed'};
  const completed=await renameTask(f.engine,f.batches,input,[f.project]);
  assert.equal(completed.state,'completed');
  const after=snapshot(f.project).fingerprint;
  const replay=await f.handler(input,{signal:controller.signal});
  assert.equal(replay.isError,undefined,JSON.stringify(replay));
  assert.equal(JSON.parse(replay.content[0]!.text).state,'completed');
  assert.equal(snapshot(f.project).fingerprint,after,'receipt inspection never reapplies a write');
  assert.equal(f.engine.status(f.task.task_id).operations.length,1);
});
