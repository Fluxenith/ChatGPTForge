import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows startup acceptance only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const label = process.argv[2] ?? 'startup-acceptance';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid report label');
const runRoot = join(root, 'artifacts', 'launcher-runs', randomUUID());
await mkdir(runRoot, { recursive: true });
const cli = join(root, 'runtime', 'dist', 'forge-cli.js');
const shell = join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const results = [];

async function guard() {
  const server = createServer();
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  return { port: server.address().port, close: () => new Promise(ok => server.close(ok)) };
}

async function run(file, args, env, timeout = 12000, requirePipeClose = false) {
  const started = Date.now();
  const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  try {
    const code = await new Promise((ok, no) => { child.once('error', no); child.once('exit', ok); });
    clearTimeout(timer);
    // Windows Start-Process descendants can inherit unused pipe handles after
    // their launcher exited. Observe exit, then allow a bounded output drain.
    let drainTimer;
    const pipesClosed = await Promise.race([closed.then(() => true), new Promise(resolve => { drainTimer = setTimeout(() => resolve(false), requirePipeClose ? 1500 : 50); })]);
    clearTimeout(drainTimer);
    if (requirePipeClose) assert.equal(pipesClosed, true, 'launcher exited but daemon retained its output pipe handles');
    return { code, timedOut, stdout, stderr, elapsed_ms: Date.now() - started };
  } finally { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); }
}

async function fixture(name, mcpPort, managerPort) {
  const base = join(runRoot, name);
  const project = join(base, '中文 專案');
  const state = join(base, 'state');
  await mkdir(project, { recursive: true });
  const env = { ...process.env, CHATGPTFORGE_CONFIG_DIR: state, CHATGPTFORGE_MANAGER_PORT: String(managerPort) };
  delete env.DEVSPACE_CONFIG_DIR;
  delete env.DEVSPACE_OAUTH_OWNER_TOKEN;
  const init = await run(process.execPath, [cli, 'init', '--workspace', project, '--public-url', 'https://startup-fixture.invalid', '--port', String(mcpPort)], env);
  assert.equal(init.code, 0, 'isolated init failed');
  return { base, state, env };
}

async function scenario(name, action) {
  try { await action(); results.push({ name, status: 'pass' }); console.log(`PASS: ${name}`); }
  catch (error) { results.push({ name, status: 'fail', reason: error.message }); console.log(`FAIL: ${name}: ${error.message}`); }
}

async function collision(name, occupied) {
  const mcp = await guard();
  const manager = await guard();
  const f = await fixture(name, mcp.port, manager.port);
  let mcpOpen = true, managerOpen = true;
  try {
    if (occupied === 'manager') { await mcp.close(); mcpOpen = false; }
    else { await manager.close(); managerOpen = false; }
    // Include cold module/SQLite initialization; readiness is still atomic.
    const result = await run(process.execPath, [cli, 'serve'], f.env, 20000);
    await writeFile(join(f.base, 'stdout.log'), result.stdout);
    await writeFile(join(f.base, 'stderr.log'), result.stderr);
    await writeFile(join(f.base, 'result.json'), JSON.stringify({ code: result.code, timedOut: result.timedOut, elapsed_ms: result.elapsed_ms, timeout_ms: 20000, bind_error_seen: /EADDRINUSE/.test(result.stderr) }));
    assert.equal(result.timedOut, false, `${occupied} collision left the coordinator running`);
    assert.notEqual(result.code, 0, `${occupied} collision was reported as success`);
    assert.match(result.stderr, /EADDRINUSE/, 'original bind error was not retained');
    const releasedPort = occupied === 'manager' ? mcp.port : manager.port;
    const probe = createServer();
    await new Promise((ok, no) => { probe.once('error', no); probe.listen(releasedPort, '127.0.0.1', ok); });
    await new Promise(ok => probe.close(ok));
  } finally {
    if (mcpOpen) await mcp.close();
    if (managerOpen) await manager.close();
  }
}

if (!process.argv.includes('--launcher-only')) {
  await scenario('manager-port-collision-exits-and-releases-mcp', () => collision('manager-collision', 'manager'));
  await scenario('mcp-port-collision-exits-and-releases-manager', () => collision('mcp-collision', 'mcp'));
}

if (!process.argv.includes('--collisions-only')) {
  const mcp = await guard(), manager = await guard();
  const f = await fixture('launcher', mcp.port, manager.port);
  await mcp.close(); await manager.close();
  const processPath = join(f.state, 'process.json'), managerPath = join(f.state, 'manager.json');
  let processReceipt, managerReceipt;
  const command = (name, args = []) => run(shell, ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', name), ...args], f.env, 45000, name === 'Start-Forge.ps1');
  const probe = () => command('Test-ForgeLocal.ps1', ['-StateDirectory', f.state]);
  const json = path => readFile(path, 'utf8').then(text => JSON.parse(text.replace(/^\uFEFF/, '')));
  const save = (path, value) => writeFile(path, JSON.stringify(value));
  try {
    await scenario('cold-start-and-authenticated-local-readiness', async () => {
      assert.equal((await command('Start-Forge.ps1')).code, 0, 'cold startup failed');
      processReceipt = await json(processPath); managerReceipt = await json(managerPath);
      assert.equal((await probe()).code, 0, 'authenticated readiness failed');
    });
    if (processReceipt && managerReceipt) {
      await scenario('repeat-start-reuses-process', async () => {
        assert.equal((await command('Start-Forge.ps1')).code, 0);
        const current = await json(processPath);
        assert.equal(current.pid, processReceipt.pid);
        assert.equal(current.startFileTime, processReceipt.startFileTime);
      });
      async function refuses(name, path, value, expected) {
        const original = await readFile(path);
        await scenario(name, async () => {
          try {
            await save(path, value);
            const result = await probe();
            assert.notEqual(result.code, 0, 'invalid receipt was accepted');
            assert.match(result.stderr, expected, 'unexpected refusal boundary');
          } finally { await writeFile(path, original); }
        });
      }
      await refuses('wrong-executable-rejected', processPath, { ...processReceipt, executable: join(f.base, 'wrong-node.exe') }, /process identity does not match/);
      await refuses('stale-manager-pid-rejected', managerPath, { ...managerReceipt, pid: 0 }, /Manager receipt does not belong/);
      const invalid = new URL(managerReceipt.url); invalid.hash = 'invalid-fixture-token';
      await refuses('invalid-manager-token-rejected', managerPath, { ...managerReceipt, url: invalid.href }, /manager authentication\/readiness check failed/);
      const foreign = await guard();
      try {
        const url = new URL(managerReceipt.url); url.port = String(foreign.port);
        await refuses('foreign-listener-owner-rejected', managerPath, { ...managerReceipt, url: url.href }, /does not own its expected local listener/);
      } finally { await foreign.close(); }
      await scenario('stop-and-restart-refreshes-manager-authentication', async () => {
        assert.equal((await command('Stop-Forge.ps1')).code, 0);
        assert.equal((await command('Start-Forge.ps1')).code, 0);
        const next = await json(processPath), nextManager = await json(managerPath);
        assert.notEqual(next.startFileTime, processReceipt.startFileTime);
        assert.notEqual(nextManager.url, managerReceipt.url);
        assert.equal((await probe()).code, 0);
        const old = new URL(managerReceipt.url);
        const response = await fetch(`${old.origin}/api/tasks`, { headers: { Authorization: `Bearer ${old.hash.slice(1)}` }, signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 401, 'old manager token survived restart');
      });
    }
  } finally {
    // Only this fixture's receipt is read by Stop-Forge; it verifies PID, creation and executable.
    const stopped = await command('Stop-Forge.ps1');
    assert.equal(stopped.code, 0, 'fixture cleanup could not verify/stop its owned coordinator');
  }
}

const report = { status: results.every(r => r.status === 'pass') ? 'pass' : 'fail', results, runRoot, scope: 'isolated Windows startup only; no production config, tunnel, model or claim call' };
await writeFile(join(root, 'artifacts', `${label}.json`), JSON.stringify(report, null, 2));
console.log(`Report: artifacts/${label}.json`);
if (report.status !== 'pass') process.exitCode = 1;
