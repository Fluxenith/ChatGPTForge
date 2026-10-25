import {isDeepStrictEqual} from 'node:util';
import * as z from 'zod/v4';
import {browserNetworkJsonCheckSchema,browserNetworkPointerSchema,checkNetworkAssertion,networkAssertionReceipt,validateNetworkAssertion,jsonAt,
  type BrowserNetworkAssertion} from './forge-browser-network-assert.js';

// A flow verifies an already-recorded sequence of requests from one owned tab.
// Cross-response links operate on secret-redacted JSON, and never return values.
export const browserNetworkFlowSchema=z.object({
  steps:z.array(z.object({
    index:z.number().int().positive(),
    expected_state:z.enum(['pending','response','completed','failed']).optional(),
    expected_status:z.number().int().min(100).max(599).optional(),
    status_min:z.number().int().min(100).max(599).optional(),
    status_max:z.number().int().min(100).max(599).optional(),
    expected_method:z.string().regex(/^[A-Z]{1,16}$/).optional(),
    expected_path:z.string().regex(/^\/[^?#]{0,299}$/).optional(),
    max_duration_ms:z.number().int().min(1).max(120000).optional(),
    json_checks:z.array(browserNetworkJsonCheckSchema).min(1).max(8).optional(),
  }).strict()).min(2).max(8),
  links:z.array(z.object({
    from_index:z.number().int().positive(),from_pointer:browserNetworkPointerSchema,
    to_index:z.number().int().positive(),to_pointer:browserNetworkPointerSchema,
  }).strict()).max(8).optional(),
  max_start_gap_ms:z.number().int().min(1).max(120000).optional(),
  max_start_span_ms:z.number().int().min(1).max(120000).optional(),
}).strict();

export type BrowserNetworkFlow=z.infer<typeof browserNetworkFlowSchema>;
export type NetworkJsonEvidence={available:true;value:unknown}|{available:false;reason:string};
export type NetworkFlowObservation={
  index:number;started_ms:number;method:string;path:string;state:'pending'|'response'|'completed'|'failed';
  status:number|null;duration_ms?:number;evidence:NetworkJsonEvidence;
};

export function validateNetworkFlow(input:BrowserNetworkFlow){
  const result=browserNetworkFlowSchema.safeParse(input);
  if(!result.success)throw Error('Invalid network flow: '+result.error.issues.map(i=>i.message).join('; ').slice(0,300));
  if(Buffer.byteLength(JSON.stringify(input))>32768)throw Error('Network flow exceeds 32 KiB');
  const indexes=new Set<number>();
  for(const step of input.steps){
    validateNetworkAssertion(step);
    if(indexes.has(step.index))throw Error('Network flow cannot select a request index twice');
    indexes.add(step.index);
  }
  for(const link of input.links??[]){
    if(link.from_index===link.to_index||!indexes.has(link.from_index)||!indexes.has(link.to_index))
      throw Error('Network flow link must connect two distinct selected request indexes');
  }
}

export function networkFlowReceipt(input:BrowserNetworkFlow):BrowserNetworkFlow{
  return {...input,steps:input.steps.map(step=>networkAssertionReceipt(step)) as BrowserNetworkFlow['steps']};
}

// Only scalar fields can be correlated: the shared JSON sanitizer truncates
// large arrays/objects and rewrites URLs, so comparing them could give a false
// match. Credential masks must never be treated as evidence of equality.
function unsafeCorrelation(value:unknown){
  if(value!==null&&typeof value==='object')return 'non_scalar_correlation';
  if(typeof value==='string'){
    if(value.includes('[redacted]'))return 'redacted_data';
    if(value.length>=2048||/^https?:\/\//i.test(value))return 'normalized_string';
  }
  return undefined;
}

export function checkNetworkFlow(input:BrowserNetworkFlow,observations:NetworkFlowObservation[]){
  if(observations.length!==input.steps.length||observations.some((item,i)=>item.index!==input.steps[i]!.index))
    throw Error('Network flow observations do not match the selected requests');
  const steps=input.steps.map((step,i)=>({index:step.index,
    ...checkNetworkAssertion(step,observations[i]!,observations[i]!.evidence)}));
  const ordered=observations.every((entry,i)=>i===0||entry.index>observations[i-1]!.index);
  const checks=[{check:'request_order',passed:ordered}];
  if(input.max_start_gap_ms!==undefined){
    const gaps=observations.slice(1).map((entry,i)=>entry.started_ms-observations[i]!.started_ms);
    checks.push({check:'max_start_gap_ms',passed:ordered&&gaps.every(gap=>gap>=0&&gap<=input.max_start_gap_ms!)});
  }
  if(input.max_start_span_ms!==undefined){
    const span=observations.at(-1)!.started_ms-observations[0]!.started_ms;
    checks.push({check:'max_start_span_ms',passed:ordered&&span>=0&&span<=input.max_start_span_ms});
  }
  const lookup=new Map(observations.map(o=>[o.index,o.evidence]));
  const links=(input.links??[]).map(link=>{
    const from=lookup.get(link.from_index)!,to=lookup.get(link.to_index)!;
    let passed=false,reason:string|undefined;
    if(!from.available||!to.available)reason=!from.available?from.reason:(to as {available:false;reason:string}).reason;
    else{
      const lhs=jsonAt(from.value,link.from_pointer),rhs=jsonAt(to.value,link.to_pointer);
      if(!lhs.found||!rhs.found)reason='missing_path';
      else{
        reason=unsafeCorrelation(lhs.value)??unsafeCorrelation(rhs.value);
        if(!reason)passed=isDeepStrictEqual(lhs.value,rhs.value);
      }
    }
    return {from_index:link.from_index,to_index:link.to_index,passed,...(reason?{reason}:{})};
  });
  return {passed:steps.every(step=>step.passed)&&checks.every(check=>check.passed)&&links.every(link=>link.passed),
    steps,checks,links};
}
