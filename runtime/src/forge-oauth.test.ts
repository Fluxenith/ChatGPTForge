import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("OAuth discovery, owner approval, PKCE, one-use code and authenticated MCP", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "forge-oauth-")));
  const issuer = "https://forge.example.com";
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: issuer }, storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] }, logging: { level: "silent" },
    oauth: { scopes: ["chatgptforge"], allowedResourceUrls:["https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_00000000000000000000000000000000"] },
  }));
  const runtime = createServer(config);
  runtime.projectBindings.seen('existing-general','ChatGPT');
  const setup=await runtime.pluginSetup.prepare('Forge OAuth project',root);
  assert.equal((await runtime.pluginSetup.prepare('Forge OAuth project',root)).id,setup.id);
  runtime.pluginSetup.queue(setup.id);
  assert.equal(runtime.pluginSetup.take()?.id,setup.id);
  runtime.pluginSetup.queue(setup.id);
  assert.equal(runtime.pluginSetup.take(),null,'opening job must not be duplicated');
  runtime.pluginSetup.report(setup.id,'blocked','fixture timeout');
  runtime.pluginSetup.queue(setup.id);
  assert.equal(runtime.pluginSetup.take()?.id,setup.id,'explicit retry recovers blocked form');
  runtime.pluginSetup.report(setup.id,'ready','fixture ready');
  runtime.pluginSetup.queue(setup.id);
  assert.equal(runtime.pluginSetup.take(),null,'ready form must not be duplicated');

  const {gunzipSync}=await import('node:zlib');const archive=gunzipSync(runtime.pluginSetup.archive(setup.id).bytes).toString();assert.match(archive,/tunnel_00000000000000000000000000000000/);assert.ok(!archive.includes(config.oauth.ownerToken));
  await assert.rejects(runtime.pluginSetup.activate('existing-general',setup.id),/已使用/);

  const listener = runtime.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await runtime.close();
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(5000),
  }).catch(error=>{throw new Error(`Local OAuth fixture port ${address.port}: ${String(error.cause??error)}`,{cause:error});});
  const unauthenticated = await request("/mcp");
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate")!, /oauth-protected-resource\/mcp/);
  const resource = await (await request("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(resource.resource, `${issuer}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${issuer}/`]);
  const metadata = await (await request("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.issuer, `${issuer}/`);
  assert.equal(metadata.registration_endpoint, `${issuer}/register`);
  const redirect = "https://chatgpt.com/connector/oauth/forge-test";
  const registration = await request("/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Forge acceptance", redirect_uris: [redirect],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const parameters = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
    response_type: "code", scope: "chatgptforge", state: "fixture-state", resource: `${issuer}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const page = await request(`/authorize?${parameters}`);
  assert.equal(page.status, 200);
  const markup=await page.text();assert.match(markup,/Authorize ChatGPTForge/);assert.ok(!markup.includes("Forge OAuth project"),"Pending projects are private before owner verification");
  const wrong = new URLSearchParams(parameters);
  wrong.set("owner_token", "wrong-password");wrong.set("forge_setup",setup.id);
  assert.equal((await request("/authorize", { method: "POST", body: wrong })).status, 401);
  assert.equal(runtime.pluginSetup.list()[0]!.client_id,null);
  const approved = new URLSearchParams(parameters);approved.set("forge_setup",setup.id);
  approved.set("owner_token", config.oauth.ownerToken);
  const projectConfirmation = await request("/authorize", { method: "POST", body: approved });assert.equal(projectConfirmation.status,200);
  const confirmedHtml=await projectConfirmation.text();assert.match(confirmedHtml,/Forge OAuth project/);
  const confirmToken=confirmedHtml.match(/name="forge_owner_approval" value="([^"]+)"/)![1]!;
  approved.delete('owner_token');approved.set('forge_owner_approval',confirmToken);
  const approval = await request("/authorize", { method: "POST", body: approved });
  assert.equal(approval.status, 302);
  const context=await runtime.projectBindings.withClient(client.client_id,()=>runtime.projectBindings.context());assert.equal(context.connection_name,'Forge OAuth project');assert.equal(context.project_path,setup.root);
  assert.equal(runtime.projectBindings.list().find(r=>r.client_id==='existing-general')!.root,null);
  assert.deepEqual(runtime.pluginSetup.pending(client.client_id),[]);
  await assert.rejects(runtime.pluginSetup.activate('second-client',setup.id),/已使用/);

  const callback = new URL(approval.headers.get("location")!);
  assert.equal(callback.origin + callback.pathname, redirect);
  assert.equal(callback.searchParams.get("state"), "fixture-state");
  const exchange = new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id,
    redirect_uri: redirect, code: callback.searchParams.get("code")!, code_verifier: verifier, resource: `${issuer}/mcp` });
  const invalid = new URLSearchParams(exchange);
  invalid.set("code_verifier", randomBytes(32).toString("base64url"));
  assert.equal((await request("/token", { method: "POST", body: invalid })).status, 400);
  const tokenResponse = await request("/token", { method: "POST", body: exchange });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.equal((await request("/token", { method: "POST", body: exchange })).status, 400);
  const initialized = await request("/mcp", { method: "POST", headers: {
    Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "forge-oauth-test", version: "1" },
  } }) });
  assert.equal(initialized.status, 200);
  assert.match(await initialized.text(), /chatgptforge/);
});
