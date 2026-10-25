import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {DurableTasks,digest,snapshot,type Snapshot,type TaskRow} from './durable-tasks.js';
import {memoryName,policyForNames} from './task-memory.js';
import {scanMemoryGraph} from './serena-memory-graph.js';
import {isPathInsideRoot} from './roots.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';

type Member={root:string;identity:string};
type State={store:string;members:Member[];memories:Record<string,string>};
type Participant={task_id:string;lease_token?:string;expected_fingerprint?:string};
type Action={action:'enroll'|'write'|'rename';name?:string;to?:string;content?:string};
type Entry={root:string;path:string;before:string|null;after:string|null;temp:string};
type Plan={before:State;after:State;entries:Entry[];participants:{task_id:string;root:string;identity:string;baseline:Snapshot}[]};
type Operation={id:string;request:string;plan:string;state:'pending'|'completed'|'rolled_back';result:string|null;direction:'finish'|'rollback'};
const marker='.forge-shared-memory.json';
const canonical=(state:State)=>JSON.stringify({...state,members:[...state.members].sort((a,b)=>a.root.localeCompare(b.root)),memories:Object.fromEntries(Object.entries(state.memories).sort(([a],[b])=>a.localeCompare(b)))});
const fingerprint=(state:State)=>digest(canonical(state));
const textHash=(text:string|null)=>text===null?null:digest(text);
function globalName(name:string|undefined){if(!name?.startsWith('global/'))throw Error('Use an explicit global/topic memory name');memoryName(name);return name;}
function references(from:string){return new RegExp('(?<![A-Za-z0-9_\\-/])mem:'+from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9_\\-/])','g');}

// SQLite commits intent before touching files. File replacements are atomic
// individually, not an atomic multi-root filesystem transaction. Pending intent
// fences every participant until an explicit finish or rollback succeeds.
export class GlobalMemory {
 constructor(private engine:DurableTasks,private roots:string[],private observe?:(index:number)=>void){
  engine.db.exec(`CREATE TABLE IF NOT EXISTS global_memory_state(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS global_memory_operations(id TEXT PRIMARY KEY,request TEXT NOT NULL,plan TEXT NOT NULL,state TEXT NOT NULL,result TEXT,direction TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS global_memory_participants(operation_id TEXT NOT NULL,task_id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(operation_id,root));`);
  engine.db.prepare('INSERT OR IGNORE INTO global_memory_state VALUES(1,?)').run(canonical({store:randomUUID(),members:[],memories:{}}));
 }
 private state():State{return JSON.parse((this.engine.db.prepare('SELECT data FROM global_memory_state WHERE id=1').get() as {data:string}).data);}
 private pending(){if(this.engine.db.prepare("SELECT 1 FROM global_memory_operations WHERE state='pending'").get())throw Error('Shared memory operation pending; inspect global_memory_operation and recover first');}
 private allowed(root:string){
  const canonicalRoot=realpathSync.native(root);
  if(canonicalRoot!==root||!this.roots.some(r=>isPathInsideRoot(root,realpathSync.native(r))))throw Error('Shared-memory project is outside current approved roots');
 }
 private tasks(parts:Participant[],write=false,except?:string){
  if(parts.length<1||parts.length>8||new Set(parts.map(p=>p.task_id)).size!==parts.length)throw Error('Supply 1..8 distinct participating tasks');
  const rows=parts.map(p=>{const row=this.engine.task(p.task_id);this.allowed(row.root);
   if(write){this.engine.assertLease(row,p.lease_token);this.engine.assertIdle(row,false,[],false,except);}
   return row;});
  if(new Set(rows.map(r=>r.root.toLowerCase())).size!==rows.length)throw Error('Duplicate project roots');
  return rows;
 }
 private completeScope(state:State,rows:TaskRow[],enroll=false){
  for(const m of state.members){this.allowed(m.root);const row=rows.find(r=>r.root===m.root);if(!row||row.root_identity!==m.identity)throw Error('All enrolled projects require their current task and write lease; project identity must match');}
  if(!enroll&&rows.some(r=>!state.members.some(m=>m.root===r.root)))throw Error('Project has not explicitly enrolled in shared memory');
  for(const a of rows)for(const b of rows)if(a!==b&&isPathInsideRoot(a.root,b.root))throw Error('Overlapping shared project roots are not supported');
 }
 private file(root:string,path:string){
  if(path!==marker&&!/^\.serena\/memories\/[A-Za-z0-9_/-]+\.md$/.test(path)&&!/^\.forge-shared-[a-f0-9-]+\.tmp$/.test(path))throw Error('Invalid shared memory journal path');
  const parts=path.split('/');if(parts.some(p=>p==='..'||p==='.'))throw Error('Invalid path');
  let current=root;
  for(const part of parts){current=join(current,part);if(existsSync(current)){const s=lstatSync(current);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('Shared memory links/special files are refused');}}
  const parent=realpathSync.native(dirname(current));const rel=relative(root,parent);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw Error('Shared memory path escaped root');
  return current;
 }
 private readFile(root:string,path:string){
  const file=this.file(root,path);if(!existsSync(file))return null;
  const stat=lstatSync(file);if(!stat.isFile()||stat.size>256*1024)throw Error('Shared memory file is not regular or exceeds 256 KiB');
  const data=readFileSync(file),after=lstatSync(file);
  if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw Error('Memory changed while reading');
  return new TextDecoder('utf-8',{fatal:true}).decode(data);
 }
 private policies(state:State,names:string[],write:boolean){
  for(const m of state.members){const p=policyForNames(m.root,names);if(names.some(n=>p.ignored.has(n)||write&&p.readOnly.has(n)))throw Error('Shared memory is protected by a participating project Serena policy');}
 }
 read(taskId:string,name?:string){
  this.pending();const row=this.tasks([{task_id:taskId}])[0]!,state=this.state();
  if(!state.members.some(m=>m.root===row.root&&m.identity===row.root_identity))throw Error('Project has not explicitly enrolled in shared memory');
  snapshot(row.root); // Reject changed link/special-file boundaries before reading policies.
  if(this.readFile(row.root,marker)!==JSON.stringify({format:'forge-shared-memory-v1',store:state.store,global_fingerprint:fingerprint(state)},null,2)+'\n')throw Error('Shared project metadata changed externally');
  const names=Object.keys(state.memories),policy=policyForNames(row.root,names);
  if(name){globalName(name);if(policy.ignored.has(name))throw Error('Shared memory is ignored by project policy');if(!Object.hasOwn(state.memories,name))throw Error('Shared memory not found');}
  return {scope:'global',store:state.store,global_fingerprint:fingerprint(state),...(name?{name,content:state.memories[name]}:{memories:names.filter(n=>!policy.ignored.has(n)).map(n=>({name:n,sha256:digest(state.memories[n]!)}))})};
 }
 private plan(parts:Participant[],input:Action):Plan{
  this.pending();const before=this.state(),after=structuredClone(before),rows=this.tasks(parts);
  this.completeScope(before,rows,input.action==='enroll');
  const baselines=new Map(rows.map(row=>[row.id,snapshot(row.root)]));
  const entries:Entry[]=[];
  const add=(root:string,path:string,a:string|null,b:string|null)=>{if(a!==b)entries.push({root,path,before:a,after:b,temp:'.forge-shared-'+randomUUID()+'.tmp'});};
  if(input.action==='enroll'){
   if(input.name!==undefined||input.to!==undefined||input.content!==undefined)throw Error('Enrollment accepts only participant tasks');
   for(const row of rows)if(!after.members.some(m=>m.root===row.root)){if(this.readFile(row.root,marker)!==null)throw Error('Project already has shared metadata; do not overwrite it');after.members.push({root:row.root,identity:row.root_identity});}
   if(after.members.length===before.members.length)throw Error('No new projects to enroll');
  }else{
   const name=globalName(input.name);this.policies(before,[name,...(input.to?[globalName(input.to)]:[])],true);
   if(input.action==='write'){
    if(input.to!==undefined||typeof input.content!=='string'||Buffer.byteLength(input.content)>65536)throw Error('Write requires content <=64 KiB and no destination');
    if(Object.keys(before.memories).some(n=>n!==name&&n.toLowerCase()===name.toLowerCase()))throw Error('Case-insensitive shared memory name collision');
    if(before.memories[name]===input.content)throw Error('Shared memory content is unchanged');
    after.memories[name]=input.content;
   }else{
    const to=globalName(input.to);if(input.content!==undefined||!Object.hasOwn(before.memories,name)||name.toLowerCase()===to.toLowerCase()||Object.keys(before.memories).some(n=>n.toLowerCase()===to.toLowerCase()))throw Error('Invalid shared rename source/destination');
    for(const [n,text] of Object.entries(before.memories)){
     const changed=text.replace(references(name),()=> 'mem:'+to);
     if(changed!==text)this.policies(before,[n],true);
     delete after.memories[n];after.memories[n===name?to:n]=changed;
    }
    for(const row of rows){
     const graph=scanMemoryGraph(row.root);if(graph.status!=='complete')throw Error('Ignored memories prevent complete shared-reference propagation');
     for(const memory of graph.memories){
      const path='.serena/memories/'+memory.name+'.md',text=this.readFile(row.root,path)!;
      if(digest(text)!==memory.sha256)throw Error('Memory changed during shared-reference scan');
      const changed=text.replace(references(name),()=> 'mem:'+to);
      if(changed!==text&&memory.read_only)throw Error('Shared reference occurs in a read-only memory');
      add(row.root,path,text,changed);
     }
    }
   }
  }
  if(after.members.length>8||Object.keys(after.memories).length>128||Buffer.byteLength(canonical(after))>2*1024*1024)throw Error('Shared store exceeds 8 projects, 128 memories or 2 MiB');
  const nextMarker=JSON.stringify({format:'forge-shared-memory-v1',store:after.store,global_fingerprint:fingerprint(after)},null,2)+'\n';
  for(const row of rows){
   const current=this.readFile(row.root,marker);
   if(before.members.some(m=>m.root===row.root)){
    const expected=JSON.stringify({format:'forge-shared-memory-v1',store:before.store,global_fingerprint:fingerprint(before)},null,2)+'\n';
    if(current!==expected)throw Error('Shared project metadata changed externally');
   }
   add(row.root,marker,current,nextMarker);
  }
  if(entries.length>64||entries.reduce((n,e)=>n+Buffer.byteLength(e.before??'')+Buffer.byteLength(e.after??''),0)>8*1024*1024)throw Error('Shared transaction exceeds 64 files or 8 MiB');
  for(const row of rows)if(snapshot(row.root).fingerprint!==baselines.get(row.id)!.fingerprint)throw Error('Project changed while building shared preview');
  return {before,after,entries,participants:rows.map(row=>({task_id:row.id,root:row.root,identity:row.root_identity,baseline:baselines.get(row.id)!}))};
 }
 preview(parts:Participant[],input:Action){
  const p=this.plan(parts,input);
  return {global_fingerprint:fingerprint(p.before),participants:p.participants.map(x=>({task_id:x.task_id,path:x.root,expected_fingerprint:x.baseline.fingerprint})),changes:p.entries.map(e=>({project:e.root,path:e.path,before_sha256:textHash(e.before),after_sha256:textHash(e.after),reference_update:e.path!==marker})),shared_names:Object.keys(p.after.memories),limits:{projects:8,memories:128,changed_files:64}};
 }
 private receipt(op:string){const row=this.engine.db.prepare('SELECT * FROM global_memory_operations WHERE id=?').get(op) as Operation|undefined;if(!row)throw Error('Unknown global memory operation');return row;}
 status(op:string){const row=this.receipt(op),p=JSON.parse(row.plan) as Plan;this.tasks(p.participants.map(x=>({task_id:x.task_id})));return {operation_id:op,state:row.state,direction:row.direction,result:row.result?JSON.parse(row.result):null,participants:p.participants.map(x=>({task_id:x.task_id,path:x.root})),changed_files:p.entries.length};}
 apply(op:string,parts:Participant[],expected:string,input:Action){
  const rows=this.tasks(parts);for(let i=0;i<rows.length;i++)this.engine.assertLease(rows[i]!,parts[i]!.lease_token);
  const request=digest(JSON.stringify({parts:parts.map(({lease_token,...p})=>p),expected,input}));
  const old=this.engine.db.prepare('SELECT * FROM global_memory_operations WHERE id=?').get(op) as Operation|undefined;
  if(old){if(old.request!==request)throw Error('Operation ID reused with different shared input');return this.status(op);}
  this.engine.db.transaction(()=>{
   this.tasks(parts,true);const plan=this.plan(parts,input);
   if(fingerprint(plan.before)!==expected)throw Error('Shared store changed; refresh preview');
   for(const p of plan.participants)if(parts.find(x=>x.task_id===p.task_id)?.expected_fingerprint!==p.baseline.fingerprint)throw Error('Project changed; refresh shared preview');
   this.insert(op,request,plan);
  }).immediate();
  return this.finish(op,'finish',parts);
 }
 private insert(op:string,request:string,plan:Plan){
  this.engine.db.prepare("INSERT INTO global_memory_operations VALUES(?,?,?,'pending',NULL,'finish')").run(op,request,JSON.stringify(plan));
  for(const p of plan.participants){this.engine.db.prepare('INSERT INTO global_memory_participants VALUES(?,?,?)').run(op,p.task_id,p.root);this.engine.event(p.task_id,'global_memory_prepared',{operation_id:op,files:plan.entries.filter(e=>e.root===p.root).length});}
 }
 private inspect(plan:Plan){
  if(fingerprint(this.state())!==fingerprint(plan.before))throw Error('Shared store changed during pending operation');
  for(const p of plan.participants){
   const row=this.engine.task(p.task_id);this.allowed(row.root);if(row.root!==p.root||row.root_identity!==p.identity)throw Error('Shared project identity changed');
   const current={...snapshot(p.root).files},original={...p.baseline.files};
   for(const e of plan.entries.filter(e=>e.root===p.root)){
    const value=textHash(this.readFile(e.root,e.path));if(value!==textHash(e.before)&&value!==textHash(e.after))throw Error('External shared file conflict: '+e.path);
    if(existsSync(this.file(e.root,e.temp))){const tmp=textHash(this.readFile(e.root,e.temp));if(tmp!==textHash(e.before)&&tmp!==textHash(e.after))throw Error('External shared temporary file conflict');}
    delete current[e.path];delete current[e.temp];delete original[e.path];
   }
   if(digest(JSON.stringify(current))!==digest(JSON.stringify(original)))throw Error('Project changed outside shared transaction targets');
  }
 }
 private finish(op:string,direction:'finish'|'rollback',parts:Participant[]){
  this.engine.db.transaction(()=>{
   const row=this.receipt(op);
   const plan=JSON.parse(row.plan) as Plan;const rows=this.tasks(parts);
   for(let i=0;i<rows.length;i++)this.engine.assertLease(rows[i]!,parts[i]!.lease_token);
   if(rows.length!==plan.participants.length||plan.participants.some(p=>!rows.some(r=>r.id===p.task_id)))throw Error('Recovery requires every original participant lease');
   if(row.state!=='pending')return;
   this.tasks(parts,true,op);
   this.inspect(plan);
   for(let i=0;i<plan.entries.length;i++){
    const e=plan.entries[i]!,desired=direction==='finish'?e.after:e.before,current=this.readFile(e.root,e.path),target=this.file(e.root,e.path),temp=this.file(e.root,e.temp);
    if(existsSync(temp))unlinkSync(temp);
    if(current!==desired){
     if(desired===null){if(this.readFile(e.root,e.path)!==current)throw Error('Shared file conflict before deletion');if(existsSync(target))unlinkSync(target);}
     else{writeFileSync(temp,desired,{flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
      if(this.readFile(e.root,e.path)!==current)throw Error('Shared file conflict before replacement');renameSync(temp,target);}
    }
    this.observe?.(i);
   }
   this.inspect(plan);
   for(const e of plan.entries)if(this.readFile(e.root,e.path)!==(direction==='finish'?e.after:e.before))throw Error('Shared target changed before commit');
   const state=direction==='finish'?plan.after:plan.before;
   const result={global_fingerprint:fingerprint(state),participants:plan.participants.map(p=>({task_id:p.task_id,fingerprint:snapshot(p.root).fingerprint})),changed_files:plan.entries.length};
   this.engine.db.prepare('UPDATE global_memory_state SET data=? WHERE id=1').run(canonical(state));
   this.engine.db.prepare('UPDATE global_memory_operations SET state=?,direction=?,result=? WHERE id=?').run(direction==='finish'?'completed':'rolled_back',direction,JSON.stringify(result),op);
   for(const p of plan.participants)this.engine.event(p.task_id,'global_memory_'+(direction==='finish'?'completed':'rolled_back'),{operation_id:op,global_fingerprint:result.global_fingerprint});
  }).immediate();
  return this.status(op);
 }
 recover(op:string,direction:'finish'|'rollback',parts:Participant[]){return this.finish(op,direction,parts);}
 rollback(change:string,op:string,parts:Participant[],expected:string){
  const rows=this.tasks(parts);for(let i=0;i<rows.length;i++)this.engine.assertLease(rows[i]!,parts[i]!.lease_token);
  const request=digest(JSON.stringify({change,parts:parts.map(({lease_token,...p})=>p),expected}));
  const prior=this.engine.db.prepare('SELECT request FROM global_memory_operations WHERE id=?').get(op) as {request:string}|undefined;
  if(prior){if(prior.request!==request)throw Error('Rollback ID reused');return this.status(op);}
  this.engine.db.transaction(()=>{
   this.pending();this.tasks(parts,true);const row=this.receipt(change);if(row.state!=='completed')throw Error('Only a completed shared change can be rolled back');
   const original=JSON.parse(row.plan) as Plan,current=this.state();this.completeScope(current,rows);
   if(expected!==fingerprint(current)||fingerprint(original.after)!==expected)throw Error('Shared state changed after this operation; undo later shared changes first');
   if(rows.length!==original.participants.length||original.participants.some(p=>!rows.some(r=>r.root===p.root&&r.root_identity===p.identity)))throw Error('Rollback requires the same participating projects');
   const entries=original.entries.map(e=>{if(this.readFile(e.root,e.path)!==e.after)throw Error('Shared rollback target changed externally');return {...e,before:e.after,after:e.before,temp:'.forge-shared-'+randomUUID()+'.tmp'};});
   const participants=rows.map(r=>({task_id:r.id,root:r.root,identity:r.root_identity,baseline:snapshot(r.root)}));
   for(const p of participants)if(parts.find(x=>x.task_id===p.task_id)?.expected_fingerprint!==p.baseline.fingerprint)throw Error('Project changed before shared rollback');
   this.insert(op,request,{before:current,after:original.before,entries,participants});
  }).immediate();
  return this.finish(op,'finish',parts);
 }
}

export function registerGlobalMemory(target:McpRegistrationTarget,engine:DurableTasks,roots:string[]){
 const shared=new GlobalMemory(engine,roots),id=z.string().min(1).max(160),fp=z.string().regex(/^[a-f0-9]{64}$/);
 const participant=z.object({task_id:id,lease_token:z.string().uuid(),expected_fingerprint:fp});
 const fields={action:z.enum(['enroll','write','rename']),name:z.string().max(200).optional(),to:z.string().max(200).optional(),content:z.string().max(65536).optional()};
 const wrap=(run:(i:any)=>unknown)=>async(i:any)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(run(i))}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:String(e)}]};}};
 const annotations=(readOnlyHint:boolean)=>({readOnlyHint,destructiveHint:!readOnlyHint,openWorldHint:true});
 target.registerTool('global_memory_read',{description:'Read/list explicitly shared Forge global/topic memories from an enrolled project task. Never reads another project private memories. This is the Forge shared store, not an implicit import of external Serena global memory.',inputSchema:{task_id:id,name:z.string().max(200).optional()},annotations:annotations(true)},wrap(i=>shared.read(i.task_id,i.name)));
 target.registerTool('global_memory_preview',{description:'Preview enrollment, shared write or exact global/topic rename. Supply current task IDs for ALL enrolled projects; enrollment may add explicit projects. Returns global and project fingerprints plus changed-reference paths. No writes. Maximum 8 projects, 128 shared memories and 64 changed files. Private content is never promoted automatically.',inputSchema:{participants:z.array(z.object({task_id:id})).min(1).max(8),...fields},annotations:annotations(true)},wrap(i=>shared.preview(i.participants,i)));
 target.registerTool('global_memory_apply',{description:'Apply a previewed enroll/write/rename with ALL participant leases and exact fingerprints. Shared rename updates exact mem:global/topic links in enrolled project memories and shared memories; other text stays unchanged. Protected/ignored memories, stale state and symlinks fail closed. Each project receives a small shared-state marker included in task verification. A durable multi-root intent fences partial writes until explicit recovery. Replay identical operation ID and arguments.',inputSchema:{operation_id:id,participants:z.array(participant).min(1).max(8),expected_global_fingerprint:fp,...fields},annotations:annotations(false)},wrap(i=>shared.apply(i.operation_id,i.participants,i.expected_global_fingerprint,{action:i.action,name:i.name,to:i.to,content:i.content})));
 target.registerTool('global_memory_operation',{description:'Inspect a shared operation receipt without exposing stored backup content or leases.',inputSchema:{operation_id:id},annotations:annotations(true)},wrap(i=>shared.status(i.operation_id)));
 target.registerTool('global_memory_recover',{description:'After inspecting a pending shared operation, explicitly finish it or restore its before-state. Requires every original participant lease; external file changes cause refusal. Does not overwrite edits made outside the recorded transaction.',inputSchema:{operation_id:id,direction:z.enum(['finish','rollback']),participants:z.array(z.object({task_id:id,lease_token:z.string().uuid()})).min(1).max(8)},annotations:annotations(false)},wrap(i=>shared.recover(i.operation_id,i.direction,i.participants)));
 target.registerTool('global_memory_rollback',{description:'Reverse a completed shared change, including reference edits and enrollment markers, using a new durable operation ID. Requires all current participant leases/fingerprints and unchanged shared after-state; undo later shared changes first. Private edits outside changed files are preserved.',inputSchema:{change_id:id,operation_id:id,participants:z.array(participant).min(1).max(8),expected_global_fingerprint:fp},annotations:annotations(false)},wrap(i=>shared.rollback(i.change_id,i.operation_id,i.participants,i.expected_global_fingerprint)));
}
