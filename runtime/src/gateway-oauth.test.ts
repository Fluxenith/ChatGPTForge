import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GatewayOAuth} from './gateway-oauth.js';
test('OAuth credentials are bound to gateway endpoint and issuer data survives reload',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-oauth-provider-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config={port:8773,origins:['https://login.example.test']};
  const p=new GatewayOAuth('example','https://mcp.example.test/mcp',config,undefined,root);
  p.saveCodeVerifier('verifier');assert.equal(p.codeVerifier(),'verifier');
  p.saveTokens({access_token:'fixture-only',token_type:'Bearer',issuer:'https://login.example.test'});
  const restored=new GatewayOAuth('example','https://mcp.example.test/mcp',config,undefined,root);
  assert.equal(restored.tokens()?.issuer,'https://login.example.test');
  assert.throws(()=>restored.codeVerifier(),/missing/);
  assert.throws(()=>new GatewayOAuth('example','https://other.example.test/mcp',config,undefined,root),/endpoint changed/);
  restored.invalidateCredentials('tokens');assert.equal(restored.tokens(),undefined);
});
test('OAuth rejects unapproved destinations before sending a request',async t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-oauth-origin-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const p=new GatewayOAuth('example','https://mcp.example.test/mcp',{port:8773,origins:[]},undefined,root);
  await assert.rejects(p.fetch('https://other.example.test/token'),/outside configured/);
  await assert.rejects(p.fetch('http://mcp.example.test/token'),/outside configured/);
  assert.throws(()=>p.redirectToAuthorization(new URL('https://mcp.example.test/auth')),/needs local login/);
});
