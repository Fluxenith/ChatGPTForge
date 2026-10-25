import {createHash} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {memoryName,policyForNames} from './task-memory.js';
import {isPathInsideRoot} from './roots.js';

// Unlike Serena's single-project memory maintenance report, the same graph
// representation also compares memory content and edges across project roots.
// This reads disk snapshots only: it does not start an LSP or mutate memories.
const MAX_MEMORIES=512,MAX_ENTRIES=2048,MAX_TOTAL_BYTES=16*1024*1024;
const MAX_MEMORY_BYTES=256*1024,MAX_EDGES=8192;
const MAX_UNMARKED=512;
const referencePattern=/(?<![A-Za-z0-9_\/-])mem:([A-Za-z0-9_\/-]+)(?![A-Za-z0-9_\/-])/g;
// A path-like name or a distinctive (12+ character) flat name may be a
// forgotten `mem:` reference. These are *candidates*, never automatic edits.
// Excluding ':' at the left boundary prevents matching already marked links.
const unmarkedPattern=/(?<![A-Za-z0-9_/:\-])([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+|[A-Za-z0-9_-]{12,})(?![A-Za-z0-9_\/-])/g;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
type Memory={name:string;sha256:string;bytes:number;read_only:boolean};
type Edge={from:string;to:string};
export type StaleMemoryLink=Edge&{occurrences:number;read_only:boolean};
export type UnmarkedMemoryLink={from:string;to:string;occurrences:number;read_only:boolean};
export type MemoryGraph={
  path:string;status:'complete'|'partial_ignored';memories:Memory[];
  edges:Edge[];stale:Edge[];external_global:Edge[];excluded_targets:Edge[];
  cycles:string[][];unreferenced:string[];excluded_count:number;fingerprint:string;
  unmarked:UnmarkedMemoryLink[];unmarked_omitted:number;stale_details:StaleMemoryLink[];
};

function assertPlainDirectory(path:string){
  const s=lstatSync(path);
  if(s.isSymbolicLink()||!s.isDirectory())throw Error('Serena memory path must be a real directory: '+path);
}
function assertPolicyFiles(project:string){
  for(const name of ['project.yml','project.yaml']){
    const path=join(project,'.serena',name);
    if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('Serena memory policy symlinks are not supported');
  }
}

function memoryFiles(project:string){
  const serena=join(project,'.serena'),base=join(serena,'memories');
  if(!existsSync(serena))return [] as {name:string;path:string}[];
  assertPlainDirectory(serena);
  assertPolicyFiles(project);
  if(!existsSync(base))return [] as {name:string;path:string}[];
  assertPlainDirectory(base);
  const discovered:{name:string;path:string}[]=[];
  let entries=0;
  function visit(directory:string,segments:string[]){
    for(const ent of readdirSync(directory,{withFileTypes:true})){
      if(++entries>MAX_ENTRIES)throw Error('Serena memory tree exceeds 2048 entries');
      const path=join(directory,ent.name);
      const status=lstatSync(path);
      if(status.isSymbolicLink())throw Error('Serena memory symlink is not supported: '+path);
      if(status.isDirectory()){
        memoryName([...segments,ent.name].join('/'));
        visit(path,[...segments,ent.name]);
      }else if(status.isFile()&&ent.name.endsWith('.md')){
        const name=[...segments,ent.name.slice(0,-3)].join('/');
        memoryName(name);
        discovered.push({name,path});
        if(discovered.length>MAX_MEMORIES)throw Error('Serena memory scan exceeds 512 markdown files');
      }
    }
  }
  visit(base,[]);
  discovered.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  const normalized=discovered.map(item=>item.name.toLowerCase());
  if(new Set(normalized).size!==normalized.length)throw Error('Ambiguous case-insensitive Serena memory names');
  return discovered;
}

function readMemory(path:string,project:string){
  // Check the canonical path in addition to rejecting symlink directory
  // entries. O_NOFOLLOW closes the final-component replacement window on
  // platforms that implement it; opening a file never executes project code.
  if(!isPathInsideRoot(realpathSync(path),project))throw Error('Memory resolves outside the approved project');
  const fd=openSync(path,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size>MAX_MEMORY_BYTES)throw Error('Memory exceeds 256 KiB or is not a regular file: '+path);
    const data=readFileSync(fd);
    const after=fstatSync(fd);
    if(!after.isFile()||after.size!==before.size||after.mtimeMs!==before.mtimeMs||data.length!==before.size)
      throw Error('Memory changed during scan: '+path);
    return {data,text:new TextDecoder('utf-8',{fatal:true}).decode(data)};
  }finally{closeSync(fd);}
}

function cyclesOf(names:string[],edges:Edge[]){
  const links=new Map(names.map(name=>[name,[] as string[]]));
  for(const edge of edges)links.get(edge.from)?.push(edge.to);
  let seq=0;const ids=new Map<string,number>(),low=new Map<string,number>(),stack:string[]=[],active=new Set<string>();
  const cycles:string[][]=[];
  const visit=(name:string)=>{
    ids.set(name,seq);low.set(name,seq++);stack.push(name);active.add(name);
    for(const next of links.get(name)??[]){
      if(!ids.has(next)){visit(next);low.set(name,Math.min(low.get(name)!,low.get(next)!));}
      else if(active.has(next))low.set(name,Math.min(low.get(name)!,ids.get(next)!));
    }
    if(low.get(name)!==ids.get(name))return;
    const group:string[]=[];
    let item:string;
    do{item=stack.pop()!;active.delete(item);group.push(item);}while(item!==name);
    if(group.length>1||edges.some(edge=>edge.from===name&&edge.to===name))cycles.push(group.sort());
  };
  for(const name of names)if(!ids.has(name))visit(name);
  return cycles.sort((a,b)=>a[0]!.localeCompare(b[0]!));
}

export function scanMemoryGraph(project:string):MemoryGraph{
  const files=memoryFiles(project);
  const names=files.map(item=>item.name);
  const policy=files.length?policyForNames(project,names):{readOnly:new Set<string>(),ignored:new Set<string>()};
  const visible=new Set(names.filter(name=>!policy.ignored.has(name)));
  const memories:Memory[]=[],edges:Edge[]=[],stale:Edge[]=[],external_global:Edge[]=[],excluded_targets:Edge[]=[];
  const stale_details:StaleMemoryLink[]=[];
  const unmarked:UnmarkedMemoryLink[]=[];
  let unmarked_omitted=0;
  let total=0;
  for(const item of files){
    if(policy.ignored.has(item.name))continue;
    const {data,text}=readMemory(item.path,project);
    total+=data.length;
    if(total>MAX_TOTAL_BYTES)throw Error('Serena memory scan exceeds 16 MiB');
    memories.push({name:item.name,sha256:sha(data),bytes:data.length,read_only:policy.readOnly.has(item.name)});
    const referenceCounts=new Map<string,number>();
    for(const match of text.matchAll(referencePattern)){
      const target=match[1]!;
      referenceCounts.set(target,(referenceCounts.get(target)??0)+1);
    }
    for(const [target,occurrences] of referenceCounts){
      if(edges.length+stale.length+external_global.length+excluded_targets.length>=MAX_EDGES)
        throw Error('Serena memory scan exceeds 8192 distinct references');
      const edge={from:item.name,to:target};
      if(target==='global'||target.startsWith('global/'))external_global.push(edge);
      else if(policy.ignored.has(target))excluded_targets.push(edge);
      else if(visible.has(target))edges.push(edge);
      else {stale.push(edge);stale_details.push({...edge,occurrences,read_only:policy.readOnly.has(item.name)});}
    }
    const unmarkedCounts=new Map<string,number>();
    for(const match of text.matchAll(unmarkedPattern)){
      const target=match[1]!;
      if(target===item.name||target==='global'||target.startsWith('global/')||!visible.has(target))continue;
      unmarkedCounts.set(target,(unmarkedCounts.get(target)??0)+1);
    }
    for(const [target,occurrences] of unmarkedCounts){
      if(unmarked.length<MAX_UNMARKED)unmarked.push({from:item.name,to:target,occurrences,read_only:policy.readOnly.has(item.name)});
      else unmarked_omitted++;
    }
  }
  const incoming=new Set(edges.map(edge=>edge.to));
  const visibleNames=memories.map(memory=>memory.name);
  return {path:project,status:policy.ignored.size?'partial_ignored':'complete',
    memories,edges,stale,external_global,excluded_targets,
    cycles:cyclesOf(visibleNames,edges),unreferenced:visibleNames.filter(name=>!incoming.has(name)),
    unmarked,unmarked_omitted,stale_details,
    excluded_count:policy.ignored.size,
    fingerprint:sha(JSON.stringify(memories.map(({name,sha256})=>[name,sha256]))),
  };
}

export function publicMemoryGraph(graph:MemoryGraph,maxDetails=40){
  const cap=<T>(values:T[])=>({items:values.slice(0,maxDetails),total:values.length,omitted:Math.max(0,values.length-maxDetails)});
  return {path:graph.path,status:graph.status,fingerprint:graph.fingerprint,
    counts:{memories:graph.memories.length,excluded_memories:graph.excluded_count,links:graph.edges.length,
      stale:graph.stale.length,excluded_targets:graph.excluded_targets.length,
      external_global:graph.external_global.length,cycles:graph.cycles.length,
      unreferenced:graph.unreferenced.length,unmarked:graph.unmarked.length+graph.unmarked_omitted},
    memories:cap(graph.memories.map(memory=>({...memory,
      incoming:graph.edges.filter(e=>e.to===memory.name).length,
      outgoing:graph.edges.filter(e=>e.from===memory.name).length}))),
    stale:cap(graph.stale),excluded_targets:cap(graph.excluded_targets),external_global:cap(graph.external_global),
    cycles:cap(graph.cycles),unreferenced:cap(graph.unreferenced),unmarked:cap(graph.unmarked),
    unmarked_omitted:graph.unmarked_omitted,
    note:'Memory contents are not returned. Unmarked candidates are exact existing memory names in unprefixed prose/path tokens; they can be ordinary text and require explicit selection before a fix. Global memories are outside this project-only scan. Ignored policies hide matching files; partial_ignored results cannot prove complete reference integrity. Unreferenced memories are informational, not errors. SHA-256 represents file bytes, not semantic equivalence; this is a bounded read, not an atomic filesystem snapshot.',
  };
}

export function compareMemoryGraphs(graphs:MemoryGraph[],maxDetails=40){
  if(graphs.length<2||graphs.length>3)throw Error('Compare 2–3 memory graphs');
  const baseline=graphs[0]!;
  const key=(e:Edge)=>JSON.stringify([e.from,e.to]);
  const cap=<T>(items:T[])=>({items:items.slice(0,maxDetails),total:items.length,omitted:Math.max(0,items.length-maxDetails)});
  const differences=graphs.slice(1).map(candidate=>{
    const old=new Map(baseline.memories.map(m=>[m.name,m]));
    const now=new Map(candidate.memories.map(m=>[m.name,m]));
    const added=[...now.keys()].filter(name=>!old.has(name));
    const removed=[...old.keys()].filter(name=>!now.has(name));
    const changed=[...now.keys()].filter(name=>old.has(name)&&old.get(name)!.sha256!==now.get(name)!.sha256);
    const unchanged=[...now.keys()].filter(name=>old.get(name)?.sha256===now.get(name)!.sha256);
    const diffEdges=(field:'edges'|'stale')=>{
      const oldKeys=new Set(baseline[field].map(key)),newKeys=new Set(candidate[field].map(key));
      return {introduced:cap(candidate[field].filter(e=>!oldKeys.has(key(e)))),
        resolved:cap(baseline[field].filter(e=>!newKeys.has(key(e))))};
    };
    return {baseline:baseline.path,candidate:candidate.path,
      conclusive:baseline.status==='complete'&&candidate.status==='complete',
      counts:{added:added.length,removed:removed.length,changed:changed.length,unchanged:unchanged.length},
      added:cap(added),removed:cap(removed),changed:cap(changed),unchanged:cap(unchanged),
      links:diffEdges('edges'),stale_references:diffEdges('stale')};
  });
  const conclusive=graphs.every(g=>g.status==='complete');
  const identical=graphs.every(g=>g.fingerprint===baseline.fingerprint);
  return {status:conclusive?'complete':'partial',equivalence:conclusive?(identical?'identical_bytes':'different_bytes'):'unknown',
    projects:graphs.map(g=>({path:g.path,status:g.status,fingerprint:g.fingerprint,
      memories:g.memories.length,excluded_memories:g.excluded_count,stale:g.stale.length,cycles:g.cycles.length})),
    differences,note:'Project 1 is baseline. Differences compare named memory file bytes and exact mem: edges. Content is never returned. Changes involving excluded memories may be hidden; partial scans are inconclusive. Global memories are not resolved and no filesystem snapshot is atomic.'};
}
