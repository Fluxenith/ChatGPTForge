import {createHash} from 'node:crypto';
import * as z from 'zod/v4';

// A bounded, redacted list of requests already captured by the owned tab.
// Filtering never reads bodies or matches raw URLs containing credentials.
export const browserNetworkListSchema=z.object({
  path_prefix:z.string().regex(/^\/[^?#]{0,299}$/).optional().describe('Filter authorized URL pathnames; query strings and fragments are forbidden.'),
  method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']).optional(),
  state:z.enum(['pending','response','completed','failed']).optional(),
  status_min:z.number().int().min(100).max(599).optional(),
  status_max:z.number().int().min(100).max(599).optional(),
  min_duration_ms:z.number().int().min(0).max(120000).optional(),
  include_static:z.boolean().optional().describe('Show successful non-fetch/XHR requests; default false. Failed static requests remain visible.'),
  after_index:z.number().int().min(0).max(2147483647).optional().describe('Only return entries with a greater original request index.'),
  limit:z.number().int().min(1).max(80).optional().describe('Maximum matching entries returned; default 80.'),
}).strict().refine(value=>value.status_min===undefined||value.status_max===undefined||value.status_min<=value.status_max,
  {message:'status_min must be <= status_max'});

export type BrowserNetworkList=z.infer<typeof browserNetworkListSchema>;
export type NetworkListObservation={
  index:number;method:string;url:string;path:string;resource_type:string;
  state:'pending'|'response'|'completed'|'failed';status:number|null;
  duration_ms?:number;authorized:boolean;frame_unavailable?:boolean;
};

export function validateNetworkList(value:unknown):asserts value is BrowserNetworkList{
  const parsed=browserNetworkListSchema.safeParse(value);
  if(!parsed.success)throw Error('Invalid network list filter: '+parsed.error.issues.map(i=>i.message).join('; ').slice(0,300));
}

export function networkListReceipt(input:BrowserNetworkList){
  const {path_prefix,...rest}=input;
  return {...rest,...(path_prefix===undefined?{}:{path_prefix_digest:createHash('sha256').update(path_prefix).digest('hex')})};
}

export function checkNetworkList(input:BrowserNetworkList,rows:NetworkListObservation[],dropped:number){
  const matched:NetworkListObservation[]=[];
  let hidden_static=0,hidden_filtered=0,excluded_unapproved=0,unavailable_frames=0;
  for(const row of rows){
    if(row.index<=(input.after_index??0))continue;
    if(!row.authorized){
      if(row.frame_unavailable)unavailable_frames++;else excluded_unapproved++;
      continue;
    }
    if(!input.include_static&&!['fetch','xhr'].includes(row.resource_type)&&row.status!==null&&row.status<400&&row.state!=='failed'){
      hidden_static++;continue;
    }
    if((input.method!==undefined&&row.method!==input.method)
      ||(input.path_prefix!==undefined&&!row.path.startsWith(input.path_prefix))
      ||(input.state!==undefined&&row.state!==input.state)
      ||(input.status_min!==undefined&&(row.status===null||row.status<input.status_min))
      ||(input.status_max!==undefined&&(row.status===null||row.status>input.status_max))
      ||(input.min_duration_ms!==undefined&&(row.duration_ms===undefined||row.duration_ms<input.min_duration_ms))){
      hidden_filtered++;continue;
    }
    matched.push(row);
  }
  const page=matched.slice(0,input.limit??80);
  return {state:'completed' as const,entries:page.map(({index,method,url,resource_type,state,status,duration_ms})=>({index,method,url,resource_type,state,status,...(duration_ms===undefined?{}:{duration_ms})})),
    matched:matched.length,returned:page.length,has_more:matched.length>page.length,
    next_after_index:page.at(-1)?.index??input.after_index??0,
    hidden_static,hidden_filtered,excluded_unapproved,unavailable_frames,
    retained:rows.length,dropped,truncated:dropped>0,scope:'authorized_origins'};
}
