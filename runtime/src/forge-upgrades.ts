import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {loadUpdateConfig, type UpdateConfig} from './forge-updates.js';
import {serenaLanguagesHome, serenaPython} from './serena-workspace-edit.js';

// Opt-in component upgrades (off by default; `components updates on --allow-upgrade`).
// One upgrade: fetch the release metadata from the official source, download
// the asset and check it against the official SHA-256 (refused if none is
// published), extract it beside the current install, swap it in, run a real
// acceptance test, and keep it only if the test passes; otherwise restore the
// previous install and pin automatically. Every step writes a receipt.
const run=promisify(execFile);
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

export interface UpgradeAdapter {
  id:string;
  asset(version:string):{repo:string;tag:string;name:string};
  resourceDir:string;           // directory replaced by the upgrade
  lockLanguage:string;          // languages-lock.json entry re-pinned on success
  extractDir?:string;
  npmPackage?:string;
  acceptance():Promise<{ok:boolean;detail:string}>;
}
export interface UpgradeHooks {
  fetchJson(url:string):Promise<unknown>;
  download(url:string):Promise<Buffer>;
  extract(zip:string,into:string):Promise<void>;
  treeDigest(dir:string):Promise<{sha256:string;files:number;bytes:number}>;
  installNpm?(archive:string,into:string):Promise<void>;
}

export function luaAdapter(home=serenaLanguagesHome()):UpgradeAdapter{
  return {
    id:'serena-lua',
    asset:v=>({repo:'LuaLS/lua-language-server',tag:v,name:`lua-language-server-${v}-win32-x64.zip`}),
    resourceDir:join(home,'language_servers','static','LuaLanguageServer'),
    lockLanguage:'lua',
    acceptance:async()=>{
      // Real cross-file Lua rename through Forge's private Serena run.
      const {planSerenaRename}=await import('./serena-workspace-edit.js');
      const {mkdtempSync,writeFileSync:w}=await import('node:fs');
      const root=mkdtempSync(join(tmpdir(),'forge-upgrade-lua-'));
      try{
        w(join(root,'calc.lua'),'local M = {}\nfunction M.add(a, b)\n  return a - b\nend\nreturn M\n');
        w(join(root,'main.lua'),'local calc = require("calc")\nprint(calc.add(1, 2))\n');
        const plan=await planSerenaRename({root,language:'lua',file:'calc.lua',line:2,column:12,new_name:'sum'});
        const files=plan.files.map(f=>f.file).join(',');
        return {ok:files==='calc.lua,main.lua',detail:'cross-file rename files: '+files};
      }catch(error){return {ok:false,detail:String(error).slice(0,400)};}
      finally{rmSync(root,{recursive:true,force:true,maxRetries:5});}
    },
  };
}
export function languageAdapter(language:'cpp'|'bash'|'php',home=serenaLanguagesHome()):UpgradeAdapter {
  const spec={cpp:{id:'serena-clangd',dir:'ClangdLanguageServer',sub:'clangd',file:'main.cpp',code:'int add(int a,int b) { return a-b; }\n',body:'int add(int a,int b) { return a+b; }'},bash:{id:'serena-bash',dir:'BashLanguageServer',sub:'bash-lsp',file:'main.sh',code:'add() { echo 1; }\nadd\n',body:'add() { echo 2; }'},php:{id:'serena-php',dir:'Intelephense',sub:'php-lsp',file:'main.php',code:'<?php\nfunction add($a,$b) { return $a-$b; }\n',body:'function add($a,$b) { return $a+$b; }'}}[language];
  return {id:spec.id,resourceDir:join(home,'language_servers','static',spec.dir),lockLanguage:language,extractDir:spec.sub,
    ...(language==='cpp'?{}:{npmPackage:language==='bash'?'bash-language-server':'intelephense'}),
    asset:v=>({repo:'clangd/clangd',tag:v,name:`clangd-windows-${v}.zip`}),
    acceptance:async()=>{
      const {mkdtempSync}=await import('node:fs');const {planSerenaSymbolEdit}=await import('./serena-workspace-edit.js');
      const root=mkdtempSync(join(tmpdir(),'forge-upgrade-'+language+'-'));
      try{writeFileSync(join(root,spec.file),spec.code);const plan=await planSerenaSymbolEdit({root,language,file:spec.file,name_path:'add',operation:'replace_body',body:spec.body});return {ok:plan.files.length===1&&plan.files[0]?.file===spec.file,detail:'Private Serena symbol edit: '+plan.files.map(f=>f.file).join(',')};}
      catch(error){return {ok:false,detail:String(error).slice(0,400)};}
      finally{rmSync(root,{recursive:true,force:true,maxRetries:5});}
    }};
}
export const UPGRADE_ADAPTERS:Record<string,()=>UpgradeAdapter>={'serena-lua':()=>luaAdapter(),'serena-clangd':()=>languageAdapter('cpp'),'serena-bash':()=>languageAdapter('bash'),'serena-php':()=>languageAdapter('php')};

export function productionUpgradeHooks():UpgradeHooks{
  return {
    fetchJson:async url=>{const r=await fetch(url,{headers:{Accept:new URL(url).hostname==='api.github.com'?'application/vnd.github+json':'application/json','User-Agent':'chatgptforge-upgrade'},signal:AbortSignal.timeout(30_000)});if(!r.ok)throw Error(url+' -> HTTP '+r.status);return r.json();},
    download:async url=>{const r=await fetch(url,{headers:{'User-Agent':'chatgptforge-upgrade'},redirect:'follow',signal:AbortSignal.timeout(600_000)});if(!r.ok)throw Error('download HTTP '+r.status);return Buffer.from(await r.arrayBuffer());},
    extract:async(zip,into)=>{mkdirSync(into,{recursive:true});await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]',zip,into],{timeout:600_000,windowsHide:true});},
    installNpm:async(archive,into)=>{
      mkdirSync(into,{recursive:true});
      const npm=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
      if(!existsSync(npm))throw Error('npm CLI not found beside Node');
      await run(process.execPath,[npm,'install','--prefix',into,'--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org',archive],{timeout:600_000,windowsHide:true});
    },
    treeDigest:async dir=>{
      const code='import json,sys,hashlib,pathlib\nd=pathlib.Path(sys.argv[1]);h=hashlib.sha256();n=0;b=0\nfor p in sorted(x for x in d.rglob("*") if x.is_file()):\n  data=p.read_bytes();h.update(p.relative_to(d).as_posix().encode()+b"\\0"+hashlib.sha256(data).digest());n+=1;b+=len(data)\nprint(json.dumps({"sha256":h.hexdigest(),"files":n,"bytes":b}))';
      return JSON.parse((await run(serenaPython(),['-I','-c',code,dir],{timeout:300_000,windowsHide:true})).stdout) as {sha256:string;files:number;bytes:number};
    },
  };
}

type UpgradeOptions={config?:UpdateConfig;adapter?:UpgradeAdapter;hooks?:UpgradeHooks;lockPath?:string;receipts?:string};
export async function upgradeComponent(id:string,version:string,options:UpgradeOptions={}){
  const mutex=(options.lockPath??join(scripts,'serena-analysis','languages-lock.json'))+'.install.lock';
  const fd=openSync(mutex,'wx');
  try{return await performUpgrade(id,version,options);}finally{closeSync(fd);unlinkSync(mutex);}
}
async function performUpgrade(id:string,version:string,options:UpgradeOptions){
  const config=options.config??loadUpdateConfig();
  if(!config.enabled||!config.allowUpgrade)throw Error('Component upgrades are off. Turn them on with: forge-cli components updates on --allow-upgrade');
  if(!/^[0-9][0-9A-Za-z.+-]{0,40}$/.test(version))throw Error('Invalid version');
  const make=UPGRADE_ADAPTERS[id];const adapter=options.adapter??make?.();
  if(!adapter)throw Error('No upgrade adapter for '+id+' yet; upgrade it through a reviewed pin change');
  const hooks=options.hooks??productionUpgradeHooks();
  const lockPath=options.lockPath??join(scripts,'serena-analysis','languages-lock.json');
  const receipts=options.receipts??join(homedir(),'.chatgptforge','components','upgrades.jsonl');
  mkdirSync(join(receipts,'..'),{recursive:true});
  const log=(step:string,detail:unknown)=>{appendFileSync(receipts,JSON.stringify({time:new Date().toISOString(),id,version,step,detail})+'\n');};
  const {repo,tag,name}=adapter.asset(version);
  log('started',{repo,tag,name});
  // 1. Official metadata and its published digest.
  const release=adapter.npmPackage?undefined:await hooks.fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`) as {assets?:{name:string;browser_download_url:string;digest?:string|null}[]}|undefined;
  const npm=adapter.npmPackage?await hooks.fetchJson(`https://registry.npmjs.org/${adapter.npmPackage}/${encodeURIComponent(version)}`) as {version:string;dist:{integrity:string;tarball:string}}:undefined;
  if(npm&&(npm.version!==version||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(npm.dist.integrity)||!npm.dist.tarball.startsWith(`https://registry.npmjs.org/${adapter.npmPackage}/-/`)))throw Error('Invalid official npm version/integrity/tarball');
  const asset=release?.assets?.find(a=>a.name===name);
  if(!asset&&!npm)throw (log('refused','asset not found'),Error('Release asset '+name+' not found'));
  const official=/^sha256:([0-9a-f]{64})$/.exec(asset?.digest??'')?.[1];
  if(!official&&!npm)throw (log('refused','no official sha256 published'),Error('The official release publishes no SHA-256 for '+name+'; upgrade refused'));
  const downloadUrl=npm?.dist.tarball??asset!.browser_download_url;
  if(!npm&&!downloadUrl.startsWith(`https://github.com/${repo}/releases/download/`))throw (log('refused','unexpected download url'),Error('Unexpected download URL'));
  // 2. Download and verify.
  const data=await hooks.download(downloadUrl);
  if(npm?'sha512-'+createHash('sha512').update(data).digest('base64')!==npm.dist.integrity:sha(data)!==official)throw (log('refused','digest mismatch'),Error('Downloaded file does not match the official SHA-256 or npm integrity; nothing installed'));
  log('verified',{sha256:sha(data),official_integrity:npm?.dist.integrity??official,bytes:data.length});
  // 3. Extract beside the current install.
  const staged=adapter.resourceDir+'.upgrade-'+version,previous=adapter.resourceDir+'.previous-'+Date.now();
  rmSync(staged,{recursive:true,force:true});
  const zip=join(tmpdir(),'forge-upgrade-'+id+'-'+Date.now()+(npm?'.tgz':'.zip'));await writeFile(zip,data);
  // New npm versions get versioned paths expected by Serena's own adapter.
  const sub=adapter.extractDir??'lua';
  const legacy=(adapter.npmPackage==='bash-language-server'&&version==='5.6.0')||(adapter.npmPackage==='intelephense'&&version==='1.14.4');
  const into=join(staged,npm&&!legacy?sub+'-'+version:sub);
  try{if(npm){if(!hooks.installNpm)throw Error('npm installation hook missing');await hooks.installNpm(zip,into);}else await hooks.extract(zip,into);}finally{rmSync(zip,{force:true});}
  // 4. Swap, keeping the previous install and pin for rollback.
  const lockBefore=await readFile(lockPath,'utf8');
  if(adapter.npmPackage==='bash-language-server'){
    // ShellCheck is a separate Serena-pinned prerequisite. Reuse only the
    // verified existing bytes, so analysis never downloads it after pinning.
    const expected=JSON.parse(lockBefore).languages.bash.resource_dirs.BashLanguageServer;
    const actual=await hooks.treeDigest(adapter.resourceDir);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Existing Bash prerequisite tree differs from its pin');
    const entries=readdirSync(adapter.resourceDir).filter(d=>existsSync(join(adapter.resourceDir,d,'shellcheck','shellcheck.exe')));
    if(entries.length!==1)throw Error('Expected one pinned ShellCheck prerequisite');
    cpSync(join(adapter.resourceDir,entries[0]!,'shellcheck'),join(into,'shellcheck'),{recursive:true,errorOnExist:true,force:false});
  }
  const hadPrevious=existsSync(adapter.resourceDir);
  let movedPrevious=false, installed=false;
  try {
  if(hadPrevious){renameSync(adapter.resourceDir,previous);movedPrevious=true;}
  renameSync(staged,adapter.resourceDir);installed=true;
  const tree=await hooks.treeDigest(adapter.resourceDir);
  const lock=JSON.parse(lockBefore) as {languages:Record<string,{state:string;resource_dirs?:Record<string,unknown>;version?:string}>};
  const dirName=adapter.resourceDir.split(/[\\/]/).at(-1)!;
  lock.languages[adapter.lockLanguage]={...lock.languages[adapter.lockLanguage],state:'installed',version,resource_dirs:{[dirName]:tree}};
  writeFileSync(lockPath,JSON.stringify(lock,null,2)+'\n');
  log('swapped',{tree});
  // 5. Real acceptance; roll back on any failure.
  let result:{ok:boolean;detail:string};
  try{result=await adapter.acceptance();}catch(error){result={ok:false,detail:String(error).slice(0,400)};}
  if(result.ok){log('kept',{detail:result.detail,previous_kept_at:hadPrevious?previous:null});return {state:'upgraded',id,version,sha256:sha(data),tree,acceptance:result.detail,previous:hadPrevious?previous:null};}
  throw new Error(result.detail);
  } catch(error) {
    const reason=String(error);
    // Never claim rollback succeeded unless both installation and pin are restored.
    try {
      if(installed)rmSync(adapter.resourceDir,{recursive:true,force:true});
      if(movedPrevious)renameSync(previous,adapter.resourceDir);
      writeFileSync(lockPath,lockBefore);
      rmSync(staged,{recursive:true,force:true});
    } catch(recoveryError) {
      log('recovery_required',{reason,recoveryError:String(recoveryError),previous});
      throw new Error('Upgrade failed and rollback needs operator recovery: '+String(recoveryError));
    }
    log('rolled_back',{detail:reason});
    return {state:'rolled_back',id,version,reason};
  }
}
