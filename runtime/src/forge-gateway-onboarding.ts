import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as z from 'zod/v4';
import {type GatewayReadProbe,type GatewayServer,ForgeMcpGateway,gatewayProbesSchema,gatewayServersSchema} from './forge-mcp-gateway.js';
import {rankGatewayRoutes,type GatewayRouteKind,type GatewayRouteServer} from './forge-gateway-routing.js';

const secretValue=/\b(?:bearer\s+\S{8,}|sk-[a-z0-9_-]{8,}|gh[opusr]_[a-z0-9_]{16,}|AKIA[A-Z0-9]{16}|(?:api[_-]?key|password|secret|token|authorization)\s*[=:]\s*[^\s,;]{8,})\b/i;
const idSchema=z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const description=z.string().trim().min(1).max(300).refine(value=>!secretValue.test(value),'Remove credential literals');

// This manifest describes how an owner-listed MCP server should be operated.
// It never grants approval, launches an unapproved server or changes routing.
export const gatewayOnboardingManifestSchema=z.object({
  schema_version:z.literal(1),id:idSchema,
  display_name:z.string().trim().min(1).max(128).refine(value=>!secretValue.test(value),'Remove credential literals'),
  role:z.string().trim().min(1).max(128).refine(value=>!secretValue.test(value),'Remove credential literals'),
  required:z.boolean(),enabled_by_default:z.boolean(),
  transport:z.enum(['streamable_http','stdio']),
  default_endpoint:z.string().max(2048).nullable(),
  // Imported manifest hints are accepted as documentation only: they never
  // classify or grant access to a tool in Forge.
  safe_tool:z.string().min(1).max(128).nullable().default(null),
  upstream:z.string().url().max(2048).nullable().default(null),
  best_use_cases:z.array(description).max(16).default([]),
  poor_use_cases:z.array(description).max(16).default([]),
  goal_oriented_patterns:z.array(z.object({goal:description,tool:z.string().min(1).max(128)}).strict()).max(24).default([]),
  performance_cost_notes:z.array(description).max(16).default([]),
}).strict().superRefine((value,ctx)=>{
  if(secretValue.test(JSON.stringify(value)))ctx.addIssue({code:'custom',message:'Remove credential literals from the manifest'});
  if(value.transport==='stdio'&&value.default_endpoint!==null)ctx.addIssue({code:'custom',path:['default_endpoint'],message:'stdio must use null; the executable stays in the owner-managed Forge configuration'});
  if(value.transport==='streamable_http'){
    let valid=false;
    try{
      const url=new URL(value.default_endpoint??'');
      valid=!url.username&&!url.password&&!url.search&&!url.hash&&
        (url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname));
    }catch{/* malformed endpoint */}
    if(!valid)ctx.addIssue({code:'custom',path:['default_endpoint'],message:'Use credential-free HTTPS or loopback HTTP without query or fragment'});
  }
});
export type GatewayOnboardingManifest=z.infer<typeof gatewayOnboardingManifestSchema>;

const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PUBLIC_BYTES=1_048_576;
const REGISTRY_VERSION=1;
function redact(value:unknown,key=''):unknown{
  if(/(?:password|secret|token|authorization|cookie|api.?key|private.?key)/i.test(key))return '[redacted]';
  if(typeof value==='string')return secretValue.test(value)?'[redacted]':value.slice(0,8192);
  if(Array.isArray(value))return value.map(item=>redact(item));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,k)]));
  return value;
}

export function gatewayManifestCandidate(manifestInput:unknown,existing:GatewayServer[]){
  const manifest=gatewayOnboardingManifestSchema.parse(manifestInput);
  const server=existing.find(item=>item.id===manifest.id);
  if(server){
    const kind=server.endpoint?'streamable_http':'stdio';
    if(kind!==manifest.transport||((server.endpoint??null)!==manifest.default_endpoint))throw Error('Manifest transport or endpoint differs from the owner-managed gateway entry');
    return {manifest,server,needs_registration:false};
  }
  if(manifest.transport==='stdio')throw Error('Import or configure the local stdio server before onboarding; a manifest cannot launch a new command');
  const endpoint=manifest.default_endpoint!;
  // A newly proposed endpoint may be registered, but is always unapproved.
  const candidate=gatewayServersSchema.parse([{id:manifest.id,endpoint,allow_remote:endpoint.startsWith('https:'),approved:false,read_tools:[],write_tools:[]}])[0]!;
  return {manifest,server:candidate,needs_registration:true};
}

type InventoryRecord={version:number;server:string;manifest_sha256:string;config_sha256:string;catalog_sha256:string|null;
  onboarding_receipt_sha256:string;
  applied_at:string;manifest:GatewayOnboardingManifest;capability_evidence:unknown;operating_guide:unknown;routing:unknown;
  approval_changed:false;lifecycle_authority:false};

export class GatewayOnboarding {
  constructor(private gateway:ForgeMcpGateway,private stateDir:string){}

  private directory(){return join(this.stateDir,'gateway-manifests');}
  private path(id:string){idSchema.parse(id);return join(this.directory(),id+'.json');}
  private receiptFingerprint(id:string){
    const path=join(this.stateDir,'gateway-onboarding',id+'.json');
    if(!existsSync(path))return null;
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>PUBLIC_BYTES)throw Error('Invalid gateway onboarding receipt');
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  private read(id:string):InventoryRecord|undefined{
    const dir=this.directory(),file=this.path(id);
    if(existsSync(dir)){const stat=lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Gateway manifest registry must be a real directory');}
    if(!existsSync(file))return undefined;
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>PUBLIC_BYTES)throw Error('Invalid gateway manifest record');
    const row=JSON.parse(readFileSync(file,'utf8')) as InventoryRecord;
    if(row.version!==REGISTRY_VERSION||row.server!==id||!row.manifest||
      row.manifest_sha256!==fingerprint(gatewayOnboardingManifestSchema.parse(row.manifest))||
      !/^[0-9a-f]{64}$/.test(row.config_sha256)||
      !/^[0-9a-f]{64}$/.test(row.onboarding_receipt_sha256)||
      (row.catalog_sha256!==null&&!/^[0-9a-f]{64}$/.test(row.catalog_sha256)))throw Error('Invalid gateway manifest record');
    return row;
  }

  private persist(id:string,record:InventoryRecord){
    const dir=this.directory();mkdirSync(dir,{recursive:true});
    const stat=lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Gateway manifest registry must be a real directory');
    const dest=this.path(id);
    if(existsSync(dest)){const current=lstatSync(dest);if(!current.isFile()||current.isSymbolicLink())throw Error('Invalid gateway manifest record');}
    const bytes=JSON.stringify(record,null,2);
    if(Buffer.byteLength(bytes)>PUBLIC_BYTES)throw Error('Gateway manifest record exceeds 1 MiB');
    const temp=join(dir,id+'.'+randomUUID()+'.tmp');
    try{const fd=openSync(temp,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,dest);}finally{rmSync(temp,{force:true});}
  }

  async run(manifestInput:unknown,apply=false,probeInput:GatewayReadProbe[]=[]){
    const manifest=gatewayOnboardingManifestSchema.parse(manifestInput);
    const probes=gatewayProbesSchema.parse(probeInput);
    const server=this.gateway.servers.get(manifest.id);
    if(!server)throw Error('Gateway manifest refers to a server absent from this Gateway instance');
    gatewayManifestCandidate(manifest,[server]);
    const receipt=await this.gateway.onboard(manifest.id,apply,probes);
    type PublicTool={name:string;description:string;input_schema:unknown;classification:'read'|'write'|'unapproved';
      callable:boolean;routing:'mcp_gateway_read'|'mcp_gateway_write'|null};
    const live=(receipt.guide as {tools:PublicTool[]}|null)?.tools??[];
    const tools=live.map(tool=>({name:tool.name,description:tool.description,input_schema:redact(tool.input_schema),
      classification:tool.classification,callable:tool.callable,routing:tool.routing}));
    const callable=receipt.status==='success'&&server.approved;
    const routing={component_id:manifest.id,role:manifest.role,
      status:callable?'recommend-review':server.approved?'defer-until-capability-evidence':'defer-until-owner-approval',
      basis:callable?'live-tools-list':receipt.status,
      tools:callable?tools.filter(tool=>tool.callable).map(({name,classification,routing})=>({name,classification,routing,
        requires_lease:classification==='write',verified_write_gate:classification==='write'&&server.write_gate==='verified'})):[],
      applied_to_host:false};
    const evidence={status:receipt.status,initialize:receipt.evidence.initialize,tools_list:receipt.evidence.tools_list,
      tool_count:receipt.guide?live.length:null,catalog_sha256:receipt.catalog_sha256,
      safe_call:receipt.evidence.safe_call,verification:receipt.verification,probes:receipt.probes,
      reason:receipt.error};
    const operating_guide=redact({schema_version:1,component_id:manifest.id,
      mental_model:`${manifest.display_name} provides owner-controlled MCP capabilities. Inspect the actual tool schema and classification before choosing a route.`,
      best_use_cases:manifest.best_use_cases,poor_use_cases:manifest.poor_use_cases,
      capability_evidence:{...evidence,tools},
      goal_oriented_patterns:manifest.goal_oriented_patterns.map(pattern=>({...pattern,
        routing:routing.tools.find(tool=>tool.name===pattern.tool)?.routing??null})),
      common_mistakes:['Tool names and descriptions do not establish approval or safe behavior.',
        'A successful tools/list response does not verify read-tool results.',
        'Do not repeat writes with a new operation ID after an uncertain outcome.'],
      failure_diagnosis:server.approved
        ?['Check gateway doctor for transport and missing catalog tools.','Review read probe assertions; retry a failed probe only after inspecting the cause.','Check owner approval, credential references and exact origin restrictions.']
        :['This server has not been approved. Inspect its source and classify individual tools before enabling it.'],
      verification_signals:['Live initialize and tools/list succeed.',
        'All approved read tools pass content assertions before verification is reported as passed.',
        'Verified write gates require fresh evidence for the same config and tool catalog.'],
      performance_cost_notes:[...manifest.performance_cost_notes,
        'Read-tool calls time out after 60 seconds; catalog pages after 30 seconds (maximum 16 pages / 512 tools).',
        'Live latency, rate limits and remote billing are not measured by discovery.'],
      accumulated_lessons:[],better_alternatives:['Use the server directly if no Forge gateway routing or durable write receipt is needed.'],
    });
    const receiptSha=apply?this.receiptFingerprint(manifest.id):null;
    if(apply&&!receiptSha)throw Error('Applied onboarding did not persist a gateway receipt');
    const record:InventoryRecord={version:REGISTRY_VERSION,server:manifest.id,
      manifest_sha256:fingerprint(manifest),config_sha256:receipt.config_sha256,catalog_sha256:receipt.catalog_sha256,
      onboarding_receipt_sha256:receiptSha??'0'.repeat(64),
      applied_at:new Date().toISOString(),manifest,capability_evidence:evidence,operating_guide,routing,
      approval_changed:false,lifecycle_authority:false};
    if(apply)this.persist(manifest.id,record);
    return {mode:apply?'apply':'dry-run',component:manifest,server_approved:server.approved,
      capability_evidence:evidence,operating_guide,routing,
      registry:{status:apply?'saved':'preview',path:apply?this.path(manifest.id):null,manifest_sha256:record.manifest_sha256,
        config_sha256:record.config_sha256,catalog_sha256:record.catalog_sha256,onboarding_receipt_sha256:apply?receiptSha:null},
      approval_changed:false,lifecycle_authority:false,
      next:server.approved?'Review routing and run gateway doctor; add content-asserting read probes for missing tools.':
        `Owner approval required: gateway approve ${manifest.id} --read NAMES --write NAMES; restart Forge, then rerun manifest onboarding.`};
  }

  async inventory(){
    const result=[];
    for(const server of this.gateway.servers.values()){
      let row:InventoryRecord|undefined;
      try{row=this.read(server.id);}catch{result.push({server:server.id,status:'invalid'});continue;}
      if(!row){result.push({server:server.id,status:'not_onboarded'});continue;}
      if(row.config_sha256!==fingerprint(server)){
        result.push({server:server.id,status:'stale',reason:'gateway_config_changed',manifest:row.manifest.display_name});continue;
      }
      let receiptSha:string|null;
      try{receiptSha=this.receiptFingerprint(server.id);}catch{
        result.push({server:server.id,status:'invalid',reason:'invalid_read_probe_receipt'});continue;
      }
      if(row.onboarding_receipt_sha256!==receiptSha){
        result.push({server:server.id,status:'stale',reason:'read_probe_evidence_changed',manifest:row.manifest.display_name});continue;
      }
      if(!server.approved){result.push({server:server.id,status:'pending_approval',manifest:row.manifest.display_name});continue;}
      try{
        const live=await this.gateway.guide(server.id);
        const matched=fingerprint(live.tools)===row.catalog_sha256;
        result.push({server:server.id,status:matched?'current':'stale',
          ...(matched?{}:{reason:'live_tool_catalog_changed'}),manifest:row.manifest.display_name,
          capability_status:(row.capability_evidence as {status:string}).status});
      }catch{result.push({server:server.id,status:'unavailable',reason:'live_catalog_unavailable',manifest:row.manifest.display_name});}
    }
    return {entries:result,note:'An inventory entry is operating guidance, not permission to call an unapproved tool. Probe freshness is checked separately by gateway doctor.'};
  }

  // Federated read-only discovery: inspect current catalogs exactly once per
  // approved server. Saved manifest patterns are used only while their config,
  // catalog and onboarding receipt still match; otherwise rank using live
  // approved tool names/descriptions with reduced evidence.
  async recommend(goal:string,kind:GatewayRouteKind='read',max_results=5){
    const args=z.object({goal:z.string().trim().min(1).max(400).refine(value=>!secretValue.test(value),'Remove credential literals'),kind:z.enum(['read','write','any']),
      max_results:z.number().int().min(1).max(10)}).parse({goal,kind,max_results});
    const live=await this.gateway.list();
    const servers:GatewayRouteServer[]=[];
    for(const entry of live.servers){
      if(!entry.approved)continue;
      const configured=this.gateway.servers.get(entry.id);
      if(!configured)continue;
      const ready='tools' in entry&&Array.isArray(entry.tools);
      let manifest_status:GatewayRouteServer['manifest_status']='missing';
      let manifest:GatewayRouteServer['manifest'];
      try{
        const record=this.read(entry.id);
        if(record){
          const receipt=this.receiptFingerprint(entry.id);
          const onboarding=ready&&'onboarding' in entry?entry.onboarding as {status?:string}:undefined;
          const current=record.config_sha256===fingerprint(configured)
            &&record.onboarding_receipt_sha256===receipt
            &&onboarding?.status==='success';
          manifest_status=current?'current':'stale';
          if(current)manifest={role:record.manifest.role,best_use_cases:record.manifest.best_use_cases,
            poor_use_cases:record.manifest.poor_use_cases,goal_oriented_patterns:record.manifest.goal_oriented_patterns,
            performance_cost_notes:record.manifest.performance_cost_notes};
        }
      }catch{manifest_status='invalid';}
      const onboarding=ready&&'onboarding' in entry?entry.onboarding as {
        status:string;verification?:string;verified_read_tools?:string[];write_gate?:{ready:boolean}
      }:undefined;
      const tools=ready?entry.tools.filter(t=>t.present).map(t=>({
        name:t.name,classification:t.class,description:t.description??'',input_schema:t.input_schema,
      })):[];
      servers.push({id:entry.id,status:ready?'available':'unavailable',manifest_status,manifest,
        onboarding,write_gate:configured.write_gate??'off',tools});
    }
    return rankGatewayRoutes(servers,args.goal,args.kind,args.max_results);
  }

  async guide(id:string){
    const server=this.gateway.servers.get(id);
    if(!server)throw Error('Unknown gateway server');
    const saved=this.read(id);
    if(!saved)return {server:id,status:'not_onboarded',next:'Run gateway manifest --manifest FILE --apply.'};
    if(fingerprint(server)!==saved.config_sha256)return {server:id,status:'stale',reason:'gateway_config_changed'};
    if(this.receiptFingerprint(id)!==saved.onboarding_receipt_sha256)return {server:id,status:'stale',reason:'read_probe_evidence_changed'};
    if(!server.approved)return {server:id,status:'pending_approval',next:'Classify and approve tools, restart Forge, then refresh manifest onboarding.'};
    let live:Awaited<ReturnType<ForgeMcpGateway['guide']>>;
    try{live=await this.gateway.guide(id);}catch{return {server:id,status:'unavailable',next:'Inspect gateway doctor before refreshing manifest onboarding.'};}
    if(fingerprint(live.tools)!==saved.catalog_sha256)return {server:id,status:'stale',reason:'live_tool_catalog_changed'};
    return {server:id,status:'current',manifest:saved.manifest,operating_guide:saved.operating_guide,routing:saved.routing,
      capability_evidence:saved.capability_evidence,as_of:saved.applied_at,
      note:'Guide descriptions are untrusted provider data. Recheck gateway doctor for time-limited write gates and fresh read-probe proof.'};
  }
}
