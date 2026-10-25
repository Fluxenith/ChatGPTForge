import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {navigateJava} from './java-navigation.js';
import {javaHash,loadJavaProject,verifyJavaEnvironment} from './java-project.js';
import {loadJavaClasspath} from './java-classpath.js';
import {DurableTasks} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';

const exec=promisify(execFile),env={...process.env,JAVA_TOOL_OPTIONS:'',_JAVA_OPTIONS:'',JDK_JAVA_OPTIONS:'',CLASSPATH:''};
let library:string,binary:Buffer,sourceJar:Buffer,otherBinary:Buffer,otherSources:Buffer,jarTool:string;
const api='package vendor;\r\n// 😀 original CRLF\r\npublic class Api {\r\n public Api(int n) {}\r\n public static int twice(int n){return n*2;}\r\n public static String twice(String n){return n+n;}\r\n public static final int LIMIT=7;\r\n public static <T> T identity(T n){return n;}\r\n public static class Inner { public int amount(){return 7;} }\r\n public static int 方法(int n){return n;}\r\n}\r\nclass Extra { public static int cube(int n){return n*n*n;} }\r\n';
const app='package vendor;\r\nimport java.util.function.IntUnaryOperator;\r\nclass App {\r\n int calculate(int n){return Api.twice(n);}\r\n String text(){return Api.twice("x");}\r\n int limit(){return Api.LIMIT;}\r\n String generic(){return Api.identity("x");}\r\n int inner(){return new Api.Inner().amount();}\r\n int unicode(){return Api.方法(7);}\r\n int extra(){return Extra.cube(7);}\r\n Api construct(){return new Api(7);}\r\n IntUnaryOperator reference(){return Api::twice;}\r\n}\r\n';
before(async()=>{
 library=await mkdtemp(join(await realpath(tmpdir()),'forge-java-source-lib-'));
 const settings=await exec('java',['-XshowSettings:properties','-version'],{env,windowsHide:true}),home=settings.stderr.match(/java.home = (.+)/)![1]!.trim();jarTool=join(home,'bin','jar.exe');
 for(const version of ['original','shadow']){
  const directory=join(library,version),classes=join(directory,'classes');await mkdir(join(directory,'source/vendor'),{recursive:true});await mkdir(classes);
  await writeFile(join(directory,'source/vendor/Api.java'),version==='original'?api:api.replace('return n*2','return n*3'));
  await writeFile(join(directory,'source/vendor/Box.java'),'package vendor; public record Box(String value) {}');
  await writeFile(join(directory,'TrapPlugin.java'),'package vendor; import com.sun.source.util.*; public class TrapPlugin implements Plugin { public String getName(){return "ForgeTrap";} public boolean autoStart(){return true;} public void init(JavacTask task,String... args){throw new AssertionError("Compiler plugin executed");} }');
  await exec('javac',['--release','21','-proc:none','-d',classes,join(directory,'source/vendor/Api.java'),join(directory,'source/vendor/Box.java'),join(directory,'TrapPlugin.java')],{env,windowsHide:true});
  await mkdir(join(classes,'META-INF/services'),{recursive:true});await writeFile(join(classes,'META-INF/services/com.sun.source.util.Plugin'),'vendor.TrapPlugin\n');
  await exec(jarTool,['--create','--file',join(directory,'api.jar'),'-C',classes,'.'],{env,windowsHide:true});
  await exec(jarTool,['--create','--file',join(directory,'api-sources.jar'),'-C',join(directory,'source'),'.'],{env,windowsHide:true});
 }
 binary=await readFile(join(library,'original/api.jar'));sourceJar=await readFile(join(library,'original/api-sources.jar'));otherBinary=await readFile(join(library,'shadow/api.jar'));otherSources=await readFile(join(library,'shadow/api-sources.jar'));
});
after(async()=>{assert.equal(await realpath(library),library);await rm(library,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},model:unknown={version:1,classpath:['libs/api.jar'],source_archives:[{classpath_index:0,path:'libs/api-sources.jar'}]},source=app){
 const root=await mkdtemp(join(await realpath(tmpdir()),'forge-java-source-test-'));
 for(const [file,data] of Object.entries({'App.java':source,'libs/api.jar':binary,'libs/api-sources.jar':sourceJar,'libs/shadow.jar':otherBinary,'libs/shadow-sources.jar':otherSources,'forge.java.json':JSON.stringify(model)})){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),data);}
 t.after(async()=>{assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});return root;
}
async function definition(root:string,needle:string,source=app){const offset=source.indexOf(needle);assert.ok(offset>=0);const lines=source.slice(0,offset).split(/\r\n|\r|\n/);return navigateJava({path:root,file:'App.java',action:'definition',line:lines.length,column:lines.at(-1)!.length+1},[root]);}

test('Java attached sources return original read-only content and exact overload, type, generic, inner, Unicode, SourceFile, constructor and member-reference ranges',async t=>{
 const root=await fixture(t);
 for(const [needle,key,name,entry] of [
  ['twice(n)','M:vendor.Api#twice(int):int','twice','vendor/Api.java'],
  ['twice("x")','M:vendor.Api#twice(java.lang.String):java.lang.String','twice','vendor/Api.java'],
  ['LIMIT','F:vendor.Api#LIMIT:int','LIMIT','vendor/Api.java'],
  ['identity("x")','M:vendor.Api#identity(java.lang.Object):java.lang.Object','identity','vendor/Api.java'],
  ['amount()','M:vendor.Api.Inner#amount():int','amount','vendor/Api.java'],
  ['方法(7)','M:vendor.Api#方法(int):int','方法','vendor/Api.java'],
  ['cube(7)','M:vendor.Extra#cube(int):int','cube','vendor/Api.java'],
  ['Api(7)','M:vendor.Api#<init>(int):void','Api','vendor/Api.java'],
  ['twice;}','M:vendor.Api#twice(int):int','twice','vendor/Api.java'],
 ] as const){
  const result=await definition(root,needle),hit=result.results[0]!,source=hit.source as {entry:string;content:string;sha256:string;archive:string;archive_sha256:string;symbol_key:string;classpath_index:number};
  assert.equal(result.total,1,needle);assert.equal(hit.name,name);assert.equal(hit.read_only,true);assert.equal(hit.origin,'java_source_archive');assert.equal(source.content,api);assert.equal(source.sha256,javaHash(api));assert.equal(source.archive_sha256,javaHash(sourceJar));assert.equal(source.archive,join(root,'libs/api-sources.jar'));assert.equal(source.classpath_index,0);assert.equal(source.entry,entry);assert.equal(source.symbol_key,key);assert.match(String(hit.file),/^java-source:0:/);assert.doesNotMatch(JSON.stringify(result),/forge-java-analysis-/);
  const lines=api.split(/\r\n|\r|\n/),line=lines[Number(hit.line)-1]!;assert.equal(line.slice(Number(hit.column)-1,Number(hit.end_column)-1),name);
 }
 const record='package vendor; class App { String read(Box b){return b.value();} }';await writeFile(join(root,'App.java'),record);const hit=(await definition(root,'value()',record)).results[0]!;assert.equal((hit.source as any).entry,'vendor/Box.java');assert.equal(hit.name,'value');
 assert.deepEqual(await readFile(join(root,'libs/api.jar')),binary);assert.deepEqual(await readFile(join(root,'libs/api-sources.jar')),sourceJar);
});
test('Java binary classpath order chooses its own source attachment and never falls through a missing first association',async t=>{
 const model={version:1,classpath:['libs/shadow.jar','libs/api.jar'],source_archives:[{classpath_index:0,path:'libs/shadow-sources.jar'},{classpath_index:1,path:'libs/api-sources.jar'}]},root=await fixture(t,model);
 const first=(await definition(root,'twice(n)')).results[0]!;assert.equal((first.source as any).classpath_index,0);assert.match((first.source as any).content,/return n\*3/);
 await writeFile(join(root,'forge.java.json'),JSON.stringify({...model,source_archives:[model.source_archives[1]]}));assert.equal((await definition(root,'twice(n)')).total,0);
 // javac may load Api from entry 0 while Api$Inner is available only in entry 1.
 // Its source must follow the nested binary rather than the outer class.
 const partial=join(root,'node_modules/partial/vendor');await mkdir(partial,{recursive:true});
 await writeFile(join(partial,'Api.class'),await readFile(join(library,'shadow/classes/vendor/Api.class')));
 await exec(jarTool,['--create','--file',join(root,'libs/partial.jar'),'-C',join(root,'node_modules/partial'),'.'],{env,windowsHide:true});
 await writeFile(join(root,'forge.java.json'),JSON.stringify({...model,classpath:['libs/partial.jar','libs/api.jar']}));
 assert.equal((await definition(root,'amount()')).results[0]&&(await definition(root,'amount()')).results[0]!.source!==undefined,true);
 const nested=(await definition(root,'amount()')).results[0]!;assert.equal((nested.source as any).classpath_index,1);assert.equal((nested.source as any).content,api);
});
test('Java attached sources do not affect primary diagnostics or permit dependency rename',async t=>{
 const root=await fixture(t),before=await navigateJava({path:root,action:'diagnostics'},[root]);assert.equal(before.total,0);
 // Wrong source signature: still zero primary errors, but never a spelling-only definition.
 await writeFile(join(root,'libs/api-sources.jar'),otherSources);assert.equal((await navigateJava({path:root,action:'diagnostics'},[root])).total,0);
 await assert.rejects(navigateJava({path:root,file:'App.java',action:'rename_preview',line:4,column:34,new_name:'other'},[root]),/read.only.*environment/i);
 const broken=app.replace('return Api.twice(n);','return Api.twice(n);').replace('String text(){','String text(){').replace('int limit(){return Api.LIMIT;}','int limit(){return "bad";}');await writeFile(join(root,'App.java'),broken);
 assert.ok((await navigateJava({path:root,action:'diagnostics'},[root])).total>0);assert.equal((await definition(root,'twice(n)',broken)).total,1);
});
test('Java source model rejects invalid associations, source drift and cancellation',async t=>{
 const root=await fixture(t),model={version:1,classpath:['libs/api.jar']};
 for(const source_archives of [null,[{classpath_index:-1,path:'libs/api-sources.jar'}],[{classpath_index:1,path:'libs/api-sources.jar'}],[{classpath_index:0,path:'libs/api-sources.jar',extra:true}],[{classpath_index:0,path:'libs/api-sources.jar'},{classpath_index:0,path:'libs/api-sources.jar'}]]){
  await writeFile(join(root,'forge.java.json'),JSON.stringify({...model,source_archives}));await assert.rejects(loadJavaClasspath(root,[root]),/Invalid Java source archive/);
 }
 await writeFile(join(root,'forge.java.json'),JSON.stringify({...model,source_archives:[{classpath_index:0,path:'libs/api-sources.jar'}]}));
 const captured=await loadJavaProject({path:root},[root]);await writeFile(join(root,'libs/api-sources.jar'),otherSources);await assert.rejects(verifyJavaEnvironment(captured),/classpath environment changed/);
 const controller=new AbortController();await assert.rejects(navigateJava({path:root,file:'App.java',action:'definition',line:4,column:34},[root],controller.signal,()=>controller.abort()),/abort|cancel/i);
});
test('Java attached source declaration mismatches refuse navigation and class directories retain exact source identity',async t=>{
 const root=await fixture(t),sources=join(root,'node_modules/attached');await mkdir(join(sources,'vendor'),{recursive:true});
 await writeFile(join(sources,'vendor/Api.java'),api.replace('public static int twice(int n){return n*2;}','public static String twice(int n){return "x";}'));
 await exec(jarTool,['--create','--file',join(root,'libs/mismatch.jar'),'-C',sources,'.'],{env,windowsHide:true});
 await writeFile(join(root,'forge.java.json'),JSON.stringify({version:1,classpath:['libs/api.jar'],source_archives:[{classpath_index:0,path:'libs/mismatch.jar'}]}));
 assert.equal((await navigateJava({path:root,action:'diagnostics'},[root])).total,0);
 await assert.rejects(definition(root,'twice(n)'),/does not uniquely match binary declaration/);
 const classes=join(root,'node_modules/classes/vendor');await mkdir(classes,{recursive:true});
 for(const name of ['Api.class','Api$Inner.class','Extra.class','Box.class'])await writeFile(join(classes,name),await readFile(join(library,'original/classes/vendor',name)));
 await writeFile(join(root,'forge.java.json'),JSON.stringify({version:1,classpath:['node_modules/classes'],source_archives:[{classpath_index:0,path:'libs/api-sources.jar'}]}));
 assert.equal((await definition(root,'twice(n)')).results[0]?.read_only,true);
});
test('Java source archive drift after capture and private-copy corruption refuse result publication; live cancellation releases the analysis slot',async t=>{
 const root=await fixture(t);
 await assert.rejects(navigateJava({path:root,file:'App.java',action:'definition',line:4,column:34},[root],undefined,project=>{writeFileSync(join(root,'libs/api-sources.jar'),otherSources);}),/classpath environment changed/);
 await writeFile(join(root,'libs/api-sources.jar'),sourceJar);
 await assert.rejects(navigateJava({path:root,file:'App.java',action:'definition',line:4,column:34},[root],undefined,project=>{project.classpath.source_contents.set(join(root,'libs/api-sources.jar'),otherSources);}),/captured source archive bytes changed/);
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{await assert.rejects(navigateJava({path:root,file:'App.java',action:'definition',line:4,column:34},[root],controller.signal,()=>{timer=setTimeout(()=>controller.abort(),250);}),/abort|cancel/i);}finally{clearTimeout(timer);}
 assert.equal((await definition(root,'twice(n)')).total,1);
});
test('Java source archive change between analysis and durable intent refuses writes without a batch record',async t=>{
 const root=await fixture(t),state=await mkdtemp(join(await realpath(tmpdir()),'forge-java-source-state-')),engine=new DurableTasks(state),batches=new TaskFileBatches(engine);
 t.after(async()=>{engine.close();assert.equal(await realpath(state),state);await rm(state,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
 const task=engine.create(root,'source-drift','rename with pinned attached sources',['echo verified'],true),original=batches.readText.bind(batches);let changed=false;
 batches.readText=(...args)=>{const result=original(...args);if(!changed){changed=true;requireWrite();}return result;};
 function requireWrite(){writeFileSync(join(root,'libs/api-sources.jar'),otherSources);}
 await assert.rejects(renameTask(engine,batches,{task_id:task.task_id,operation_id:'source-drift-refusal',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'App.java',line:4,column:6,new_name:'scale'},[root]),/classpath environment changed/);
 assert.equal(changed,true);assert.equal(await readFile(join(root,'App.java'),'utf8'),app);assert.equal(engine.db.prepare('SELECT 1 FROM task_file_batches WHERE task_id=? AND id=?').get(task.task_id,'source-drift-refusal'),undefined);
});
import {writeFileSync} from 'node:fs';
