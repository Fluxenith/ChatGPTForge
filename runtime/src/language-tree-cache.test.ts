import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cacheLanguageTrees,repairLanguageTrees} from './language-tree-cache.js';

test('repair restores exact pins, retains damaged trees, and refuses incomplete cache before swapping',async t=>{
  const home=mkdtempSync(join(tmpdir(),'forge-repair-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'language_servers','static');mkdirSync(root,{recursive:true});
  const digest=async(path:string)=>{const b=readFileSync(join(path,'server'));return {sha256:createHash('sha256').update(b).digest('hex'),files:1,bytes:b.length};};
  const resource_dirs:Record<string,Awaited<ReturnType<typeof digest>>>={};
  for(const name of ['A','B']){const path=join(root,name);mkdirSync(path);writeFileSync(join(path,'server'),name);resource_dirs[name]=await digest(path);}
  const lockPath=join(home,'lock.json');writeFileSync(lockPath,JSON.stringify({languages:{example:{state:'installed',resource_dirs}}}));
  const options={home,lockPath,cache:join(home,'cache'),digest};
  await cacheLanguageTrees(options);
  writeFileSync(join(root,'A','server'),'broken-a');writeFileSync(join(root,'B','server'),'broken-b');
  const cachedB=join(options.cache,resource_dirs.B!.sha256,'server');writeFileSync(cachedB,'bad-cache');
  await assert.rejects(repairLanguageTrees(options),/No verified cache/);
  assert.equal(readFileSync(join(root,'A','server'),'utf8'),'broken-a');
  assert.equal(existsSync(lockPath+'.install.lock'),false);
  writeFileSync(cachedB,'B');
  const result=await repairLanguageTrees(options);assert.deepEqual(result.repaired,['A','B']);
  assert.equal(readFileSync(join(root,'A','server'),'utf8'),'A');assert.equal(readFileSync(join(root,'B','server'),'utf8'),'B');
  assert.equal(readFileSync(join(result.previous[0]!,'server'),'utf8'),'broken-a');
  assert.deepEqual((await repairLanguageTrees(options)).repaired,[]);
});
