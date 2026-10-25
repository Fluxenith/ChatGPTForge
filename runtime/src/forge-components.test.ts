import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installComponent,verifyComponents} from './forge-components.js';

test('component verification reports a missing private JDT LS and offline install refuses unpinned sources',{timeout:300_000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-components-'));
  const saved=process.env.FORGE_SERENA_JAVA_DIR;
  t.after(()=>{if(saved===undefined)delete process.env.FORGE_SERENA_JAVA_DIR;else process.env.FORGE_SERENA_JAVA_DIR=saved;rmSync(dir,{recursive:true,force:true});});
  process.env.FORGE_SERENA_JAVA_DIR=join(dir,'absent');
  const report=await verifyComponents();
  const java=report.components.find(c=>c.id==='serena-jdtls')!;
  assert.equal(java.state,'missing');assert.equal(report.ok,false);
  for(const id of ['gopls','python-vendor'])assert.equal(report.components.find(c=>c.id===id)!.state,'verified');
  await assert.rejects(installComponent('gopls',dir),/Offline install is supported for serena-jdtls/);
  writeFileSync(join(dir,'package.json'),JSON.stringify({publisher:'someone',name:'java',version:'0.0.1'}));
  await assert.rejects(installComponent('serena-jdtls',dir),/Unexpected vscode-java extension/);
});
