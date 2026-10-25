import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureKotlinRoots,kotlinModelFiles,assertKotlinWritable} from './kotlin-generated.js';
import {kotlinWorkspace,KOTLIN_MODEL} from './serena-kotlin.js';
import {kotlinBuildInputs,kotlinInputHash} from './kotlin-model-inputs.js';
import {kotlinSettings,validateKotlinCompiler} from './kotlin-compiler-settings.js';
import {convertSerenaWorkspaceEdit,captureSerenaProject} from './serena-workspace-edit.js';
import {pathToFileURL} from 'node:url';
import {DurableTasks,snapshot,digest} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {serenaSymbolEditTask} from './task-rename.js';
test('generated sources are captured, pinned, isolated from old runs and read-only',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'forge-gen-test-'));
 try{
  await mkdir(join(root,'src'));await mkdir(join(root,'target/gen'),{recursive:true});
  await writeFile(join(root,'src/Main.kt'),'fun main()=generated()');await writeFile(join(root,'target/gen/Gen.kt'),'fun generated()=1');
  const initial=new Map([['src/Main.kt',Buffer.from('fun main()=generated()')]]);
  const r=await captureKotlinRoots(root,[join(root,'src'),join(root,'target/gen')],[join(root,'target/gen')],initial,'.forge/kotlin-import/run/m0');
  assert.equal(r.additions.size,1);assert.equal(r.roots.length,2);
  const spec={version:3,modules:[{name:'main',roots:r.roots,compiler:{jvmTarget:'21'}}],input_hashes:kotlinBuildInputs(initial),library_hashes:{},generated_hashes:r.hashes,generated_origins:r.origins};
  const f=new Map([...initial,...r.additions]);f.set(KOTLIN_MODEL,Buffer.from(JSON.stringify(spec)));f.set('.forge/kotlin-import/old/Gen.kt',Buffer.from('old'));
  const ws=JSON.parse(kotlinWorkspace(f,'src/Main.kt'));assert.equal(ws.kotlinSettings[0].compilerArguments,'J{"jvmTarget":"21","pluginOptions":[],"pluginClasspaths":[]}');
  assert.equal(kotlinModelFiles(f).copied('.forge/kotlin-import/old/Gen.kt'),false);
  assert.throws(()=>assertKotlinWritable(f,[...r.additions.keys()]),/read-only/);assert.throws(()=>assertKotlinWritable(f,['target/gen/Gen.kt']),/read-only/);
  f.set([...r.additions.keys()][0]!,Buffer.from('tampered'));assert.throws(()=>kotlinWorkspace(f,'src/Main.kt'),/snapshot changed/);
  await writeFile(join(root,'src/Main.kt'),'build changed original');await assert.rejects(captureKotlinRoots(root,[join(root,'src')],[],initial,'.forge/kotlin-import/run'),/authored/);
  await assert.rejects(captureKotlinRoots(root,[join(root,'../outside')],[],initial,'.forge/kotlin-import/run'),/inside/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('compiler settings preserve supported plugin options and reject unpinned free-argument paths',()=>{
 const c={languageVersion:'2.2',jvmTarget:'21',pluginOptions:['plugin:org.jetbrains.kotlin.allopen:annotation=demo.Open'],pluginClasspaths:['.forge/kotlin-import/a/kotlin-allopen-compiler-plugin.jar'],freeArgs:['-Xjvm-default=all']};
 assert.match(kotlinSettings('main',['src'],c).compilerArguments,/WORKSPACE.*allopen/);
 assert.throws(()=>validateKotlinCompiler({...c,freeArgs:['-Xplugin=C:/external.jar']}),/Unrepresented/);
 assert.throws(()=>validateKotlinCompiler({...c,pluginOptions:['plugin:unknown:write=C:/output']}),/Unrepresented/);
 validateKotlinCompiler({...c,pluginOptions:['plugin:androidx.compose.compiler.plugins.kotlin:sourceInformation=true','plugin:androidx.compose.compiler.plugins.kotlin:featureFlag=-StrongSkipping']});
 assert.throws(()=>validateKotlinCompiler({...c,pluginOptions:['plugin:androidx.compose.compiler.plugins.kotlin:stabilityConfigurationPath=C:/external.txt']}),/Unrepresented/);
 assert.throws(()=>validateKotlinCompiler({...c,jvmTarget:21} as any),/Invalid/);
});
test('Kotlin suffix-only rename covers a reference only when it produces the exact requested identifier',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'forge-rename-insert-'));
 try{
  await writeFile(join(root,'Main.kt'),'fun spare()=1\nfun use()=spare()\n');
  const capture=captureSerenaProject(root),uri=pathToFileURL(join(root,'Main.kt')).href;
  const range=(line:number,start:number,end:number)=>({start:{line,character:start},end:{line,character:end}});
  const edit={changes:{[uri]:[{range:range(0,9,9),newText:'Renamed'},{range:range(1,15,15),newText:'Renamed'}]}};
  const refs=[{uri,range:range(1,10,15)}];
  assert.match((await convertSerenaWorkspaceEdit(root,capture,'Main.kt',edit,refs,'spareRenamed')).changes[0]!.content!,/use\(\)=spareRenamed/);
  await assert.rejects(convertSerenaWorkspaceEdit(root,capture,'Main.kt',edit,refs,'unrelated'),/omits/);
  await assert.rejects(convertSerenaWorkspaceEdit(root,capture,'Main.kt',edit,refs),/omits/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Java semantic transactions cannot bypass generated-source protection through a planner',async()=>{
 const base=await mkdtemp(join(await realpath(tmpdir()),'forge-generated-batch-')),root=join(base,'project');
 const engine=new DurableTasks(join(base,'state')),batches=new TaskFileBatches(engine);
 try{
  await mkdir(join(root,'target/generated'),{recursive:true});await mkdir(join(root,'.forge'),{recursive:true});
  const main='class Main {}',generated='class Generated {}';
  await writeFile(join(root,'Main.java'),main);await writeFile(join(root,'target/generated/Generated.java'),generated);
  await writeFile(join(root,KOTLIN_MODEL),JSON.stringify({version:3,generated_origins:{'.forge/kotlin-import/run/Generated.java':'target/generated/Generated.java'}}));
  const task=engine.create(root,'generated','guard Java transaction',['echo ok'],true);
  await assert.rejects(serenaSymbolEditTask(engine,batches,{task_id:task.task_id,operation_id:'edit',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,language:'java',file:'Main.java',operation:'replace_body',name_path:'Main',body:'class Main { int x; }'},undefined,async()=>({fingerprint:task.fingerprint,changes:[{path:'Main.java',content:'class Main { int x; }',expected_hash:digest(Buffer.from(main))},{path:'target/generated/Generated.java',content:'class Generated { int x; }',expected_hash:digest(Buffer.from(generated))}]} as any)),/read-only/);
  assert.equal(snapshot(root).fingerprint,task.fingerprint);
  assert.equal((engine.db.prepare('SELECT count(*) AS n FROM task_file_batches').get() as {n:number}).n,0);
 }finally{engine.close();await rm(base,{recursive:true,force:true});}
});
