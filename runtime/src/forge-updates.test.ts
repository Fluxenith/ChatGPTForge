import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkUpdates,officialSources,repairComponents,loadUpdateConfig,saveUpdateConfig,type RepairHooks} from './forge-updates.js';
import type {ComponentReport} from './forge-components.js';

test('update check reads official metadata only and reports newer versions without installing',async()=>{
  const urls:string[]=[];
  const fake=async(url:string)=>{urls.push(url);
    if(url.includes('registry.npmjs.org'))return {version:'9.9.9',dist:{integrity:'sha512-abc',tarball:'https://registry.npmjs.org/pyright/-/pyright-9.9.9.tgz'}};
    if(url.includes('pypi.org'))return {info:{version:'1.7.0'},urls:[{packagetype:'bdist_wheel',digests:{sha256:'f'.repeat(64)},url:'https://files.pythonhosted.org/x.whl'}]};
    if(url.includes('proxy.golang.org'))return {Version:'v0.99.0'};
    if(url.includes('LuaLS'))throw Error('rate limited');
    return {tag_name:'19.1.2',html_url:'https://github.com/clangd/clangd/releases/tag/19.1.2'};};
  const report=await checkUpdates(officialSources(fake));
  const by=Object.fromEntries(report.components.map(c=>[c.id,c]));
  assert.equal(by.pyright!.update_available,true);assert.equal(by.pyright!.official_digest,'sha512-abc');
  assert.equal(by.serena!.update_available,false);assert.equal(by.serena!.official_digest,'sha256:'+'f'.repeat(64));
  assert.equal(by.gopls!.update_available,true);assert.equal(by['serena-clangd']!.update_available,false);
  assert.match(String(by['serena-lua']!.error),/rate limited/);
  assert.ok(urls.every(u=>/^https:\/\/(registry\.npmjs\.org|pypi\.org|proxy\.golang\.org|api\.github\.com)\//.test(u)),'official sources only');
  assert.match(report.note,/nothing was downloaded/);
});

test('repair is off by default; when on it reinstalls only damaged pinned components and accepts them only if verification passes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-updates-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  assert.deepEqual(loadUpdateConfig(dir),{enabled:false,autoRepair:false,checkIntervalHours:24,allowUpgrade:false});
  const receipts=join(dir,'components','receipts.jsonl');
  const state:Record<string,ComponentReport['state']>={gopls:'verified','serena-languages':'mismatch',serena:'missing'};
  const calls:string[]=[];
  const hooks:RepairHooks={
    verify:async()=>({components:Object.entries(state).map(([id,s])=>({id,pinned:'p',state:s,detail:s,checked:0}))}),
    reinstall:async id=>{calls.push('reinstall '+id);if(id==='serena-languages')state[id]='verified';return {ok:true,detail:'reinstalled pinned version'};},
    quarantine:async id=>{calls.push('quarantine '+id);return '/moved/'+id;},
  };
  await assert.rejects(repairComponents(loadUpdateConfig(dir),hooks,receipts),/updates are off/);
  assert.deepEqual(calls,[]);
  saveUpdateConfig({enabled:true,autoRepair:false,checkIntervalHours:24,allowUpgrade:false},dir);
  const result=await repairComponents(loadUpdateConfig(dir),hooks,receipts);
  assert.deepEqual(calls,['reinstall serena-languages','reinstall serena','quarantine serena'],'healthy gopls untouched; a reinstall that still fails verification is moved aside');
  assert.deepEqual(result.receipts.map(r=>[r.id,r.state]),[['serena-languages','repaired'],['serena','failed']]);
  const lines=readFileSync(receipts,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.deepEqual(lines.map(l=>l.state),['started','repaired','started','failed'],'intent is written before each reinstall');
  calls.length=0;
  const only=await repairComponents(loadUpdateConfig(dir),hooks,receipts,'gopls');
  assert.equal(only.checked,0);assert.deepEqual(calls,[]);
});
