import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import test,{after} from 'node:test';
import {navigateGo,goOffset,goIdentifier} from './go-navigation.js';
import {runGoAnalysis,closeGoAnalysisCache} from './go-analysis-runtime.js';
import {verifyGoEnvironment,type GoProject} from './go-project.js';
import {windowsProcessIdentity} from './durable-windows-job.js';
import {registerCodeNavigation} from './code-navigation.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';

const source='package math\r\n\r\ntype Number interface { ~int | ~float64 }\r\nfunc Double[T Number](n T) T { return n * 2 }\r\ntype Counter struct { Value int }\r\nfunc (c Counter) Total() int { return c.Value }\r\nfunc Shadow() int { Double := 7; return Double }\r\n';
after(closeGoAnalysisCache);
const app='package app\nimport (\n "example.test/forge/math"\n "fmt"\n)\nfunc Run() int { fmt.Println("😀"); return math.Double(3) }\nfunc Value(c math.Counter) int { return c.Total() }\n';
async function fixture(t:any,seed:Record<string,string>={}) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'forge-go-test-'));
  for(const [file,text] of Object.entries({'go.mod':'module example.test/forge\n\ngo 1.26.0\n','math/math.go':source,'app.go':app,...seed})) {
    await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),text);
  }
  t.after(async()=>{const canonical=await realpath(root);assert.equal(canonical,root);await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return root;
}
test('Go UTF-16 offsets and LSP frames reject malformed or partial input',async()=>{
  assert.equal(goOffset('\uFEFFa😀b\r\nxyz\n',0,4),4);
  assert.equal(goOffset('\uFEFFa😀b\r\nxyz\n',1,2),9);
  assert.throws(()=>goOffset('a😀b',0,2),/surrogate/);
  assert.throws(()=>goOffset('a',0,2),/outside/);
  assert.equal(goIdentifier('數值2'),true);assert.equal(goIdentifier('range'),false);assert.equal(goIdentifier('_'),false);
  const helper=new URL('../scripts/go-analysis/lsp-client.mjs',import.meta.url).href;
  const {LspFrames}=await import(helper);const values:unknown[]=[];
  const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,result:'😀'}));
  const frame=Buffer.concat([Buffer.from('Content-Length: '+bytes.length+'\r\n\r\n'),bytes]);
  const reader=new LspFrames((message:unknown)=>values.push(message));
  for(const byte of frame)reader.push(Buffer.from([byte]));reader.end();assert.equal((values[0] as any).result,'😀');
  assert.throws(()=>new LspFrames(()=>{}).push(Buffer.from('Content-Length: 1\r\nContent-Length: 1\r\n\r\n{}')),/Content-Length/);
  assert.throws(()=>new LspFrames(()=>{}).push(Buffer.from('Content-Length: 20000000\r\n\r\n')),/bounds/);
  const partial=new LspFrames(()=>{});partial.push(Buffer.from('Content-Length: 2\r\n\r\n{'));assert.throws(()=>partial.end(),/Incomplete/);
});
test('gopls resolves generic imports, references and CRLF rename without merging a shadow',async t=>{
  const root=await fixture(t);
  const phases:{query:string;phase:string;elapsed_ms:number}[]=[];
  const observe=(query:string)=>(phase:string,elapsed_ms:number)=>{phases.push({query,phase,elapsed_ms});};
  t.after(()=>{t.diagnostic('Go query phase timings: '+JSON.stringify(phases));});
  const definition=await navigateGo({path:root,file:'app.go',action:'definition',line:6,column:app.split('\n')[5]!.indexOf('Double')+1},[root],undefined,undefined,observe('definition'));
  assert.equal(definition.project.language_server.name,'gopls');
  assert.ok(definition.results.some(item=>item.file==='math/math.go'&&item.line===4));
  const references=await navigateGo({path:root,file:'math/math.go',action:'references',line:4,column:6},[root],undefined,undefined,observe('references'));
  assert.deepEqual(references.results.map(item=>item.file+':'+item.line).sort(),['app.go:6','math/math.go:4']);
  const preview=await navigateGo({path:root,file:'math/math.go',action:'rename_preview',line:4,column:6,new_name:'Scale'},[root],undefined,undefined,observe('rename'));
  assert.equal(preview.total,2);assert.equal(preview.edits!.length,2);
  for(const edit of preview.edits!)assert.ok(edit.replacements.every(item=>item.old_text==='Double'&&item.new_text==='Scale'));
  assert.ok(preview.edits!.every(edit=>edit.replacements.every(item=>item.line!==7)));
  assert.equal(await readFile(join(root,'math/math.go'),'utf8'),source);
});
test('gopls completes type diagnostics and returns captured standard-library definitions read-only',async t=>{
  const root=await fixture(t,{'bad.go':'package app\nvar Wrong string = 3\n','broken.go':'package app\nfunc Broken( {\n'});
  const diagnostics=await navigateGo({path:root,action:'diagnostics'},[root]);
  assert.equal(diagnostics.project.diagnostics_complete,true);
  assert.ok(diagnostics.results.some(item=>item.file==='bad.go'&&item.severity==='error'&&/cannot use 3/.test(String(item.message))),JSON.stringify(diagnostics.results));
  assert.ok(diagnostics.results.some(item=>item.file==='broken.go'&&item.severity==='error'&&/expected/.test(String(item.message))),JSON.stringify(diagnostics.results));
  const definition=await navigateGo({path:root,file:'app.go',action:'definition',line:6,column:app.split('\n')[5]!.indexOf('Println')+1},[root]);
  assert.ok(definition.results.some(item=>String(item.file).startsWith('go:src/fmt/')&&item.read_only===true),JSON.stringify(definition.results));
});
test('Go environment recheck detects config drift before reuse',async t=>{
  const root=await fixture(t);let captured:GoProject|undefined;
  await navigateGo({path:root,file:'math/math.go',action:'outline'},[root],project=>{captured=project;});
  await writeFile(join(root,'go.mod'),'module example.test/changed\n\ngo 1.26.0\n');
  await assert.rejects(verifyGoEnvironment(captured!),/changed|bound/);
});
test('Go cached toolchain corruption is refused before any helper launch and a fresh inspection recovers',async t=>{
  const root=await fixture(t);let captured:GoProject|undefined;
  await navigateGo({path:root,file:'math/math.go',action:'outline'},[root],project=>{captured=project;});
  const originalVersion=join(captured!.trees[1]!.root,'VERSION'),cachedVersion=join(captured!.trees[1]!.destination,'VERSION');
  const original=await readFile(originalVersion);
  await writeFile(cachedVersion,'corrupt cached VERSION\n');
  let launches=0;
  await assert.rejects(runGoAnalysis({path:root,file:'math/math.go',action:'outline'},[root],{onLaunched(){launches++;}}),/changed|bound/);
  assert.equal(launches,0);assert.deepEqual(await readFile(originalVersion),original);
  const next=await navigateGo({path:root,file:'math/math.go',action:'outline'},[root]);
  assert.ok(next.results.some(item=>item.name==='Counter'));
});
test('Go owned jobs stop on cancellation and the next query can proceed',async t=>{
  const root=await fixture(t),controller=new AbortController();const handles:{pid:number;creation:string}[]=[];
  const query=runGoAnalysis({path:root,file:'math/math.go',action:'outline'},[root],{signal:controller.signal,onLaunched(pid,creation){handles.push({pid,creation});controller.abort();}});
  await assert.rejects(query,/cancelled/);assert.equal(handles.length,1);
  assert.notEqual(windowsProcessIdentity(handles[0]!.pid),handles[0]!.creation);
  const next=await navigateGo({path:root,file:'math/math.go',action:'outline'},[root]);
  assert.ok(next.results.some(item=>item.name==='Counter'));
});
test('Go MCP routing and durable rename preserve exact receipts and BOM/CRLF bytes',async t=>{
  const root=await fixture(t,{'math/math.go':'\uFEFF'+source}),state=await mkdtemp(join(await realpath(tmpdir()),'forge-go-state-'));
  const engine=new DurableTasks(state),batches=new TaskFileBatches(engine);
  t.after(async()=>{engine.close();assert.equal(await realpath(state),state);await rm(state,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(root,'go','Go durable rename',['echo verified'],true);
  let handler:any;
  const target={registerTool:(_name:string,_definition:unknown,callback:unknown)=>{handler=callback;}} as unknown as McpRegistrationTarget;
  registerCodeNavigation(target,[root]);
  const response=await handler({path:root,action:'symbols',query:'Double'},{signal:new AbortController().signal});
  assert.equal(response.isError,undefined,JSON.stringify(response));
  assert.equal(JSON.parse(response.content[0].text).project.language,'go');
  const input={task_id:task.task_id,operation_id:'go-rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'math/math.go',line:4,column:6,new_name:'Scale'};
  const result=await renameTask(engine,batches,input,[root]);assert.equal(result.state,'completed');
  const content=await readFile(join(root,'math/math.go'),'utf8');
  assert.equal(content,'\uFEFF'+source.replace('func Double','func Scale'));
  assert.equal(await readFile(join(root,'app.go'),'utf8'),app.replace('math.Double','math.Scale'));
  const fingerprint=snapshot(root).fingerprint,controller=new AbortController();controller.abort();
  assert.deepEqual(await renameTask(engine,batches,input,[root],controller.signal),result);
  assert.equal(snapshot(root).fingerprint,fingerprint);assert.equal(engine.status(task.task_id).operations.length,1);
});
test('Go workspaces resolve and rename across original local modules',async t=>{
  const root=await fixture(t,{'go.work':'go 1.26.0\nuse (\n .\n ./lib\n)\n','go.mod':'module example.test/forge\ngo 1.26.0\nrequire example.test/lib v0.0.0\n',
    'lib/go.mod':'module example.test/lib\ngo 1.26.0\n','lib/value.go':'package lib\nfunc Value() int { return 42 }\n','app.go':'package app\nimport "example.test/lib"\nfunc Run() int { return lib.Value() }\n'});
  const preview=await navigateGo({path:root,file:'lib/value.go',action:'rename_preview',line:2,column:6,new_name:'Result'},[root]);
  assert.equal(preview.total,2);assert.deepEqual(preview.edits!.map(edit=>edit.file).sort(),['app.go','lib/value.go']);
});
test('Go installed test dependencies are captured and return original module locations read-only',async t=>{
  const root=await fixture(t,{'go.mod':'module example.test/forge\ngo 1.26.0\nrequire github.com/google/go-cmp v0.7.0\n',
    'go.sum':'github.com/google/go-cmp v0.7.0 h1:wk8382ETsv4JYUZwIsn6YpYiWiBsYLSJiTsyBybVuN8=\ngithub.com/google/go-cmp v0.7.0/go.mod h1:pXiqmnSA92OHEEa9HXL2W4E7lf9JzCmGVUdgjX3N/iU=\n',
    'compare_test.go':'package app\nimport "github.com/google/go-cmp/cmp"\nfunc Compare() bool { return cmp.Equal(1, 1) }\n'});
  const result=await navigateGo({path:root,file:'compare_test.go',action:'definition',line:3,column:'func Compare() bool { return cmp.Equal(1, 1) }'.indexOf('Equal')+1},[root]);
  assert.equal(result.project.environment.installed_modules,1);
  assert.ok(result.results.some(item=>String(item.file).startsWith('go-module:github.com/google/go-cmp@v0.7.0/cmp/')&&item.read_only===true),JSON.stringify(result.results));
});
test('Go refuses external local replacements and linked sources without executing them',async t=>{
  const root=await fixture(t,{'go.mod':'module example.test/forge\ngo 1.26.0\nrequire example.test/external v0.0.0\nreplace example.test/external => ../external\n'});
  await assert.rejects(navigateGo({path:root,file:'app.go',action:'outline'},[root]),/outside the captured project/);
  const link=join(root,'linked'),outside=await mkdtemp(join(await realpath(tmpdir()),'forge-go-external-'));
  t.after(async()=>{assert.equal(await realpath(outside),outside);await rm(outside,{recursive:true,force:true});});
  await symlink(outside,link,'junction');
  try {await assert.rejects(navigateGo({path:root,file:'app.go',action:'outline'},[root]),/refuses links/);}
  finally {await unlink(link);}
});
test('Go queue deadlines include waiting and overflow/cancellation return no capture or partial success',async t=>{
  const root=await fixture(t),active=new AbortController();let captured=0,launched=0;
  const input={path:root,file:'app.go',action:'outline' as const};
  const started=runGoAnalysis(input,[root],{signal:active.signal,onCaptured(){captured++;},onLaunched(){launched++;}});
  const waiting=Array.from({length:8},()=>runGoAnalysis(input,[root],{timeoutMs:30,onCaptured(){captured++;},onLaunched(){launched++;}}));
  const overflow=runGoAnalysis(input,[root]);
  const settled=Promise.allSettled([started,...waiting,overflow]);
  setTimeout(()=>active.abort(),80);
  const results=await settled;
  assert.ok(results.every(item=>item.status==='rejected'));
  assert.match(String((results[0] as PromiseRejectedResult).reason),/cancelled/);
  for(const result of results.slice(1,9))assert.match(String((result as PromiseRejectedResult).reason),/timed out in queued after \d+ ms \(\d+ ms total\)/);
  assert.match(String((results[9] as PromiseRejectedResult).reason),/queue is full/);
  assert.equal(captured,0);assert.equal(launched,0);
});
