import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compatibleComponentVersion,componentTree,rollbackManaged} from './managed-components.js';
import {managedRelease,type ManagedRelease} from './managed-component-state.js';

test('component compatibility excludes unreviewed major releases and moving git refs',()=>{
  assert.ok(compatibleComponentVersion('playwright','0.0.83'));assert.ok(compatibleComponentVersion('windows-mcp','0.8.8'));
  assert.equal(compatibleComponentVersion('serena','2.0.0'),false);assert.equal(compatibleComponentVersion('playwright','0.1.0'),false);
  assert.equal(compatibleComponentVersion('skills-manager','main'),false);assert.throws(()=>compatibleComponentVersion('model-provider','1.0.0'));
});
test('rollback verifies the previous tree and never activates a tampered release',async t=>{
  const config=mkdtempSync(join(tmpdir(),'forge-managed-test-')),old=process.env.CHATGPTFORGE_CONFIG_DIR;
  process.env.CHATGPTFORGE_CONFIG_DIR=config;t.after(()=>{if(old===undefined)delete process.env.CHATGPTFORGE_CONFIG_DIR;else process.env.CHATGPTFORGE_CONFIG_DIR=old;rmSync(config,{recursive:true,force:true});});
  const home=join(config,'components','managed'),a=join(home,'releases','a'),b=join(home,'releases','b');
  for(const root of [a,b]){mkdirSync(root,{recursive:true});writeFileSync(join(root,'entry.js'),root);}
  const release=(root:string):ManagedRelease=>({id:'playwright',version:'0.0.83',root,command:process.execPath,args:[],tree:componentTree(root),tools:['browser_snapshot'],created:'fixture'});
  const previous=release(a),current=release(b),state=join(home,'state.json');writeFileSync(state,JSON.stringify({version:1,active:{playwright:current},history:{playwright:[previous]}}));
  writeFileSync(join(a,'entry.js'),'tampered');const before=readFileSync(state,'utf8');
  await assert.rejects(rollbackManaged('playwright'),/differs/);assert.equal(readFileSync(state,'utf8'),before);
  writeFileSync(join(a,'entry.js'),a);assert.equal((await rollbackManaged('playwright')).root,a);
  assert.equal(managedRelease('playwright')?.root,a);
  const invalid=JSON.parse(readFileSync(state,'utf8'));invalid.active.playwright.root=config;writeFileSync(state,JSON.stringify(invalid));
  assert.throws(()=>managedRelease('playwright'),/outside/);
});
