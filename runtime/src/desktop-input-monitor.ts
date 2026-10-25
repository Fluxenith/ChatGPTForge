import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {inputMonitorSource} from './desktop-input-guard.js';

export type InputStamp={name:string,epoch:number};
export interface InputMonitor {
  authorize(window?:string):Promise<void>;
  stamp():InputStamp;
  check(stamp:InputStamp):void;
  close():void;
}
export class DesktopInputMonitor implements InputMonitor {
  constructor(private onStop:(name:string)=>void=()=>{}){}
  private child?:ChildProcess;
  private name='';private epoch=0;private stopped=false;private ready=false;private heartbeat=0;
  private starting?:Promise<void>;
  private targets=new Set<string>();
  async authorize(window?:string):Promise<void> {
    if(this.starting)await this.starting;
    const healthy=this.ready&&!this.stopped&&Date.now()-this.heartbeat<2000;
    if(healthy&&(!window||this.targets.has(window)))return;
    const targets=healthy?new Set(this.targets):new Set<string>();
    if(window)targets.add(window);
    this.close();this.targets=targets;this.stopped=false;this.name='Local\\ForgeInput.'+randomUUID();
    this.starting=this.start();
    try {await this.starting;}finally{this.starting=undefined;}
  }
  private start():Promise<void> {
    const script=String.raw`$ErrorActionPreference='Stop'
$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
Add-Type -TypeDefinition $r.source
[ForgeInputMonitor]::Run([string]$r.name,[int]$r.parent,[string[]]$r.windows)
`;
    return new Promise((resolve,reject)=>{
      const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
      this.child=p;let buffer='',error='',settled=false;
      const fail=(e:Error)=>{if(this.child===p){this.ready=false;this.onStop(this.name);}if(!settled){settled=true;clearTimeout(timeout);reject(e);}};
      const timeout=setTimeout(()=>{fail(Error('Input monitor startup timed out'));p.kill();},15000);
      p.stdout!.setEncoding('utf8');p.stdout!.on('data',(chunk:string)=>{
        buffer+=chunk;
        if(buffer.length>16384){fail(Error('Invalid input monitor output'));p.kill();return;}
        for(let end;(end=buffer.indexOf('\n'))>=0;){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          try {
            const state=JSON.parse(line);
            if(!Number.isInteger(state.epoch)||state.epoch<0||typeof state.stopped!=='boolean')throw Error('Invalid input monitor state');
            if(this.child!==p)return;
            const newlyStopped=state.stopped&&!this.stopped;
            this.epoch=state.epoch;this.stopped=state.stopped;this.heartbeat=Date.now();this.ready=true;
            if(newlyStopped)this.onStop(this.name);
            if(!settled){settled=true;clearTimeout(timeout);resolve();}
          }catch(e){fail(e as Error);p.kill();}
        }
      });
      p.stderr!.on('data',b=>{error=(error+b).slice(-2000);});
      p.on('error',fail);p.stdin!.on('error',()=>{});
      p.on('exit',()=>fail(Error(error||'Input monitor exited; reauthorize locally')));
      p.stdin!.end(JSON.stringify({source:inputMonitorSource,name:this.name,parent:process.pid,windows:[...this.targets]}));
      // Child verifies parent liveness; it must not keep an otherwise closed CLI alive.
      p.unref();(p.stdout as any).unref?.();(p.stderr as any).unref?.();
    });
  }
  stamp():InputStamp {
    if(this.stopped)throw Error('Desktop stopped by physical Escape; reauthorize locally');
    if(!this.ready||Date.now()-this.heartbeat>2000)throw Error('Input monitor unavailable; reauthorize locally');
    return {name:this.name,epoch:this.epoch};
  }
  check(stamp:InputStamp):void {
    const now=this.stamp();
    if(now.name!==stamp.name||now.epoch!==stamp.epoch)throw Error('User input detected; observe again before input');
  }
  close():void {this.ready=false;this.onStop(this.name);this.child?.kill();this.child=undefined;this.targets.clear();}
}
