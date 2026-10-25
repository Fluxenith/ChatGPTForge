import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import * as z from 'zod/v4';

// These checks inspect one already-observed request; they never trigger a
// request or evaluate JavaScript from the page. Actual and expected JSON values
// stay out of browser tool results.
export const browserNetworkPointerSchema=z.string().max(256).refine(v=>v===''||/^\/(?:[^~]|~[01])*(?:\/(?:[^~]|~[01])*)*$/.test(v),'Use an RFC 6901 JSON pointer');
export const browserNetworkJsonCheckSchema=z.object({
  pointer:browserNetworkPointerSchema,
  equals:z.json().optional(),
  type:z.enum(['null','array','object','string','number','boolean']).optional(),
  exists:z.boolean().optional(),
}).strict().refine(c=>Object.hasOwn(c,'equals')||c.type!==undefined||c.exists!==undefined,'Specify a JSON assertion')
  .refine(c=>c.exists!==false||(!Object.hasOwn(c,'equals')&&c.type===undefined),'Absent paths cannot have value assertions');

export type BrowserNetworkJsonCheck=z.infer<typeof browserNetworkJsonCheckSchema>;
export type BrowserNetworkAssertion={
  index?:number;
  expected_state?:'pending'|'response'|'completed'|'failed';
  expected_status?:number;
  status_min?:number;
  status_max?:number;
  expected_method?:string;
  expected_path?:string;
  max_duration_ms?:number;
  json_checks?:BrowserNetworkJsonCheck[];
};

export function validateNetworkAssertion(input:BrowserNetworkAssertion){
  if(!Number.isInteger(input.index)||input.index===undefined||input.index<=0)throw Error('network_assert requires a positive current-tab network index');
  if(input.expected_state!==undefined&&!['pending','response','completed','failed'].includes(input.expected_state))throw Error('Invalid expected network state');
  for(const [key,value] of [['expected_status',input.expected_status],['status_min',input.status_min],['status_max',input.status_max]] as const){
    if(value!==undefined&&(!Number.isInteger(value)||value<100||value>599))throw Error(`${key} must be an HTTP status from 100 to 599`);
  }
  if(input.expected_status!==undefined&&(input.status_min!==undefined||input.status_max!==undefined))throw Error('Exact status cannot be combined with a status range');
  if(input.status_min!==undefined&&input.status_max!==undefined&&input.status_min>input.status_max)throw Error('Invalid status range');
  if(input.expected_method!==undefined&&!/^[A-Z]{1,16}$/.test(input.expected_method))throw Error('expected_method must be an uppercase HTTP method');
  if(input.expected_path!==undefined&&!/^\/[^?#]{0,299}$/.test(input.expected_path))throw Error('expected_path must be an exact URL pathname without query or fragment (at most 300 chars)');
  if(input.max_duration_ms!==undefined&&(!Number.isInteger(input.max_duration_ms)||input.max_duration_ms<1||input.max_duration_ms>120000))throw Error('max_duration_ms must be between 1 and 120000');
  if(input.json_checks!==undefined){
    const parsed=z.array(browserNetworkJsonCheckSchema).min(1).max(8).safeParse(input.json_checks);
    if(!parsed.success)throw Error('Invalid network JSON checks: '+parsed.error.issues.map(i=>i.message).join('; ').slice(0,300));
    if(Buffer.byteLength(JSON.stringify(input.json_checks))>16384)throw Error('Network JSON assertions exceed 16 KiB');
  }
  if(input.expected_state===undefined&&input.expected_status===undefined&&input.status_min===undefined&&input.status_max===undefined&&!input.json_checks?.length)
    throw Error('network_assert requires a state, HTTP status or JSON content assertion');
}

export function jsonAt(root:unknown,pointer:string){
  let value=root;
  if(!pointer)return {found:true,value};
  for(const raw of pointer.slice(1).split('/')){
    const key=raw.replace(/~1/g,'/').replace(/~0/g,'~');
    if(Array.isArray(value)){
      if(!/^(0|[1-9]\d*)$/.test(key)||!Object.hasOwn(value,key))return {found:false,value:undefined};
      value=value[Number(key)];
    }else if(value!==null&&typeof value==='object'&&Object.hasOwn(value,key)){
      value=(value as Record<string,unknown>)[key];
    }else return {found:false,value:undefined};
  }
  return {found:true,value};
}

type Observation={method:string;path?:string;state:'pending'|'response'|'completed'|'failed';status:number|null;duration_ms?:number};
type JsonEvidence={available:true;value:unknown}|{available:false;reason:string};
type CheckResult={check:string;passed:boolean;reason?:string};

export function checkNetworkAssertion(input:BrowserNetworkAssertion,observation:Observation,evidence:JsonEvidence={available:false,reason:'not_requested'}){
  const checks:CheckResult[]=[];
  const add=(check:string,passed:boolean,reason='mismatch')=>checks.push({check,passed,...(!passed?{reason}:{})});
  // An HTTP response header can arrive before the body is received, or a
  // transfer can fail after a 200. Status-only assertions require completion.
  if(input.expected_state===undefined)add('completed',observation.state==='completed',observation.state==='failed'?'request_failed':'request_pending');
  if(input.expected_state!==undefined)add('state',observation.state===input.expected_state);
  if(input.expected_status!==undefined)add('status',observation.status===input.expected_status,observation.status===null?'no_response':'mismatch');
  if(input.status_min!==undefined)add('status_min',observation.status!==null&&observation.status>=input.status_min,observation.status===null?'no_response':'mismatch');
  if(input.status_max!==undefined)add('status_max',observation.status!==null&&observation.status<=input.status_max,observation.status===null?'no_response':'mismatch');
  if(input.expected_method!==undefined)add('method',observation.method===input.expected_method);
  if(input.expected_path!==undefined)add('path',observation.path===input.expected_path);
  if(input.max_duration_ms!==undefined)add('duration',observation.duration_ms!==undefined&&observation.duration_ms<=input.max_duration_ms,observation.duration_ms===undefined?'duration_unavailable':'exceeded');
  for(const [i,check] of (input.json_checks??[]).entries()){
    const name=`json_${i+1}`;
    if(!evidence.available){add(name,false,evidence.reason);continue;}
    const {found,value}=jsonAt(evidence.value,check.pointer);
    if(check.exists===false){add(name,!found);continue;}
    if(!found){add(name,false,'missing_path');continue;}
    const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
    if(check.type!==undefined&&kind!==check.type){add(name,false,'wrong_type');continue;}
    add(name,!Object.hasOwn(check,'equals')||isDeepStrictEqual(value,check.equals));
  }
  return {passed:checks.every(check=>check.passed),checks};
}

// Browser read receipts must compare identical assertions without retaining
// expected response values (which may contain user data or credentials).
export function networkAssertionReceipt(input:BrowserNetworkAssertion){
  return {...input,json_checks:input.json_checks?.map(check=>{
    if(!Object.hasOwn(check,'equals'))return check;
    const {equals,...rest}=check;
    return {...rest,equals_digest:hashEquals(equals)};
  })};
}

function hashEquals(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
