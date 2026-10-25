import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {GoToolchainCache} from './go-toolchain-cache.js';

async function fixture(t: any) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'forge-go-cache-test-'));
  for (const [file, value] of Object.entries({'VERSION': 'go1.26.2\n', 'src/fmt/print.go': 'package fmt\n', 'bin/go.exe': 'test bytes; never executed'})) {
    await mkdir(dirname(join(root, file)), {recursive: true});
    await writeFile(join(root, file), value);
  }
  t.after(async () => {
    assert.equal(await realpath(root), root);
    await rm(root, {recursive: true, force: true});
  });
  return root;
}

test('Go toolchain concurrent leases share a complete copy and close waits for every user', async t => {
  const root = await fixture(t), cache = new GoToolchainCache();
  t.after(() => cache.close());
  const [first, second] = await Promise.all([cache.acquire(root, 'go1.26.2'), cache.acquire(root, 'go1.26.2')]);
  assert.equal(first.tree.destination, second.tree.destination);
  assert.equal(first.key, second.key);
  assert.deepEqual(first.tree.files.map(pin => pin.file), ['VERSION', 'bin/go.exe', 'src/fmt/print.go']);
  let closed = false;
  const closing = cache.close().then(() => { closed = true; });
  await assert.rejects(cache.acquire(root, 'go1.26.2'), /closed/);
  await first.release();
  assert.equal(closed, false);
  await access(second.tree.destination);
  await second.verifyCached();
  await second.release();
  await closing;
  await assert.rejects(access(dirname(first.tree.destination)), {code: 'ENOENT'});
  await second.release();
});

test('Go toolchain same-version source drift refuses stale reuse and the next inspection rebuilds', async t => {
  const root = await fixture(t), cache = new GoToolchainCache();
  t.after(() => cache.close());
  const first = await cache.acquire(root, 'go1.26.2');
  await first.release();
  await writeFile(join(root, 'src/fmt/print.go'), 'package fmt\nfunc Changed() {}\n');
  await assert.rejects(cache.acquire(root, 'go1.26.2'), /changed|bound/);
  await assert.rejects(access(first.tree.destination), {code: 'ENOENT'});
  const second = await cache.acquire(root, 'go1.26.2');
  assert.notEqual(second.key, first.key);
  assert.equal(await readFile(join(second.tree.destination, 'src/fmt/print.go'), 'utf8'), 'package fmt\nfunc Changed() {}\n');
  await second.release();
});

test('Go toolchain cache corruption retires its copy without deleting an outstanding lease', async t => {
  const root = await fixture(t), cache = new GoToolchainCache();
  t.after(() => cache.close());
  const first = await cache.acquire(root, 'go1.26.2');
  await writeFile(join(first.tree.destination, 'VERSION'), 'go1.26.9\n');
  await assert.rejects(cache.acquire(root, 'go1.26.2'), /changed/);
  await access(first.tree.destination);
  await assert.rejects(cache.acquire(root, 'go1.26.2'), /still in use/);
  await first.release();
  await assert.rejects(access(first.tree.destination), {code: 'ENOENT'});
  const next = await cache.acquire(root, 'go1.26.2');
  assert.equal(await readFile(join(next.tree.destination, 'VERSION'), 'utf8'), 'go1.26.2\n');
  assert.equal(await readFile(join(root, 'VERSION'), 'utf8'), 'go1.26.2\n');
  await next.release();
});

test('Go toolchain pre-cancelled acquisition rejects and installed version change replaces the key', async t => {
  const root = await fixture(t), cache = new GoToolchainCache(), abort = new AbortController();
  t.after(() => cache.close());
  abort.abort(new Error('cache request cancelled'));
  await assert.rejects(cache.acquire(root, 'go1.26.2', abort.signal), /cancelled/);
  const first = await cache.acquire(root, 'go1.26.2');
  await first.release();
  await writeFile(join(root, 'VERSION'), 'go1.26.3\n');
  await assert.rejects(cache.acquire(root, 'go1.26.2'), /version changed/);
  const second = await cache.acquire(root, 'go1.26.3');
  assert.notEqual(second.key, first.key);
  assert.notEqual(second.tree.destination, first.tree.destination);
  await assert.rejects(access(first.tree.destination), {code: 'ENOENT'});
  await second.release();
});

test('Go toolchain close refuses a replaced root, preserves the outside target and retries only its repaired own root', async t => {
  const root = await fixture(t), outside = await fixture(t), cache = new GoToolchainCache();
  const lease = await cache.acquire(root, 'go1.26.2');
  await lease.release();
  const owned = dirname(lease.tree.destination), saved = owned + '-saved';
  await rename(owned, saved);
  await symlink(outside, owned, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(cache.close(), /Refusing cleanup/);
    assert.equal(await readFile(join(outside, 'VERSION'), 'utf8'), 'go1.26.2\n');
  } finally {
    await unlink(owned);
    await rename(saved, owned);
    await cache.close();
  }
  await assert.rejects(access(owned), {code: 'ENOENT'});
});
