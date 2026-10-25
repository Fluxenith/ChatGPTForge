import {randomUUID} from 'node:crypto';
type Entry={id:string;revision:string;abort:AbortController;done:Promise<void>;state:'running'|'complete'|'failed';value?:string;error?:unknown;deadline:ReturnType<typeof setTimeout>;lastPoll:number};
// Short transport requests follow one bounded, read-only analysis. No process
// or cache survives service shutdown; changed inputs never reuse an old result.
export class DeferredReads {
 private entries=new Map<string,Entry>();private active=new Set<Entry>();private closed=false;
 constructor(private waitMs=8000,private lifetimeMs=600000,private limit=4){}
 async invoke(key:string,revision:string,run:(signal:AbortSignal)=>Promise<string>,signal?:AbortSignal){
  if(this.closed)throw Error('Read service is closing');signal?.throwIfAborted();
  const now=Date.now();
  for(const [k,e]of this.entries)if(now-e.lastPoll>180000){e.abort.abort();this.entries.delete(k);}
  let entry=this.entries.get(key);
  if(entry&&entry.revision!==revision){entry.abort.abort();this.entries.delete(key);entry=undefined;}
  if(!entry){
   if(this.entries.size>=this.limit||this.active.size>=this.limit)throw Error('Cold-index read limit reached; continue an existing read first');
   const abort=new AbortController();
   entry={id:randomUUID(),revision,abort,state:'running',done:Promise.resolve(),deadline:setTimeout(()=>abort.abort(new Error('Cold-index read exceeded its deadline')),this.lifetimeMs),lastPoll:now};
   entry.deadline.unref();const current=entry;
   this.active.add(current);
   current.done=Promise.resolve().then(()=>{abort.signal.throwIfAborted();return run(abort.signal);}).then(value=>{if(abort.signal.aborted)throw abort.signal.reason;current.value=value;current.state='complete';}).catch(error=>{current.error=error;current.state='failed';}).finally(()=>{clearTimeout(current.deadline);this.active.delete(current);});
   this.entries.set(key,current);
  }
  const current=entry;current.lastPoll=now;
  let timer:ReturnType<typeof setTimeout>|undefined,rejectCancel:((e:unknown)=>void)|undefined;
  const cancel=()=>{current.abort.abort();rejectCancel?.(signal?.reason??new Error('Read cancelled'));};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
   await Promise.race([current.done,new Promise<void>(r=>{timer=setTimeout(r,this.waitMs);}),new Promise<never>((_,reject)=>{rejectCancel=reject;if(signal?.aborted)cancel();})]);
   signal?.throwIfAborted();
   if(current.state==='running')return JSON.stringify({status:'indexing',operation_id:current.id,retry_after_ms:1000,continuation:'Repeat this same tool with identical arguments to retrieve the existing analysis. Do not start duplicate queries. Source changes invalidate it.'});
   if(this.entries.get(key)===current)this.entries.delete(key);
   if(current.state==='failed')throw current.error;
   return current.value!;
  }finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 }
 async close(){this.closed=true;const entries=[...this.active];this.entries.clear();for(const e of entries)e.abort.abort();await Promise.allSettled(entries.map(e=>e.done));}
}
