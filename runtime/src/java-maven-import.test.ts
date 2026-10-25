import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {copyFile,cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {loadJavaClasspath} from './java-classpath.js';
import {importMaven} from './java-maven-static.js';
import {navigateJava} from './java-navigation.js';
import {verifyJavaEnvironment,type JavaProject} from './java-project.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';

const exec=promisify(execFile),bs=String.fromCharCode(92);
const real=join(homedir(),'.m2','repository');
const pom=(deps:string,props='',extra='')=>`<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>app</artifactId><version>1.0</version><properties><maven.compiler.release>21</maven.compiler.release>${props}</properties><dependencies>${deps}</dependencies>${extra}</project>`;
const TEXT='<dependency><groupId>org.apache.commons</groupId><artifactId>commons-text</artifactId><version>${text.version}</version></dependency><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>';
const MIXED='<dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>30.1-android</version></dependency><dependency><groupId>org.apache.commons</groupId><artifactId>commons-compress</artifactId><version>1.20</version><scope>provided</scope></dependency><dependency><groupId>org.apache.commons</groupId><artifactId>commons-text</artifactId><version>1.9</version><exclusions><exclusion><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId></exclusion></exclusions></dependency>';
// Maven 3.9.9's actual offline javac test-compile classpath for the same POMs
// (artifacts/java-maven-import-v1/maven-oracle.json).
const ORACLE={text:['org/apache/commons/commons-text/1.9/commons-text-1.9.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar','junit/junit/4.13.2/junit-4.13.2.jar','org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar'],
 mixed:['com/google/guava/guava/30.1-android/guava-30.1-android.jar','com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar','com/google/guava/listenablefuture/9999.0-empty-to-avoid-conflict-with-guava/listenablefuture-9999.0-empty-to-avoid-conflict-with-guava.jar','com/google/code/findbugs/jsr305/3.0.2/jsr305-3.0.2.jar','org/checkerframework/checker-compat-qual/2.5.5/checker-compat-qual-2.5.5.jar','com/google/errorprone/error_prone_annotations/2.3.4/error_prone_annotations-2.3.4.jar','com/google/j2objc/j2objc-annotations/1.3/j2objc-annotations-1.3.jar','org/apache/commons/commons-compress/1.20/commons-compress-1.20.jar','org/apache/commons/commons-text/1.9/commons-text-1.9.jar']};
const available=existsSync(join(real,'org/apache/commons/commons-text/1.9/commons-text-1.9.jar'))&&existsSync(join(real,'com/google/guava/guava/30.1-android/guava-30.1-android.jar'));

// Owned approved root holding a project and a private copy of exactly the
// repository files the import reads; the user's real repository stays untouched.
async function fixture(t:{after:(f:()=>unknown)=>void},rootPom:string,files:Record<string,string>={}){
 const base=await mkdtemp(join(await realpath(tmpdir()),'forge-maven-import-')),project=join(base,'project'),repo=join(base,'repository');
 await mkdir(project);await writeFile(join(project,'pom.xml'),rootPom);
 for(const [f,s] of Object.entries(files)){await mkdir(dirname(join(project,f)),{recursive:true});await writeFile(join(project,f),s);}
 // Scout once against the real repository (read-only) to learn which files to copy.
 const previous=process.env.CHATGPTFORGE_MAVEN_REPOSITORY;process.env.CHATGPTFORGE_MAVEN_REPOSITORY=real;
 const scout=await importMaven(project,Buffer.from(rootPom),[project,real]).catch(()=>undefined);
 for(const path of [...(scout?.inputs??[]).map(i=>i.path),...(scout?.artifacts??[]).map(a=>a.path)]){if(!path.startsWith(real))continue;const target=join(repo,relative(real,path));await mkdir(dirname(target),{recursive:true});await copyFile(path,target);}
 process.env.CHATGPTFORGE_MAVEN_REPOSITORY=repo;
 const close:(()=>void)[]=[];
 t.after(async()=>{for(const c of close)c();if(previous===undefined)delete process.env.CHATGPTFORGE_MAVEN_REPOSITORY;else process.env.CHATGPTFORGE_MAVEN_REPOSITORY=previous;await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {base,project,repo,close};
}

test('Java static Maven import reproduces Maven 3.9.9 classpaths from an approved local repository',{skip:!available},async t=>{
 for(const [name,deps,props] of [['text',TEXT,'<text.version>1.9</text.version>'],['mixed',MIXED,'']] as const){
  const f=await fixture(t,pom(deps,props));
  const classpath=await loadJavaClasspath(f.project,[f.base]);
  assert.equal(classpath.maven?.state,'imported',JSON.stringify(classpath.maven));
  assert.deepEqual(classpath.entries.map(e=>relative(f.repo,e.path).split(bs).join('/')),ORACLE[name],name);
  assert.ok(classpath.inputs.some(i=>i.path.endsWith('pom.xml')));
  // Outside the approved roots the repository is never read: sources-only fallback.
  // A project-local .m2/repository is used when no explicit setting exists.
  const env=process.env.CHATGPTFORGE_MAVEN_REPOSITORY;delete process.env.CHATGPTFORGE_MAVEN_REPOSITORY;
  try{await cp(f.repo,join(f.project,'.m2','repository'),{recursive:true});const local=await loadJavaClasspath(f.project,[f.project]);
   assert.equal(local.maven?.state,'imported');assert.equal(local.entries.length,ORACLE[name].length);assert.ok(local.entries.every(e=>e.path.startsWith(join(f.project,'.m2'))));
   await rm(join(f.project,'.m2'),{recursive:true,force:true});}finally{process.env.CHATGPTFORGE_MAVEN_REPOSITORY=env;}
  const fallback=await loadJavaClasspath(f.project,[f.project]);
  assert.equal(fallback.entries.length,0);assert.equal(fallback.maven?.state,'skipped');assert.match((fallback.maven as {reason:string}).reason,/not approved/);
 }
});

test('Java static Maven import refuses constructs that need Maven instead of approximating them',{skip:!available},async t=>{
 const f=await fixture(t,pom(TEXT,'<text.version>1.9</text.version>'));
 const reason=async(xml:string)=>{await writeFile(join(f.project,'pom.xml'),xml);const c=await loadJavaClasspath(f.project,[f.base]);assert.equal(c.maven?.state,'skipped',xml);assert.equal(c.entries.length,0);return (c.maven as {reason:string}).reason;};
 assert.match(await reason(pom('<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>[4.0,5.0)</version></dependency>')),/version range/);
 assert.match(await reason(pom('<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>${missing}</version></dependency>')),/unresolved property/);
 assert.match(await reason(pom('<dependency><groupId>x</groupId><artifactId>y</artifactId><version>1</version><scope>system</scope></dependency>')),/Missing in local Maven repository|system/);
 assert.match(await reason(pom('',' ','<profiles><profile><id>p</id><activation><activeByDefault>true</activeByDefault></activation><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></profile></profiles>')),/activatable profile/);
 // Reactors are supported; a listed module without a POM is refused.
 assert.match(await reason(pom('','','<modules><module>a</module></modules>')),/module POM missing/);
 assert.match(await reason(pom('','','<build><plugins><plugin><artifactId>build-helper-maven-plugin</artifactId></plugin></plugins></build>')),/build plugin/);
 assert.match(await reason(pom('<dependency><groupId>org.example</groupId><artifactId>absent</artifactId><version>1.0</version></dependency>')),/no download is attempted/);
 assert.match(await reason(pom('<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><classifier>tests</classifier></dependency>')),/classifier/);
});

const APP='package demo;\n\nimport org.apache.commons.lang3.StringUtils;\nimport org.apache.commons.text.WordUtils;\n\npublic class App {\n  static String shout(String value) { return WordUtils.capitalize(StringUtils.reverse(value)); }\n  public static void main(String[] args) { if (!shout("ba ca").equals("Ac Ab")) throw new AssertionError(shout("ba ca")); System.out.print("PASS"); }\n}\n';
const USE='package demo;\n\nclass Use { String run() { return App.shout("x y"); } }\n';
test('Java navigation and durable rename use the imported Maven classpath with native javac before and after',{skip:!available,timeout:300_000},async t=>{
 const f=await fixture(t,pom(TEXT,'<text.version>1.9</text.version>'),{'src/main/java/demo/App.java':APP,'src/main/java/demo/Use.java':USE});
 const roots=[f.base];
 const diagnostics=await navigateJava({path:f.project,action:'diagnostics'},roots);
 assert.equal(diagnostics.total,0,JSON.stringify(diagnostics.results));
 const env=diagnostics.project.environment as {maven_import:{state:string;artifacts:{artifact:string}[]};classpath_entries:number};
 assert.equal(env.maven_import.state,'imported');assert.equal(env.classpath_entries,4);
 assert.deepEqual(env.maven_import.artifacts.map(a=>a.artifact),['commons-text','commons-lang3','junit','hamcrest-core']);
 const pos=(text:string,needle:string)=>{const at=text.indexOf(needle);const parts=text.slice(0,at).split('\n');return {line:parts.length,column:parts.at(-1)!.length+1};};
 const external=await navigateJava({path:f.project,action:'definition',file:'src/main/java/demo/App.java',...pos(APP,'capitalize(')},roots);
 // Existing contract: without an attached source archive, a library symbol yields no guessed definition.
 assert.equal(external.total,0);
 await assert.rejects(navigateJava({path:f.project,action:'rename_preview',file:'src/main/java/demo/App.java',...pos(APP,'capitalize('),new_name:'other'},roots),/read-only|Read-only/i);
 const javac=async(phase:string)=>{const out=join(f.base,phase);await mkdir(out);
  const jars=['org/apache/commons/commons-text/1.9/commons-text-1.9.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar'].map(p=>join(f.repo,...p.split('/'))).join(';');
  await exec('javac',['--release','21','-proc:none','-cp',jars,'-d',out,join(f.project,'src/main/java/demo/App.java'),join(f.project,'src/main/java/demo/Use.java')]);
  assert.equal((await exec('java',['-cp',out+';'+jars,'demo.App'])).stdout,'PASS');};
 await javac('before');
 const engine=new DurableTasks(join(f.base,'state')),batches=new TaskFileBatches(engine);f.close.push(()=>engine.close());
 const task=engine.create(f.project,'maven','rename with imported classpath',['echo ok'],true);
 const args={task_id:task.task_id,lease_token:task.lease_token!,expected_fingerprint:task.fingerprint,operation_id:'rename',file:'src/main/java/demo/Use.java',...pos(USE,'shout('),new_name:'yell'};
 const result=await renameTask(engine,batches,args,roots);assert.equal(result.state,'completed');assert.deepEqual(await renameTask(engine,batches,args,roots),result);
 assert.match(await readFile(join(f.project,'src/main/java/demo/App.java'),'utf8'),/static String yell\(/);assert.match(await readFile(join(f.project,'src/main/java/demo/Use.java'),'utf8'),/App\.yell\(/);
 await javac('after');
 const undo=batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(undo.state,'completed');assert.equal(snapshot(f.project).fingerprint,task.fingerprint);
 // A changed repository artifact invalidates captured analysis before write intent.
 let captured:JavaProject|undefined;await navigateJava({path:f.project,action:'outline',file:'src/main/java/demo/Use.java'},roots,undefined,project=>{captured=project;});
 const lang=join(f.repo,'org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.pom');await writeFile(lang,(await readFile(lang,'utf8'))+'<!-- changed -->');
 await assert.rejects(verifyJavaEnvironment(captured!),/classpath environment changed/);
});

// Owned reactor matching artifacts/java-maven-import-v1/reactor-oracle.mjs: Maven
// compiles core with commons-text 1.9 + commons-lang3 3.11 and app with core's
// classes plus the same JARs; app adds junit/hamcrest for tests.
const PARENT='<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging><modules><module>core</module><module>app</module></modules><properties><maven.compiler.release>21</maven.compiler.release></properties><dependencyManagement><dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-text</artifactId><version>1.9</version></dependency></dependencies></dependencyManagement></project>';
const CORE_POM='<project><modelVersion>4.0.0</modelVersion><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent><artifactId>core</artifactId><dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-text</artifactId></dependency></dependencies></project>';
const APP_POM='<project><modelVersion>4.0.0</modelVersion><parent><groupId>demo</groupId><artifactId>parent</artifactId><version>1.0</version></parent><artifactId>app</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>core</artifactId><version>${project.version}</version></dependency><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies></project>';
const TEXT_JAVA='package demo.core;\n\npublic class Text {\n  public static String shout(String v) { return org.apache.commons.text.WordUtils.capitalize(org.apache.commons.lang3.StringUtils.reverse(v)); }\n}\n';
const APP_JAVA='package demo.app;\n\nimport demo.core.Text;\n\npublic class App {\n  public static void main(String[] args) { if (!Text.shout("ba ca").equals("Ac Ab")) throw new AssertionError(); System.out.print("PASS"); }\n}\n';
const reactorFiles={'core/pom.xml':CORE_POM,'app/pom.xml':APP_POM,'core/src/main/java/demo/core/Text.java':TEXT_JAVA,'app/src/main/java/demo/app/App.java':APP_JAVA};

test('Java Maven reactor import resolves modules from source and matches Maven per-module classpaths',{skip:!available,timeout:300_000},async t=>{
 const f=await fixture(t,PARENT,reactorFiles),roots=[f.base];
 const classpath=await loadJavaClasspath(f.project,roots);
 assert.equal(classpath.maven?.state,'imported',JSON.stringify(classpath.maven));
 assert.deepEqual(classpath.entries.map(e=>relative(f.repo,e.path).split(bs).join('/')),['org/apache/commons/commons-text/1.9/commons-text-1.9.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar','junit/junit/4.13.2/junit-4.13.2.jar','org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar']);
 assert.ok(['pom.xml','core/pom.xml','app/pom.xml'].every(p=>classpath.inputs.some(i=>i.path===join(f.project,...p.split('/')))));
 const diagnostics=await navigateJava({path:f.project,action:'diagnostics'},roots);assert.equal(diagnostics.total,0,JSON.stringify(diagnostics.results));
 const javac=async(phase:string)=>{const out=join(f.base,phase);await mkdir(out);
  const jars=['org/apache/commons/commons-text/1.9/commons-text-1.9.jar','org/apache/commons/commons-lang3/3.11/commons-lang3-3.11.jar'].map(p=>join(f.repo,...p.split('/'))).join(';');
  await exec('javac',['--release','21','-proc:none','-cp',jars,'-d',out,join(f.project,'core/src/main/java/demo/core/Text.java'),join(f.project,'app/src/main/java/demo/app/App.java')]);
  assert.equal((await exec('java',['-cp',out+';'+jars,'demo.app.App'])).stdout,'PASS');};
 await javac('before');
 const engine=new DurableTasks(join(f.base,'state')),batches=new TaskFileBatches(engine);f.close.push(()=>engine.close());
 const task=engine.create(f.project,'reactor','rename across Maven modules',['echo ok'],true);
 const at=APP_JAVA.indexOf('shout('),parts=APP_JAVA.slice(0,at).split('\n');
 const args={task_id:task.task_id,lease_token:task.lease_token!,expected_fingerprint:task.fingerprint,operation_id:'rename',file:'app/src/main/java/demo/app/App.java',line:parts.length,column:parts.at(-1)!.length+1,new_name:'yell'};
 const result=await renameTask(engine,batches,args,roots);assert.equal(result.state,'completed');
 assert.match(await readFile(join(f.project,'core/src/main/java/demo/core/Text.java'),'utf8'),/static String yell\(/);
 assert.match(await readFile(join(f.project,'app/src/main/java/demo/app/App.java'),'utf8'),/Text\.yell\(/);
 await javac('after');
 batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(snapshot(f.project).fingerprint,task.fingerprint);
});

test('Java Maven reactor import refuses version conflicts and escaping or conditional modules',{skip:!available},async t=>{
 const f=await fixture(t,PARENT,reactorFiles);
 const reason=async(files:Record<string,string>)=>{for(const [p,s] of Object.entries(files)){await mkdir(dirname(join(f.project,p)),{recursive:true});await writeFile(join(f.project,p),s);}
  const c=await loadJavaClasspath(f.project,[f.base]);assert.equal(c.maven?.state,'skipped');return (c.maven as {reason:string}).reason;};
 assert.match(await reason({'app/pom.xml':APP_POM.replace('<dependency><groupId>junit','<dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.5</version></dependency><dependency><groupId>junit')}),/one compilation cannot hold both|Missing/);
 await writeFile(join(f.project,'app/pom.xml'),APP_POM);
 assert.match(await reason({'pom.xml':PARENT.replace('<module>app</module>','<module>../outside</module>')}),/Unsupported Maven module path/);
 assert.match(await reason({'pom.xml':PARENT.replace('<module>app</module>','<module>missing</module>')}),/module POM missing/);
 assert.match(await reason({'pom.xml':PARENT.replace('</dependencyManagement>','</dependencyManagement><profiles><profile><id>x</id><modules><module>app</module></modules></profile></profiles>')}),/profile-dependent modules/);
 await writeFile(join(f.project,'pom.xml'),PARENT);
 assert.equal((await loadJavaClasspath(f.project,[f.base])).maven?.state,'imported');
});
