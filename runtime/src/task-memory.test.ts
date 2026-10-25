import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameMemory,editMemories,memoryName,assertMemoryWritable} from './task-memory.js';
import {applyMemoryLinks} from './task-memory-links.js';
import {SerenaBridge} from './serena-bridge.js';
test('memory topic rename propagates exact references, replays, rolls back and refuses conflicts/policies',t=>{
 const root=mkdtempSync(join(tmpdir(),'forge-mem-')),project=join(root,'project'),mem=join(project,'.serena/memories');mkdirSync(join(mem,'topic'),{recursive:true});
 writeFileSync(join(mem,'old.md'),'self mem:old');writeFileSync(join(mem,'refs.md'),'mem:old mem:older mem:old/sub xmem:old (mem:old)');
 const engine=new DurableTasks(join(root,'state'));t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:5});});
 const task=engine.create(project,'memory','rename memory',['echo ok'],true),id=task.task_id,lease=task.lease_token!;
 const first=renameMemory(engine,id,'rename','old','topic/new',task.fingerprint,lease);assert.equal(first.state,'completed');
 assert.equal(existsSync(join(mem,'old.md')),false);assert.equal(readFileSync(join(mem,'topic/new.md'),'utf8'),'self mem:topic/new');
 assert.equal(readFileSync(join(mem,'refs.md'),'utf8'),'mem:topic/new mem:older mem:old/sub xmem:old (mem:topic/new)');
 assert.deepEqual(renameMemory(engine,id,'rename','old','topic/new',task.fingerprint,lease),first);
 assert.throws(()=>renameMemory(engine,id,'rename','old','other',task.fingerprint,lease),/different batch/);
 assert.equal(new TaskFileBatches(engine).rollback(id,'rename','undo',lease).state,'completed');
 assert.equal(readFileSync(join(mem,'old.md'),'utf8'),'self mem:old');assert.equal(existsSync(join(mem,'topic/new.md')),false);
 assert.throws(()=>renameMemory(engine,id,'collision','old','refs',snapshot(project).fingerprint,lease),/already exists/);
 writeFileSync(join(project,'.serena/project.yml'),'read_only_memory_patterns: ["old"]');
 assert.throws(()=>renameMemory(engine,id,'policy','old','topic/new',snapshot(project).fingerprint,lease),/protected by Serena memory policy/);
 for(const name of ['../old','topic/../old','CON','topic/NUL','/root','x\\y'])assert.throws(()=>memoryName(name));
});

test('Python Serena fullmatch policies allow unrelated memories while protecting read-only references and ignored topics',t=>{
 const base=mkdtempSync(join(tmpdir(),'forge-mem-policy-')),project=join(base,'project'),mem=join(project,'.serena/memories');
 mkdirSync(join(mem,'topic'),{recursive:true});
 const originalHome=process.env.SERENA_USER_HOME;
 process.env.SERENA_USER_HOME=join(base,'empty-global');
 writeFileSync(join(mem,'old.md'),'mem:old');
 writeFileSync(join(mem,'refs.md'),'link mem:old');
 writeFileSync(join(mem,'topic/locked.md'),'cannot change');
 writeFileSync(join(project,'.serena/project.yml'),'read_only_memory_patterns: ["(?i:topic/locked)"]\n');
 const engine=new DurableTasks(join(base,'state'));
 t.after(()=>{engine.close();rmSync(base,{recursive:true,force:true,maxRetries:5});
   if(originalHome===undefined)delete process.env.SERENA_USER_HOME;else process.env.SERENA_USER_HOME=originalHome;});
 assert.doesNotThrow(()=>assertMemoryWritable(project,'old'));
 assert.throws(()=>assertMemoryWritable(project,'topic/locked'),/protected/);
 assert.throws(()=>assertMemoryWritable(project,'global/private'),/Global/);
 const task=engine.create(project,'memory','policy aware',['done'],true),id=task.task_id,lease=task.lease_token!;
 const first=renameMemory(engine,id,'allowed','old','topic/new',task.fingerprint,lease);
 assert.equal(first.state,'completed');
 assert.equal(readFileSync(join(mem,'refs.md'),'utf8'),'link mem:topic/new');
 assert.equal(readFileSync(join(mem,'topic/locked.md'),'utf8'),'cannot change');
 assert.equal(new TaskFileBatches(engine).rollback(id,'allowed','rollback',lease).state,'completed');
 writeFileSync(join(mem,'topic/locked.md'),'secret mem:old');
 const fingerprint=snapshot(project).fingerprint;
 assert.throws(()=>renameMemory(engine,id,'readonly','old','topic/new',fingerprint,lease),/read-only Serena memory/);
 assert.equal(existsSync(join(mem,'topic/new.md')),false);
 assert.equal(readFileSync(join(mem,'old.md'),'utf8'),'mem:old');
 writeFileSync(join(project,'.serena/project.yml'),'ignored_memory_patterns: ["topic/locked"]\n');
 assert.throws(()=>renameMemory(engine,id,'ignored','old','topic/new',snapshot(project).fingerprint,lease),/Ignored project memories/);
});

test('multiple project memories support one journaled literal and Python regex edit with exact counts and rollback',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-memory-edit-')),project=join(root,'project'),mem=join(project,'.serena/memories');
  mkdirSync(join(mem,'topic'),{recursive:true});
  writeFileSync(join(mem,'old.md'),'see mem:old then mem:old\n');
  writeFileSync(join(mem,'topic/code.md'),'call greet(2)\n');
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:5});});
  const task=engine.create(project,'memory-edit','edit memory',['echo ok'],true),lease=task.lease_token!,id=task.task_id;
  const edits=[
    {name:'old',needle:'mem:old',repl:'mem:topic/new',mode:'literal' as const,expected_occurrences:2},
    {name:'topic/code',needle:'call (\\w+)\\((\\d+)\\)',repl:'invoke $!1($!2)',mode:'regex' as const,expected_occurrences:1},
  ];
  assert.throws(()=>editMemories(engine,id,'wrong-count',[{...edits[0]!,expected_occurrences:3}],task.fingerprint,lease),/expected 3 occurrences but matched 2/);
  assert.throws(()=>editMemories(engine,id,'duplicate',[edits[0]!,edits[0]!],task.fingerprint,lease),/different memory/);
  assert.equal(readFileSync(join(mem,'old.md'),'utf8'),'see mem:old then mem:old\n');
  const first=editMemories(engine,id,'edit',edits,task.fingerprint,lease);
  assert.equal(first.state,'completed');
  assert.equal(readFileSync(join(mem,'old.md'),'utf8'),'see mem:topic/new then mem:topic/new\n');
  assert.equal(readFileSync(join(mem,'topic/code.md'),'utf8'),'invoke greet(2)\n');
  assert.deepEqual(editMemories(engine,id,'edit',edits,task.fingerprint,lease),first);
  assert.throws(()=>editMemories(engine,id,'edit',[edits[0]!],task.fingerprint,lease),/different batch input/);
  assert.equal(new TaskFileBatches(engine).rollback(id,'edit','undo',lease).state,'completed');
  assert.equal(readFileSync(join(mem,'old.md'),'utf8'),'see mem:old then mem:old\n');
  assert.equal(readFileSync(join(mem,'topic/code.md'),'utf8'),'call greet(2)\n');
  writeFileSync(join(project,'.serena/project.yml'),'read_only_memory_patterns: ["topic/code"]\n');
  assert.throws(()=>editMemories(engine,id,'readonly',edits,snapshot(project).fingerprint,lease),/protected by Serena memory policy/);
});

test('Serena regex memory edit rejects ambiguous multi-line capture and leaves all files intact',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-memory-regex-')),project=join(root,'project'),mem=join(project,'.serena/memories');
  mkdirSync(mem,{recursive:true});writeFileSync(join(mem,'notes.md'),'BEGIN a\nBEGIN b\nEND\n');
  const engine=new DurableTasks(join(root,'state'));
  t.after(()=>{engine.close();rmSync(root,{recursive:true,force:true,maxRetries:5});});
  const task=engine.create(project,'regex-edit','edit',['echo ok'],true);
  const edit={name:'notes',needle:'BEGIN.*?END',repl:'new value',mode:'regex' as const,expected_occurrences:1};
  assert.throws(()=>editMemories(engine,task.task_id,'ambiguous',[edit],task.fingerprint,task.lease_token!),/Ambiguous overlapping/);
  assert.equal(readFileSync(join(mem,'notes.md'),'utf8'),'BEGIN a\nBEGIN b\nEND\n');
});

test('Serena unmarked memory links preview, selective journaled apply and rollback enforce stale fingerprints and policy',async t=>{
  const base=mkdtempSync(join(tmpdir(),'forge-memory-autolink-')),
    project=join(base,'project'),mem=join(project,'.serena/memories');
  mkdirSync(join(mem,'auth'),{recursive:true});
  const originalHome=process.env.SERENA_USER_HOME;
  process.env.SERENA_USER_HOME=join(base,'absent-global-config');
  writeFileSync(join(mem,'main.md'),
    'Review auth/tokens and (auth/tokens), but preserve mem:auth/tokens, ' +
    'https://auth/tokens, and xauth/tokens. Also architecture_notes.');
  writeFileSync(join(mem,'auth/tokens.md'),'secret token details');
  writeFileSync(join(mem,'architecture_notes.md'),'long memory');
  writeFileSync(join(mem,'readonly.md'),'auth/tokens appears but cannot change');
  writeFileSync(join(project,'.serena/project.yml'),
    'read_only_memory_patterns: ["^readonly$"]\n');
  const engine=new DurableTasks(join(base,'state'));
  const bridge=new SerenaBridge([project]);
  t.after(async()=>{
    await bridge.close();engine.close();rmSync(base,{recursive:true,force:true,maxRetries:5});
    if(originalHome===undefined)delete process.env.SERENA_USER_HOME;else process.env.SERENA_USER_HOME=originalHome;
  });
  const plan=await bridge.memoryLinkPreview(project,10);
  assert.equal(plan.status,'reviewable');
  assert.equal(plan.counts.unmarked_candidates,3);
  const selected=plan.fixes.items.find(f=>f.source==='main'&&f.target==='auth/tokens');
  assert.deepEqual(selected,{source:'main',target:'auth/tokens',expected_occurrences:2,read_only:false});
  assert.ok(plan.fixes.items.some(f=>f.source==='readonly'&&f.read_only));
  assert.equal(JSON.stringify(plan).includes('secret token details'),false);
  const task=engine.create(project,'repair memory','reconcile links',['done'],true);
  const id=task.task_id,lease=task.lease_token!;
  assert.equal(plan.expected_fingerprint,task.fingerprint);
  assert.throws(()=>applyMemoryLinks(engine,id,'wrong-count',[
    {...selected!,expected_occurrences:3}],task.fingerprint,plan.expected_memory_fingerprint,lease),/does not match/);
  assert.throws(()=>applyMemoryLinks(engine,id,'readonly',[
    {source:'readonly',target:'auth/tokens',expected_occurrences:1}],task.fingerprint,plan.expected_memory_fingerprint,lease),/read-only/);
  const first=applyMemoryLinks(engine,id,'repair',[selected!],task.fingerprint,plan.expected_memory_fingerprint,lease);
  assert.equal(first.state,'completed');
  assert.equal(readFileSync(join(mem,'main.md'),'utf8'),
    'Review mem:auth/tokens and (mem:auth/tokens), but preserve mem:auth/tokens, ' +
    'https://auth/tokens, and xauth/tokens. Also architecture_notes.');
  assert.equal(readFileSync(join(mem,'readonly.md'),'utf8'),'auth/tokens appears but cannot change');
  assert.deepEqual(applyMemoryLinks(engine,id,'repair',[selected!],task.fingerprint,plan.expected_memory_fingerprint,lease),first);
  assert.throws(()=>applyMemoryLinks(engine,id,'stale',[selected!],task.fingerprint,plan.expected_memory_fingerprint,lease),/Workspace conflict/);
  assert.equal(new TaskFileBatches(engine).rollback(id,'repair','undo-repair',lease).state,'completed');
  assert.equal(readFileSync(join(mem,'main.md'),'utf8').startsWith('Review auth/tokens'),true);
  writeFileSync(join(project,'.serena/project.yml'),'ignored_memory_patterns: ["^readonly$"]\n');
  const partial=await bridge.memoryLinkPreview(project,10);
  assert.equal(partial.status,'incomplete');
  assert.throws(()=>applyMemoryLinks(engine,id,'ignored',[selected!],snapshot(project).fingerprint,
    partial.expected_memory_fingerprint,lease),/Incomplete Serena memory graph/);
});
