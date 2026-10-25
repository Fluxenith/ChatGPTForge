import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from './config.js';
import { SqliteOAuthStore } from './oauth-store.js';
import { createServer } from './server.js';
import { writeTestDevspaceConfig } from './test-support/config.test.js';
import { SerenaBridge, serenaRelativePath } from './serena-bridge.js';

test('Serena tool paths are confined to one project', () => {
  const root = join(tmpdir(), 'forge-serena-boundary');
  assert.equal(serenaRelativePath('src\\hello.py', root), 'src/hello.py');
  assert.equal(serenaRelativePath('.', root), '.');
  assert.equal(serenaRelativePath('', root), '');
  for (const invalid of ['../outside.py', 'src/../../outside', 'src//outside', 'C:\\outside.py', '\\\\server\\file', '/tmp/file']) {
    assert.throws(() => serenaRelativePath(invalid, root), /Serena/);
  }
});

test('Serena discards failed RPC sessions without retaining a broken project slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-serena-timeout-'));
  await writeFile(join(root, 'sample.py'), 'answer = 42\n');
  const bridge = new SerenaBridge([root]);
  const project = await (bridge as unknown as { project(path: string): Promise<string> }).project(root);
  const sessions = (bridge as unknown as { sessions: Map<string, Promise<unknown>> }).sessions;
  let clientCloses = 0;
  let transportCloses = 0;
  sessions.set(project, Promise.resolve({
    client: {
      callTool: async () => { throw new Error('Request timed out'); },
      close: async () => { clientCloses++; },
    },
    transport: { close: async () => { transportCloses++; } },
    tools: new Set(['get_symbols_overview']),
    lastUsed: Date.now(),
  }));
  try {
    await assert.rejects(
      bridge.invoke(root, 'get_symbols_overview', { relative_path: 'sample.py' }),
      /timed out after 90s.*session was closed/i,
    );
    assert.equal(sessions.has(project), false);
    assert.equal(clientCloses, 1);
    assert.equal(transportCloses, 1);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Serena preserves a healthy session after a backend tool-level error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-serena-semantic-error-'));
  await writeFile(join(root, 'sample.py'), 'answer = 42\n');
  const bridge = new SerenaBridge([root]);
  const project = await (bridge as unknown as { project(path: string): Promise<string> }).project(root);
  const sessions = (bridge as unknown as { sessions: Map<string, Promise<unknown>> }).sessions;
  let closes = 0;
  sessions.set(project, Promise.resolve({
    client: {
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'invalid search' }] }),
      close: async () => { closes++; },
    },
    transport: { close: async () => {} },
    tools: new Set(['get_symbols_overview']),
    lastUsed: Date.now(),
  }));
  try {
    await assert.rejects(
      bridge.invoke(root, 'get_symbols_overview', { relative_path: 'sample.py' }),
      /invalid search/,
    );
    assert.equal(sessions.has(project), true);
    assert.equal(closes, 0);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Serena reuses project slots by evicting the oldest idle server, never a running query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-serena-rotation-'));
  const folders = ['one', 'two', 'three', 'four'].map(name => join(root, name));
  for (const folder of folders) {
    await mkdir(folder);
    await writeFile(join(folder, 'sample.py'), 'answer = 1\n');
  }
  const bridge = new SerenaBridge([root]);
  const internal = bridge as unknown as {
    project(path: string): Promise<string>;
    start(project: string): Promise<unknown>;
    sessions: Map<string, Promise<unknown>>;
  };
  const paths = await Promise.all(folders.map(folder => internal.project(folder)));
  const clientsClosed: string[] = [];
  const transportsClosed: string[] = [];
  let entered!: () => void;
  let release!: () => void;
  const activeEntered = new Promise<void>(resolve => { entered = resolve; });
  const activeRelease = new Promise<void>(resolve => { release = resolve; });
  const session = (name: string, lastUsed: number) => ({
    client: {
      callTool: async () => {
        if (name === 'one') { entered(); await activeRelease; }
        return { content: [{ type: 'text', text: name }] };
      },
      close: async () => { clientsClosed.push(name); },
    },
    transport: { close: async () => { transportsClosed.push(name); } },
    tools: new Set(['get_symbols_overview']),
    lastUsed,
  });
  internal.sessions.set(paths[0]!, Promise.resolve(session('one', Date.now() - 40_000)));
  internal.sessions.set(paths[1]!, Promise.resolve(session('two', Date.now() - 30_000)));
  internal.sessions.set(paths[2]!, Promise.resolve(session('three', Date.now() - 10_000)));
  let started = 0;
  internal.start = async project => {
    assert.equal(project, paths[3]);
    started++;
    return session('four', Date.now());
  };
  try {
    const pending = bridge.invoke(folders[0]!, 'get_symbols_overview', { relative_path: 'sample.py' });
    await activeEntered;
    assert.equal(await bridge.invoke(folders[3]!, 'get_symbols_overview', { relative_path: 'sample.py' }), 'four');
    assert.equal(started, 1);
    assert.deepEqual(clientsClosed, ['two']);
    assert.deepEqual(transportsClosed, ['two']);
    assert.equal(internal.sessions.has(paths[0]!), true);
    assert.equal(internal.sessions.has(paths[1]!), false);
    assert.equal(internal.sessions.size, 3);
    release();
    assert.equal(await pending, 'one');
  } finally {
    release();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(clientsClosed.slice().sort(), ['one', 'two', 'three', 'four'].sort());
  assert.deepEqual(transportsClosed.slice().sort(), ['one', 'two', 'three', 'four'].sort());
});

test('Serena rejects fourth project only when every existing server is busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-serena-busy-'));
  const folders = ['one', 'two', 'three', 'four'].map(name => join(root, name));
  for (const folder of folders) {
    await mkdir(folder);
    await writeFile(join(folder, 'sample.py'), 'answer = 1\n');
  }
  const bridge = new SerenaBridge([root]);
  const internal = bridge as unknown as {
    project(path: string): Promise<string>;
    sessions: Map<string, Promise<unknown>>;
    activeRequests: Map<string, number>;
  };
  const paths = await Promise.all(folders.map(folder => internal.project(folder)));
  for (const project of paths.slice(0, 3)) {
    internal.sessions.set(project, Promise.resolve({
      client: { close: async () => {} },
      transport: { close: async () => {} },
      tools: new Set(['get_symbols_overview']),
      lastUsed: 1,
    }));
    internal.activeRequests.set(project, 1);
  }
  try {
    await assert.rejects(
      bridge.invoke(folders[3]!, 'get_symbols_overview', { relative_path: 'sample.py' }),
      /all project sessions are busy/,
    );
    assert.equal(internal.sessions.size, 3);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Serena actually indexes and navigates a Python project', {
  skip: process.env.FORGE_SERENA_LIVE !== '1',
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-serena-live-'));
  const source = 'def double(value: int) -> int:\n    return value * 2\n\nresult = double(21)\n';
  await writeFile(join(root, 'sample.py'), source);
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "forge-serena-live"\nversion = "0.1.0"\n');
  const bridge = new SerenaBridge([root]);
  try {
    await assert.rejects(
      bridge.invoke(join(root, '..'), 'find_symbol', { name_path_pattern: 'double' }),
      /outside allowed roots/i,
    );
    const outline = await bridge.invoke(root, 'get_symbols_overview', { relative_path: 'sample.py' });
    assert.match(outline, /double/);
    const symbol = await bridge.invoke(root, 'find_symbol', {
      name_path_pattern: 'double', relative_path: 'sample.py', include_body: true, max_matches: 5,
    });
    assert.match(symbol, /value \* 2/);
    const references = await bridge.invoke(root, 'find_referencing_symbols', {
      name_path: 'double', relative_path: 'sample.py',
    });
    assert.match(references, /double/);
    assert.equal(await readFile(join(root, 'sample.py'), 'utf8'), source);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated Forge MCP forwards approved symbol queries to the real Serena backend', {
  skip: process.env.FORGE_SERENA_LIVE !== '1',
  timeout: 180_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-serena-http-'));
  const project = join(root, 'approved-project');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(project);
  const source = 'class Example:\n    def total(self, number: int) -> int:\n        return number + 8\n';
  await writeFile(join(project, 'module.py'), source);
  const config = loadConfig(writeTestDevspaceConfig(join(root, 'config'), {
    server: { publicBaseUrl: 'https://forge.example.com' },
    storage: { stateDir: join(root, 'state') },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, 'worktrees') },
    ui: { enabled: false }, skills: { enabled: false }, logging: { level: 'silent' },
  }));
  const token = randomBytes(32).toString('base64url');
  const store = new SqliteOAuthStore(config.stateDir);
  const registered = store.registerClient({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }, config.oauth.allowedRedirectHosts);
  store.saveAccessToken(createHash('sha256').update(token).digest('base64url'), {
    clientId: registered.client_id, scopes: ['devspace'],
    expiresAt: Math.floor(Date.now() / 1000) + 120, resource: 'https://forge.example.com/mcp',
  });
  store.close();
  const runtime = createServer(config);
  const listener = runtime.app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'serena-http-live', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await runtime.close();
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal((await fetch(endpoint)).status, 401);
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(item => item.name === 'serena_find_symbol'));
  const result = await client.callTool({ name: 'serena_find_symbol', arguments: {
    path: project, name_path_pattern: 'Example/total', relative_path: 'module.py', include_body: true,
  } }, undefined, { timeout: 120_000 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /number \+ 8/);
  const denied = await client.callTool({ name: 'serena_find_symbol', arguments: {
    path: root, name_path_pattern: 'Example', relative_path: 'module.py',
  } });
  assert.equal(denied.isError, true);
  assert.equal(await readFile(join(project, 'module.py'), 'utf8'), source);
});
