// Keep filesystem concurrency bounded, but do not leave free slots waiting for
// the slowest member of a fixed batch. Drain every started callback before
// reporting failure so callers can safely clean up their owned snapshot.
export async function visitGoInputs<T>(items:T[],visit:(item:T,index:number)=>Promise<void>,signal?:AbortSignal) {
  signal?.throwIfAborted();
  let cursor=0,failed=false,failure:unknown;
  async function worker() {
    while(!failed&&cursor<items.length) {
      try {
        signal?.throwIfAborted();
        const index=cursor++;
        await visit(items[index]!,index);
      } catch(error) {
        if(!failed){failed=true;failure=error;}
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(16,items.length)},()=>worker()));
  if(failed)throw failure;
}
