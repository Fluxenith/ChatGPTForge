import {createHash} from 'node:crypto';
import * as z from 'zod/v4';

// Evaluate a bounded cohort of requests already observed by the current tab.
// No browser activity or response-body reads occur while calculating budgets.
export const browserNetworkAuditSchema=z.object({
  path_prefix:z.string().regex(/^\/[^?#]{0,299}$/).optional().describe('URL pathname prefix (no query or fragment).'),
  method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']).optional(),
  include_static:z.boolean().optional().describe('Include document, script, image and other non-fetch/XHR resources; default false.'),
  min_completed:z.number().int().min(1).max(80).optional().describe('Minimum fully finished requests; default 1.'),
  max_failed:z.number().int().min(0).max(80).optional().describe('Maximum transport failures; default 0.'),
  max_http_errors:z.number().int().min(0).max(80).optional().describe('Maximum completed HTTP 4xx/5xx responses; default 0.'),
  max_pending:z.number().int().min(0).max(80).optional().describe('Maximum in-flight or response-only requests; default 0.'),
  max_p95_ms:z.number().int().min(1).max(120000).optional().describe('Upper bound for nearest-rank p95 of completed requests.'),
  max_duration_ms:z.number().int().min(1).max(120000).optional().describe('Upper bound for every completed request duration.'),
  allow_truncated:z.boolean().optional().describe('Opt into evaluating only the retained 80-request window; default false.'),
}).strict();

export type BrowserNetworkAudit=z.infer<typeof browserNetworkAuditSchema>;
export type NetworkAuditObservation={
  index:number;method:string;path:string;resource_type:string;
  state:'pending'|'response'|'completed'|'failed';status:number|null;
  duration_ms?:number;authorized:boolean;frame_unavailable?:boolean;
};

export function validateNetworkAudit(value:unknown):asserts value is BrowserNetworkAudit {
  const parsed=browserNetworkAuditSchema.safeParse(value);
  if(!parsed.success)throw Error('Invalid network audit: '+parsed.error.issues.map(i=>i.message).join('; ').slice(0,300));
}

export function networkAuditReceipt(input:BrowserNetworkAudit){
  const {path_prefix,...rest}=input;
  return {...rest,...(path_prefix!==undefined?{
    path_prefix_digest:createHash('sha256').update(path_prefix).digest('hex'),
  }:{})};
}

export function checkNetworkAudit(input:BrowserNetworkAudit,observations:NetworkAuditObservation[],dropped:number){
  const selected:NetworkAuditObservation[]=[];
  let inaccessible=0,frameUnavailable=0;
  for(const row of observations){
    if(!input.include_static&&!['xhr','fetch'].includes(row.resource_type))continue;
    if(input.method!==undefined&&row.method!==input.method)continue;
    if(!row.authorized){
      // An unauthorized URL cannot be evaluated against a pathname filter.
      // A once-authorized origin whose frame disappeared is incomplete evidence.
      if(row.frame_unavailable)frameUnavailable++;else inaccessible++;
      continue;
    }
    if(input.path_prefix!==undefined&&!row.path.startsWith(input.path_prefix))continue;
    selected.push(row);
  }
  const completed=selected.filter(row=>row.state==='completed');
  const failed=selected.filter(row=>row.state==='failed').length;
  const pending=selected.filter(row=>row.state==='pending'||row.state==='response').length;
  const httpErrors=completed.filter(row=>row.status!==null&&row.status>=400).length;
  const durations=completed.map(row=>row.duration_ms).filter((ms):ms is number=>ms!==undefined&&Number.isFinite(ms)).sort((a,b)=>a-b);
  const p95=durations.length?durations[Math.ceil(durations.length*0.95)-1]:null;
  const max=durations.at(-1)??null;
  const mean=durations.length?Math.round(durations.reduce((sum,value)=>sum+value,0)/durations.length):null;
  const checks:{check:string;passed:boolean;reason?:string}[]=[];
  const add=(check:string,passed:boolean,reason='budget_exceeded')=>checks.push({check,passed,...(!passed?{reason}:{})});
  // The cohort is explicitly limited to owner-authorized origins. A blocked
  // third-party request is outside the cohort and never supplies metric data.
  add('complete_evidence',frameUnavailable===0&&(dropped===0||input.allow_truncated===true),
    frameUnavailable?'frame_unavailable':'retention_window_truncated');
  add('min_completed',completed.length>=(input.min_completed??1),'insufficient_completed_requests');
  add('max_failed',failed<=(input.max_failed??0));
  add('max_http_errors',httpErrors<=(input.max_http_errors??0));
  add('max_pending',pending<=(input.max_pending??0));
  if(input.max_p95_ms!==undefined)add('max_p95_ms',p95!==null&&durations.length===completed.length&&p95<=input.max_p95_ms,
    p95===null||durations.length!==completed.length?'missing_duration':'budget_exceeded');
  if(input.max_duration_ms!==undefined)add('max_duration_ms',max!==null&&durations.length===completed.length&&max<=input.max_duration_ms,
    max===null||durations.length!==completed.length?'missing_duration':'budget_exceeded');
  const slowest=completed.filter(row=>row.duration_ms!==undefined)
    .sort((a,b)=>(b.duration_ms??0)-(a.duration_ms??0)||a.index-b.index)
    .slice(0,5).map(row=>({index:row.index,status:row.status,duration_ms:row.duration_ms}));
  return {state:'completed' as const,passed:checks.every(check=>check.passed),
    retained:observations.length,dropped,excluded_unapproved:inaccessible,unavailable_frames:frameUnavailable,scope:'authorized_origins',
    matched:selected.length,completed:completed.length,failed,pending,http_errors:httpErrors,
    latency_ms:{mean,p95,max,samples:durations.length},slowest,checks};
}
