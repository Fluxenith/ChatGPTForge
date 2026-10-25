import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createServer as tcpServer,connect} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrowserNetwork} from './forge-browser-network.js';
import {chromium} from 'playwright-core';
import {randomInt,createHash} from 'node:crypto';

test('owned browser network forwards permitted HTTP bytes and rejects before contacting an ungranted origin',async t=>{
  let hits=0;const origin=createServer((req,res)=>{hits++;assert.equal(req.headers['proxy-authorization'],undefined);res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.from([0,1,255]));});origin.listen(0,'127.0.0.1');await once(origin,'listening');const url='http://127.0.0.1:'+(origin.address() as any).port;
  let granted=true;const guard=await createBrowserNetwork(target=>granted&&new URL(target).origin===url);
  t.after(async()=>{await guard.close();origin.closeAllConnections();await new Promise<void>(r=>origin.close(()=>r()));});
  const send=()=>new Promise<{status:number,bytes:Buffer}>((resolve,reject)=>{const r=request(guard.proxy.server,{path:url+'/file',headers:{'proxy-authorization':'fixture-only'}},response=>{const chunks:Buffer[]=[];response.on('data',b=>chunks.push(b));response.on('end',()=>resolve({status:response.statusCode!,bytes:Buffer.concat(chunks)}));});r.on('error',reject);r.end();});
  assert.deepEqual(await send(),{status:200,bytes:Buffer.from([0,1,255])});assert.equal(hits,1);granted=false;assert.equal((await send()).status,403);assert.equal(hits,1);
});

test('TLS tunnel checks its HTTPS origin, preserves raw bytes and closes on revoked grants',async t=>{
  let hits=0;const sockets=new Set<any>(),origin=tcpServer(socket=>{hits++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('data',b=>socket.write(b));});origin.listen(0,'127.0.0.1');await once(origin,'listening');const authority='127.0.0.1:'+(origin.address() as any).port;
  let granted=false;const guard=await createBrowserNetwork(url=>granted&&new URL(url).origin==='https://'+authority);
  t.after(async()=>{await guard.close();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>origin.close(()=>r()));});
  const connectProxy=async()=>{const proxy=new URL(guard.proxy.server),socket=connect(Number(proxy.port),proxy.hostname);await once(socket,'connect');socket.write('CONNECT '+authority+' HTTP/1.1\r\nHost: '+authority+'\r\n\r\n');const [headers]=await once(socket,'data');return {socket,headers:headers.toString()};};
  let connection=await connectProxy();assert.match(connection.headers,/403/);connection.socket.destroy();assert.equal(hits,0);
  granted=true;connection=await connectProxy();assert.match(connection.headers,/200/);connection.socket.write(Buffer.from([0x16,1,2,255]));assert.deepEqual((await once(connection.socket,'data'))[0],Buffer.from([0x16,1,2,255]));assert.equal(hits,1);
  const closed=once(connection.socket,'close');granted=false;connection.socket.write('revoked');await closed;assert.equal(hits,1);
});

test('closing one owned proxy leaves another context connection usable',async t=>{
  const origin=createServer((_req,res)=>res.end('owned'));origin.listen(0,'127.0.0.1');await once(origin,'listening');const url='http://127.0.0.1:'+(origin.address() as any).port;
  const first=await createBrowserNetwork(target=>new URL(target).origin===url),second=await createBrowserNetwork(target=>new URL(target).origin===url);
  t.after(async()=>{await second.close();origin.closeAllConnections();await new Promise<void>(r=>origin.close(()=>r()));});
  const send=(proxy:string)=>new Promise<string>((resolve,reject)=>{const r=request(proxy,{path:url},response=>{let body='';response.on('data',b=>body+=b);response.on('end',()=>resolve(body));});r.on('error',reject);r.end();});
  assert.equal(await send(first.proxy.server),'owned');assert.equal(await send(second.proxy.server),'owned');await first.close();await delay(10);assert.equal(await send(second.proxy.server),'owned');
});

test('native Chrome WebSocket upgrades preserve messages and enforce origin revocation',async t=>{
  const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><body>Owned socket fixture</body>');}),sockets=new Set<any>();let upgrades=0,messages=0;
  site.on('upgrade',(req,socket,head)=>{
    upgrades++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let pending=head;const consume=(chunk:Buffer)=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=6){const size=pending[1]&127;if(size>125)throw Error('Fixture only accepts short frames');if(pending.length<size+6)return;const mask=pending.subarray(2,6),payload=Buffer.from(pending.subarray(6,size+6)),opcode=pending[0]&15;for(let i=0;i<size;i++)payload[i]^=mask[i%4];pending=pending.subarray(size+6);if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}assert.equal(opcode,1);messages++;socket.write(Buffer.concat([Buffer.from([0x81,size]),payload]));}};socket.on('data',consume);if(head.length)consume(Buffer.alloc(0));
  });
  for(let i=0;i<50;i++){site.listen(randomInt(49152,65535),'127.0.0.1');try{await once(site,'listening');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error;}}
  const origin='http://127.0.0.1:'+(site.address() as any).port,checked:string[]=[];let granted=true;const guard=await createBrowserNetwork(url=>{checked.push(url);return granted&&new URL(url).origin===origin;}),browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await guard.close();for(const socket of sockets)socket.destroy();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));});
  const context=await browser.newContext({proxy:guard.proxy}),page=await context.newPage();await page.goto(origin);
  let first:string;try{first=await page.evaluate(url=>new Promise<string>((resolve,reject)=>{const ws=new WebSocket(url);(window as any).ownedWS=ws;ws.onopen=()=>ws.send('你好 socket');ws.onerror=()=>reject(Error('Socket failed'));ws.onmessage=event=>resolve(event.data);}),origin.replace('http:','ws:')+'/echo');}catch(error){throw Error(String(error)+' checked='+JSON.stringify(checked)+' upgrades='+upgrades);}assert.equal(first,'你好 socket');assert.equal(upgrades,1);assert.equal(messages,1);
  granted=false;const closed=await page.evaluate(()=>new Promise<boolean>(resolve=>{const ws=(window as any).ownedWS as WebSocket;ws.onclose=()=>resolve(true);ws.send('revoked');}));assert.equal(closed,true);assert.equal(messages,1);
  const denied=await page.evaluate(url=>new Promise<boolean>(resolve=>{const ws=new WebSocket(url);ws.onerror=()=>resolve(true);ws.onopen=()=>resolve(false);}),origin.replace('http:','ws:')+'/echo');assert.equal(denied,true);assert.equal(upgrades,1);
});

test('HTTP-only authority cannot open a TLS upstream through CONNECT',async t=>{
  let hits=0;const origin=tcpServer(socket=>{hits++;socket.destroy();});origin.listen(0,'127.0.0.1');await once(origin,'listening');const authority='127.0.0.1:'+(origin.address() as any).port,guard=await createBrowserNetwork(url=>new URL(url).origin==='http://'+authority);
  t.after(async()=>{await guard.close();await new Promise<void>(r=>origin.close(()=>r()));});
  const proxy=new URL(guard.proxy.server),socket=connect(Number(proxy.port),proxy.hostname);await once(socket,'connect');socket.write('CONNECT '+authority+' HTTP/1.1\r\nHost: '+authority+'\r\n\r\n');assert.match((await once(socket,'data'))[0].toString(),/200/);const closed=once(socket,'close');socket.write(Buffer.from([0x16,3,3,0,1,0]));await closed;assert.equal(hits,0);
});
