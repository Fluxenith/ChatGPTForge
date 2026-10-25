export type ConnectionCheck = { name: string; ok: boolean; detail: string };

/** Transport readiness, not a substitute for a real ChatGPT tool invocation. */
export async function diagnoseConnection(
  localOrigin: string, publicOrigin: string, request: typeof fetch = fetch,
): Promise<{ ok: boolean; checks: ConnectionCheck[] }> {
  const checks: ConnectionCheck[] = [];
  const expectedResource = new URL('/mcp', publicOrigin).href;
  const expectedMetadata = new URL('/.well-known/oauth-protected-resource/mcp', publicOrigin).href;
  const issuer = new URL(publicOrigin).href;
  const probe = async (name: string, run: () => Promise<void>) => {
    try { await run(); checks.push({ name, ok: true, detail: 'passed' }); }
    catch (error) {
      const e = error as Error & { cause?: { code?: string } };
      checks.push({ name, ok: false, detail: e.cause?.code ?? e.message ?? String(error) });
    }
  };
  const get = (url: string) => request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  const challenge = async (origin: string) => {
    const response = await get(new URL('/mcp', origin).href);
    if (response.status !== 401) throw Error(`Expected unauthenticated 401, received ${response.status}`);
    const metadata = /resource_metadata="([^"]+)"/.exec(response.headers.get('www-authenticate') ?? '')?.[1];
    if (metadata !== expectedMetadata) throw Error('Bearer challenge metadata URL does not match configured issuer');
  };
  await probe('local_mcp_auth', () => challenge(localOrigin));
  await probe('public_mcp_auth', () => challenge(publicOrigin));
  await probe('public_resource_metadata', async () => {
    const response = await get(expectedMetadata);
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const body = await response.json() as { resource?: string; authorization_servers?: string[] };
    if (body.resource !== expectedResource || !body.authorization_servers?.includes(issuer)) throw Error('Resource or authorization server mismatch');
  });
  await probe('public_oauth_metadata', async () => {
    const response = await get(new URL('/.well-known/oauth-authorization-server', publicOrigin).href);
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const body = await response.json() as { issuer?: string; code_challenge_methods_supported?: string[] };
    if (!body.issuer || new URL(body.issuer).href !== issuer) throw Error('OAuth issuer mismatch');
    if (!body.code_challenge_methods_supported?.includes('S256')) throw Error('OAuth PKCE S256 is missing');
  });
  return { ok: checks.every(check => check.ok), checks };
}
