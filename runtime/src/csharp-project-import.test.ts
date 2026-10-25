import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {importCSharpBuild,globMatch} from './csharp-msbuild-static.js';
import {navigateCSharp} from './csharp-navigation.js';
import {loadCSharpProject,verifyCSharpEnvironment,type CSharpProject} from './csharp-project.js';
import {loadCSharpToolchain} from './csharp-toolchain.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';

const bs=String.fromCharCode(92);
async function fixture(t:{after:(f:()=>unknown)=>void},files:Record<string,string>){
 const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'forge-csharp-import-')),project=join(root,'solution 中文');await mkdir(project);
 for(const [file,text] of Object.entries(files)){await mkdir(dirname(join(project,file)),{recursive:true});await writeFile(join(project,file),text);}
 const close:(()=>void)[]=[];
 t.after(async()=>{for(const dispose of close)dispose();assert.ok(root.startsWith(base+bs));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {root,project,close};
}
const csproj=(body:string)=>`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>${body}</PropertyGroup></Project>`;

test('C# static project import matches the pinned SDK evaluation and csc command line',async t=>{
 // Same owned fixture as artifacts/csharp-project-import-v1/sdk-oracle.mjs; expected
 // values are that run's MSBuild evaluation and actual csc arguments.
 const f=await fixture(t,{'Oracle.sln':`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Lib", "Lib${bs}Lib.csproj", "{1}"\r\nEndProject\r\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "App${bs}App.csproj", "{2}"\r\nEndProject\r\n`,
  'Lib/Lib.csproj':csproj('<Nullable>enable</Nullable>'),
  'App/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><LangVersion>13</LangVersion><AllowUnsafeBlocks>true</AllowUnsafeBlocks><DefineConstants>$(DefineConstants);CUSTOM_FLAG</DefineConstants></PropertyGroup><ItemGroup><ProjectReference Include="..${bs}Lib${bs}Lib.csproj" /><Compile Remove="Skip${bs}**" /></ItemGroup></Project>`,
  'Lib/A.cs':'namespace Lib; public static class A { public static int One()=>1; }','App/Program.cs':'class P{static void Main(){System.Console.WriteLine(Lib.A.One());}}','App/Skip/S.cs':'class S{}','App/obj/x.cs':'class X{}'});
 const build=(await importCSharpBuild(f.project))!,[lib,app]=build.projects;
 const sdk='DEBUG;NET;NET10_0;NETCOREAPP;NET5_0_OR_GREATER;NET6_0_OR_GREATER;NET7_0_OR_GREATER;NET8_0_OR_GREATER;NET9_0_OR_GREATER;NET10_0_OR_GREATER;NETCOREAPP1_0_OR_GREATER;NETCOREAPP1_1_OR_GREATER;NETCOREAPP2_0_OR_GREATER;NETCOREAPP2_1_OR_GREATER;NETCOREAPP2_2_OR_GREATER;NETCOREAPP3_0_OR_GREATER;NETCOREAPP3_1_OR_GREATER';
 assert.equal(lib!.options.defines.join(';'),'TRACE;'+sdk);assert.equal(app!.options.defines.join(';'),'TRACE;CUSTOM_FLAG;'+sdk);
 assert.deepEqual(lib!.sources,['Lib/A.cs']);assert.deepEqual(app!.sources,['App/Program.cs']);
 assert.deepEqual(app!.global_usings,['System','System.Collections.Generic','System.IO','System.Linq','System.Net.Http','System.Threading','System.Threading.Tasks']);assert.deepEqual(lib!.global_usings,[]);
 assert.deepEqual([lib!.options.language_version,lib!.options.nullable,lib!.options.output_kind,lib!.options.allow_unsafe],['14','enable','library',false]);
 assert.deepEqual([app!.options.language_version,app!.options.output_kind,app!.options.allow_unsafe],['13','exe',true]);
 assert.deepEqual(app!.project_references,['Lib/Lib.csproj']);assert.equal(build.solution,'Oracle.sln');assert.equal(build.inputs.length,3);
 for(const [glob,path,ok] of [['Skip/**','Skip/S.cs',true],['Skip/**','Skip/a/b.cs',true],['*.cs','a/b.cs',false],['**/*.cs','a/b.cs',true],['s?ip/*.CS','Skip/S.cs',true]] as const)assert.equal(globMatch(glob,path),ok,glob+' '+path);
});

test('C# static import refuses MSBuild-dependent constructs instead of approximating them',async t=>{
 const refuse=async(files:Record<string,string>,pattern:RegExp)=>{const f=await fixture(t,{'A.cs':'class A{}',...files});await assert.rejects(importCSharpBuild(f.project),pattern);};
 await refuse({'P.csproj':'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup Condition="true"><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'},/conditional/);
 await refuse({'P.csproj':'<Project Sdk="Microsoft.NET.Sdk"><Import Project="x.props"/></Project>'},/Import/);
 await refuse({'P.csproj':'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="X"/></ItemGroup></Project>'},/PackageReference.*restore/);
 await refuse({'P.csproj':csproj(''),'Directory.Build.props':'<Project/>'},/Directory\.Build\.props/);
 await refuse({'P.csproj':'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'},/net10\.0 only/);
 await refuse({'P.csproj':csproj('<OutputPath>x</OutputPath>')},/unsupported property OutputPath/);
 await refuse({'P.csproj':csproj('<DefineConstants>ONLY</DefineConstants>')},/extend \$\(DefineConstants\)/);
 await refuse({'P.csproj':csproj('<AssemblyName>$(X)</AssemblyName>')},/MSBuild expansion/);
 await refuse({'P.csproj':'<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'},/Microsoft\.NET\.Sdk/);
 await refuse({'P.csproj':'<!DOCTYPE x><Project Sdk="Microsoft.NET.Sdk"/>'},/Unsupported XML|Invalid XML|Expected XML/);
 await refuse({'P.csproj':csproj(''),'Q.csproj':csproj('')},/Multiple C# solutions or projects/);
 await refuse({'S.sln':`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "P", "P${bs}P.csproj", "{1}"\r\nEndProject\r\n`,'P/P.csproj':csproj(''),'Other/O.csproj':csproj('')},/not in the imported solution/);
 await refuse({'S.sln':`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "P", "P${bs}P.csproj", "{1}"\r\nEndProject\r\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "N", "P${bs}N${bs}N.csproj", "{2}"\r\nEndProject\r\n`,'P/P.csproj':csproj(''),'P/N/N.csproj':csproj(''),'P/N/n.cs':'class N{}'},/belongs to both/);
 await refuse({'S.sln':`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "A${bs}A.csproj", "{1}"\r\nEndProject\r\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "B", "B${bs}B.csproj", "{2}"\r\nEndProject\r\n`,
  'A/A.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="..${bs}B${bs}B.csproj"/></ItemGroup></Project>`,
  'B/B.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="..${bs}A${bs}A.csproj"/></ItemGroup></Project>`},/cycle/);
 await refuse({'P.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="..${bs}x.cs"/></ItemGroup></Project>`},/linked Compile/);
 await refuse({'S.sln':`Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "F", "F${bs}F.fsproj", "{1}"\r\nEndProject\r\n`},/non-C# project/);
 const plain=await fixture(t,{'A.cs':'class A{}'});assert.equal(await importCSharpBuild(plain.project),undefined);
});

const solution={'Demo.slnx':'<Solution><Project Path="Lib/Lib.csproj" /><Folder Name="/apps/"><Project Path="App/App.csproj" /></Folder></Solution>',
 'NuGet.Config':'<configuration><packageSources><clear/></packageSources></configuration>',
 'Lib/Lib.csproj':csproj('<Nullable>enable</Nullable>'),
 'Lib/Calc.cs':'namespace Lib;\r\n// 😀 CRLF\r\npublic static class Calc { public static int Twice(int value)=>value*2; public static string Twice(string value)=>value+value; internal static int Hidden()=>0; }',
 'App/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="..${bs}Lib${bs}Lib.csproj" /></ItemGroup></Project>`,
 'App/Program.cs':'var values=new List<int>{Lib.Calc.Twice(3)};\r\n#if NET10_0_OR_GREATER\r\nvalues.Add(Lib.Calc.Twice(4));\r\n#endif\r\nif(values.Sum()!=14||Lib.Calc.Twice("x")!="xx"||nameof(Lib.Calc.Twice)!="Twice")throw new Exception("Behavior changed");\r\nConsole.Write("PASS");\r\n'};
function position(text:string,needle:string){const at=text.indexOf(needle);assert.ok(at>=0,needle);const parts=text.slice(0,at).split(/\r\n|\r|\n/);return {line:parts.length,column:parts.at(-1)!.length+1};}

test('C# solution import navigates and renames across projects with native SDK build, replay and exact rollback',{timeout:600_000},async t=>{
 const f=await fixture(t,solution),roots=[f.project];
 const diagnostics=await navigateCSharp({path:f.project,action:'diagnostics'},roots);assert.equal(diagnostics.total,0,JSON.stringify(diagnostics.results));
 const environment=diagnostics.project.environment as {project_import:{kind:string;solution:string;projects:{file:string}[]}};
 assert.equal(environment.project_import.kind,'sdk_static');assert.equal(environment.project_import.solution,'Demo.slnx');assert.deepEqual(environment.project_import.projects.map(p=>p.file),['Lib/Lib.csproj','App/App.csproj']);
 const definition=await navigateCSharp({path:f.project,action:'definition',file:'App/Program.cs',...position(solution['App/Program.cs'],'Twice(3)')},roots);
 assert.equal(definition.total,1);assert.equal(definition.results[0]!.file,'Lib/Calc.cs');
 const references=await navigateCSharp({path:f.project,action:'references',file:'Lib/Calc.cs',...position(solution['Lib/Calc.cs'],'Twice(int')},roots);
 // nameof over the overload group is a genuine candidate reference; rename keeps it.
 assert.deepEqual(references.results.filter(r=>r.file==='App/Program.cs').map(r=>r.line),[1,3,5]);
 assert.doesNotMatch(JSON.stringify(references),/forge-generated/);
 // Native acceptance in owned copies: the real SDK must agree with the static model.
 const toolchain=await loadCSharpToolchain();
 const native=async(phase:string)=>{const copy=join(f.root,phase);await cp(f.project,copy,{recursive:true});
  const env={...process.env,DOTNET_ROOT:toolchain.root,DOTNET_CLI_HOME:join(f.root,'cli-'+phase),DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_GENERATE_ASPNET_CERTIFICATE:'false',DOTNET_NOLOGO:'1',DOTNET_CLI_UI_LANGUAGE:'en-US',DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER:'1',MSBUILDDISABLENODEREUSE:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1'};
  execFileSync(toolchain.dotnet,['build',join(copy,'App','App.csproj'),'--nologo','--verbosity','quiet','-p:UseSharedCompilation=false','-p:RestoreConfigFile='+join(copy,'NuGet.Config')],{windowsHide:true,env});
  assert.equal(execFileSync(toolchain.dotnet,[join(copy,'App','bin','Debug','net10.0','App.dll')],{encoding:'utf8',windowsHide:true,env}),'PASS');};
 await native('before');
 const engine=new DurableTasks(join(f.root,'state')),batches=new TaskFileBatches(engine);f.close.push(()=>engine.close());
 const task=engine.create(f.project,'csharp-solution','rename across imported projects',['echo ok'],true);
 const args={task_id:task.task_id,lease_token:task.lease_token!,expected_fingerprint:task.fingerprint,operation_id:'rename',file:'App/Program.cs',...position(solution['App/Program.cs'],'Twice(3)'),new_name:'Scale'};
 const result=await renameTask(engine,batches,args,roots);assert.equal(result.state,'completed');assert.deepEqual(await renameTask(engine,batches,args,roots),result);
 const lib=await readFile(join(f.project,'Lib/Calc.cs'),'utf8'),app=await readFile(join(f.project,'App/Program.cs'),'utf8');
 assert.match(lib,/int Scale\(int value\)/);assert.match(lib,/string Twice\(string value\)/);
 assert.match(app,/Calc\.Scale\(3\)/);assert.match(app,/Calc\.Scale\(4\)/);assert.match(app,/Calc\.Twice\("x"\)/);assert.match(app,/nameof\(Lib\.Calc\.Twice\)/);
 await native('after');
 const undo=batches.rollback(task.task_id,'rename','undo',task.lease_token!);assert.equal(undo.state,'completed');assert.deepEqual(batches.rollback(task.task_id,'rename','undo',task.lease_token!),undo);
 assert.equal(snapshot(f.project).fingerprint,task.fingerprint);
 // A changed project file invalidates captured analysis before any write intent.
 let captured:CSharpProject|undefined;await navigateCSharp({path:f.project,action:'outline',file:'Lib/Calc.cs'},roots,undefined,p=>{captured=p;});
 await writeFile(join(f.project,'App/App.csproj'),solution['App/App.csproj'].replace('<Nullable>enable</Nullable>','<Nullable>disable</Nullable>'));
 await assert.rejects(verifyCSharpEnvironment(captured!),/changed since capture/);
 assert.equal((await loadCSharpProject({path:f.project},roots)).import!.projects[1]!.options.nullable,'disable');
});
