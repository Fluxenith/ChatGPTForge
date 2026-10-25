import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('CLI refuses an upgrade while updates are off with a clean message, exit code 1, and exits promptly',{timeout:60_000},t=>{
  const home=mkdtempSync(join(tmpdir(),'forge-cli-exit-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const cli=fileURLToPath(new URL('./forge-cli.ts',import.meta.url));
  const started=Date.now();
  const r=spawnSync(process.execPath,['--import','tsx',cli,'components','upgrade','serena-lua','--version','3.19.2'],
    {cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,USERPROFILE:home,HOME:home,CHATGPTFORGE_CONFIG_DIR:join(home,'.chatgptforge')},encoding:'utf8',timeout:45_000});
  const elapsed=Date.now()-started;
  assert.equal(r.error,undefined,String(r.error));
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/Component upgrades are off/);
  assert.doesNotMatch(r.stderr,/\n\s+at /,'no stack trace for a refusal');
  assert.ok(elapsed<30_000,'took '+elapsed+' ms');
});
