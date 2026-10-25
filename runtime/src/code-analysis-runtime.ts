import { Worker } from 'node:worker_threads';
import type { CodeProject } from './code-project.js';
import type { CodeNavigationInput, analyzeCode } from './code-navigation.js';

type Reply={result:Awaited<ReturnType<typeof analyzeCode>>;project?:CodeProject};
interface Job {
  input:CodeNavigationInput; roots:string[]; includeProject:boolean;
  resolve:(reply:Reply)=>void;reject:(error:Error)=>void;
  worker?:Worker;timer?:ReturnType<typeof setTimeout>;done:boolean;
  signal?:AbortSignal;abort?:()=>void;onCaptured?:()=>void;
}
const pending:Job[]=[];let active:Job|undefined;

function finish(job:Job,error?:Error,reply?:Reply) {
  if(job.done)return;job.done=true;clearTimeout(job.timer);
  if(job.signal&&job.abort)job.signal.removeEventListener('abort',job.abort);
  const index=pending.indexOf(job);if(index!==-1)pending.splice(index,1);
  const settled=()=>{
    if(active===job)active=undefined;
    pump();if(error)job.reject(error);else job.resolve(reply!);
  };
  // The handle belongs to this read-only analysis. Never terminate by saved PID.
  if(job.worker)void job.worker.terminate().then(settled,settled);else settled();
}
function pump() {
  if(active||!pending.length)return;
  const job=pending.shift()!;active=job;
  try {
    const source=import.meta.url.endsWith('.ts');
    const module=new URL(source?'./code-analysis-worker.ts':'./code-analysis-worker.js',import.meta.url).href;
    const worker=new Worker(new URL('../scripts/code-analysis-bootstrap.mjs',import.meta.url),{
      workerData:{module,source,input:job.input,roots:job.roots,includeProject:job.includeProject},execArgv:[],
      resourceLimits:{maxOldGenerationSizeMb:1024,maxYoungGenerationSizeMb:128,stackSizeMb:8},
    });
    job.worker=worker;
    worker.on('message',(message:{stage?:string;ok?:boolean;reply?:Reply;error?:string})=>{
      if(job.done)return;
      if(message.stage==='captured') {
        try{job.onCaptured?.();}catch(error){finish(job,error instanceof Error?error:new Error(String(error)));}
      } else if(message.ok)finish(job,undefined,message.reply);
      else finish(job,new Error(message.error??'Code analysis failed'));
    });
    worker.once('error',error=>finish(job,error instanceof Error?error:new Error(String(error))));
    worker.once('exit',code=>{if(!job.done)finish(job,new Error(`Code analysis worker exited before a result (${code})`));});
  }catch(error){finish(job,error instanceof Error?error:new Error(String(error)));}
}

// One active compiler and at most eight waiting queries bound memory and load.
// Timeout includes queue wait. An incomplete result never becomes an empty success.
export function runCodeAnalysis(input:CodeNavigationInput,roots:string[],includeProject=false,options:{signal?:AbortSignal;timeoutMs?:number;onCaptured?:()=>void}={}):Promise<Reply> {
  if(options.signal?.aborted)return Promise.reject(new Error('Code analysis cancelled'));
  if(pending.length>=8)return Promise.reject(new Error('Code analysis queue is full; wait for current queries before trying again'));
  return new Promise((resolve,reject)=>{
    const job:Job={input,roots,includeProject,resolve,reject,done:false,signal:options.signal,onCaptured:options.onCaptured};
    job.abort=()=>finish(job,new Error('Code analysis cancelled'));
    job.timer=setTimeout(()=>finish(job,new Error('Code analysis timed out; no partial result is returned')),options.timeoutMs??120000);
    job.signal?.addEventListener('abort',job.abort,{once:true});pending.push(job);pump();
  });
}
