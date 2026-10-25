import {execFile} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import * as z from 'zod/v4';
import {verifyComponents, type ComponentReport} from './forge-components.js';
import {serenaLanguagesHome, serenaPython} from './serena-workspace-edit.js';

// Component updates, opt-in and off by default.
// - checkUpdates reads official release metadata (npm registry, PyPI, Go module
//   proxy, GitHub releases) and reports newer versions than Forge pins. A newer
//   version is a prompt for a reviewed pin change, never installed silently:
//   Forge's code checks exact versions and digests.
// - repair restores pinned language trees from a verified content cache.
//   Other adapters re-fetch the pinned package from its official source.
//   Every result must pass verification; language replacement is transactional.
export const updateConfigSchema=z.object({
  enabled:z.boolean().default(false),
  autoRepair:z.boolean().default(false),
  checkIntervalHours:z.number().int().min(1).max(720).default(24),
  allowUpgrade:z.boolean().default(false),
}).strict();
export type UpdateConfig=z.infer<typeof updateConfigSchema>;
const run=promisify(execFile);
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));

export interface Source {id:string;pinned:string;latest:()=>Promise<{version:string;digest?:string;url?:string}>}
export function officialSources(fetchJson:(url:string)=>Promise<unknown>=defaultFetchJson):Source[]{
  const pinnedPyright=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {dependencies:Record<string,string>}).dependencies.pyright!;
  const goLock=JSON.parse(readFileSync(join(scripts,'go-analysis','backend-lock.json'),'utf8')) as {gopls_version:string};
  const languageLock=JSON.parse(readFileSync(join(scripts,'serena-analysis','languages-lock.json'),'utf8')) as {languages:Record<string,{version?:string}>};
  const npmSource=(id:string,pkg:string,language:string,fallback:string):Source=>({id,pinned:languageLock.languages[language]?.version??fallback,latest:async()=>{const r=await fetchJson(`https://registry.npmjs.org/${pkg}/latest`) as {version:string;dist:{integrity:string;tarball:string}};return {version:r.version,digest:r.dist.integrity,url:r.dist.tarball};}});
  const github=(repo:string)=>async()=>{const r=await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`) as {tag_name:string;html_url:string};return {version:r.tag_name.replace(/^v/,''),url:r.html_url};};
  return [
    {id:'pyright',pinned:pinnedPyright,latest:async()=>{const r=await fetchJson('https://registry.npmjs.org/pyright/latest') as {version:string;dist:{integrity:string;tarball:string}};return {version:r.version,digest:r.dist.integrity,url:r.dist.tarball};}},
    {id:'serena',pinned:'1.7.0',latest:async()=>{const r=await fetchJson('https://pypi.org/pypi/serena-agent/json') as {info:{version:string};urls:{packagetype:string;digests:{sha256:string};url:string}[]};const wheel=r.urls.find(u=>u.packagetype==='bdist_wheel');return {version:r.info.version,...(wheel?{digest:'sha256:'+wheel.digests.sha256,url:wheel.url}:{})};}},
    {id:'gopls',pinned:goLock.gopls_version.replace(/^v/,''),latest:async()=>{const r=await fetchJson('https://proxy.golang.org/golang.org/x/tools/gopls/@latest') as {Version:string};return {version:r.Version.replace(/^v/,'')};}},
    {id:'serena-lua',pinned:languageLock.languages.lua?.version??'3.15.0',latest:github('LuaLS/lua-language-server')},
    {id:'serena-clangd',pinned:languageLock.languages.cpp?.version??'19.1.2',latest:github('clangd/clangd')},
    npmSource('serena-bash','bash-language-server','bash','5.6.0'),
    npmSource('serena-php','intelephense','php','1.14.4'),
  ];
}
async function defaultFetchJson(url:string){const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'chatgptforge-update-check'},signal:AbortSignal.timeout(20_000)});if(!r.ok)throw Error(url+' -> HTTP '+r.status);return r.json();}
const newer=(a:string,b:string)=>{const p=(v:string)=>v.split(/[.-]/).map(x=>Number.parseInt(x,10)||0);const x=p(a),y=p(b);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]??0)!==(y[i]??0))return (x[i]??0)>(y[i]??0);}return false;};

export async function checkUpdates(sources=officialSources()){
  const results=[];
  for(const s of sources){
    try{const l=await s.latest();results.push({id:s.id,pinned:s.pinned,latest:l.version,update_available:newer(l.version,s.pinned),official_digest:l.digest??null,source:l.url??null});}
    catch(error){results.push({id:s.id,pinned:s.pinned,error:String(error).slice(0,300)});}
  }
  return {checked:new Date().toISOString(),note:'A newer version needs a reviewed pin change in Forge before use; nothing was downloaded.',components:results};
}

export interface RepairHooks {
  verify():Promise<{components:ComponentReport[]}>;
  // Re-fetch exactly the pinned version from the official source.
  reinstall(id:string):Promise<{ok:boolean;detail:string}>;
  quarantine(id:string):Promise<string|null>;
}
export function productionRepairHooks():RepairHooks{
  const python=serenaPython();
  return {
    verify:async()=>verifyComponents(),
    async reinstall(id){
      try{
        if(id==='serena'){
          const uv=process.env.FORGE_UV??'uv';
          const r=await run(uv,['tool','install','--force','serena-agent==1.7.0'],{timeout:900_000,windowsHide:true});return {ok:true,detail:r.stdout.slice(-300)};
        }
        if(id==='serena-languages'){
          const {repairLanguageTrees}=await import('./language-tree-cache.js');
          const {productionUpgradeHooks}=await import('./forge-upgrades.js');
          const result=await repairLanguageTrees({lockPath:join(scripts,'serena-analysis','languages-lock.json'),home:serenaLanguagesHome(),cache:join(homedir(),'.chatgptforge','components','language-cache'),digest:productionUpgradeHooks().treeDigest});
          return {ok:true,detail:JSON.stringify(result)};
        }
        return {ok:false,detail:'No automatic official source for '+id+'; use its documented install command'};
      }catch(error){return {ok:false,detail:String((error as {stderr?:string}).stderr??error).slice(-400)};}
    },
    async quarantine(id){
      // Language repair stages and verifies every tree, then rolls back on
      // failure. Never quarantine the whole shared home after a later check.
      return null;
    },
  };
}
export async function repairComponents(config:UpdateConfig,hooks:RepairHooks,receiptsPath=join(homedir(),'.chatgptforge','components','receipts.jsonl'),only?:string){
  if(!config.enabled)throw Error('Component updates are off. Turn them on with: forge-cli components updates on (repairs re-fetch pinned versions from official sources).');
  mkdirSync(join(receiptsPath,'..'),{recursive:true});
  const before=(await hooks.verify()).components.filter(c=>(c.state==='missing'||c.state==='mismatch')&&(!only||c.id===only));
  const receipts=[];
  for(const c of before){
    const started=new Date().toISOString();
    appendFileSync(receiptsPath,JSON.stringify({time:started,id:c.id,action:'repair',state:'started',observed:c.state+': '+c.detail})+'\n');
    const result=await hooks.reinstall(c.id);
    const after=(await hooks.verify()).components.find(x=>x.id===c.id);
    const accepted=result.ok&&after?.state==='verified';
    const quarantined=!accepted&&result.ok?await hooks.quarantine(c.id):null;
    const receipt={time:new Date().toISOString(),id:c.id,action:'repair',state:accepted?'repaired':'failed',observed:c.state,after:after?.state??'unknown',detail:result.detail.slice(0,300),...(quarantined?{quarantined}:{})};
    appendFileSync(receiptsPath,JSON.stringify(receipt)+'\n');receipts.push(receipt);
  }
  return {checked:before.length,receipts};
}

export function loadUpdateConfig(stateDir=join(homedir(),'.chatgptforge')):UpdateConfig{
  const path=join(stateDir,'components','updates.json');
  return updateConfigSchema.parse(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{});
}
export function saveUpdateConfig(config:UpdateConfig,stateDir=join(homedir(),'.chatgptforge')){
  const dir=join(stateDir,'components');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'updates.json'),JSON.stringify(updateConfigSchema.parse(config),null,2)+'\n');
}
