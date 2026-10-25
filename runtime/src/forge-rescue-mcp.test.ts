import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {appendFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SqliteOAuthStore} from './oauth-store.js';
import {createRemoteRescueApp,redactLogText,remoteRescuePaths,setupRemoteRescue,REMOTE_RESCUE_SCOPE} from './forge-rescue-mcp.js';
import type {ComponentId} from './forge-rescue.js';

test('remote rescue line: own OAuth, narrow tools, redacted logs, receipts with replay and unknown never rerun',{timeout:60_000},async t=>{
  const stateDir=mkdtempSync(join(tmpdir(),'forge-rescue-remote-'));
  const setup=setupRemoteRescue(stateDir,'https://rescue.example.com:10000/ignored-path');
  assert.equal(setup.mcp_url,'https://rescue.example.com:10000/mcp');
  assert.ok(readFileSync(setup.owner_password_file,'utf8').trim().length>=24);
  const healthy:Record<ComponentId,boolean>={forge:false,tunnel:true,skills:true};
  const calls:string[]=[];
  const deps={stateDir,components:['forge','tunnel'] as ComponentId[],
    hooks:{now:()=>Date.now(),sleep:async()=>{},probe:async(id:ComponentId)=>({healthy:healthy[id],detail:id+(healthy[id]?' up':' down')}),
      recover:async(id:ComponentId)=>{calls.push('recover '+id);healthy[id]=true;return {ok:true,detail:'started'};}},
    restart:async(id:ComponentId)=>{calls.push('restart '+id);return {ok:true,detail:'restarted'};},
    status:()=>({time:'t',status:{forge:{healthy:healthy.forge,detail:'probe'}}})};
  const {app,close}=createRemoteRescueApp({enabled:true,port:0,publicBaseUrl:'https://rescue.example.com:10000'},deps);
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
  const url='http://127.0.0.1:'+(listener.address() as any).port+'/mcp';
  let client:Client|undefined;
  t.after(async()=>{await client?.close();listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));close();rmSync(stateDir,{recursive:true,force:true,maxRetries:10});});
  assert.equal((await fetch(url,{method:'POST'})).status,401,'no token, no access');
  // Access token issued by the rescue line's own OAuth store (not Forge's).
  const store=new SqliteOAuthStore(remoteRescuePaths(stateDir).oauth),token=randomBytes(32).toString('base64url');
  const owner=store.registerClient({redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']},['chatgpt.com']);
  store.saveAccessToken(createHash('sha256').update(token).digest('base64url'),{clientId:owner.client_id,scopes:[REMOTE_RESCUE_SCOPE],expiresAt:Math.floor(Date.now()/1000)+600,resource:'https://rescue.example.com:10000/mcp'});store.close();
  client=new Client({name:'rescue-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name).sort(),['rescue_logs','rescue_recover','rescue_restart','rescue_status']);
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await client!.callTool({name,arguments:args});return {error:!!r.isError,value:(r.content as {text:string}[])[0]!.text};};
  const status=JSON.parse((await call('rescue_status',{})).value);assert.deepEqual(status.managed,['forge','tunnel']);
  writeFileSync(join(stateDir,'stderr.log'),'boot ok\nAuthorization: Bearer abcdefghijklmnopqrstuv\naccess_token="sk-live-1234567890"\n');
  const logs=JSON.parse((await call('rescue_logs',{component:'forge',lines:10})).value);
  assert.ok(logs['stderr.log'].includes('boot ok'));assert.ok(!logs['stderr.log'].includes('abcdefghijklmnopqrstuv'));assert.ok(!logs['stderr.log'].includes('sk-live-1234567890'));
  const first=JSON.parse((await call('rescue_recover',{component:'forge',operation_id:'r1'})).value);
  assert.equal(first.healthy,true);assert.equal(first.before,'forge down');assert.deepEqual(calls,['recover forge']);
  assert.equal(JSON.parse((await call('rescue_recover',{component:'forge',operation_id:'r1'})).value).replayed,true);assert.equal(calls.length,1,'replay never reruns');
  const conflict=await call('rescue_restart',{component:'forge',operation_id:'r1'});assert.equal(conflict.error,true);assert.match(conflict.value,/different arguments/);
  const already=JSON.parse((await call('rescue_recover',{component:'tunnel',operation_id:'r2'})).value);assert.match(already.script,/ok/);assert.equal(calls.length,1,'healthy component is not touched');
  assert.match((await call('rescue_recover',{component:'skills',operation_id:'r3'})).value,/not managed/);
  appendFileSync(remoteRescuePaths(stateDir).operations,JSON.stringify({operation_id:'lost',action:'restart',component:'forge',state:'started',time:'x'})+'\n');
  const lost=JSON.parse((await call('rescue_restart',{component:'forge',operation_id:'lost'})).value);assert.equal(lost.state,'unknown');assert.equal(calls.length,1);
  assert.equal(JSON.parse((await call('rescue_restart',{component:'forge',operation_id:'r4'})).value).state,'completed');assert.deepEqual(calls,['recover forge','restart forge']);
});

test('log redaction removes bearer tokens, key-like assignments and long opaque values',()=>{
  const out=redactLogText('Bearer abc.def-ghi_jkl password: hunter2hunter2 id=short '+'x'.repeat(48));
  assert.ok(!out.includes('abc.def-ghi_jkl'));assert.ok(!out.includes('hunter2hunter2'));assert.ok(out.includes('id=short'));assert.ok(!out.includes('x'.repeat(48)));
});

test('outbound-only rescue route: second tunnel profile on loopback, no stored key, supervised restarts',async t=>{
  const {setupRescueTunnel,loadRemoteRescueConfig}=await import('./forge-rescue-mcp.js');
  const {superviseRescueTunnel}=await import('./forge-rescue.js');
  const stateDir=mkdtempSync(join(tmpdir(),'forge-rescue-tunnel-'));t.after(()=>rmSync(stateDir,{recursive:true,force:true,maxRetries:10}));
  assert.throws(()=>setupRescueTunnel(stateDir,'not-a-tunnel','file:C:/k.key'),/tunnel id/);
  assert.throws(()=>setupRescueTunnel(stateDir,'tunnel_abcdefgh12','sk-raw-key'),/never stored/);
  assert.equal(superviseRescueTunnel(stateDir,()=>{throw Error('must not start without a profile');}),false);
  const r=setupRescueTunnel(stateDir,'tunnel_abcdefgh12','file:C:/Users/x/rescue.key');
  assert.equal(r.inbound_ports,0);
  const profile=JSON.parse(readFileSync(r.profile_file,'utf8'));
  assert.deepEqual(profile.mcp.server_urls,[{channel:'main',url:'http://127.0.0.1:8771/mcp'}]);
  assert.equal(profile.harpoon.allow_plaintext_http,true);assert.equal(profile.harpoon.targets[0].url,'http://127.0.0.1:8771');
  assert.equal(profile.control_plane.api_key,'file:C:/Users/x/rescue.key');assert.equal(profile.control_plane.tunnel_id,'tunnel_abcdefgh12');
  assert.ok(!JSON.stringify(profile).includes('ts.net'),'no inbound Funnel route');
  assert.deepEqual(loadRemoteRescueConfig(stateDir),{enabled:true,port:8771,transport:'tunnel',publicBaseUrl:'http://127.0.0.1:8771'});
  let starts=0;const exits:((code:number|null)=>void)[]=[];
  assert.equal(superviseRescueTunnel(stateDir,()=>{starts++;return {once:(_e:'exit',cb:(code:number|null)=>void)=>{exits.push(cb);}};},20),true);
  assert.equal(starts,1);exits[0]!(1);await new Promise(r=>setTimeout(r,60));assert.equal(starts,2,'restarted after exit');
  assert.match(readFileSync(join(stateDir,'rescue','receipts.jsonl'),'utf8'),/rescue-tunnel/);
});
