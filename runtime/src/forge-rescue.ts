import {execFile,spawn as spawnChild} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

// Forge rescue supervisor: a separate long-lived process that observes the
// Forge server, the Forge Tunnel and the optional Skills service, and recovers
// a failed component only through the existing start scripts (a fixed
// allowlist). Healthy components are never restarted; each recovery has an
// attempt budget, backoff and post-state verification, and one supervisor at a
// time owns recovery (lock file). Every observation that leads to an action is
// written as a receipt.
const run=promisify(execFile);
import {createRemoteRescueApp,loadRemoteRescueConfig} from './forge-rescue-mcp.js';
export type ComponentId='skills'|'forge'|'tunnel';
export interface Probe {healthy:boolean;detail:string}
export interface RescueHooks {
  probe(id:ComponentId):Promise<Probe>;
  recover(id:ComponentId):Promise<{ok:boolean;detail:string}>;
  now():number;
  sleep(ms:number):Promise<void>;
}
export interface RescueOptions {stateDir:string;components:ComponentId[];maxAttempts?:number;backoffMs?:number[];cooldownMs?:number}
export interface RescueReceipt {time:string;component:ComponentId;observed:string;action:'recover'|'skipped_cooldown'|'budget_exhausted';result?:'recovered'|'failed';detail:string;attempt:number}

export class ForgeRescue {
  private attempts=new Map<ComponentId,{count:number;since:number}>();
  constructor(private hooks:RescueHooks,private options:RescueOptions){mkdirSync(join(options.stateDir,'rescue'),{recursive:true});}
  get receiptsPath(){return join(this.options.stateDir,'rescue','receipts.jsonl');}
  private record(receipt:RescueReceipt){appendFileSync(this.receiptsPath,JSON.stringify(receipt)+'\n','utf8');return receipt;}

  // One pass in dependency order. A component whose dependency is unhealthy
  // after recovery is not touched in the same pass.
  async tick():Promise<{status:Record<string,Probe>;receipts:RescueReceipt[]}> {
    const status:Record<string,Probe>={},receipts:RescueReceipt[]=[];
    const max=this.options.maxAttempts??3,backoff=this.options.backoffMs??[0,30_000,120_000],cooldown=this.options.cooldownMs??30*60_000;
    for(const id of this.options.components){
      if(id==='tunnel'&&status.forge&&!status.forge.healthy){status.tunnel={healthy:false,detail:'waiting for forge'};continue;}
      let probe=await this.hooks.probe(id);
      if(probe.healthy){this.attempts.delete(id);status[id]=probe;continue;}
      const now=this.hooks.now(),state=this.attempts.get(id)??{count:0,since:now};
      if(now-state.since>cooldown){state.count=0;state.since=now;}
      if(state.count>=max){receipts.push(this.record({time:new Date(now).toISOString(),component:id,observed:probe.detail,action:'budget_exhausted',detail:`${max} recovery attempts used; waiting for the cooldown or an operator`,attempt:state.count}));status[id]=probe;continue;}
      const wait=backoff[Math.min(state.count,backoff.length-1)]!;
      if(state.count>0&&now-state.since<wait){receipts.push(this.record({time:new Date(now).toISOString(),component:id,observed:probe.detail,action:'skipped_cooldown',detail:`next attempt after ${wait} ms`,attempt:state.count}));status[id]=probe;continue;}
      state.count++;this.attempts.set(id,state);
      const observed=probe.detail,result=await this.hooks.recover(id);
      // Post-state is authoritative: a script error with a healthy component is
      // still recovered, a clean exit with an unhealthy component is not.
      probe=await this.hooks.probe(id);
      receipts.push(this.record({time:new Date(this.hooks.now()).toISOString(),component:id,observed,action:'recover',result:probe.healthy?'recovered':'failed',detail:(result.ok?'script ok':'script failed: '+result.detail.slice(0,400))+'; post-state '+probe.detail,attempt:state.count}));
      if(probe.healthy)this.attempts.delete(id);
      status[id]=probe;
    }
    return {status,receipts};
  }
}

// Exclusive ownership of recovery on this machine.
export function acquireRescueLock(stateDir:string){
  const path=join(stateDir,'rescue','owner.lock');mkdirSync(join(stateDir,'rescue'),{recursive:true});
  if(existsSync(path)){
    const owner=Number(readFileSync(path,'utf8').trim());
    try{process.kill(owner,0);throw Error('Another rescue supervisor (PID '+owner+') owns recovery');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;rmSync(path,{force:true});}
  }
  const fd=openSync(path,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);
  return ()=>{try{if(readFileSync(path,'utf8').trim()===String(process.pid))rmSync(path,{force:true});}catch{}};
}

// Production probes and the fixed recovery allowlist.
export function productionHooks(stateDir:string,mcpPort:number,skillsEndpoint:string|null):RescueHooks{
  const scripts=resolve(fileURLToPath(new URL('../../scripts/',import.meta.url)));
  const script:Record<ComponentId,string>={skills:'Start-ForgeSkills.ps1',forge:'Start-Forge.ps1',tunnel:'Start-ForgeTunnel.ps1'};
  const fetchStatus=async(url:string,init?:RequestInit)=>{try{const r=await fetch(url,{...init,signal:AbortSignal.timeout(8000)});await r.body?.cancel();return r.status;}catch{return 0;}};
  return {
    now:()=>Date.now(),
    sleep:ms=>new Promise(r=>setTimeout(r,ms)),
    async probe(id){
      if(id==='forge'){const status=await fetchStatus(`http://127.0.0.1:${mcpPort}/mcp`);return {healthy:status===401||status===405,detail:'mcp http '+status};}
      if(id==='tunnel'){
        let health='';try{health=readFileSync(join(stateDir,'tunnel','health.url'),'utf8').trim();}catch{return {healthy:false,detail:'no tunnel health url'};}
        const status=await fetchStatus(health+'/healthz');return {healthy:status===200,detail:'tunnel health '+status};
      }
      if(!skillsEndpoint)return {healthy:true,detail:'not configured'};
      const status=await fetchStatus(skillsEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
      return {healthy:status===200,detail:'skills http '+status};
    },
    async recover(id){return runScript(join(scripts,script[id]));},
  };
}
async function runScript(path:string){
  try{const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path],{timeout:240_000,windowsHide:true});return {ok:true,detail:stdout.trim().slice(-400)};}
  catch(error){return {ok:false,detail:String((error as {stderr?:string}).stderr??error).slice(-400)};}
}
// Restart = the component's fixed stop script, then its fixed start script.
export async function productionRestart(id:ComponentId){
  const scripts=resolve(fileURLToPath(new URL('../../scripts/',import.meta.url)));
  const names:Record<ComponentId,[string,string]>={skills:['Stop-ForgeSkills.ps1','Start-ForgeSkills.ps1'],forge:['Stop-Forge.ps1','Start-Forge.ps1'],tunnel:['Stop-ForgeTunnel.ps1','Start-ForgeTunnel.ps1']};
  const stop=await runScript(join(scripts,names[id][0]));
  const start=await runScript(join(scripts,names[id][1]));
  return {ok:stop.ok&&start.ok,detail:'stop '+(stop.ok?'ok':stop.detail)+'; start '+(start.ok?'ok':start.detail)};
}

// Keeps the outbound-only rescue tunnel client running (separate from the main
// Forge tunnel); restarts it with backoff if it exits.
export function superviseRescueTunnel(stateDir:string,spawnClient:(profile:string)=>{once(event:'exit',cb:(code:number|null)=>void):void}=defaultTunnelSpawn,retryMs=30_000){
  const profile=join(stateDir,'rescue','tunnel','profile.json');
  if(!existsSync(profile))return false;
  const start=()=>{const child=spawnClient(profile);child.once('exit',code=>{appendFileSync(join(stateDir,'rescue','receipts.jsonl'),JSON.stringify({time:new Date().toISOString(),component:'rescue-tunnel',action:'exited',detail:'exit '+code+'; restarting in '+retryMs+' ms'})+'\n');setTimeout(start,retryMs);});};
  start();return true;
}
function defaultTunnelSpawn(profile:string){
  const exe=resolve(fileURLToPath(new URL('../../.tools/openai-tunnel-v0.0.16/tunnel-client-runtime.exe',import.meta.url)));
  return spawnChild(exe,['run','--config',profile],{stdio:'ignore',windowsHide:true});
}
export async function runRescue(stateDir:string,mcpPort:number,skillsEndpoint:string|null,intervalMs=30_000,statusPort=8770){
  const release=acquireRescueLock(stateDir);
  const components:ComponentId[]=skillsEndpoint?['skills','forge','tunnel']:['forge','tunnel'];
  const rescue=new ForgeRescue(productionHooks(stateDir,mcpPort,skillsEndpoint),{stateDir,components});
  let last:{time:string;status:Record<string,Probe>}={time:'',status:{}};
  const server=createServer((req,res)=>{
    if(req.url!=='/status'){res.statusCode=404;res.end();return;}
    let receipts:string[]=[];try{receipts=readFileSync(rescue.receiptsPath,'utf8').trim().split('\n').slice(-20);}catch{}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({pid:process.pid,last,receipts:receipts.filter(Boolean).map(r=>JSON.parse(r))}));
  });
  server.listen(statusPort,'127.0.0.1');
  // Optional independent remote rescue line (off unless remote.json enables it).
  const remote=loadRemoteRescueConfig(stateDir);
  let remoteServer:ReturnType<typeof createServer>|undefined;
  if(remote?.enabled){
    const {app}=createRemoteRescueApp(remote,{stateDir,components,hooks:productionHooks(stateDir,mcpPort,skillsEndpoint),restart:productionRestart,status:()=>last});
    remoteServer=app.listen(remote.port,'127.0.0.1');
    if(remote.transport==='tunnel')superviseRescueTunnel(stateDir);
  }
  const stop=()=>{release();server.close();remoteServer?.close();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let lastUpdateCheck=0;
  for(;;){
    const {status}=await rescue.tick();last={time:new Date().toISOString(),status};
    // Opt-in component maintenance (off by default): periodic official update
    // check, and repair of damaged pinned components only if autoRepair is on.
    try{
      const {loadUpdateConfig,checkUpdates,repairComponents,productionRepairHooks}=await import('./forge-updates.js');
      const updates=loadUpdateConfig(stateDir);
      if(updates.enabled&&Date.now()-lastUpdateCheck>updates.checkIntervalHours*3600_000){
        lastUpdateCheck=Date.now();
        mkdirSync(join(stateDir,'components'),{recursive:true});
        writeFileSync(join(stateDir,'components','updates-available.json'),JSON.stringify(await checkUpdates(),null,2)+'\n');
        if(updates.autoRepair)await repairComponents(updates,productionRepairHooks(),join(stateDir,'components','receipts.jsonl'));
      }
    }catch(error){appendFileSync(join(stateDir,'rescue','receipts.jsonl'),JSON.stringify({time:new Date().toISOString(),component:'components',action:'update_check_failed',detail:String(error).slice(0,300)})+'\n');}
    await new Promise(r=>setTimeout(r,intervalMs));
  }
}
