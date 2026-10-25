import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyLanguageTree,writeLanguagePin} from './language-pin-transaction.js';

test('copy failure removes only its own tree and preserves existing destinations',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-pin-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),target=join(root,'target');mkdirSync(source);writeFileSync(join(source,'server'),'valid');
  const pin={sha256:'expected',files:1,bytes:5};
  await assert.rejects(copyLanguageTree(source,target,pin,async()=>({...pin,sha256:'changed'})),/differs/);
  assert.equal(existsSync(target),false);
  mkdirSync(target);writeFileSync(join(target,'owner'),'keep');
  await assert.rejects(copyLanguageTree(source,target,pin,async()=>pin),/EEXIST/);
  assert.equal(readFileSync(join(target,'owner'),'utf8'),'keep');
});

test('pin publication and verified copy succeed without stale temporary files',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-pin-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),target=join(root,'target');mkdirSync(source);writeFileSync(join(source,'server'),'valid');
  const pin={sha256:'expected',files:1,bytes:5};
  await copyLanguageTree(source,target,pin,async path=>{assert.equal(readFileSync(join(path,'server'),'utf8'),'valid');return pin;});
  const path=join(root,'lock.json');writeLanguagePin(path,{old:true});writeLanguagePin(path,{pin});
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),{pin});
  assert.equal(readdirSync(root).some(n=>n.endsWith('.new')),false);
  const directory=join(root,'not-a-file');mkdirSync(directory);
  assert.throws(()=>writeLanguagePin(directory,{pin}));
  assert.equal(readdirSync(root).some(n=>n.endsWith('.new')),false);
});
