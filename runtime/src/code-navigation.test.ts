import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { navigateCode } from './code-navigation.js';

test('semantic navigation follows imported alias, excludes shadowed names and refreshes after edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-nav-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'math.ts'), 'export function double(n: number) { return n * 2; }');
  const caller = "import { double as twice } from './math';\ntwice(4);\nfunction other(twice: (n:number)=>number) { return twice(5); }";
  await writeFile(join(root, 'caller.ts'), caller);
  const base = { path: root, files: ['math.ts', 'caller.ts'], file: 'caller.ts', line: 2, column: 2 };
  const definition = await navigateCode({ ...base, action: 'definition' }, [root]);
  assert.equal((definition.results[0] as {file:string}).file, 'math.ts');
  const refs = await navigateCode({ ...base, action: 'references' }, [root]);
  assert.ok(refs.results.length >= 2);
  assert.ok(!refs.results.some(r => (r as {line:number}).line === 3));
  const outline = await navigateCode({ ...base, action: 'outline' }, [root]);
  assert.ok(outline.results.some(r => (r as {name:string}).name === 'other'));
  await writeFile(join(root, 'caller.ts'), caller.replace('twice(4)', 'twice(9)'));
  const fresh = await navigateCode({ ...base, action: 'references' }, [root]);
  assert.notDeepEqual(refs.snapshots, fresh.snapshots);
  await assert.rejects(navigateCode({ ...base, action: 'definition', line: 99 }, [root]), /Line outside/);
});

test('navigation rejects escapes, junctions, oversized files and does not resolve unselected imports', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'forge-nav-boundary-'));
  t.after(async () => {
    await unlink(join(root, 'link'));
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const root = join(parent, 'project'); const outside = join(parent, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;');
  await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const base = { path: root, file: 'main.ts', action: 'outline' as const };
  for (const file of ['../outside/secret.ts', 'link/secret.ts']) {
    await assert.rejects(navigateCode({ ...base, files: [file], file }, [root]), /outside allowed roots/);
  }
  await writeFile(join(root, 'huge.ts'), 'x'.repeat(512 * 1024 + 1));
  await assert.rejects(navigateCode({ ...base, files: ['huge.ts'], file: 'huge.ts' }, [root]), /512 KiB/);
  await writeFile(join(root, 'main.ts'), "import { secret } from '../outside/secret';\nsecret;");
  const result = await navigateCode({ ...base, files: ['main.ts'], action: 'definition', line: 2, column: 2 }, [root]);
  assert.ok(result.results.every(r => (r as {file:string}).file === 'main.ts'));
  assert.equal(result.snapshots.length, 1);
});
