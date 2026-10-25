import {existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,renameSync} from 'node:fs';
import {join,dirname,relative,resolve,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {compatibleComponentVersion} from './managed-components.js';
import {loadConfig} from './config.js';
import {requireChatGPTOnly} from './forge-policy.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function exportDeployment(destination:string,source=root){
  const dest=resolve(destination),rel=relative(source,dest);
  if(!rel||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)))throw Error('Export outside the runtime directory');
  if(existsSync(dest))throw Error('Destination exists; use a new release directory');
  const stage=dest+'.partial-'+randomUUID();mkdirSync(stage,{recursive:true});
  const files:{path:string,sha256:string,bytes:number}[]=[];
  const add=(from:string,path:string)=>{
    const stat=lstatSync(from);if(stat.isSymbolicLink()||!stat.isFile())throw Error('Release files must be regular files: '+path);
    const data=readFileSync(from);mkdirSync(dirname(join(stage,path)),{recursive:true});copyFileSync(from,join(stage,path));
    files.push({path,sha256:digest(data),bytes:data.length});
  };
  const visit=(path:string)=>{
    for(const name of readdirSync(join(source,path)).sort()){
      if(name.startsWith('.')||name==='node_modules'||name==='__pycache__'||/staging|\.test\.|\.pyc$|\.log$/i.test(name))continue;
      const next=join(path,name),stat=lstatSync(join(source,next));
      if(stat.isSymbolicLink())throw Error('Release cannot contain symbolic links: '+next);
      if(stat.isDirectory())visit(next);else if(stat.isFile())add(join(source,next),'runtime/'+next.replaceAll('\\','/'));
    }
  };
  for(const file of ['package.json','package-lock.json','LICENSE','UPSTREAM.md','README.md'])add(join(source,file),'runtime/'+file);
  for(const dir of ['bin','dist','docs','examples','schema','scripts','skills/forge-operation'])if(existsSync(join(source,dir)))visit(dir);
  if(existsSync(join(source,'native')))for(const file of readdirSync(join(source,'native')).filter(f=>f.endsWith('.cpp')))add(join(source,'native',file),'runtime/native/'+file);
  for(const file of ['dist/forge-cli.js','bin/chatgptforge.js','scripts/fix-node-pty-permissions.mjs'])if(!files.some(f=>f.path==='runtime/'+file))throw Error('Build is incomplete: '+file);
  add(join(source,'scripts/deployment-setup.mjs'),'setup.mjs');
  const manifest={version:1,product:'chatgptforge',release:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version,platform:'win32',node:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).engines.node,files};
  const data=JSON.stringify(manifest,null,2)+'\n';writeFileSync(join(stage,'manifest.json'),data);renameSync(stage,dest);
  return {directory:dest,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),manifest_sha256:digest(Buffer.from(data)),next:'node setup.mjs --help',includes_user_state:false};
}
export const profileSchema=z.object({version:z.literal(1),components:z.array(z.object({id:z.enum(['playwright','serena','windows-mcp','skills-manager']),version:z.string().min(1),required:z.boolean().default(true),chromium:z.boolean().default(false)}).strict()).max(4).default([]),gateways:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),transport:z.enum(['stdio','http']),ownership:z.enum(['forge-managed','external']),required:z.boolean().default(false)}).strict()).max(32).default([])}).strict();
export function deploymentPlan(input:unknown){
  const profile=profileSchema.parse(input);
  if(new Set(profile.components.map(x=>x.id)).size!==profile.components.length||new Set(profile.gateways.map(x=>x.id)).size!==profile.gateways.length)throw Error('Duplicate component or gateway ID');
  for(const c of profile.components)if(!compatibleComponentVersion(c.id,c.version))throw Error('Unreviewed component version: '+c.id);
  for(const c of profile.components)if(c.chromium&&c.id!=='playwright')throw Error('chromium is only valid for playwright');
  return {profile,steps:[{stage:'core',commands:['node setup.mjs --check','node setup.mjs --apply --workspace PATH --config-dir NEW_CONFIG --public-url HTTPS_ORIGIN'],gate:'install receipt and local authenticated MCP readiness'},...profile.components.map(c=>({stage:c.id,commands:[`chatgptforge components external-install ${c.id} --version ${c.version}`,`chatgptforge components external-bind ${c.id}`],gate:'pinned tree plus real capability probe; installed is not authenticated or GUI-approved'})),...profile.gateways.map(g=>({stage:g.id,commands:[`chatgptforge gateway onboard ${g.id}`],gate:g.required?'configured, approved, handshake and explicit safe probe must pass':'optional; report skipped separately',lifecycle:g.ownership==='external'?'Do not stop, replace or install the external service':'Only manage the receipt-owned component'}))],acceptance:'Read-only independent providers may coexist; all GUI mutations serialize; unknown writes require receipt/post-state recovery. No step executes automatically.'};
}
export function deploymentInventory(){
  const cfg=loadConfig();requireChatGPTOnly(cfg);
  return {node:process.versions.node,platform:process.platform,core_configured:true,gateways:(cfg.mcpGatewayServers??[]).map(g=>({id:g.id,transport:g.endpoint?'http':'stdio',approved:g.approved,read_tools:g.read_tools,write_tools:g.write_tools,credential_source:g.bearer_env?'environment':g.oauth?'oauth':g.env_from?'external-config':'none',status:g.approved?'needs_live_probe':'not_enabled'})),next:'Use gateway onboard ID for live catalog/probe evidence. Inventory does not contact services or print credentials.'};
}

export function exportOperationGuide(destination:string,source=root){
  const dest=resolve(destination),rel=relative(source,dest);
  if(!rel||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)))throw Error('Export guide outside the runtime directory');
  if(existsSync(dest))throw Error('Guide destination exists');
  const stage=dest+'.partial-'+randomUUID();mkdirSync(stage,{recursive:true});
  const copy=(folder:string,prefix='')=>{for(const name of readdirSync(folder).sort()){
    const from=join(folder,name),stat=lstatSync(from),to=join(stage,prefix,name);
    if(stat.isSymbolicLink())throw Error('Guide cannot contain symbolic links');
    if(stat.isDirectory()){mkdirSync(to);copy(from,join(prefix,name));}
    else if(stat.isFile()){let text=readFileSync(from,'utf8');if(name==='SKILL.md')text=text.replace('../../docs/deployment.md','references/deployment-runbook.md');writeFileSync(to,text);}
  }};
  copy(join(source,'skills/forge-operation'));
  writeFileSync(join(stage,'references/deployment-runbook.md'),readFileSync(join(source,'docs/deployment.md'),'utf8').replace('../examples/deployment-profile.json','deployment-profile.json').replace('../skills/forge-operation/SKILL.md','../SKILL.md'));
  copyFileSync(join(source,'examples/deployment-profile.json'),join(stage,'references/deployment-profile.json'));
  renameSync(stage,dest);return {directory:dest,entrypoint:'SKILL.md',self_contained:true,credentials_included:false};
}
