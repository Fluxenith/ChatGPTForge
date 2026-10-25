import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,realpath,readdir,rm,writeFile,symlink} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {navigateCSharp} from './csharp-navigation.js';
import {loadCSharpProject,verifyCSharpEnvironment,csharpHash,usesCSharpNavigation} from './csharp-project.js';
import {loadCSharpToolchain,CSHARP_RUNTIME} from './csharp-toolchain.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';
import {windowsProcessIdentity} from './durable-windows-job.js';
async function fixture(t:any,sources:Record<string,string>){
 const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'forge-csharp-test-')),project=join(root,'中文 project');await mkdir(project);
 for(const [file,text] of Object.entries(sources)){await mkdir(dirname(join(project,file)),{recursive:true});await writeFile(join(project,file),text);}
 const close:(()=>void)[]=[];
 t.after(async()=>{for(const dispose of close)dispose();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+'\\'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return {root,project,close};
}
function position(text:string,needle:string){const at=text.indexOf(needle);assert.ok(at>=0,needle);const parts=text.slice(0,at).split(/\r\n|\r|\n/);return {line:parts.length,column:parts.at(-1)!.length+1};}
async function query(project:string,action:any,file='',needle='',new_name='',query=''){return navigateCSharp({path:project,action,...(file?{file}:{}),...(needle?position(await readFile(join(project,file),'utf8'),needle):{}),...(new_name?{new_name}:{}),...(query?{query}:{})},[project]);}
const api='namespace Demo;\r\n// 😀 original CRLF\r\npublic partial class Api { static Api(){if(System.Environment.GetEnvironmentVariable("FORGE_NATIVE_RUN")!="1")throw new System.Exception("Unexpected project execution");} public static int Twice(int value)=>value*2; public static string Twice(string value)=>value+value; public static T Identity<T>(T value)=>value; }';
const app='using Alias=Demo.Api; namespace Demo; public static class App {public static int Run(){System.Func<int,int> fn=Api.Twice; return Api.Twice(3)+Alias.Twice(2)+fn(4)+Api.Limit;} public static string Text()=>Api.Twice("x"); public static string Generic()=>Api.Identity("x"); public static string Label()=>nameof(Api.Twice);}';
const sources={'Api.cs':api,'Partial.cs':'namespace Demo; public partial class Api {public static int Limit=7;}','App.cs':app};

test('C# compiler navigation resolves overloads, generic calls, partial types and metadata without executing project code',async t=>{
 const f=await fixture(t,sources);assert.equal(await usesCSharpNavigation({path:f.project,file:'App.cs'},[f.project]),true);
 const diagnostics=await query(f.project,'diagnostics');assert.equal(diagnostics.total,0,JSON.stringify(diagnostics.results));
 for(const [needle,file,name] of [['Twice(3)','Api.cs','Twice'],['Twice("x")','Api.cs','Twice'],['Identity("x")','Api.cs','Identity'],['Limit;','Partial.cs','Limit']]){const r=await query(f.project,'definition','App.cs',needle!);assert.equal(r.total,1);assert.equal(r.results[0]!.file,file);assert.equal(r.results[0]!.name,name);}
 const refs=await query(f.project,'references','App.cs','Twice(3)');assert.ok(refs.total>=4);assert.ok(refs.results.every(r=>r.name==='Twice'));assert.ok(!refs.results.some(r=>r.file==='App.cs'&&r.column===position(app,'Twice("x")').column));
 const outline=await query(f.project,'outline','Api.cs');assert.ok(outline.results.some(r=>r.name==='Twice'));assert.equal(outline.project.environment.compiler_version,'5.9.0.0');
 assert.equal((await query(f.project,'symbols','','','','Api')).results.filter(r=>r.name==='Api'&&r.kind==='NamedType').length,2);
 const metadata=await query(f.project,'definition','Api.cs','GetEnvironmentVariable');assert.equal(metadata.results[0]!.read_only,true);assert.equal(metadata.results[0]!.origin,'csharp_metadata');
 for(const [file,content] of Object.entries(sources))assert.equal(await readFile(join(f.project,file),'utf8'),content);
});

test('C# durable rename preserves mixed-overload nameof and native behavior, supports replay and exact rollback',async t=>{
 const f=await fixture(t,sources),engine=new DurableTasks(join(f.root,'state')),batches=new TaskFileBatches(engine);f.close.push(()=>engine.close());
 const task=engine.create(f.project,'csharp','verify C# rename',['echo verified'],true),args={task_id:task.task_id,lease_token:task.lease_token!,expected_fingerprint:task.fingerprint,operation_id:'rename',file:'App.cs',...position(app,'Twice(3)'),new_name:'Scale'};
 const preview=await query(f.project,'rename_preview','App.cs','Twice(3)','Scale');assert.equal(preview.rename!.can_rename,true);assert.equal(preview.edits!.length,2);
 const native=async(phase:string)=>{const toolchain=await loadCSharpToolchain(),directory=join(f.root,phase);await mkdir(directory);const output=join(directory,'App.dll'),entry=join(directory,'Entry.cs');
  await writeFile(entry,'class Entry {static void Main(){if(Demo.App.Run()!=25||Demo.App.Text()!="xx"||Demo.App.Generic()!="x"||Demo.App.Label()!="Twice")throw new System.Exception("Behavior changed");System.Console.Write("PASS");}}');
  execFileSync(toolchain.dotnet,[join(toolchain.root,'sdk/10.0.402/Roslyn/bincore/csc.dll'),'/noconfig','/nologo','/target:exe','/nullable:enable','/out:'+output,...toolchain.framework.map(r=>'/reference:'+join(toolchain.root,r)),...Object.keys(sources).map(file=>join(f.project,file)),entry],{windowsHide:true,env:{...process.env,DOTNET_ROOT:toolchain.root,DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});
  await writeFile(join(directory,'App.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0',framework:{name:'Microsoft.NETCore.App',version:CSHARP_RUNTIME},rollForward:'Disable'}}));
  assert.equal(execFileSync(toolchain.dotnet,[output],{encoding:'utf8',windowsHide:true,env:{...process.env,DOTNET_ROOT:toolchain.root,FORGE_NATIVE_RUN:'1'}}),'PASS');
 };
 await native('before');const result=await renameTask(engine,batches,args,[f.project]);assert.equal(result.state,'completed');assert.deepEqual(await renameTask(engine,batches,args,[f.project]),result);
 const changed=await readFile(join(f.project,'App.cs'),'utf8');assert.match(changed,/Api.Scale\(3\)/);assert.match(changed,/Api.Twice\("x"\)/);assert.match(changed,/nameof\(Api.Twice\)/);await native('after');
 const undo=batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(undo.state,'completed');assert.deepEqual(batches.rollback(task.task_id,'rename','undo',task.lease_token!),undo);assert.equal(snapshot(f.project).fingerprint,task.fingerprint);
 for(const [file,content] of Object.entries(sources))assert.equal(await readFile(join(f.project,file),'utf8'),content);
});

test('C# rename follows internal interface and override families, partial methods, record properties and type constructors',async t=>{
 for(const [source,needle,name,expected] of [
  ['interface I {int Value();} class Base:I {public virtual int Value()=>1;} class Child:Base {public override int Value()=>2;} class Use {int Run(I i,Child c)=>i.Value()+c.Value();}','Value()=>2','Amount',['int Amount();','virtual int Amount','override int Amount','i.Amount()+c.Amount()']],
  ['partial class Api {partial void Work(); public void Run()=>Work();} partial class Api {partial void Work(){}}','Work();','Perform',['partial void Perform();','Run()=>Perform();','partial void Perform()']],
  ['record Box(int Value); class Use {int Run(Box box)=>box.Value;}','Value);','Amount',['Box(int Amount)','box.Amount']],
  ['class Box {public Box(){} public Box(int value){} } class Use {Box Run()=>new Box(1);}','Box {','Item',['class Item','public Item()','public Item(int value)','Item Run()=>new Item(1)']],
 ] as const){const f=await fixture(t,{'App.cs':source}),r=await query(f.project,'rename_preview','App.cs',needle,name);assert.ok(r.edits!.length);let text=source;for(const replacement of r.edits![0]!.replacements)text=text.slice(0,replacement.start)+replacement.new_text+text.slice(replacement.start+replacement.length);for(const part of expected)assert.ok(text.includes(part),text);await writeFile(join(f.project,'App.cs'),text);assert.equal((await query(f.project,'diagnostics')).results.filter(r=>r.severity==='error').length,0);}
});

test('C# explicit compiler environment controls preprocessor, nullable and top-level output; pins prevent stale publication',async t=>{
 const source='#if FEATURE\nSystem.Console.WriteLine("active");\n#else\n#error feature missing\n#endif\n',model={version:1,sources:['App.cs'],references:[],options:{defines:['FEATURE'],output_kind:'exe',nullable:'disable'}},f=await fixture(t,{'App.cs':source,'Project.csproj':'<Project/>','forge.csharp.json':JSON.stringify(model),'obj/Excluded.cs':'#error must not be discovered'});
 const result=await query(f.project,'diagnostics');assert.equal(result.results.filter(r=>r.severity==='error').length,0);assert.equal(result.project.source_files,1);assert.equal(result.project.environment.project_model,true);
 const captured=await loadCSharpProject({path:f.project},[f.project]);await writeFile(join(f.project,'forge.csharp.json'),JSON.stringify({...model,options:{...model.options,defines:[]}}));await assert.rejects(verifyCSharpEnvironment(captured),/environment changed/);
 assert.ok((await query(f.project,'diagnostics')).results.some(r=>r.code==='CS1029'));
 const raw=await readFile(join(f.project,'Project.csproj'));await writeFile(join(f.project,'forge.csharp.json'),JSON.stringify({...model,build_inputs:[{path:'Project.csproj',sha256:csharpHash(raw)}]}));await writeFile(join(f.project,'Project.csproj'),'<Project changed="true"/>');await assert.rejects(loadCSharpProject({path:f.project},[f.project]),/build input changed/);
});

test('C# capture rejects escapes, links, missing build models and stale snapshots; unsafe rename never records write intent',async t=>{
 const f=await fixture(t,{'App.cs':'class App {int First=1,Second=2; int Run()=>First+Second;}','other.ts':'export const x=1;'});
 await assert.rejects(loadCSharpProject({path:f.project,files:['../escape.cs']},[f.project]),/relative .cs/);await assert.rejects(loadCSharpProject({path:f.project,files:['other.ts']},[f.project]),/relative .cs/);
 const external=join(f.root,'External.cs');await writeFile(external,'class External {}');await symlink(external,join(f.project,'Linked.cs'),'file');await assert.rejects(loadCSharpProject({path:f.project,files:['Linked.cs']},[f.project]),/link|outside allowed roots/);
 await rm(join(f.project,'Linked.cs'));
 const engine=new DurableTasks(join(f.root,'state')),batches=new TaskFileBatches(engine);f.close.push(()=>engine.close());const task=engine.create(f.project,'csharp','reject invalid rename',['echo verified'],true);
 await assert.rejects(renameTask(engine,batches,{task_id:task.task_id,operation_id:'bad',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'App.cs',line:1,column:16,new_name:'Second'},[f.project]),/compiler errors/);assert.equal(engine.status(task.task_id).operations.length,0);
 await assert.rejects(query(f.project,'rename_preview','App.cs','First','class'),/non-keyword/);
 await writeFile(join(f.project,'Build.csproj'),'<Project/>');await assert.rejects(loadCSharpProject({path:f.project},[f.project]),/only <Project Sdk="Microsoft.NET.Sdk"> is supported by static import/);
 await rm(join(f.project,'Build.csproj'));await assert.rejects(navigateCSharp({path:f.project,action:'diagnostics'},[f.project],undefined,()=>writeFileSync(join(f.project,'App.cs'),'class Changed {}')),/environment changed/);
});

test('C# analysis cancellation closes its owned Windows job and refuses external override/interface renames',async t=>{
 const f=await fixture(t,{'App.cs':'class App:System.IDisposable {public void Dispose(){} public override string ToString()=>"owned";}'});
 await assert.rejects(query(f.project,'rename_preview','App.cs','ToString','Render'),/external override/);
 await assert.rejects(query(f.project,'rename_preview','App.cs','Dispose','Release'),/external interface/);
 let launched:{pid:number;creation:string}|undefined;const controller=new AbortController();
 await assert.rejects(navigateCSharp({path:f.project,action:'diagnostics'},[f.project],controller.signal,undefined,{onLaunched:(pid,creation)=>{launched={pid,creation};controller.abort();}}),/abort/i);
 assert.ok(launched);for(let attempt=0;attempt<30&&windowsProcessIdentity(launched.pid)===launched.creation;attempt++)await new Promise(r=>setTimeout(r,30));assert.notEqual(windowsProcessIdentity(launched.pid),launched.creation);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(navigateCSharp({path:f.project,action:'diagnostics'},[f.project],cancelled.signal),/abort/i);
});
