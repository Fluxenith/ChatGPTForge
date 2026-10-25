import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches,type BatchChange} from './task-file-batches.js';
import {memoryName} from './task-memory.js';
import {scanMemoryGraph} from './serena-memory-graph.js';

export type MemoryLinkFix={source:string;target:string;expected_occurrences:number};

const escapeRegex=(name:string)=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

// Identical token boundaries to the analyzer, with the target fixed to a
// caller-selected, previously observed *existing* memory name.
function unmarkedExact(name:string){
  return new RegExp('(?<![A-Za-z0-9_/:\\-])'+escapeRegex(name)+'(?![A-Za-z0-9_\\/-])','g');
}

export function applyMemoryLinks(engine:DurableTasks,id:string,op:string,fixes:MemoryLinkFix[],
  expected:string,expectedMemoryFingerprint:string,lease?:string){
  if(fixes.length<1||fixes.length>32)throw Error('Select 1–32 memory link fixes from the preview');
  if(!/^[a-f0-9]{64}$/.test(expectedMemoryFingerprint))throw Error('Invalid memory graph fingerprint');
  const request={kind:'memory-autolink',fixes,expected,expectedMemoryFingerprint};
  const batch=new TaskFileBatches(engine);
  const replay=batch.replay(id,op,request,lease);if(replay)return replay;
  const task=engine.task(id);engine.assertLease(task,lease);engine.assertIdle(task);
  const captured=snapshot(task.root);
  if(captured.fingerprint!==expected)throw Error('Workspace conflict before memory link repair');

  const graph=scanMemoryGraph(task.root);
  if(graph.status!=='complete'||graph.unmarked_omitted>0)
    throw Error('Incomplete Serena memory graph; cannot verify all reference candidates');
  if(graph.fingerprint!==expectedMemoryFingerprint)throw Error('Memory graph changed since link preview');
  const candidates=new Map(graph.unmarked.map(item=>[JSON.stringify([item.from,item.to]),item]));
  const grouped=new Map<string,MemoryLinkFix[]>();
  const seen=new Set<string>();
  for(const fix of fixes){
    memoryName(fix.source);memoryName(fix.target);
    if(!Number.isInteger(fix.expected_occurrences)||fix.expected_occurrences<1||fix.expected_occurrences>65536)
      throw Error('Invalid memory reference occurrence count');
    if(fix.source===fix.target||fix.target==='global'||fix.target.startsWith('global/'))
      throw Error('Self or global memory links cannot be repaired automatically');
    const key=JSON.stringify([fix.source,fix.target]);
    if(seen.has(key))throw Error('Duplicate memory link fix');
    seen.add(key);
    const candidate=candidates.get(key);
    if(!candidate||candidate.occurrences!==fix.expected_occurrences)
      throw Error('Memory link fix does not match a current exact unmarked candidate');
    if(candidate.read_only)throw Error('Memory link source is read-only by Serena policy');
    const list=grouped.get(fix.source)??[];list.push(fix);grouped.set(fix.source,list);
  }
  if(grouped.size>16)throw Error('One repair batch can modify at most 16 memories');

  const changes:BatchChange[]=[];
  for(const [source,targets] of grouped){
    const path='.serena/memories/'+source+'.md',hash=captured.files[path];
    if(!hash)throw Error('Selected memory source no longer exists');
    const before=batch.readText(task.root,path);
    if(Buffer.byteLength(before,'utf8')>65536)throw Error('Memory link source exceeds 64 KiB edit limit');
    let after=before;
    for(const fix of [...targets].sort((a,b)=>b.target.length-a.target.length)){
      let count=0;
      after=after.replace(unmarkedExact(fix.target),()=>{count++;return 'mem:'+fix.target;});
      if(count!==fix.expected_occurrences)throw Error('Memory link occurrence count changed during repair');
    }
    if(after===before||Buffer.byteLength(after,'utf8')>65536)
      throw Error('Memory link repair made no change or exceeds 64 KiB');
    changes.push({path,content:after,expected_hash:hash});
  }
  // The existing file journal verifies the entire project snapshot and file
  // hashes before the first write, saves durable receipts and supports rollback.
  return batch.write(id,op,changes,expected,lease,request);
}
