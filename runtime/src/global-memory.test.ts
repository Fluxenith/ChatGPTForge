import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {GlobalMemory} from './global-memory.js';

function fixture(t:any){
 const base=mkdtempSync(join(tmpdir(),'forge-global-')),engine=new DurableTasks(join(base,'state'));
 const roots=['a','b','private'].map(n=>join(base,n));
 for(const root of roots){mkdirSync(join(root,'.serena/memories'),{recursive:true});writeFileSync(join(root,'.serena/memories/refs.md'),'mem:global/design mem:global/designer xmem:global/design mem:global/design/sub');writeFileSync(join(root,'.serena/memories/private.md'),'private-'+root);}
 const tasks=roots.map(root=>engine.create(root,'shared','test shared memories',['echo ok'],true));
 const parts=tasks.slice(0,2).map(x=>({task_id:x.task_id,lease_token:x.lease_token!}));
 const shared=new GlobalMemory(engine,[base]);
 const apply=(id:string,input:any,service=shared)=>{const p=service.preview(parts,input);return service.apply(id,parts.map((x,i)=>({...x,expected_fingerprint:p.participants[i]!.expected_fingerprint})),p.global_fingerprint,input);};
 const undo=(id:string,change:string)=>shared.rollback(change,id,parts.map((x,i)=>({...x,expected_fingerprint:snapshot(roots[i]!).fingerprint})),shared.read(parts[0]!.task_id).global_fingerprint);
 t.after(()=>{engine.close();rmSync(base,{recursive:true,force:true,maxRetries:5});});
 return {base,engine,roots,tasks,parts,shared,apply,undo};
}

test('shared enrollment, cross-project exact references, rename replay and ordered rollback',t=>{
 const {roots,tasks,parts,shared,apply,undo}=fixture(t);
 apply('enroll',{action:'enroll'});apply('design',{action:'write',name:'global/design',content:'shared design'});apply('index',{action:'write',name:'global/index',content:'see mem:global/design'});
 assert.equal(shared.read(tasks[0]!.task_id,'global/design').content,shared.read(tasks[1]!.task_id,'global/design').content);
 assert.throws(()=>shared.read(tasks[2]!.task_id),/not explicitly enrolled/);
 assert.throws(()=>shared.preview(parts.slice(0,1),{action:'rename',name:'global/design',to:'global/new'}),/All enrolled/);
 const input={action:'rename' as const,name:'global/design',to:'global/new'},p=shared.preview(parts,input),args=parts.map((x,i)=>({...x,expected_fingerprint:p.participants[i]!.expected_fingerprint}));
 assert.throws(()=>shared.apply('bad',args.map((x,i)=>i?{...x,lease_token:undefined}:x),p.global_fingerprint,input),/lease/i);
 assert.throws(()=>shared.apply('stale',args,'0'.repeat(64),input),/Shared store changed/);
 const renamed=shared.apply('rename',args,p.global_fingerprint,input);assert.equal(renamed.state,'completed');assert.deepEqual(shared.apply('rename',args,p.global_fingerprint,input),renamed);
 for(const root of roots.slice(0,2)){assert.equal(readFileSync(join(root,'.serena/memories/refs.md'),'utf8'),'mem:global/new mem:global/designer xmem:global/design mem:global/design/sub');assert.equal(readFileSync(join(root,'.serena/memories/private.md'),'utf8'),'private-'+root);}
 assert.equal(shared.read(tasks[0]!.task_id,'global/index').content,'see mem:global/new');
 assert.throws(()=>undo('out-of-order','design'),/undo later/);
 undo('undo-rename','rename');assert.equal(shared.read(tasks[1]!.task_id,'global/index').content,'see mem:global/design');
 writeFileSync(join(roots[1]!,'.serena/project.yml'),'read_only_memory_patterns: ["refs"]\n');
 assert.throws(()=>shared.preview(parts,input),/read-only/);
 undo('undo-index','index');undo('undo-design','design');undo('undo-enroll','enroll');
 assert.throws(()=>shared.read(tasks[0]!.task_id),/not explicitly enrolled/);
});

test('partial shared intent survives coordinator reconstruction, fences cancellation, refuses conflicts and recovers',t=>{
 const {base,engine,roots,parts,shared,apply}=fixture(t);
 apply('enroll',{action:'enroll'});apply('design',{action:'write',name:'global/design',content:'v1'});
 const broken=new GlobalMemory(engine,[base],()=>{throw Error('simulated interruption');});
 assert.throws(()=>apply('rename',{action:'rename',name:'global/design',to:'global/new'},broken),/simulated/);
 assert.equal(shared.status('rename').state,'pending');
 assert.throws(()=>engine.cancel(parts[0]!.task_id,parts[0]!.lease_token),/pending shared/);
 assert.throws(()=>engine.assertIdle(engine.task(parts[1]!.task_id)),/Pending shared/);
 const reopened=new GlobalMemory(engine,[base]),path=join(roots[0]!,'.serena/memories/refs.md'),partial=readFileSync(path,'utf8');
 writeFileSync(path,'external edit');assert.throws(()=>reopened.recover('rename','finish',parts),/External shared file conflict/);assert.equal(readFileSync(path,'utf8'),'external edit');
 writeFileSync(path,partial);assert.equal(reopened.recover('rename','rollback',parts).state,'rolled_back');
 assert.equal(reopened.read(parts[0]!.task_id,'global/design').content,'v1');assert.match(readFileSync(path,'utf8'),/^mem:global\/design /);
 assert.throws(()=>reopened.recover('rename','rollback',parts.slice(0,1)),/every original/);
 let once=true;const interrupted=new GlobalMemory(engine,[base],()=>{if(once){once=false;throw Error('stop');}});
 assert.throws(()=>apply('write',{action:'write',name:'global/design',content:'v2'},interrupted),/stop/);
 assert.equal(new GlobalMemory(engine,[base]).recover('write','finish',parts).state,'completed');
 assert.equal(shared.read(parts[1]!.task_id,'global/design').content,'v2');
});
