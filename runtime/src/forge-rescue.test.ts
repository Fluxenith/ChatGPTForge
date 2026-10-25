import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ForgeRescue,acquireRescueLock,type ComponentId,type RescueHooks} from './forge-rescue.js';

function fake(initial:Record<ComponentId,boolean>,recovers:Partial<Record<ComponentId,'heals'|'fails'|'throws-but-heals'>>){
  const health={...initial},calls:ComponentId[]=[];let clock=1_000_000;
  const hooks:RescueHooks={
    now:()=>clock,sleep:async()=>{},
    probe:async id=>({healthy:health[id],detail:id+(health[id]?' ok':' down')}),
    recover:async id=>{calls.push(id);const mode=recovers[id]??'fails';if(mode!=='fails')health[id]=true;return mode==='throws-but-heals'?{ok:false,detail:'exit 1'}:{ok:mode==='heals',detail:''};},
  };
  return {hooks,calls,health,advance:(ms:number)=>{clock+=ms;}};
}

test('rescue never touches healthy components and recovers in dependency order',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-rescue-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const ok=fake({skills:true,forge:true,tunnel:true},{});
  const quiet=await new ForgeRescue(ok.hooks,{stateDir:dir,components:['skills','forge','tunnel']}).tick();
  assert.deepEqual(ok.calls,[]);assert.equal(quiet.receipts.length,0);
  const down=fake({skills:true,forge:false,tunnel:false},{forge:'heals',tunnel:'heals'});
  const pass=await new ForgeRescue(down.hooks,{stateDir:dir,components:['skills','forge','tunnel']}).tick();
  assert.deepEqual(down.calls,['forge','tunnel']);
  assert.deepEqual(pass.receipts.map(r=>[r.component,r.result,r.observed]),[['forge','recovered','forge down'],['tunnel','recovered','tunnel down']]);
  assert.equal(readFileSync(join(dir,'rescue','receipts.jsonl'),'utf8').trim().split('\n').length,2);
});

test('rescue waits for a failed dependency, honours backoff and the attempt budget, and trusts post-state',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-rescue-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fake({skills:true,forge:false,tunnel:false},{forge:'fails'});
  const rescue=new ForgeRescue(f.hooks,{stateDir:dir,components:['forge','tunnel'],maxAttempts:2,backoffMs:[0,60_000],cooldownMs:10*60_000});
  let r=await rescue.tick();
  assert.deepEqual(f.calls,['forge']);assert.equal(r.receipts[0]!.result,'failed');assert.equal(r.status.tunnel!.detail,'waiting for forge');
  r=await rescue.tick();assert.deepEqual(f.calls,['forge']);assert.equal(r.receipts[0]!.action,'skipped_cooldown');
  f.advance(61_000);r=await rescue.tick();assert.deepEqual(f.calls,['forge','forge']);
  f.advance(61_000);r=await rescue.tick();assert.equal(r.receipts[0]!.action,'budget_exhausted');assert.equal(f.calls.length,2);
  f.advance(11*60_000);r=await rescue.tick();assert.equal(f.calls.length,3);
  // A script that exits non-zero while the component is healthy afterwards is recovered.
  const g=fake({skills:true,forge:false,tunnel:true},{forge:'throws-but-heals'});
  const healed=await new ForgeRescue(g.hooks,{stateDir:dir,components:['forge']}).tick();
  assert.equal(healed.receipts[0]!.result,'recovered');assert.match(healed.receipts[0]!.detail,/script failed/);
});

test('only one rescue supervisor owns recovery',t=>{
  const dir=mkdtempSync(join(tmpdir(),'forge-rescue-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const release=acquireRescueLock(dir);
  assert.throws(()=>acquireRescueLock(dir),/Another rescue supervisor/);
  release();const again=acquireRescueLock(dir);again();
});
