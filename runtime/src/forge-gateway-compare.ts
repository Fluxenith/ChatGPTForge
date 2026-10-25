import {isDeepStrictEqual} from 'node:util';
import * as z from 'zod/v4';

// Explicit, independent read endpoints. Each provider may encode the same
// value under a different JSON path; the caller specifies the mapping.
const jsonPointer=z.string().max(256).refine(
  value=>value===''||/^\/(?:[^~]|~[01])*(?:\/(?:[^~]|~[01])*)*$/.test(value),
  'Use an RFC 6901 JSON pointer');
const source=z.object({
  server:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  tool:z.string().min(1).max(128),
  arguments:z.record(z.string(),z.json()).default({}),
  pointer:jsonPointer,
  expected_type:z.enum(['null','boolean','number','string','array','object']).optional(),
}).strict();
export const gatewayCompareReadSchema=z.object({
  reads:z.array(source).min(2).max(6),
  tolerance:z.object({
    absolute:z.number().finite().min(0).max(1e12).default(0),
    relative:z.number().finite().min(0).max(1).default(0),
  }).strict().default({absolute:0,relative:0}),
}).strict().superRefine((value,context)=>{
  if(new Set(value.reads.map(read=>read.server)).size!==value.reads.length)
    context.addIssue({code:'custom',message:'Each compared source must use a different approved MCP server'});
});
export type GatewayCompareRead=z.input<typeof gatewayCompareReadSchema>;
export type GatewayComparedSource=z.output<typeof source>;

export type ComparedReadResult={
  content?:{type:string;text?:unknown}[];
  structuredContent?:unknown;
  isError?:boolean;
};
type ValueKind='null'|'boolean'|'number'|'string'|'array'|'object';
type ReadStatus='ok'|'tool_error'|'ambiguous_content'|'invalid_json'|'content_too_large'|'missing_pointer'|'type_mismatch';
const MAX_DOCUMENT_BYTES=65536;
function kind(value:unknown):ValueKind{
  return value===null?'null':Array.isArray(value)?'array':typeof value as ValueKind;
}
function lookup(root:unknown,pointer:string):{found:boolean;value:unknown}{
  if(pointer==='')return {found:true,value:root};
  let value=root;
  for(const raw of pointer.slice(1).split('/')){
    const segment=raw.replace(/~1/g,'/').replace(/~0/g,'~');
    if(Array.isArray(value)){
      if(!/^(0|[1-9]\d*)$/.test(segment)||!Object.hasOwn(value,segment))return {found:false,value:undefined};
      value=value[Number(segment)];
    }else if(value!==null&&typeof value==='object'&&Object.hasOwn(value,segment)){
      value=(value as Record<string,unknown>)[segment];
    }else return {found:false,value:undefined};
  }
  return {found:true,value};
}

export function comparedReadValue(response:ComparedReadResult,source:Pick<GatewayComparedSource,'pointer'|'expected_type'>):
  {status:ReadStatus;content_source?:'structured'|'text';value_type?:ValueKind;value?:unknown}{
  if(response.isError)return {status:'tool_error'};
  let serialized:string,origin:'structured'|'text';
  if(response.structuredContent!==undefined){
    origin='structured';
    try{serialized=JSON.stringify(response.structuredContent);}catch{return {status:'invalid_json'};}
    if(typeof serialized!=='string')return {status:'invalid_json'};
  }else{
    const text=(response.content??[]).filter(block=>block.type==='text'&&typeof block.text==='string');
    if(text.length!==1||(response.content??[]).some(block=>block.type!=='text'))return {status:'ambiguous_content'};
    origin='text';serialized=text[0]!.text as string;
  }
  if(Buffer.byteLength(serialized,'utf8')>MAX_DOCUMENT_BYTES)return {status:'content_too_large'};
  let document:unknown;
  try{document=JSON.parse(serialized);}catch{return {status:'invalid_json'};}
  const {found,value}=lookup(document,source.pointer);
  if(!found)return {status:'missing_pointer',content_source:origin};
  const value_type=kind(value);
  if(source.expected_type&&source.expected_type!==value_type)return {status:'type_mismatch',content_source:origin,value_type};
  return {status:'ok',content_source:origin,value_type,value};
}

export function compareReadValues(reference:unknown,candidate:unknown,tolerance:{absolute:number;relative:number}){
  if(typeof reference==='number'&&typeof candidate==='number'){
    const absolute_difference=Math.abs(candidate-reference);
    const allowed_difference=Math.max(tolerance.absolute,tolerance.relative*Math.max(Math.abs(reference),Math.abs(candidate)));
    return {matched:absolute_difference<=allowed_difference,mode:'numeric' as const,
      absolute_difference,allowed_difference};
  }
  return {matched:isDeepStrictEqual(reference,candidate),mode:'exact' as const};
}
