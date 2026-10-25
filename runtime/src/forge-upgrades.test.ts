import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {upgradeComponent,type UpgradeAdapter,type UpgradeHooks} from './forge-upgrades.js';

function fixture(t:test.TestContext,acceptance:()=>Promise<{ok:boolean;detail:string}>,digest:(data:Buffer)=>string|null=d=>'sha256:'+createHash('sha256').update(d).digest('hex'),served=Buffer.from('new release bytes')){
  const root=mkdtempSync(join(tmpdir(),'forge-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5}));
  const resourceDir=join(root,'LuaLanguageServer');mkdirSync(join(resourceDir,'lua'),{recursive:true});writeFileSync(join(resourceDir,'lua','version.txt'),'3.15.0');
  const lockPath=join(root,'languages-lock.json');writeFileSync(lockPath,JSON.stringify({languages:{lua:{state:'installed',resource_dirs:{LuaLanguageServer:{sha256:'old'}}}}},null,2));
  const urls:string[]=[];
  const hooks:UpgradeHooks={
    fetchJson:async url=>{urls.push(url);return {assets:[{name:'lua-language-server-3.19.2-win32-x64.zip',browser_download_url:'https://github.com/LuaLS/lua-language-server/releases/download/3.19.2/lua-language-server-3.19.2-win32-x64.zip',digest:digest(Buffer.from('new release bytes'))}]};},
    download:async url=>{urls.push(url);return served;},
    extract:async(_zip,into)=>{mkdirSync(into,{recursive:true});writeFileSync(join(into,'version.txt'),'3.19.2');},
    treeDigest:async dir=>({sha256:createHash('sha256').update(readFileSync(join(dir,'lua','version.txt'))).digest('hex'),files:1,bytes:6}),
  };
  const adapter:UpgradeAdapter={id:'serena-lua',asset:v=>({repo:'LuaLS/lua-language-server',tag:v,name:`lua-language-server-${v}-win32-x64.zip`}),resourceDir,lockLanguage:'lua',acceptance};
  const config={enabled:true,autoRepair:false,checkIntervalHours:24,allowUpgrade:true};
  return {root,resourceDir,lockPath,urls,run:(c=config)=>upgradeComponent('serena-lua','3.19.2',{config:c,adapter,hooks,lockPath,receipts:join(root,'upgrades.jsonl')}),hooks,receipts:()=>readFileSync(join(root,'upgrades.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l).step as string)};
}
const version=(dir:string)=>readFileSync(join(dir,'lua','version.txt'),'utf8');

test('upgrades are off by default and refuse unverifiable or tampered downloads without touching the install',async t=>{
  const f=fixture(t,async()=>({ok:true,detail:'ok'}));
  await assert.rejects(f.run({enabled:true,autoRepair:false,checkIntervalHours:24,allowUpgrade:false}),/upgrades are off/);
  const noDigest=fixture(t,async()=>({ok:true,detail:'ok'}),()=>null);
  await assert.rejects(noDigest.run(),/publishes no SHA-256/);assert.equal(version(noDigest.resourceDir),'3.15.0');
  const tampered=fixture(t,async()=>({ok:true,detail:'ok'}),undefined,Buffer.from('tampered bytes'));
  await assert.rejects(tampered.run(),/does not match the official SHA-256/);assert.equal(version(tampered.resourceDir),'3.15.0');
  assert.deepEqual(tampered.receipts(),['started','refused']);
  assert.ok(tampered.urls.every(u=>u.startsWith('https://api.github.com/repos/LuaLS/')||u.startsWith('https://github.com/LuaLS/')));
});

test('a verified upgrade is kept only when the real acceptance passes; otherwise install and pin roll back exactly',async t=>{
  const good=fixture(t,async()=>({ok:true,detail:'cross-file rename files: calc.lua,main.lua'}));
  const kept=await good.run();
  assert.equal(kept.state,'upgraded');assert.equal(version(good.resourceDir),'3.19.2');
  const lock=JSON.parse(readFileSync(good.lockPath,'utf8'));assert.equal(lock.languages.lua.version,'3.19.2');assert.notEqual(lock.languages.lua.resource_dirs.LuaLanguageServer.sha256,'old');
  assert.ok(kept.previous&&existsSync(kept.previous),'previous install kept for manual rollback');
  assert.deepEqual(good.receipts(),['started','verified','swapped','kept']);
  const bad=fixture(t,async()=>({ok:false,detail:'Serena rename plan omits referenced file main.lua'}));
  const lockBefore=readFileSync(bad.lockPath,'utf8');
  const rolled=await bad.run();
  assert.equal(rolled.state,'rolled_back');assert.match(String(rolled.reason),/omits referenced file/);
  assert.equal(version(bad.resourceDir),'3.15.0','previous install restored');
  assert.equal(readFileSync(bad.lockPath,'utf8'),lockBefore,'pin restored exactly');
  assert.ok(!existsSync(bad.resourceDir+'.upgrade-3.19.2'));
  assert.deepEqual(bad.receipts(),['started','verified','swapped','rolled_back']);
});


test('post-swap hashing failure restores the original installation and pin',async t=>{
  const f=fixture(t,async()=>({ok:true,detail:'unused'}));
  const before=readFileSync(f.lockPath,'utf8');
  f.hooks.treeDigest=async()=>{throw new Error('injected tree failure');};
  const result=await f.run();
  assert.equal(result.state,'rolled_back');
  assert.equal(version(f.resourceDir),'3.15.0');
  assert.equal(readFileSync(f.lockPath,'utf8'),before);
  assert.equal(f.receipts().at(-1),'rolled_back');
});
test('malformed lock after swap restores installation and exact lock bytes',async t=>{
  const f=fixture(t,async()=>({ok:true,detail:'unused'}));
  writeFileSync(f.lockPath,'invalid json');
  assert.equal((await f.run()).state,'rolled_back');
  assert.equal(version(f.resourceDir),'3.15.0');
  assert.equal(readFileSync(f.lockPath,'utf8'),'invalid json');
});
