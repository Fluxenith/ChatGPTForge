import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {navigateJava} from './java-navigation.js';
import {loadJavaProject, usesJavaNavigation} from './java-project.js';
import {registerCodeNavigation} from './code-navigation.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';

const fixtureRoot=resolve(import.meta.dirname,'../../artifacts/java-navigation-v1/fixture');
const calcFile='src/main/java/demo/Calc.java';
const callerFile='src/main/java/demo/Caller.java';

async function fixture(t: {after:(cleanup:()=>Promise<void>)=>void}, sources:Record<string,string>) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'forge-java-test-'));
  for(const [path,body] of Object.entries(sources)) {
    const file=join(root,path);
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file,body,'utf8');
  }
  t.after(async()=>{assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  return root;
}

test('Java JDK 21 compiler navigation resolves cross-file references, declarations and lexical shadows',async()=>{
  assert.equal(await usesJavaNavigation({path:fixtureRoot},[fixtureRoot]),true);
  const before=await Promise.all([calcFile,callerFile].map(file=>readFile(join(fixtureRoot,file))));
  const outline=await navigateJava({path:fixtureRoot,file:calcFile,action:'outline'},[fixtureRoot]);
  assert.equal(outline.project.language,'java');
  assert.ok(outline.results.some(item=>item.name==='Calc'&&item.declaration));
  assert.ok(outline.results.some(item=>item.name==='twice'&&item.declaration));
  const symbols=await navigateJava({path:fixtureRoot,action:'symbols',query:'twice'},[fixtureRoot]);
  assert.equal(symbols.total,2);
  assert.ok(symbols.results.some(item=>item.file===calcFile&&item.kind==='METHOD'));
  assert.ok(symbols.results.some(item=>item.file===callerFile&&item.kind==='LOCAL_VARIABLE'));
  const definition=await navigateJava({path:fixtureRoot,file:callerFile,action:'definition',line:5,column:27},[fixtureRoot]);
  assert.deepEqual(definition.results.map(item=>item.file),[calcFile]);
  const references=await navigateJava({path:fixtureRoot,file:callerFile,action:'references',line:5,column:27},[fixtureRoot]);
  assert.deepEqual(references.results.map(item=>item.file).sort(),[calcFile,callerFile]);
  assert.equal(references.results.filter(item=>item.declaration).length,1);
  const diagnostics=await navigateJava({path:fixtureRoot,action:'diagnostics'},[fixtureRoot]);
  assert.equal(diagnostics.total,0,JSON.stringify(diagnostics.results));
  assert.equal(diagnostics.project.source_files,2);
  const after=await Promise.all([calcFile,callerFile].map(file=>readFile(join(fixtureRoot,file))));
  assert.deepEqual(after,before);
});

test('Java produces syntax and semantic errors with original UTF-16 ranges and leaves source untouched',async t=>{
  const source='package demo;\r\npublic class Bad {\r\n  String emoji = "😀";\r\n  int count = "wrong";\r\n}\r\n';
  const root=await fixture(t,{'src/demo/Bad.java':source,'pom.xml':'<project />'});
  const result=await navigateJava({path:root,action:'diagnostics'},[root]);
  assert.ok(result.results.some(item=>item.severity==='error'&&item.file==='src/demo/Bad.java'&&item.line===4),JSON.stringify(result.results));
  assert.equal(await readFile(join(root,'src/demo/Bad.java'),'utf8'),source);
});

test('Java captured sources reject escapes, mixed-language selections and invalid request locations',async t=>{
  const root=await fixture(t,{'App.java':'class App {}','other.ts':'export const x=1;'});
  await assert.rejects(loadJavaProject({path:root,files:['../escape.java']},[root]),/outside allowed roots/);
  await assert.rejects(loadJavaProject({path:root,files:['App.java','other.ts']},[root]),/only .java/);
  await assert.rejects(navigateJava({path:root,file:'App.java',action:'definition',line:99,column:1},[root]),/outside source/);
  const renamed=await navigateJava({path:root,file:'App.java',action:'rename_preview',line:1,column:7,new_name:'Other'},[root]);assert.equal(renamed.edits?.[0]?.replacements[0]?.new_text,'Other');assert.equal(await readFile(join(root,'App.java'),'utf8'),'class App {}');
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(navigateJava({path:root,action:'symbols',query:'App'},[root],cancelled.signal),/abort/i);
});

test('Java MCP registration routes to Java analyzer on project discovery',async()=>{
  let handler:((input:any,extra:any)=>Promise<any>)|undefined;
  const target={registerTool:(_name:string,_spec:unknown,callback:typeof handler)=>{handler=callback;}} as unknown as McpRegistrationTarget;
  registerCodeNavigation(target,[fixtureRoot]);
  assert.ok(handler);
  const response=await handler!({path:fixtureRoot,action:'symbols',query:'Calc'},{signal:new AbortController().signal});
  assert.equal(response.isError,undefined,JSON.stringify(response));
  const body=JSON.parse(response.content[0].text);
  assert.equal(body.project.language,'java');
  assert.equal(body.results[0].name,'Calc');
});
