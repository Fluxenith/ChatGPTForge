import {createServer,request as httpRequest,Agent,type IncomingMessage,type IncomingHttpHeaders} from 'node:http';
import {connect,type Socket} from 'node:net';
import {once} from 'node:events';

// Chromium native downloads do not consistently pass through page Fetch
// interception. This owned context proxy enforces the same origin grants
// before HTTP forwarding or a TLS tunnel, including native downloads.
export async function createBrowserNetwork(permitted:(url:string)=>boolean){
  const sockets=new Set<Socket>();
  const agent=new Agent({keepAlive:true,maxSockets:64,maxTotalSockets:128});
  const track=(socket:Socket)=>{if(sockets.has(socket))return;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});};
  const target=(request:IncomingMessage,upgrade=false)=>{const url=new URL(request.url!);if(upgrade&&url.protocol==='ws:')url.protocol='http:';if(url.protocol!=='http:'||url.username||url.password||!permitted(url.href))throw Error('Origin not granted');return url;};
  const headers=(request:IncomingMessage,url:URL)=>{const h:IncomingHttpHeaders={...request.headers,host:url.host};delete h['proxy-authorization'];delete h['proxy-connection'];return h;};
  const server=createServer((request,response)=>{
    let url:URL;try{url=target(request);}catch{response.writeHead(403);response.end('Origin not granted');return;}
    const upstream=httpRequest(url,{agent,method:request.method,headers:headers(request,url)},incoming=>{if(!permitted(url.href)){incoming.destroy();response.destroy();return;}response.writeHead(incoming.statusCode??502,incoming.headers);incoming.on('data',()=>{if(!permitted(url.href)){incoming.destroy();response.destroy();}});incoming.pipe(response);});
    upstream.on('socket',socket=>track(socket));upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});request.on('data',()=>{if(!permitted(url.href)){upstream.destroy();request.destroy();}});request.on('aborted',()=>upstream.destroy());response.on('close',()=>{if(!response.writableEnded)upstream.destroy();});request.pipe(upstream);
  });
  server.on('connection',socket=>{if(sockets.size>=128){socket.destroy();return;}track(socket);});
  const tunnel=(socket:Socket,upstream:Socket,url:string,head:Buffer)=>{
    track(upstream);
    const check=()=>{if(!permitted(url)){socket.destroy();upstream.destroy();}};
    socket.on('data',check);upstream.on('data',check);
    socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
    if(head.length&&permitted(url))upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
  };
  server.on('connect',(request,socket,head)=>{
    let secure:URL,plain:URL;
    try{if(!request.url||/[\s\/?#@]/.test(request.url))throw Error('Invalid authority');secure=new URL('https://'+request.url);plain=new URL('http://'+request.url);if(!permitted(secure.href)&&!permitted(plain.href))throw Error('Not granted');}catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    // Chrome also uses CONNECT for cleartext WebSocket. Do not interpret an
    // HTTP grant as HTTPS authority: inspect the bounded first handshake
    // before opening an upstream connection, then pin its actual scheme.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');let pending=Buffer.alloc(0),started=false;
    const timer=setTimeout(()=>socket.destroy(),5000);socket.once('close',()=>clearTimeout(timer));
    const classify=(chunk:Buffer)=>{
      if(started)return;pending=Buffer.concat([pending,chunk]);if(pending.length>16384){socket.destroy();return;}if(!pending.length)return;
      let url:URL,initial:Buffer;
      if(pending[0]===0x16){url=secure;initial=pending;}
      else{
        const end=pending.indexOf('\r\n\r\n');if(end<0)return;
        const lines=pending.subarray(0,end).toString('latin1').split('\r\n'),match=/^GET (\/[^ ]*) HTTP\/1\.1$/.exec(lines.shift()??''),headers=lines.map(line=>{const colon=line.indexOf(':');if(colon<1)throw Error('Invalid handshake header');return [line.slice(0,colon).toLowerCase(),line.slice(colon+1).trim()] as const;});
        const hosts=headers.filter(([key])=>key==='host');if(!match||match[1].startsWith('//')||hosts.length!==1||hosts[0][1].toLowerCase()!==plain.host.toLowerCase()||!headers.some(([key,value])=>key==='upgrade'&&value.toLowerCase()==='websocket')||!headers.some(([key,value])=>key==='connection'&&value.toLowerCase().split(/\s*,\s*/).includes('upgrade'))){socket.destroy();return;}
        url=new URL(match[1],plain);initial=Buffer.concat([Buffer.from('GET '+match[1]+' HTTP/1.1\r\n'+lines.filter(line=>!/^proxy-(authorization|connection):/i.test(line)).join('\r\n')+'\r\n\r\n','latin1'),pending.subarray(end+4)]);
      }
      if(!permitted(url.href)){socket.destroy();return;}started=true;clearTimeout(timer);socket.removeListener('data',receive);socket.pause();
      const upstream=connect({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(request.url!.match(/:(\d+)$/)?.[1]??443)});track(upstream);
      upstream.once('connect',()=>{if(!permitted(url.href)){socket.destroy();upstream.destroy();return;}tunnel(socket as Socket,upstream,url.href,initial);socket.resume();});upstream.on('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());
    };
    const receive=(chunk:Buffer)=>{try{classify(chunk);}catch{socket.destroy();}};socket.on('data',receive);if(head.length)receive(head);
  });
  server.on('upgrade',(request,socket,head)=>{
    let url:URL;try{url=target(request,true);}catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const upstream=httpRequest(url,{agent,method:request.method,headers:headers(request,url)});
    upstream.on('upgrade',(response,remote,remoteHead)=>{if(!permitted(url.href)){socket.destroy();remote.destroy();return;}socket.write('HTTP/1.1 '+response.statusCode+' Switching Protocols\r\n'+Object.entries(response.headers).map(([key,value])=>key+': '+(Array.isArray(value)?value.join(', '):value)).join('\r\n')+'\r\n\r\n');if(remoteHead.length)socket.write(remoteHead);tunnel(socket as Socket,remote,url.href,head);});
    upstream.on('response',response=>{socket.end('HTTP/1.1 '+response.statusCode+' Rejected\r\nConnection: close\r\n\r\n');response.destroy();});upstream.on('error',()=>socket.destroy());upstream.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Owned browser network listener unavailable');
  return {proxy:{server:'http://127.0.0.1:'+address.port,bypass:'<-loopback>'},close:async()=>{agent.destroy();for(const socket of sockets)socket.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
