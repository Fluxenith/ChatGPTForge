import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';

const requestSignals=new AsyncLocalStorage<AbortSignal>();
export function withAnalysisRequestSignal<T>(signal:AbortSignal|undefined,run:()=>T):T {
  return signal?requestSignals.run(signal,run):run();
}
export function analysisRequestSignal(protocol:AbortSignal,http?:AbortSignal):AbortSignal {
  const signals=[protocol,http,requestSignals.getStore()].filter((signal):signal is AbortSignal=>!!signal);
  return signals.length===1?protocol:AbortSignal.any(signals);
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validId=(value:unknown):value is string|number=>typeof value==='string'||(typeof value==='number'&&Number.isFinite(value));
export class AnalysisRequestCapacityError extends Error {}

// The legacy stateless SDK creates a new protocol instance for each POST, so
// cancellation notifications cannot find another POST's request controller.
// Scope analysis and owned browser drags by authenticated grant + optional
// session + typed RPC id. Cancelling a drag must interrupt a pending hover.
// Never persist/log tokens, retain cancellation tombstones or guess ambiguous ids.
export class HttpAnalysisCancellation {
  private readonly pending=new Map<string,Set<AbortController>>();
  private count=0;
  private closed=false;
  open(bearer:string,session:string|undefined,body:unknown) {
    if(this.closed)throw new Error('MCP analysis requests are closed');
    if(!bearer||!object(body)||body.jsonrpc!=='2.0'||!object(body.params))return;
    const id=body.method==='notifications/cancelled'?body.params.requestId:body.id;
    if(!validId(id))return;
    const key=createHash('sha256').update(JSON.stringify([bearer,session??'',typeof id,id])).digest('hex');
    if(body.method==='notifications/cancelled'){
      if('id' in body||('reason' in body.params&&typeof body.params.reason!=='string'))return;
      const matches=this.pending.get(key);
      if(matches?.size===1)matches.values().next().value!.abort();
      return;
    }
    const drag=body.params.name==='browser_action'&&object(body.params.arguments)&&body.params.arguments.action==='drag';
    if(body.method!=='tools/call'||(!['code_navigate','task_rename','task_serena_rename','task_serena_edit','serena_rename_preview'].includes(String(body.params.name))&&!drag))return;
    if(this.count>=64)throw new AnalysisRequestCapacityError('MCP analysis request capacity exceeded');
    const controller=new AbortController(),matches=this.pending.get(key)??new Set<AbortController>();
    matches.add(controller);this.pending.set(key,matches);this.count++;
    let disposed=false;
    return {
      signal:controller.signal,
      abort:()=>controller.abort(),
      dispose:()=>{
        if(disposed)return;disposed=true;
        const live=this.pending.get(key);
        if(live?.delete(controller)){this.count--;if(!live.size)this.pending.delete(key);}
      },
    };
  }
  close(){
    this.closed=true;
    for(const matches of this.pending.values())for(const controller of matches)controller.abort();
    this.pending.clear();this.count=0;
  }
}
