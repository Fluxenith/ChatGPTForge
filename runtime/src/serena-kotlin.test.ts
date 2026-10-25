import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {kotlinWorkspace,KOTLIN_MODEL} from './serena-kotlin.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {serenaRenameTask} from './task-rename.js';

test('Kotlin rejects incomplete build models and escaping/cyclic module inputs',()=>{
 const f=new Map([['src/Main.kt',Buffer.from('fun main() {}')],['build.gradle.kts',Buffer.from('error("must never execute")')]]);
 assert.throws(()=>kotlinWorkspace(f,'src/Main.kt'),/require/);
 const check=(modules:unknown[])=>{f.set(KOTLIN_MODEL,Buffer.from(JSON.stringify({version:1,modules})));return()=>kotlinWorkspace(f,'src/Main.kt');};
 assert.throws(check([{name:'main',roots:['../src']}]),/traversal/);
 assert.throws(check([{name:'main',roots:['src'],libraries:['missing.jar']}]),/captured JAR/);
 assert.throws(check([{name:'main',roots:['src'],dependencies:['missing']}]),/Unknown/);
 f.set('other/Extra.kt',Buffer.from('fun extra() {}'));
 assert.throws(check([{name:'main',roots:['src']}]),/omits/);
 assert.throws(check([{name:'main',roots:['src'],dependencies:['other']},{name:'other',roots:['other'],dependencies:['main']}]),/Cyclic/);
});

test('Kotlin JVM modules rename across dependencies, preserve unrelated symbols, replay and roll back', {skip:process.platform!=='win32',timeout:300_000},async()=>{
 const base=mkdtempSync(join(tmpdir(),'forge-kotlin-acceptance-')),root=join(base,'project');
 const files:Record<string,string>={
  'core/src/Calc.kt':'package demo\nfun twice(v: Int) = v * 2\n',
  'app/src/Main.kt':'package app\nimport demo.twice\nfun main() { println(twice(3)) }\n// twice stays in comment\n',
  'other/src/Other.kt':'package other\nfun twice(v: Int) = v + v\n',
  'build.gradle.kts':'error("BUILD SCRIPT MUST NOT EXECUTE")\n',
  [KOTLIN_MODEL]:JSON.stringify({version:1,modules:[{name:'core',roots:['core/src']},{name:'app',roots:['app/src'],dependencies:['core']},{name:'other',roots:['other/src']}]}),
 };
 for(const [p,s]of Object.entries(files)){mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),s);}
 const engine=new DurableTasks(join(base,'state')),batches=new TaskFileBatches(engine);
 try{
  const task=engine.create(root,'kotlin-build-model','Kotlin module rename',['echo acceptance'],true);
  const input={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language:'kotlin',file:'core/src/Calc.kt',line:2,column:5,new_name:'scale'};
  const result=await serenaRenameTask(engine,batches,input);assert.equal(result.state,'completed');
  assert.equal(readFileSync(join(root,'core/src/Calc.kt'),'utf8'),files['core/src/Calc.kt']!.replace('twice','scale'));
  assert.equal(readFileSync(join(root,'app/src/Main.kt'),'utf8'),files['app/src/Main.kt']!.replace('demo.twice','demo.scale').replace('println(twice','println(scale'));
  for(const p of ['other/src/Other.kt','build.gradle.kts',KOTLIN_MODEL])assert.equal(readFileSync(join(root,p),'utf8'),files[p]);
  assert.deepEqual(await serenaRenameTask(engine,batches,input),result);
  batches.rollback(task.task_id,'rename','undo',task.lease_token!);
  assert.equal(snapshot(root).fingerprint,task.fingerprint);
  console.log(JSON.stringify({fixture:root,modules:3,changed_files:2,replay:true,rollback:true}));
 }finally{engine.close();}
});
