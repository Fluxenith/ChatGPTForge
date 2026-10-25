import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseConnection } from './forge-doctor.js';

const origin = 'https://forge.example:8443';
const fixture: typeof fetch = async input => {
  const u = new URL(String(input));
  if (u.pathname === '/mcp') return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
  if (u.pathname.includes('oauth-protected-resource')) return Response.json({ resource: origin + '/mcp', authorization_servers: [origin + '/'] });
  return Response.json({ issuer: origin, code_challenge_methods_supported: ['S256'] });
};
test('connection diagnosis checks both auth boundaries, resource identity and PKCE', async () => {
  const result = await diagnoseConnection('http://127.0.0.1:8767', origin, fixture);
  assert.equal(result.ok, true); assert.equal(result.checks.length, 4);
  const publicBypass: typeof fetch = async (input, init) => String(input) === origin + '/mcp' ? new Response('unprotected') : fixture(input, init);
  const bad = await diagnoseConnection('http://127.0.0.1:8767', origin, publicBypass);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find(c => c.name === 'public_mcp_auth')?.ok, false);
});
test('public DNS failure preserves local result and reports all failed layers without crashing', async () => {
  const broken: typeof fetch = async (input, init) => {
    if (String(input).startsWith(origin)) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    return fixture(input, init);
  };
  const result = await diagnoseConnection('http://127.0.0.1:8767', origin, broken);
  assert.equal(result.ok, false); assert.equal(result.checks[0]?.ok, true);
  assert.equal(result.checks.filter(c => c.detail === 'ENOTFOUND').length, 3);
});
test('metadata mismatch and missing PKCE fail independently', async () => {
  const bad: typeof fetch = async (input, init) => {
    if (String(input).includes('oauth-protected-resource')) return Response.json({ resource: origin + '/wrong', authorization_servers: [origin + '/'] });
    if (String(input).includes('oauth-authorization-server')) return Response.json({ issuer: origin });
    return fixture(input, init);
  };
  const result = await diagnoseConnection('http://127.0.0.1:8767', origin, bad);
  assert.equal(result.ok, false);
  assert.equal(result.checks.filter(c => !c.ok).length, 2);
});
