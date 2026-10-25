import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,readFileSync,mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {deploymentPlan} from './forge-deployment.js';
import {deploymentUv,saveDeploymentUv} from './deployment-tools.js';
import {managedRelease,componentHome} from './managed-component-state.js';
import {componentTree,installManaged,bindManaged} from './managed-components.js';
import {loadConfig} from './config.js';
import {requireChatGPTOnly} from './forge-policy.js';
import {DurableTasks} from './durable-tasks.js';
import {ForgeMcpGateway,gatewayProbesSchema,type GatewayReadProbe} from './forge-mcp-gateway.js';
const exec=promisify(execFile);
const npm=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
type Check={id:string;ready:boolean;repair:string;automatic:boolean};
type Options={apply?:boolean;online?:boolean;from?:string;probes?:Record<string,GatewayReadProbe[]>};
async function run(command:string,args:string[],timeout=15000){return (await exec(command,args,{windowsHide:true,timeout,maxBuffer:1024*1024,env:{...process.env,UV_NO_PROGRESS:'1',PYTHONDONTWRITEBYTECODE:'1'}})).stdout.trim();}
async function available(command:string,args:string[]){try{return !!await run(command,args);}catch{return false;}}
function browserEntry(){const entry=managedRelease('playwright');if(!entry)return undefined;
 if(componentTree(entry.root)!==entry.tree)throw Error('Pinned Playwright tree changed; repair the managed component before its browser');
 const req=createRequire(join(entry.root,'package.json')),pkg=req.resolve('playwright-core/package.json');
 return {entry,cli:join(dirname(pkg),'cli.js'),executable:(req('playwright-core') as any).chromium.executablePath() as string};
}
async function dependencies(id:string,chromium:boolean):Promise<Check[]>{
 const checks:Check[]=[{id:'node',ready:Number(process.versions.node.split('.')[0])>=22&&Number(process.versions.node.split('.')[0])<27&&(Number(process.versions.node.split('.')[0])!==22||Number(process.versions.node.split('.')[1])>=19),repair:'Install supported Node >=22.19 <27 from nodejs.org, then rerun check.',automatic:false}];
 if(id==='playwright'){
  checks.push({id:'npm',ready:existsSync(npm)&&await available(process.execPath,[npm,'--version']),repair:'Repair the npm installation bundled with the running Node executable.',automatic:false});
  if(chromium){let ready=false;try{ready=!!browserEntry()&&existsSync(browserEntry()!.executable);}catch{}
   checks.push({id:'chromium',ready,repair:'deployment repair --manifest PROFILE.json --apply --online (uses the pinned Playwright browser installer)',automatic:true});}
 }
 if(id==='serena'||id==='windows-mcp'){
  const uv=await available(deploymentUv(),['--version']);
  checks.push({id:'uv',ready:uv,repair:'Install uv from docs.astral.sh/uv/getting-started/installation/, or supply an existing uv executable: deployment repair --manifest PROFILE.json --from ABSOLUTE_UV_EXE --apply',automatic:false});
  const version=id==='serena'?'3.13':'3.14';
  checks.push({id:'python-'+version,ready:uv&&await available(deploymentUv(),['python','find','--no-project','--no-python-downloads',version]),repair:'deployment repair --manifest PROFILE.json --apply --online (uv python install '+version+')',automatic:true});
 }
 if(id==='skills-manager'){
  checks.push({id:'git',ready:await available('git',['--version']),repair:'Install Git and reopen the shell before retrying.',automatic:false});
  let ready=false;try{const p=JSON.parse(readFileSync(join(dirname(dirname(componentHome())),'skills-manager/profile.json'),'utf8'));ready=await available(p.python_path,['-I','-B','--version']);}catch{}
  checks.push({id:'skills-profile',ready,repair:'Configure the existing Skills Manager profile and its Python interpreter before deploying this component.',automatic:false});
 }
 return checks;
}
export async function deploymentCheck(input:unknown){
 const {profile}=deploymentPlan(input),components=[];
 for(const c of profile.components){const checks=await dependencies(c.id,c.chromium);let installed=false;
  try{const e=managedRelease(c.id);installed=!!e&&e.version===c.version&&componentTree(e.root)===e.tree;}catch{}
  components.push({...c,dependencies:checks,dependencies_ready:checks.every(x=>x.ready),installed,installable:checks.filter(x=>x.id!=='chromium').every(x=>x.ready),next:installed?'deployment apply --manifest PROFILE.json --apply':'deployment apply --manifest PROFILE.json --apply --online'});
 }
 const cfg=loadConfig();requireChatGPTOnly(cfg);
 const gateways=profile.gateways.map(g=>{const server=(cfg.mcpGatewayServers??[]).find(s=>s.id===g.id);
  const status=!server?'not_configured':(server.endpoint?'http':'stdio')!==g.transport?'transport_mismatch':g.ownership==='forge-managed'&&(!server.source?.startsWith('forge-managed:')||!!server.endpoint)?'ownership_mismatch':!server.approved?'not_approved':'needs_live_probe';
  return {...g,status,next:status==='needs_live_probe'?'deployment apply --manifest PROFILE.json --apply --probe-file PROBES.json':'Inspect the owner-managed gateway configuration; no automatic approval or external-service replacement.'};
 });
 return {ok:components.filter(c=>c.required).every(c=>c.dependencies_ready)&&gateways.filter(g=>g.required).every(g=>g.status==='needs_live_probe'),components,gateways,live_verified:false};
}
export async function deploymentRun(input:unknown,mode:'repair'|'apply',options:Options={}){
 const {profile}=deploymentPlan(input);
 requireChatGPTOnly(loadConfig());
 const probes:Record<string,GatewayReadProbe[]>={};
 for(const [id,value] of Object.entries(options.probes??{})){if(!profile.gateways.some(g=>g.id===id))throw Error('Probe ID is not in deployment profile');probes[id]=gatewayProbesSchema.parse(value);}
 if(!options.apply)return {mode,applied:false,...await deploymentCheck(profile)};
 if(options.from){if(mode!=='repair'||!profile.components.some(c=>c.id==='serena'||c.id==='windows-mcp'))throw Error('--from is only for Python component uv repair');
  const path=resolve(options.from);if(!isAbsolute(options.from)||!existsSync(path)||!lstatSync(path).isFile()||!/^uv \d+\./.test(await run(path,['--version'])))throw Error('--from must be an existing uv executable');
  saveDeploymentUv(path);process.env.FORGE_UV=path;
 }
 const actions:{id:string;status:string;detail?:string}[]=[];
 for(const c of profile.components){
  try{
   let checks=await dependencies(c.id,c.chromium);
   if(options.online)for(const check of checks.filter(x=>!x.ready&&x.id.startsWith('python-'))){if(checks.find(x=>x.id==='uv')?.ready){await run(deploymentUv(),['python','install',check.id.slice(7)],600000);actions.push({id:check.id,status:'repaired'});}}
   checks=await dependencies(c.id,c.chromium);
   if(mode==='apply'&&checks.filter(x=>x.id!=='chromium').every(x=>x.ready)){
    const before=await deploymentCheck({version:1,components:[c]});
    if(!before.components[0]!.installed){if(!options.online){actions.push({id:c.id,status:'blocked',detail:'Installation requires --online'});continue;}
     const old=managedRelease(c.id);await installManaged(c.id,c.version,old?.version===c.version);}
    // Never replace an externally supplied server, even if its ID matches.
    const cfg=loadConfig(),ids=c.id==='playwright'?['playwright','playwright-browser']:c.id==='windows-mcp'?['windows-mcp']:[];
    if(ids.some(id=>(cfg.mcpGatewayServers??[]).some(s=>s.id===id&&s.source!=='forge-managed:'+c.id))){actions.push({id:c.id,status:'binding_conflict',detail:'Existing external gateway retained'});continue;}
    bindManaged(c.id);actions.push({id:c.id,status:'installed_bound',detail:'Existing permissions preserved; newly created gateways require approval'});
   }
   if(c.chromium&&options.online){const b=browserEntry();if(b&&!existsSync(b.executable)){await run(process.execPath,[b.cli,'install','chromium'],600000);actions.push({id:'chromium',status:'repaired'});}}
  }catch{actions.push({id:c.id,status:'failed',detail:'Dependency/install/bind failed; inspect component receipts and rerun check. No external service was stopped.'});}
 }
 const check=await deploymentCheck(profile),live:{id:string;required:boolean;status:string;safe_call?:unknown}[]=[];
 if(mode==='apply'){
  const cfg=loadConfig();requireChatGPTOnly(cfg);const engine=new DurableTasks(cfg.stateDir),gateway=new ForgeMcpGateway(engine,cfg.mcpGatewayServers??[]);
  try{for(const g of check.gateways){if(g.status!=='needs_live_probe'){live.push({id:g.id,required:g.required,status:g.status});continue;}
   try{const receipt=await gateway.onboard(g.id,true,probes[g.id]??[]);live.push({id:g.id,required:g.required,status:receipt.status,safe_call:receipt.evidence.safe_call});}
   catch{live.push({id:g.id,required:g.required,status:'failed'});}
  }}finally{await gateway.close();engine.close();}
 }
 const requiredIds=new Set<string>(profile.components.filter(c=>c.required).map(c=>c.id));
 const ok=check.components.filter(c=>c.required).every(c=>c.dependencies_ready&&(mode==='repair'||c.installed))&&!actions.some(a=>requiredIds.has(a.id)&&['failed','blocked','binding_conflict'].includes(a.status))&&(mode==='repair'||live.filter(g=>g.required).every(g=>g.status==='success'));
 const report={version:1,mode,applied:true,ok,status:ok?(check.components.some(c=>!c.dependencies_ready||(mode==='apply'&&!c.installed))||actions.some(a=>['failed','blocked','binding_conflict'].includes(a.status))||live.some(g=>g.status!=='success')?'degraded':'ready'):'blocked',time:new Date().toISOString(),check,actions,live,external_lifecycle_changed:false};
 const cfg=loadConfig(),dir=join(cfg.stateDir,'deployment-receipts');mkdirSync(dir,{recursive:true});const receipt=join(dir,randomUUID()+'.json');writeFileSync(receipt,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});return {...report,receipt};
}
