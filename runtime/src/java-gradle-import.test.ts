import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {loadJavaClasspath} from './java-classpath.js';
import {compareVersions,importGradle,parseBuild} from './java-gradle-static.js';
import {navigateJava} from './java-navigation.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';

const exec=promisify(execFile),bs=String.fromCharCode(92),real=join(homedir(),'.m2','repository');
const available=existsSync(join(real,'org/apache/commons/commons-text/1.9/commons-text-1.9.jar'))&&existsSync(join(real,'com/google/guava/guava/30.1-android/guava-30.1-android.jar'))&&existsSync(join(real,'org/apache/commons/commons-lang3/3.5/commons-lang3-3.5.jar'));
// Same fixtures as artifacts/java-gradle-import-v1/gradle-oracle.mjs. Expected sets
// are the union of each project's main and test compile classpaths that Gradle
// 8.14.3 printed offline (gradle-oracle.json); all sources compile together.
const SINGLE={'settings.gradle':"rootProject.name = 'app'",'build.gradle':"plugins { id 'java' }\nrepositories { mavenLocal() }\ndependencies {\n  implementation 'org.apache.commons:commons-text:1.9'\n  implementation 'org.apache.commons:commons-lang3:3.5'\n  compileOnly 'com.google.code.findbugs:jsr305:3.0.2'\n  testImplementation 'junit:junit:4.13.2'\n}\n"};
const MULTI={'settings.gradle':"rootProject.name = 'demo'\ninclude 'core', 'app'",'build.gradle':'',
 'core/build.gradle':"plugins { id 'java-library' }\nrepositories { mavenLocal() }\ndependencies {\n  api 'org.apache.commons:commons-text:1.9'\n  implementation 'com.google.guava:guava:30.1-android'\n}\n",
 'app/build.gradle':"plugins { id 'java' }\nrepositories { mavenLocal() }\ndependencies {\n  implementation project(':core')\n  testImplementation 'junit:junit:4.13.2'\n}\n"};
const ORACLE={single:['com/google/code/findbugs/jsr305/3.0.2/jsr305-3.0.2.jar','org/apache/commons/commons-text/1.9/commons-text-1.9.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar','junit/junit/4.13.2/junit-4.13.2.jar','org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar'],
 multi:['org/apache/commons/commons-text/1.9/commons-text-1.9.jar','com/google/guava/guava/30.1-android/guava-30.1-android.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar','com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar','com/google/guava/listenablefuture/9999.0-empty-to-avoid-conflict-with-guava/listenablefuture-9999.0-empty-to-avoid-conflict-with-guava.jar','com/google/code/findbugs/jsr305/3.0.2/jsr305-3.0.2.jar','org/checkerframework/checker-compat-qual/2.5.5/checker-compat-qual-2.5.5.jar','com/google/errorprone/error_prone_annotations/2.3.4/error_prone_annotations-2.3.4.jar','com/google/j2objc/j2objc-annotations/1.3/j2objc-annotations-1.3.jar','junit/junit/4.13.2/junit-4.13.2.jar','org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar']};

async function fixture(t:{after:(f:()=>unknown)=>void},files:Record<string,string>){
 const base=await mkdtemp(join(await realpath(tmpdir()),'forge-gradle-import-')),project=join(base,'project'),repo=join(base,'repository');
 for(const [f,s] of Object.entries(files)){await mkdir(dirname(join(project,f)),{recursive:true});await writeFile(join(project,f),s);}
 const previous=process.env.CHATGPTFORGE_MAVEN_REPOSITORY;process.env.CHATGPTFORGE_MAVEN_REPOSITORY=real;
 const scout=await importGradle(project,[project,real]).catch(()=>undefined);
 for(const path of [...(scout?.inputs??[]).map(i=>i.path),...(scout?.artifacts??[]).map(a=>a.path)]){if(!path.startsWith(real))continue;const target=join(repo,relative(real,path));await mkdir(dirname(target),{recursive:true});await copyFile(path,target);}
 process.env.CHATGPTFORGE_MAVEN_REPOSITORY=repo;
 const close:(()=>void)[]=[];
 t.after(async()=>{for(const c of close)c();if(previous===undefined)delete process.env.CHATGPTFORGE_MAVEN_REPOSITORY;else process.env.CHATGPTFORGE_MAVEN_REPOSITORY=previous;await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {base,project,repo,close};
}

test('Java static Gradle import matches Gradle 8.14.3 compile classpaths (highest version wins)',{skip:!available},async t=>{
 for(const [name,files] of [['single',SINGLE],['multi',MULTI]] as const){
  const f=await fixture(t,files);const c=await loadJavaClasspath(f.project,[f.base]);
  assert.equal(c.maven?.state,'imported',JSON.stringify(c.maven));assert.equal((c.maven as {build:string}).build,'gradle');
  assert.deepEqual(c.entries.map(e=>relative(f.repo,e.path).split(bs).join('/')).sort(),[...ORACLE[name]].sort(),name);
  assert.ok(c.inputs.some(i=>i.path.endsWith('build.gradle')));
 }
 assert.ok(compareVersions('3.11','3.5')>0&&compareVersions('1.0-rc1','1.0')<0&&compareVersions('2.0','2.0.0')===0&&compareVersions('1.10','1.9')>0);
});

test('Java static Gradle import refuses programmatic build logic instead of evaluating it',{skip:!available},async t=>{
 const f=await fixture(t,SINGLE);
 const reason=async(files:Record<string,string>)=>{for(const [p,s] of Object.entries(files))await writeFile(join(f.project,p),s);const c=await loadJavaClasspath(f.project,[f.base]);assert.equal(c.maven?.state,'skipped');return (c.maven as {reason:string}).reason;};
 assert.match(await reason({'build.gradle':SINGLE['build.gradle']+"\ndef v = '1.9'\n"}),/unsupported build statement/);
 assert.match(await reason({'build.gradle':SINGLE['build.gradle'].replace("'org.apache.commons:commons-text:1.9'",'"org.apache.commons:commons-text:$v"')}),/literal group:artifact:version/);
 assert.match(await reason({'build.gradle':SINGLE['build.gradle'].replace("id 'java'","id 'org.springframework.boot'")}),/plugin/);
 assert.match(await reason({'build.gradle':SINGLE['build.gradle'].replace("1.9'","1.+'")}),/Dynamic version|literal group/);
 assert.match(await reason({'build.gradle':SINGLE['build.gradle'].replace('mavenLocal()',"maven { url 'https://x' }")}),/repository|unsupported/);
 assert.match(await reason({'build.gradle':SINGLE['build.gradle'].replace("implementation 'org.apache.commons:commons-lang3:3.5'","implementation platform('org.example:bom:1')")}),/literal group|unsupported/);
 await writeFile(join(f.project,'build.gradle'),SINGLE['build.gradle']);await writeFile(join(f.project,'gradle.properties'),'x=1');
 assert.match((await loadJavaClasspath(f.project,[f.base])).maven!.state==='skipped'?((await loadJavaClasspath(f.project,[f.base])).maven as {reason:string}).reason:'',/gradle.properties/);
 await rm(join(f.project,'gradle.properties'));
 assert.match(await reason({'settings.gradle':"rootProject.name = 'app'\nif (true) { include 'x' }"}),/unsupported settings statement/);
 assert.throws(()=>parseBuild("plugins { id 'java' }\nallprojects { }",'b'),/unsupported build statement/);
});

const CORE='package demo.core;\n\npublic class Text {\n  public static String shout(String v) { return org.apache.commons.text.WordUtils.capitalize(org.apache.commons.lang3.StringUtils.reverse(v)); }\n}\n';
const APP='package demo.app;\n\nimport demo.core.Text;\n\npublic class App {\n  public static void main(String[] args) { if (!Text.shout("ba ca").equals("Ac Ab")) throw new AssertionError(); System.out.print("PASS"); }\n}\n';
test('Java navigation and durable rename across Gradle projects use the imported classpath with native javac',{skip:!available,timeout:300_000},async t=>{
 const f=await fixture(t,{...MULTI,'core/src/main/java/demo/core/Text.java':CORE,'app/src/main/java/demo/app/App.java':APP}),roots=[f.base];
 const diagnostics=await navigateJava({path:f.project,action:'diagnostics'},roots);assert.equal(diagnostics.total,0,JSON.stringify(diagnostics.results));
 const env=diagnostics.project.environment as {maven_import:{state:string;build:string;projects:string[]}};assert.equal(env.maven_import.build,'gradle');assert.deepEqual(env.maven_import.projects,[':core',':app']);
 const jars=['org/apache/commons/commons-text/1.9/commons-text-1.9.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar'].map(p=>join(f.repo,...p.split('/'))).join(';');
 const javac=async(phase:string)=>{const out=join(f.base,phase);await mkdir(out);await exec('javac',['--release','21','-proc:none','-cp',jars,'-d',out,join(f.project,'core/src/main/java/demo/core/Text.java'),join(f.project,'app/src/main/java/demo/app/App.java')]);assert.equal((await exec('java',['-cp',out+';'+jars,'demo.app.App'])).stdout,'PASS');};
 await javac('before');
 const engine=new DurableTasks(join(f.base,'state')),batches=new TaskFileBatches(engine);f.close.push(()=>engine.close());
 const task=engine.create(f.project,'gradle','rename across Gradle projects',['echo ok'],true);
 const at=APP.indexOf('shout('),parts=APP.slice(0,at).split('\n');
 const args={task_id:task.task_id,lease_token:task.lease_token!,expected_fingerprint:task.fingerprint,operation_id:'rename',file:'app/src/main/java/demo/app/App.java',line:parts.length,column:parts.at(-1)!.length+1,new_name:'yell'};
 assert.equal((await renameTask(engine,batches,args,roots)).state,'completed');
 assert.match(await readFile(join(f.project,'core/src/main/java/demo/core/Text.java'),'utf8'),/static String yell\(/);
 await javac('after');
 batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(snapshot(f.project).fingerprint,task.fingerprint);
});
