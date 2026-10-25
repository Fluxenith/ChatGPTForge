import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {navigateJava} from './java-navigation.js';
import {verifyJavaEnvironment,loadJavaProject} from './java-project.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';

async function fixture(t:any,sources:Record<string,string>){const root=await mkdtemp(join(await realpath(tmpdir()),'forge-java-rename-')),project=join(root,'中文 project');await mkdir(project);for(const [file,text] of Object.entries(sources)){await mkdir(dirname(join(project,file)),{recursive:true});await writeFile(join(project,file),text);}const engine=new DurableTasks(join(root,'state')),batches=new TaskFileBatches(engine),task=engine.create(project,'java-rename','verify Java rename',['echo verified'],true);t.after(async()=>{engine.close();assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return {root,project,engine,batches,task};}
function position(text:string,needle:string,occurrence=0){let index=-1;for(let i=0;i<=occurrence;i++){index=text.indexOf(needle,index+1);assert.ok(index>=0,needle);}const before=text.slice(0,index),line=before.split(/\r\n|\r|\n/).length,column=before.length-Math.max(before.lastIndexOf('\n'),before.lastIndexOf('\r'));return {line,column};}
async function preview(f:Awaited<ReturnType<typeof fixture>>,file:string,needle:string,new_name:string,occurrence=0){return navigateJava({path:f.project,file,action:'rename_preview',...position(await readFile(join(f.project,file),'utf8'),needle,occurrence),new_name},[f.project]);}
async function rename(f:Awaited<ReturnType<typeof fixture>>,file:string,needle:string,new_name:string,occurrence=0,operation_id='rename'){return renameTask(f.engine,f.batches,{task_id:f.task.task_id,lease_token:f.task.lease_token!,expected_fingerprint:snapshot(f.project).fingerprint,operation_id,file,...position(await readFile(join(f.project,file),'utf8'),needle,occurrence),new_name},[f.project]);}

test('Java method rename resolves overloads, static imports, method references and same-spelling local shadows',async t=>{
  const f=await fixture(t,{'p/Calc.java':'package p; public class Calc { public static int twice(int value){ return value*2; } public static String twice(String value){ return value+value; } }','p/Caller.java':'package p; import java.util.function.IntUnaryOperator; public class Caller { public int run(){ int twice=5; IntUnaryOperator fn=Calc::twice; return Calc.twice(4)+fn.applyAsInt(twice); } public String other(){return Calc.twice("x");} }'});
  const p=await preview(f,'p/Calc.java','twice','scale');assert.equal(p.total,3);assert.deepEqual(p.edits?.map(e=>e.file).sort(),['p/Calc.java','p/Caller.java']);const r=await rename(f,'p/Calc.java','twice','scale');assert.equal(r.state,'completed');const caller=await readFile(join(f.project,'p/Caller.java'),'utf8');assert.match(caller,/Calc::scale/);assert.match(caller,/int twice=5/);assert.match(caller,/Calc.twice\("x"\)/);
  const f2=await fixture(t,{'p/Maths.java':'package p; public class Maths {public static int twice(int n){return n*2;}}','p/Use.java':'package p; import static p.Maths.twice; class Use {int run(){return twice(2);}}'});const p2=await preview(f2,'p/Maths.java','twice','scale');assert.equal(p2.total,3);
});

test('Java public type rename moves its filename, constructors and caller tokens in one reversible batch',async t=>{
  const sources={'p/Calc.java':'package p; public class Calc { public Calc(){} public Calc(int n){} public int run(){ return 7; } }','p/Caller.java':'package p; public class Caller { public static void main(String[] args){Calc c=new Calc(2);System.out.print(c.run());} }'},f=await fixture(t,sources),p=await preview(f,'p/Calc.java','Calc','Compute');assert.deepEqual(p.file_moves?.map(m=>[m.from,m.to]),[['p/Calc.java','p/Compute.java']]);assert.equal(p.total,5);
  const args={task_id:f.task.task_id,lease_token:f.task.lease_token!,expected_fingerprint:f.task.fingerprint,operation_id:'rename',file:'p/Calc.java',...position(sources['p/Calc.java'],'Calc'),new_name:'Compute'};const r=await renameTask(f.engine,f.batches,args,[f.project]);assert.equal(r.state,'completed');assert.equal(existsSync(join(f.project,'p/Calc.java')),false);assert.match(await readFile(join(f.project,'p/Compute.java'),'utf8'),/public Compute\(int n\)/);assert.deepEqual(await renameTask(f.engine,f.batches,args,[f.project]),r);
  const compiled=join(f.root,'classes');await mkdir(compiled);execFileSync('javac',['-proc:none','--release','21','-encoding','UTF-8','-d',compiled,join(f.project,'p/Compute.java'),join(f.project,'p/Caller.java')],{windowsHide:true});assert.equal(execFileSync('java',['-cp',compiled,'p.Caller'],{windowsHide:true,encoding:'utf8'}),'7');
  assert.equal(f.batches.rollback(f.task.task_id,'rename','undo',f.task.lease_token!).state,'completed');assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);for(const [file,text] of Object.entries(sources))assert.equal(await readFile(join(f.project,file),'utf8'),text);
});

test('Java case-only public type rename changes the actual Windows filename and restores exact source names on rollback',async t=>{
  const sources={'p/Calc.java':'package p; public class Calc { public Calc(){} public int run(){return 7;} }','p/Use.java':'package p; public class Use {public static void main(String[] args){Calc c=new Calc();System.out.print(c.run());}}'},f=await fixture(t,sources);
  const plan=await preview(f,'p/Calc.java','Calc','calc');assert.deepEqual(plan.file_moves?.map(move=>[move.from,move.to]),[['p/Calc.java','p/calc.java']]);assert.equal(plan.total,4);
  const args={task_id:f.task.task_id,lease_token:f.task.lease_token!,expected_fingerprint:f.task.fingerprint,operation_id:'case',file:'p/Calc.java',...position(sources['p/Calc.java'],'Calc'),new_name:'calc'};
  const result=await renameTask(f.engine,f.batches,args,[f.project]);assert.equal(result.state,'completed');assert.deepEqual((await readdir(join(f.project,'p'))).sort(),['Use.java','calc.java']);
  for(const [file,text] of Object.entries(sources))assert.equal(await readFile(join(f.project,file==='p/Calc.java'?'p/calc.java':file),'utf8'),text.replaceAll('Calc','calc'));
  const compiled=join(f.root,'classes');await mkdir(compiled);execFileSync('javac',['-proc:none','--release','21','-d',compiled,join(f.project,'p/calc.java'),join(f.project,'p/Use.java')],{windowsHide:true});assert.equal(execFileSync('java',['-cp',compiled,'p.Use'],{windowsHide:true,encoding:'utf8'}),'7');
  assert.deepEqual(await renameTask(f.engine,f.batches,args,[f.project]),result);
  const undo=f.batches.rollback(f.task.task_id,'case','undo',f.task.lease_token!);assert.equal(undo.state,'completed');assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);assert.deepEqual((await readdir(join(f.project,'p'))).sort(),['Calc.java','Use.java']);
  assert.deepEqual(f.batches.rollback(f.task.task_id,'case','undo',f.task.lease_token!),undo);assert.deepEqual(await renameTask(f.engine,f.batches,args,[f.project]),result);assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);
});

test('Java public interface, enum, record and Unicode type renames move the matching source filename',async t=>{
  for(const [file,source,use,newName] of [
    ['Api.java','public interface Api {int run();}','class Use {Api a;}','Contract'],
    ['Flag.java','public enum Flag {YES; public boolean run(){return true;}}','class Use {Flag f=Flag.YES;}','Choice'],
    ['Box.java','public record Box(int value) {public Box {if(value<0)throw new IllegalArgumentException();}}','class Use {Box b=new Box(1); int run(){return b.value();}}','Item'],
    ['中文.java','public class 中文 {public 中文(){}}','class Use {中文 c=new 中文();}','新版'],
  ]){const old=file!.slice(0,-5),f=await fixture(t,{[file!]:source!,'Use.java':use!});
    const p=await preview(f,file!,old,newName!);assert.deepEqual(p.file_moves?.map(m=>[m.from,m.to]),[[file,newName+'.java']]);
    assert.equal((await rename(f,file!,old,newName!)).state,'completed');
    assert.equal(existsSync(join(f.project,file!)),false);
    assert.equal(await readFile(join(f.project,newName+'.java'),'utf8'),source!.replaceAll(old,newName!));
    assert.equal(await readFile(join(f.project,'Use.java'),'utf8'),use!.replaceAll(old,newName!));
  }
});

test('Java override families change interface and implementation while external contracts remain read-only',async t=>{
  const f=await fixture(t,{'p/Api.java':'package p; public interface Api {int value();}','p/Impl.java':'package p; public class Impl implements Api {public int value(){return 4;}}','p/Use.java':'package p; class Use {int run(Api a,Impl b){return a.value()+b.value();}}'});const p=await preview(f,'p/Impl.java','value','amount');assert.equal(p.total,4);assert.equal((await rename(f,'p/Impl.java','value','amount')).state,'completed');
  const external=await fixture(t,{'App.java':'class App {public String toString(){return "owned";} int run(){return "string".length();}}'});await assert.rejects(preview(external,'App.java','toString','render'),/external override contract/);await assert.rejects(preview(external,'App.java','length','size'),/Read-only Java/);assert.equal(external.engine.status(external.task.task_id).operations.length,0);
});

test('Java rejects compiler collisions and silent lexical capture before intent',async t=>{
  for(const source of ['class App {int first=1,second=2; int run(){return first;}}','class App {int first=1; int run(){int second=2;return first+second;}}','class App {int second=2; int run(){int first=1;return first+second;}}']){const f=await fixture(t,{'App.java':source});await assert.rejects(rename(f,'App.java','first','second'),/compiler error|symbol binding/);assert.equal(await readFile(join(f.project,'App.java'),'utf8'),source);assert.equal(f.engine.status(f.task.task_id).operations.length,0);}
});

test('Java record components include accessor references and compact constructor parameters',async t=>{
  const f=await fixture(t,{'Box.java':'public record Box(String value) {public Box {value=value.strip();}}','Use.java':'class Use {String run(Box b){return b.value();}}'});const p=await preview(f,'Box.java','value','text');assert.equal(p.total,4);assert.equal((await rename(f,'Box.java','value','text')).state,'completed');assert.match(await readFile(join(f.project,'Box.java'),'utf8'),/text=text.strip/);assert.match(await readFile(join(f.project,'Use.java'),'utf8'),/b.text\(\)/);
});

test('Java selecting a canonical record parameter renames the component family but leaves overload parameters alone',async t=>{
  const source='public record Box(String value) {public Box(String value) {this.value=value.strip();} public Box(int value){this(String.valueOf(value));}}',use='class Use {String run(Box b){return b.value();}}',f=await fixture(t,{'Box.java':source,'Use.java':use});
  const p=await preview(f,'Box.java','value','text',1);assert.equal(p.total,5);
  assert.equal((await rename(f,'Box.java','value','text',1)).state,'completed');
  assert.equal(await readFile(join(f.project,'Box.java'),'utf8'),'public record Box(String text) {public Box(String text) {this.text=text.strip();} public Box(int value){this(String.valueOf(value));}}');
  assert.equal(await readFile(join(f.project,'Use.java'),'utf8'),use.replace('b.value()','b.text()'));
  const compact=await fixture(t,{'Box.java':'public record Box(String value) {public Box {value=value.strip();}}','Use.java':use});
  assert.equal((await preview(compact,'Box.java','value','text',1)).total,4);
});

test('Java Unicode names, escaped identifiers and text blocks preserve raw UTF-16 edits and non-code text',async t=>{
  const source='class App {\r\n String note="😀 名称"; String block="""\n名称 inside block\n""";\r\n int 名称=2; int run(){return \\u540d\\u79f0;}\r\n}',f=await fixture(t,{'App.java':source});const p=await preview(f,'App.java','名称=','值');assert.equal(p.total,2);assert.ok(p.edits?.[0]?.replacements.some(r=>r.old_text==='\\u540d\\u79f0'));assert.equal((await rename(f,'App.java','名称=','值')).state,'completed');const after=await readFile(join(f.project,'App.java'),'utf8');assert.match(after,/return 值/);assert.match(after,/😀 名称/);assert.match(after,/名称 inside block/);
});

test('Java Unicode paths and supplementary identifiers survive native stdout for navigation and rename',async t=>{
  const name='\u{10400}名',renamed='\u{10401}值',source=`class 中文 {int ${name}=2; int run(){return ${name};}}`,f=await fixture(t,{'中文.java':source});
  const outline=await navigateJava({path:f.project,file:'中文.java',action:'outline'},[f.project]);
  assert.ok(outline.results.some(r=>r.file==='中文.java'&&r.name===name));
  const p=await preview(f,'中文.java',name,renamed);assert.equal(p.total,2);
  assert.ok(p.edits?.[0]?.replacements.every(r=>r.new_text===renamed));
  assert.equal((await rename(f,'中文.java',name,renamed)).state,'completed');
  assert.equal(await readFile(join(f.project,'中文.java'),'utf8'),source.replaceAll(name,renamed));
});

test('Java rename cancellation, changed capture and more than 300 references create no write intent',async t=>{
  const f=await fixture(t,{'App.java':'class App {int value=1; int run(){return value;}}'}),cancelled=new AbortController();cancelled.abort();await assert.rejects(renameTask(f.engine,f.batches,{task_id:f.task.task_id,lease_token:f.task.lease_token!,expected_fingerprint:f.task.fingerprint,operation_id:'cancelled',file:'App.java',line:1,column:16,new_name:'other'},[f.project],cancelled.signal),/cancelled/);assert.equal(f.engine.status(f.task.task_id).operations.length,0);
  const capture=await loadJavaProject({path:f.project},[f.project]);await writeFile(join(f.project,'Extra.java'),'class Extra {}');await assert.rejects(verifyJavaEnvironment(capture),/inventory/);
  const many=await fixture(t,{'Many.java':'class Many {int value=1;int run(){return '+Array.from({length:301},()=> 'value').join('+')+';}}'});await assert.rejects(rename(many,'Many.java','value','other'),/exceeds 300 edits/);assert.equal(many.engine.status(many.task.task_id).operations.length,0);
});

test('Java cancellation during native analysis and drift after analysis leave no write intent',async t=>{
  const source='class App {int value=1; int run(){return value;}}',f=await fixture(t,{'App.java':source}),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),150);
  try {await assert.rejects(renameTask(f.engine,f.batches,{task_id:f.task.task_id,lease_token:f.task.lease_token!,expected_fingerprint:f.task.fingerprint,operation_id:'during',file:'App.java',...position(source,'value'),new_name:'other'},[f.project],controller.signal),/abort|cancel/i);}finally{clearTimeout(timer);}
  assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);assert.equal(f.engine.status(f.task.task_id).operations.length,0);
  for(const phase of ['cancel','inventory'] as const){const next=await fixture(t,{'App.java':source}),signal=new AbortController(),read=next.batches.readText.bind(next.batches);
    next.batches.readText=(root,path)=>{const content=read(root,path);if(phase==='cancel')signal.abort();else writeFileSync(join(next.project,'Added.java'),'class Added {}');return content;};
    await assert.rejects(renameTask(next.engine,next.batches,{task_id:next.task.task_id,lease_token:next.task.lease_token!,expected_fingerprint:next.task.fingerprint,operation_id:phase,file:'App.java',...position(source,'value'),new_name:'other'},[next.project],signal.signal),/cancel|inventory/);
    assert.equal(await readFile(join(next.project,'App.java'),'utf8'),source);assert.equal(next.engine.status(next.task.task_id).operations.length,0);
  }
});

test('interrupted Java filename move retains unknown and can restore the full original batch',async t=>{
  const f=await fixture(t,{'Calc.java':'public class Calc {public Calc(){}}','Use.java':'class Use {Calc c=new Calc();}'}),batches=new TaskFileBatches(f.engine,(phase,index)=>{if(phase==='replaced'&&index===0)throw Error('Owned fixture interruption after first rename target');});const r=await renameTask(f.engine,batches,{task_id:f.task.task_id,lease_token:f.task.lease_token!,expected_fingerprint:f.task.fingerprint,operation_id:'rename',file:'Calc.java',line:1,column:14,new_name:'Compute'},[f.project]);assert.equal(r.state,'unknown');assert.throws(()=>f.engine.complete(f.task.task_id,f.task.lease_token!),/Outstanding/);const recovered=f.batches.recover(f.task.task_id,'rename','restore','rollback',snapshot(f.project).fingerprint,f.task.lease_token!);assert.equal(recovered.operation.state,'completed');assert.equal(snapshot(f.project).fingerprint,f.task.fingerprint);assert.equal(existsSync(join(f.project,'Compute.java')),false);
});

test('Java mixed overload static imports preserve the original import and add the renamed overload',async t=>{
  const f=await fixture(t,{'p/Calc.java':'package p; public class Calc {public static int twice(int n){return n*2;}public static String twice(String s){return s+s;}}','p/Use.java':'package p; import static p.Calc.twice; class Use {int number(){return twice(4);}String text(){return twice("x");}}'});const p=await preview(f,'p/Calc.java','twice','scale');assert.equal(p.total,3);assert.ok(p.edits?.some(e=>e.replacements.some(r=>r.new_text.includes('import static p.Calc.scale'))));assert.equal((await rename(f,'p/Calc.java','twice','scale')).state,'completed');const use=await readFile(join(f.project,'p/Use.java'),'utf8');assert.match(use,/import static p.Calc.twice;/);assert.match(use,/import static p.Calc.scale;/);assert.match(use,/return scale\(4\)/);assert.match(use,/return twice\("x"\)/);
});

test('Java can rename from a unique static import and refuses missing, keyword and filename collisions',async t=>{
  const f=await fixture(t,{'p/Maths.java':'package p; public class Maths {public static int twice(int n){return n*2;}}','p/Use.java':'package p; import static p.Maths.twice; class Use {int run(){return twice(2);}}'});const p=await preview(f,'p/Use.java','twice','scale');assert.equal(p.total,3);
  for(const name of ['class','with space','Maths'])await assert.rejects(preview(f,'p/Maths.java','Maths',name),/non-keyword|differ/);
  const collision=await fixture(t,{'Calc.java':'public class Calc {}','Compute.java':'class Separate {}'});await assert.rejects(rename(collision,'Calc.java','Calc','Compute'),/destination already exists/);assert.equal(collision.engine.status(collision.task.task_id).operations.length,0);
  const broken=await fixture(t,{'Calc.java':'class Calc {Missing type;}'});await assert.rejects(rename(broken,'Calc.java','Calc','Other'),/error-free/);assert.equal(broken.engine.status(broken.task.task_id).operations.length,0);
});
