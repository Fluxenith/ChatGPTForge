import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {runCodeAnalysis} from './code-analysis-runtime.js';
import {analyzeCode} from './code-navigation.js';

test('real Forge analysis keeps the parent responsive while compiler work is still running',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  let capture!:()=>void;const captured=new Promise<void>(resolve=>{capture=resolve;});
  let finished=false;
  const query={path:root,action:'diagnostics' as const};
  const analysis=(process.env.FORGE_ANALYSIS_INLINE
    ? analyzeCode(query,[root],capture).then(result=>({result}))
    : runCodeAnalysis(query,[root],false,{onCaptured:capture})).finally(()=>{finished=true;});
  await Promise.race([captured,analysis.then(()=>{throw new Error('Missing capture phase');})]);
  const tick=Date.now();await delay(50);
  const responsive=!finished&&Date.now()-tick<5000;
  const reply=await analysis;
  assert.equal(responsive,true,'parent timer must run during compiler analysis, before its result');
  assert.deepEqual(reply.result.results,[]);
  assert.ok(reply.result.snapshots.length>=168);
  assert.ok(reply.result.project.environment.files>512);
  assert.ok(reply.result.project.environment.bytes>16*1024*1024);
});

test('cancelled, timed-out and overloaded analysis leaves source intact and releases worker capacity',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-analysis-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source='export const unchanged=1;';await writeFile(join(root,'main.ts'),source);
  const input={path:root,files:['main.ts'],action:'symbols' as const,query:'unchanged'};
  await assert.rejects(runCodeAnalysis(input,[root],false,{timeoutMs:1}),/timed out/);
  const controllers=Array.from({length:10},()=>new AbortController());
  const waiting=controllers.map(controller=>runCodeAnalysis(input,[root],false,{signal:controller.signal}));
  const outcomes=Promise.allSettled(waiting);for(const controller of controllers)controller.abort();
  const settled=await outcomes;
  assert.equal(settled.filter(value=>value.status==='rejected'&&/queue is full/.test(String(value.reason))).length,1);
  assert.equal(settled.filter(value=>value.status==='rejected'&&/cancelled/.test(String(value.reason))).length,9);
  const reply=await runCodeAnalysis(input,[root]);
  assert.ok(reply.result.results.some(value=>(value as {name:string}).name==='unchanged'));
  assert.equal(await readFile(join(root,'main.ts'),'utf8'),source);
});
