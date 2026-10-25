import {spawn} from 'node:child_process';

const MAX_MESSAGE=16*1024*1024;
export class LspFrames {
  buffer=Buffer.alloc(0); length; bytes=0; messages=0;
  constructor(receive){this.receive=receive;}
  push(chunk) {
    this.bytes+=chunk.length;
    if(this.bytes>64*1024*1024)throw new Error('Go LSP traffic exceeds 64 MiB');
    this.buffer=Buffer.concat([this.buffer,chunk]);
    for(;;) {
      if(this.length===undefined) {
        const end=this.buffer.indexOf('\r\n\r\n');
        if(end<0){if(this.buffer.length>16384)throw new Error('Invalid LSP header');return;}
        if(end>16384)throw new Error('Invalid LSP header');
        const headers=this.buffer.subarray(0,end).toString('ascii').split('\r\n');
        const lengths=headers.filter(line=>/^content-length:/i.test(line));
        if(lengths.length!==1||!/^content-length: *[0-9]+ *$/i.test(lengths[0]))throw new Error('Invalid LSP Content-Length');
        this.length=Number(lengths[0].split(':')[1].trim());
        if(!Number.isSafeInteger(this.length)||this.length<1||this.length>MAX_MESSAGE)throw new Error('LSP message exceeds bounds');
        this.buffer=this.buffer.subarray(end+4);
      }
      if(this.buffer.length<this.length)return;
      const bytes=this.buffer.subarray(0,this.length),text=bytes.toString('utf8');
      if(!Buffer.from(text).equals(bytes))throw new Error('LSP message is not UTF-8');
      const message=JSON.parse(text);
      if(!message||message.jsonrpc!=='2.0'||typeof message!=='object'||Array.isArray(message))throw new Error('Invalid LSP envelope');
      this.buffer=this.buffer.subarray(this.length);this.length=undefined;
      if(++this.messages>100000)throw new Error('Too many LSP messages');
      this.receive(message);
    }
  }
  end(){if(this.length!==undefined||this.buffer.length)throw new Error('Incomplete LSP frame');}
}

export class GoLsp {
  next=1; pending=new Map(); diagnostics=new Map(); notifications=[]; stderr=''; closed=false; failure;
  constructor(executable,cwd,env,settings,folders) {
    this.settings=settings;this.folders=folders;
    this.process=spawn(executable,['serve'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.frames=new LspFrames(message=>this.receive(message));
    this.process.stdout.on('data',chunk=>{try{this.frames.push(chunk);}catch(error){this.fail(error);}});
    this.process.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString('utf8')).slice(-65536);});
    this.process.on('error',error=>this.fail(error));
    this.process.on('close',code=>{
      this.closed=true;
      try{this.frames.end();}catch(error){this.fail(error);}
      if(this.pending.size)this.fail(new Error('gopls exited before a response ('+code+')'));
    });
    this.process.stdin.on('error',error=>this.fail(error));
  }
  fail(error) {
    this.failure??=error instanceof Error?error:new Error(String(error));
    for(const waiter of this.pending.values())waiter.reject(this.failure);
    this.pending.clear();
    this.process.kill();
  }
  send(message) {
    if(this.failure)throw this.failure;
    if(this.closed)throw new Error('gopls connection is closed');
    const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}));
    if(bytes.length>MAX_MESSAGE)throw new Error('Go LSP request exceeds bounds');
    this.process.stdin.write(Buffer.concat([Buffer.from('Content-Length: '+bytes.length+'\r\n\r\n'),bytes]));
  }
  request(method,params) {
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.send({id,method,params});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  notify(method,params){this.send({method,params});}
  receive(message) {
    if(typeof message.method==='string') {
      if(message.id!==undefined) {
        let result=null,error;
        if(message.method==='workspace/configuration') {
          const items=message.params?.items;
          if(!Array.isArray(items)||items.length>2048)throw new Error('Invalid Go LSP configuration request');
          result=items.map(item=>!item.section||item.section==='gopls'?this.settings:null);
        } else if(message.method==='workspace/workspaceFolders')result=this.folders;
        else if(message.method==='workspace/applyEdit')result={applied:false,failureReason:'Forge analysis is read-only'};
        else if(!['window/workDoneProgress/create','window/showMessageRequest'].includes(message.method))error={code:-32601,message:'Client operation unavailable during read-only analysis'};
        this.send({id:message.id,...(error?{error}:{result})});
      } else if(message.method==='textDocument/publishDiagnostics') {
        if(typeof message.params?.uri!=='string'||!Array.isArray(message.params.diagnostics)||message.params.diagnostics.length>10000)throw new Error('Invalid Go diagnostics notification');
        if(this.diagnostics.size>=4096&&!this.diagnostics.has(message.params.uri))throw new Error('Go diagnostics file bound exceeded');
        this.diagnostics.set(message.params.uri,message.params.diagnostics);
      } else if(['window/showMessage','window/logMessage'].includes(message.method)) {
        if(this.notifications.length<32)this.notifications.push({method:message.method,params:message.params});
      }
    } else {
      const waiter=this.pending.get(message.id);
      if(!waiter)throw new Error('Unexpected Go LSP response');
      this.pending.delete(message.id);
      if(message.error)waiter.reject(new Error('gopls: '+String(message.error.message)));
      else if(!Object.hasOwn(message,'result'))waiter.reject(new Error('Go LSP response omitted result'));
      else waiter.resolve(message.result);
    }
  }
  async shutdown() {
    if(this.failure||this.closed){this.process.kill();return;}
    await this.request('shutdown',null);this.notify('exit');this.process.stdin.end();
    await new Promise(resolve=>this.closed?resolve():this.process.once('close',resolve));
  }
}
