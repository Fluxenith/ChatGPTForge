import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm,symlink,copyFile,readdir,access,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadJavaClasspath,validateJavaJar} from './java-classpath.js';
import {loadJavaProject,verifyJavaEnvironment,javaHash} from './java-project.js';
import {navigateJava} from './java-navigation.js';
import {DurableTasks} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile);let library:string,jar:Buffer,classes:string;
const nativeEnv={...process.env,JAVA_TOOL_OPTIONS:'',_JAVA_OPTIONS:'',JDK_JAVA_OPTIONS:'',CLASSPATH:''};
before(async()=>{
  library=await mkdtemp(join(await realpath(tmpdir()),'forge-java-lib-'));classes=join(library,'classes');await mkdir(classes);
  await writeFile(join(library,'Api.java'),`package vendor; public class Api { static { if (System.getProperty("forge.marker")!=null) throw new Error("Library code executed"); } public static int twice(int n){return n*2;} public int external(int n){return n;} }`);
  await writeFile(join(library,'TrapPlugin.java'),'package vendor; import com.sun.source.util.*; public class TrapPlugin implements Plugin { public String getName(){return "ForgeTrap";} public boolean autoStart(){return true;} public void init(JavacTask task,String... args){throw new AssertionError("Compiler plugin executed");} }');
  await exec('javac',['--release','21','-proc:none','-d',classes,join(library,'Api.java'),join(library,'TrapPlugin.java')],{env:nativeEnv});
  await mkdir(join(classes,'META-INF/services'),{recursive:true});await writeFile(join(classes,'META-INF/services/com.sun.source.util.Plugin'),'vendor.TrapPlugin\n');
  const settings=await exec('java',['-XshowSettings:properties','-version'],{env:nativeEnv});const home=settings.stderr.match(/java.home = (.+)/)![1]!.trim();
  await exec(join(home,'bin','jar.exe'),['--create','--file',join(library,'api.jar'),'-C',classes,'.'],{env:nativeEnv});jar=await readFile(join(library,'api.jar'));validateJavaJar(jar);
});
after(async()=>{assert.equal(await realpath(library),library);await rm(library,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},files:Record<string,string|Buffer>={}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'forge-java-classpath-'));
  const source='import vendor.Api;\nclass App {\n  int calculate(int n){ return Api.twice(n); }\n  int call(){ return calculate(7); }\n}\n';
  for(const [file,data] of Object.entries({'App.java':source,'libs/api.jar':jar,'forge.java.json':JSON.stringify({version:1,classpath:['libs/api.jar']}),...files})){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),data);}
  t.after(async()=>{assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});return root;
}
test('Java dependency JARs resolve types and support local rename while library symbols and contracts stay read-only',async t=>{
  const root=await fixture(t),before=await readFile(join(root,'libs/api.jar'));
  const diagnostics=await navigateJava({path:root,action:'diagnostics'},[root]);assert.equal(diagnostics.total,0);assert.equal(diagnostics.project.environment.classpath_entries,1);
  const renamed=await navigateJava({path:root,file:'App.java',action:'rename_preview',line:3,column:7,new_name:'scale'},[root]);assert.equal(renamed.edits![0]!.replacements.length,2);
  await assert.rejects(navigateJava({path:root,file:'App.java',action:'rename_preview',line:3,column:37,new_name:'other'},[root]),/Read-only Java environment/);
  const override='class App extends vendor.Api { @Override public int external(int n){return n+1;} }';await writeFile(join(root,'App.java'),override);
  await assert.rejects(navigateJava({path:root,file:'App.java',action:'rename_preview',line:1,column:override.indexOf('external')+1,new_name:'other'},[root]),/external.*contract|read-only/i);
  assert.deepEqual(await readFile(join(root,'libs/api.jar')),before);
});
test('Java captured classpath honors class directories and detects model, bytes and class inventory drift',async t=>{
  const root=await fixture(t,{'forge.java.json':JSON.stringify({version:1,classpath:['classes']})});await mkdir(join(root,'classes/vendor'),{recursive:true});await copyFile(join(classes,'vendor/Api.class'),join(root,'classes/vendor/Api.class'));
  assert.equal((await navigateJava({path:root,action:'diagnostics'},[root])).total,0);
  const captured=await loadJavaProject({path:root},[root]);await writeFile(join(root,'classes/vendor/Extra.class'),'new');await assert.rejects(verifyJavaEnvironment(captured),/classpath environment changed/);
  await rm(join(root,'classes/vendor/Extra.class'));await writeFile(join(root,'classes/vendor/Api.class'),Buffer.from('different'));await assert.rejects(verifyJavaEnvironment(captured),/classpath environment changed/);
});
test('Java generated classpath build pins refuse stale descriptors before analysis',async t=>{
  const body='<project/>',root=await fixture(t,{'pom.xml':body,'forge.java.json':JSON.stringify({version:1,classpath:['libs/api.jar'],build_inputs:[{path:'pom.xml',sha256:javaHash(body)}]})});
  assert.equal((await loadJavaClasspath(root,[root])).inputs.length,2);await writeFile(join(root,'pom.xml'),'<project>changed</project>');await assert.rejects(loadJavaClasspath(root,[root]),/build inputs changed/);
});
test('Java classpath rejects links, unauthorized paths, duplicates and hidden Manifest Class-Path without following them',async t=>{
  const root=await fixture(t);await symlink(join(root,'libs/api.jar'),join(root,'libs/link.jar'));
  try{for(const path of ['libs/link.jar',join(library,'api.jar')]){await writeFile(join(root,'forge.java.json'),JSON.stringify({version:1,classpath:[path]}));await assert.rejects(loadJavaClasspath(root,[root]),/link|approved|allowed|outside/i);}}finally{assert.equal(await realpath(root),root);await unlink(join(root,'libs/link.jar'));}
  await writeFile(join(root,'forge.java.json'),JSON.stringify({version:1,classpath:['libs/api.jar','libs/api.jar']}));await assert.rejects(loadJavaClasspath(root,[root]),/Duplicate/);
  const settings=await exec('java',['-XshowSettings:properties','-version'],{env:nativeEnv}),home=settings.stderr.match(/java.home = (.+)/)![1]!.trim();
  await writeFile(join(root,'manifest.mf'),'Manifest-Version: 1.0\r\nClass-Path: file:/unapproved/secret.jar\r\n\r\n');
  await exec(join(home,'bin','jar.exe'),['--create','--file',join(root,'libs/hidden.jar'),'--manifest',join(root,'manifest.mf'),'-C',classes,'.'],{env:nativeEnv});
  assert.throws(()=>validateJavaJar(Buffer.from('not a ZIP')),/Invalid/);
  await writeFile(join(root,'forge.java.json'),JSON.stringify({version:1,classpath:['libs/hidden.jar']}));await assert.rejects(loadJavaClasspath(root,[root]),/Manifest Class-Path/);
});
test('Java dependency drift after semantic capture prevents a durable rename intent',async t=>{
  const root=await fixture(t),parent=await realpath(tmpdir()),state=await mkdtemp(join(parent,'forge-java-classpath-state-'));const engine=new DurableTasks(state),batches=new TaskFileBatches(engine);t.after(async()=>{engine.close();assert.equal(await realpath(state),state);await rm(state,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const task=engine.create(root,'classpath-drift','rename only with pinned dependency environment',['echo verified'],true),query={file:'App.java',line:3,column:7,new_name:'scale'};
  const original=await readFile(join(root,'App.java'),'utf8');
  const initial=new Set(await readdir(parent));
  const operation=renameTask(engine,batches,{task_id:task.task_id,operation_id:'must-not-write',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,...query},[root]);void operation.catch(()=>{});
  let captured=false;
  for(let i=0;i<400&&!captured;i++){
    for(const name of await readdir(parent))if(name.startsWith('forge-java-analysis-')&&!initial.has(name))captured=await access(join(parent,name,'classpath.txt')).then(()=>true,()=>false);
    if(!captured)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(captured,true,'observe private classpath snapshot before mutating original dependency');
  const changed=Buffer.concat([jar,Buffer.from('x')]);changed.writeUInt16LE(1,jar.length-2);validateJavaJar(changed);await writeFile(join(root,'libs/api.jar'),changed);
  await assert.rejects(operation,/classpath environment changed/);
  assert.equal(await readFile(join(root,'App.java'),'utf8'),original);assert.equal(engine.db.prepare('SELECT 1 FROM task_file_batches WHERE task_id=? AND id=?').get(task.task_id,'must-not-write'),undefined);
});
test('Java source helpers retain the six-argument source-only client contract during deployment',async t=>{
  const root=await fixture(t),snapshot=join(root,'legacy');await mkdir(snapshot);const source='class Plain { int calc(int n){return n*2;} int run(){return calc(7);} }';await writeFile(join(snapshot,'Plain.java'),source);
  const encoded=(text:string)=>'v'+Buffer.from(text).toString('base64url');
  for(const [helper,action,column,query] of [['ForgeJavaAnalyze.java','outline',0,''],['ForgeJavaRename.java','rename_preview',source.indexOf('calc')+1,'scale']] as const){
    const result=await exec('java',['--source','21',fileURLToPath(new URL('../scripts/java-analysis/'+helper,import.meta.url)),snapshot,action,encoded('Plain.java'),action==='outline'?'0':'1',String(column),encoded(query)],{env:nativeEnv,windowsHide:true});
    const reply=JSON.parse(result.stdout);assert.ok(reply.total>=2);if(action==='rename_preview')assert.equal(reply.total,2);assert.equal(await readFile(join(snapshot,'Plain.java'),'utf8'),source);
  }
});
