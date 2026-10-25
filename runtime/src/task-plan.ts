import * as z from 'zod/v4';
import {digest, snapshot, type DurableTasks} from './durable-tasks.js';
import {sourceHead} from './source-head.js';

// Planning layer for long-running work: a durable step plan per task, progress
// receipts, sizing advice from this project's verified history, and a project
// lessons ledger. Every write is a leased, idempotent receipt; a step counts as
// done only with a passing task_verify for the current workspace fingerprint.
// Advice is advisory: ChatGPT still decides; nothing here runs commands.
export const planStepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1).max(4000),
  estimate_minutes: z.number().positive().max(1440).optional(),
});
export type PlanStepInput = z.infer<typeof planStepSchema>;
export const PLAN_STEP_STATES = ['in_progress', 'done', 'blocked', 'split'] as const;
export const CLOSURE_PHASES=['executing','implementation-complete','validating','documenting','ready-to-commit','committed','prompt-generated','prompt-validated','submitted','receiving-run-verified','closed'] as const;
export const SOFT_BUDGET_DEFAULT_MINUTES = 20, SOFT_BUDGET_MIN_MINUTES = 10, SOFT_BUDGET_MAX_MINUTES = 90;
export const CLOSURE_RESERVE_RATIO = 0.25, MAX_SPLIT_DEPTH = 2, MAX_STEPS = 64;

type StepRow = {task_id:string;id:string;parent:string|null;depth:number;ord:number;title:string;objective:string;estimate_minutes:number|null;
  state:string;started:number|null;finished:number|null;evidence:string|null;note:string|null;blocked_count:number};
const MINUTE = 60_000;
const median = (values:number[]) => {const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]!:(s[m-1]!+s[m]!)/2;};

export class TaskPlans {
  constructor(private engine: DurableTasks) {
    engine.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_steps(task_id TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,depth INTEGER NOT NULL,ord REAL NOT NULL,
        title TEXT NOT NULL,objective TEXT NOT NULL,estimate_minutes REAL,state TEXT NOT NULL,started INTEGER,finished INTEGER,
        evidence TEXT,note TEXT,blocked_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS plan_operations(task_id TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS plan_lessons(seq INTEGER PRIMARY KEY AUTOINCREMENT,root TEXT NOT NULL,task_id TEXT NOT NULL,step_id TEXT,lesson TEXT NOT NULL,tags TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_closures(task_id TEXT PRIMARY KEY,phase TEXT NOT NULL,source_head TEXT,fingerprint TEXT NOT NULL,note TEXT NOT NULL,reopen_count INTEGER NOT NULL DEFAULT 0);
    `);
  }

  // Leased, idempotent write: same operation_id and arguments replay the saved
  // result; different arguments are refused. All plan writes are local SQLite
  // only, so there is no unknown external outcome to fence.
  private receipt<T>(taskId:string, operationId:string, lease:string|undefined, request:unknown, write:()=>T):T {
    return this.engine.db.transaction(()=>{
      const task=this.engine.task(taskId);this.engine.assertLease(task,lease);
      const body=JSON.stringify(request);
      const prior=this.engine.db.prepare('SELECT request,result FROM plan_operations WHERE task_id=? AND id=?').get(taskId,operationId) as {request:string;result:string}|undefined;
      if(prior){if(prior.request!==body)throw Error('Operation ID already used with different arguments');return JSON.parse(prior.result) as T;}
      const result=write();
      this.engine.db.prepare('INSERT INTO plan_operations VALUES(?,?,?,?,?)').run(taskId,operationId,body,JSON.stringify(result),Date.now());
      return result;
    }).immediate();
  }
  private steps(taskId:string){return this.engine.db.prepare('SELECT * FROM plan_steps WHERE task_id=? ORDER BY ord').all(taskId) as StepRow[];}

  closure(taskId:string,lease:string|undefined,operationId:string,input:{phase:typeof CLOSURE_PHASES[number];note:string;reopen?:boolean;evidence_operation_id?:string}) {
    return this.receipt(taskId,operationId,lease,{op:'closure',...input},()=>{
      const task=this.engine.task(taskId);this.engine.assertIdle(task);
      const note=z.string().trim().min(1).max(4000).parse(input.note),phase=CLOSURE_PHASES.indexOf(input.phase);
      const previous=this.closureStatus(taskId),old=previous?CLOSURE_PHASES.indexOf(previous.phase):-1;
      if(input.reopen){
        if(old<5||phase<1||phase>4)throw Error('Reopen requires a committed closure and an implementation/validation/documentation phase');
        this.engine.db.prepare("UPDATE operations SET state='verification_invalidated' WHERE task_id=? AND kind='verify' AND state='completed'").run(taskId);
      }else if(phase<old)throw Error('Closure cannot regress; explicitly reopen with contradictory evidence in note');
      const fingerprint=snapshot(task.root).fingerprint,head=sourceHead(task.root);
      if(!input.reopen&&previous&&old>=5&&(head!==previous.source_head||fingerprint!==previous.fingerprint))throw Error('Source changed after commit; reopen closure');
      if(phase>=4){
        const plan=this.status(taskId);
        if(plan.defined&&!plan.complete)throw Error('Plan steps remain');
        const op=this.engine.db.prepare("SELECT kind,state,exit_code,after_hash FROM operations WHERE task_id=? AND id=?").get(taskId,input.evidence_operation_id??'') as {kind:string;state:string;exit_code:number;after_hash:string}|undefined;
        if(!op||op.kind!=='verify'||op.state!=='completed'||op.exit_code!==0||op.after_hash!==fingerprint)throw Error('Closure needs fresh passing task_verify evidence');
      }
      this.engine.db.prepare('INSERT OR REPLACE INTO plan_closures VALUES(?,?,?,?,?,?)').run(taskId,input.phase,head,fingerprint,note,(previous?.reopen_count??0)+(input.reopen?1:0));
      this.engine.event(taskId,input.reopen?'closure_reopened':'closure_advanced',{...input,source_head:head,fingerprint});
      return this.closureStatus(taskId);
    });
  }
  private closureStatus(taskId:string){return this.engine.db.prepare('SELECT * FROM plan_closures WHERE task_id=?').get(taskId) as {phase:typeof CLOSURE_PHASES[number];source_head:string|null;fingerprint:string;note:string;reopen_count:number}|undefined;}
  assertClosed(taskId:string){
    const closure=this.closureStatus(taskId);if(!closure)return;
    if(closure.phase!=='closed')throw Error('Closure is not closed');
    if(closure.source_head!==sourceHead(this.engine.task(taskId).root)||closure.fingerprint!==snapshot(this.engine.task(taskId).root).fingerprint)throw Error('Closure source changed; reopen and verify');
  }

  define(taskId:string, lease:string|undefined, operationId:string, steps:PlanStepInput[]) {
    const parsed=z.array(planStepSchema).min(1).max(32).parse(steps);
    if(new Set(parsed.map(s=>s.id)).size!==parsed.length)throw Error('Plan step ids must be unique');
    return this.receipt(taskId,operationId,lease,{op:'define',steps:parsed},()=>{
      if(this.steps(taskId).length)throw Error('This task already has a plan; extend it by splitting steps');
      const insert=this.engine.db.prepare("INSERT INTO plan_steps(task_id,id,parent,depth,ord,title,objective,estimate_minutes,state) VALUES(?,?,NULL,0,?,?,?,?,'pending')");
      parsed.forEach((s,i)=>insert.run(taskId,s.id,i+1,s.title,s.objective,s.estimate_minutes??null));
      this.engine.event(taskId,'plan_defined',{steps:parsed.map(s=>s.id)});
      return this.status(taskId);
    });
  }

  update(taskId:string, lease:string|undefined, operationId:string, input:{step_id:string;state:typeof PLAN_STEP_STATES[number];note?:string;evidence_operation_id?:string;split_into?:PlanStepInput[]}) {
    const split=input.split_into?z.array(planStepSchema).min(1).max(8).parse(input.split_into):undefined;
    return this.receipt(taskId,operationId,lease,{op:'update',...input,split_into:split},()=>{
      const step=this.steps(taskId).find(s=>s.id===input.step_id);
      if(!step)throw Error('Unknown plan step');
      const now=Date.now(),note=input.note?.slice(0,4000)??null;
      const allowed:Record<string,string[]>={pending:['in_progress'],in_progress:['done','blocked','split'],blocked:['in_progress','split'],done:['in_progress']};
      if(!allowed[step.state]?.includes(input.state))throw Error(`A ${step.state} step cannot become ${input.state}`);
      if(step.state==='done'){
        if(!note?.trim())throw Error('Reopening a verified step requires a reason in note');
        if(this.engine.task(taskId).status!=='active')throw Error('Only active tasks can reopen plan steps');
        if(this.engine.db.prepare("SELECT 1 FROM handoffs WHERE task_id=? AND state='prepared'").get(taskId))throw Error('Withdraw the pending handoff before reopening a plan step');
        this.engine.db.prepare('UPDATE plan_steps SET evidence=NULL,finished=NULL,started=NULL WHERE task_id=? AND id=?').run(taskId,step.id);
        this.engine.db.prepare("UPDATE operations SET state='verification_invalidated' WHERE task_id=? AND kind='verify' AND state='completed'").run(taskId);
        this.engine.event(taskId,'plan_step_reopened',{step_id:step.id,reason:note,previous_evidence:step.evidence});
      }
      let evidence:string|null=null;
      if(input.state==='done'){
        // Closure needs proof: a completed, passing task_verify for the
        // workspace exactly as it is now.
        if(!input.evidence_operation_id)throw Error('done requires evidence_operation_id of a passing task_verify');
        const op=this.engine.db.prepare("SELECT kind,state,exit_code,after_hash FROM operations WHERE task_id=? AND id=?").get(taskId,input.evidence_operation_id) as {kind:string;state:string;exit_code:number|null;after_hash:string|null}|undefined;
        const current=snapshot(this.engine.task(taskId).root).fingerprint;
        if(!op||op.kind!=='verify'||op.state!=='completed'||op.exit_code!==0)throw Error('Evidence must be a completed task_verify with exit code 0');
        if(op.after_hash!==current)throw Error('Evidence was verified against a different workspace; run task_verify again');
        evidence=JSON.stringify({operation_id:input.evidence_operation_id,fingerprint:current});
      }
      if(input.state==='split'){
        if(!split)throw Error('split requires split_into');
        if(step.depth>=MAX_SPLIT_DEPTH)throw Error('Split depth exhausted; freeze the scope and close this step');
        const existing=new Set(this.steps(taskId).map(s=>s.id));
        if(split.some(s=>existing.has(s.id))||new Set(split.map(s=>s.id)).size!==split.length)throw Error('Split step ids must be new and unique');
        if(existing.size+split.length>MAX_STEPS)throw Error(`A plan holds at most ${MAX_STEPS} steps`);
        const next=(this.engine.db.prepare('SELECT MIN(ord) AS o FROM plan_steps WHERE task_id=? AND ord>?').get(taskId,step.ord) as {o:number|null}).o??step.ord+1;
        const insert=this.engine.db.prepare("INSERT INTO plan_steps(task_id,id,parent,depth,ord,title,objective,estimate_minutes,state) VALUES(?,?,?,?,?,?,?,?,'pending')");
        split.forEach((s,i)=>insert.run(taskId,s.id,step.id,step.depth+1,step.ord+(next-step.ord)*(i+1)/(split.length+1),s.title,s.objective,s.estimate_minutes??null));
      }
      this.engine.db.prepare(`UPDATE plan_steps SET state=?,note=COALESCE(?,note),evidence=COALESCE(?,evidence),
        started=CASE WHEN ?='in_progress' AND started IS NULL THEN ? ELSE started END,
        finished=CASE WHEN ? IN ('done','split') THEN ? ELSE finished END,
        blocked_count=blocked_count+CASE WHEN ?='blocked' THEN 1 ELSE 0 END WHERE task_id=? AND id=?`)
        .run(input.state,note,evidence,input.state,now,input.state,now,input.state,taskId,step.id);
      this.engine.event(taskId,'plan_step_'+input.state,{step_id:step.id,...(split?{split_into:split.map(s=>s.id)}:{}),...(evidence?{evidence:JSON.parse(evidence)}:{})});
      return this.status(taskId);
    });
  }

  recordLesson(taskId:string, lease:string|undefined, operationId:string, lesson:string, tags:string[], stepId?:string) {
    const text=z.string().trim().min(1).max(2000).parse(lesson),tagList=z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)).max(8).parse(tags);
    return this.receipt(taskId,operationId,lease,{op:'lesson',lesson:text,tags:tagList,step_id:stepId??null},()=>{
      const task=this.engine.task(taskId);
      if(stepId&&!this.steps(taskId).some(s=>s.id===stepId))throw Error('Unknown plan step');
      const seq=this.engine.db.prepare('INSERT INTO plan_lessons(root,task_id,step_id,lesson,tags,created) VALUES(?,?,?,?,?,?)').run(task.root,taskId,stepId??null,text,JSON.stringify(tagList),Date.now()).lastInsertRowid;
      this.engine.event(taskId,'plan_lesson',{seq:Number(seq),tags:tagList});
      return {lesson_id:Number(seq),root:task.root,lesson:text,tags:tagList};
    });
  }

  // Lessons are project data written by earlier conversations: guidance, never
  // authorization.
  lessons(taskId:string, tag?:string) {
    const root=this.engine.task(taskId).root;
    const rows=this.engine.db.prepare('SELECT seq,task_id,step_id,lesson,tags,created FROM plan_lessons WHERE root=? ORDER BY seq DESC LIMIT 200').all(root) as {seq:number;task_id:string;step_id:string|null;lesson:string;tags:string;created:number}[];
    return {root,lessons:rows.map(r=>({lesson_id:r.seq,task_id:r.task_id,step_id:r.step_id,lesson:r.lesson,tags:JSON.parse(r.tags) as string[],created:new Date(r.created).toISOString()}))
      .filter(r=>!tag||r.tags.includes(tag)).slice(0,50)};
  }

  // Duration-based sizing: a soft budget per step from the median duration of this
  // project's first-pass verified steps (at least 3), else 20 minutes, with a
  // reserved share for closure (verification, completion, hand-off).
  sizing(taskId:string, step?:StepRow) {
    const root=this.engine.task(taskId).root;
    const history=(this.engine.db.prepare(`SELECT s.started,s.finished FROM plan_steps s JOIN tasks t ON t.id=s.task_id
      WHERE t.root=? AND s.state='done' AND s.blocked_count=0 AND s.started IS NOT NULL AND s.finished>s.started`).all(root) as {started:number;finished:number}[])
      .map(r=>(r.finished-r.started)/MINUTE);
    const budget=history.length>=3?Math.max(SOFT_BUDGET_MIN_MINUTES,Math.min(SOFT_BUDGET_MAX_MINUTES,median(history))):SOFT_BUDGET_DEFAULT_MINUTES;
    const reserve=budget*CLOSURE_RESERVE_RATIO,implementation=budget-reserve;
    const base={soft_budget_minutes:Math.round(budget*10)/10,closure_reserve_minutes:Math.round(reserve*10)/10,history_samples:history.length,
      basis:history.length>=3?'median of verified first-pass steps in this project':'default (fewer than 3 verified first-pass steps)'};
    if(!step)return {...base,action:'none',reason:'no open step'};
    const elapsed=step.started?(Date.now()-step.started)/MINUTE:0;
    const projected=Math.max(elapsed,step.estimate_minutes??0);
    const action=projected<=implementation?'continue':step.depth<MAX_SPLIT_DEPTH?'split':'freeze_and_close';
    return {...base,step_id:step.id,elapsed_minutes:Math.round(elapsed*10)/10,projected_minutes:Math.round(projected*10)/10,action,
      reason:action==='continue'?'projected work fits the budget before the closure reserve':action==='split'?'projected work exceeds the budget; split the step':'split depth exhausted; freeze scope and close'};
  }

  status(taskId:string) {
    this.engine.task(taskId);
    const steps=this.steps(taskId);
    const closure=this.closureStatus(taskId)??null;
    if(!steps.length)return {task_id:taskId,defined:false,steps:[],closure};
    const current=steps.find(s=>s.state==='in_progress')??steps.find(s=>s.state==='blocked')??steps.find(s=>s.state==='pending');
    const counts=Object.fromEntries(['pending','in_progress','done','blocked','split'].map(k=>[k,steps.filter(s=>s.state===k).length]));
    const view=steps.map(s=>({id:s.id,parent:s.parent,depth:s.depth,title:s.title,objective:s.objective,state:s.state,estimate_minutes:s.estimate_minutes,
      started:s.started?new Date(s.started).toISOString():null,finished:s.finished?new Date(s.finished).toISOString():null,
      evidence:s.evidence?JSON.parse(s.evidence):null,note:s.note,blocked_count:s.blocked_count}));
    return {task_id:taskId,defined:true,closure,plan_sha256:digest(JSON.stringify(view.map(({started:_s,finished:_f,...rest})=>rest))),counts,
      current_step:current?.id??null,complete:steps.every(s=>s.state==='done'||s.state==='split'),steps:view,sizing:this.sizing(taskId,current)};
  }
}
