import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureSerenaProject,serenaPython,serenaLanguagesHome,SERENA_EDIT_LANGUAGES,planSerenaRename,type SerenaRenameInput} from './serena-workspace-edit.js';
import {productionUpgradeHooks} from './forge-upgrades.js';
import {copyLanguageTree,writeLanguagePin} from './language-pin-transaction.js';

export async function registerProjectRename(input:SerenaRenameInput){
  const path=fileURLToPath(new URL('../scripts/serena-analysis/languages-lock.json',import.meta.url)),mutex=path+'.install.lock',fd=openSync(mutex,'wx');
  try{
    const lock=JSON.parse(readFileSync(path,'utf8'));
    if(lock.languages[input.language]?.state!=='installed')throw Error('Install and pin this language first');
    const plan=await planSerenaRename(input,undefined,{probeInstalled:true});
    lock.languages[input.language].capabilities=['edit','rename'];
    lock.languages[input.language].rename_probe={files:plan.files.length,references:plan.readiness.references,fingerprint:plan.fingerprint};
    writeLanguagePin(path,lock);
    return {language:input.language,capabilities:['edit','rename'],probe:lock.languages[input.language].rename_probe,source_modified:false};
  }finally{closeSync(fd);unlinkSync(mutex);}
}

/** Local onboarding uses a private source copy; runtime calls only use pinned trees. */
export async function installProjectLanguage(language:string,root:string,file:string,version?:string){
  if(!/^[a-z][a-z0-9_]{0,39}$/.test(language)||(SERENA_EDIT_LANGUAGES as readonly string[]).includes(language))throw Error('Use the existing upgrade adapter for built-in languages');
  const capture=captureSerenaProject(root);if(!capture.files.has(file))throw Error('Source must be a captured project-relative file');
  const lockPath=fileURLToPath(new URL('../scripts/serena-analysis/languages-lock.json',import.meta.url));
  const mutex=lockPath+'.install.lock',fd=openSync(mutex,'wx');
  let owned:string|undefined;
  const installed:string[]=[];
  try{
    owned=mkdtempSync(join(tmpdir(),'forge-language-'));
    const home=join(owned,'home'),project=join(owned,'project'),result=join(owned,'probe.json');
    const before=readFileSync(lockPath,'utf8'),lock=JSON.parse(before);
    if(lock.languages[language]?.state==='installed')throw Error('Language is already pinned; use a reviewed upgrade');
    for(const [name,data] of capture.files){const path=join(project,...name.split('/'));mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data);}
    await promisify(execFile)(serenaPython(),['-I','-B',fileURLToPath(new URL('../scripts/serena-analysis/install-project-language.py',import.meta.url)),home,project,language,file,result,...(version?[version]:[])],{timeout:600000,windowsHide:true,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}});
    const probe=JSON.parse(readFileSync(result,'utf8')) as {directories:string[];symbols:number};
    if(!Array.isArray(probe.directories)||!probe.directories.length||new Set(probe.directories).size!==probe.directories.length||!Number.isInteger(probe.symbols)||probe.symbols<1)throw Error('Invalid language installation probe');
    const destination=join(serenaLanguagesHome(),'language_servers','static'),pins:Record<string,{sha256:string;files:number;bytes:number}>={};mkdirSync(destination,{recursive:true});
    for(const name of probe.directories){
      if(!/^[A-Za-z0-9_-]+$/.test(name)||existsSync(join(destination,name)))throw Error('Backend directory is invalid or already owned: '+name);
      const source=join(home,'language_servers','static',name);pins[name]=await productionUpgradeHooks().treeDigest(source);
    }
    if(readFileSync(lockPath,'utf8')!==before)throw Error('Language pins changed during installation');
    for(const name of probe.directories){const target=join(destination,name);await copyLanguageTree(join(home,'language_servers','static',name),target,pins[name]!,productionUpgradeHooks().treeDigest);installed.push(target);}
    // Startup + symbols establish editing availability, not complete references.
    // Rename remains unavailable until an independent cross-file adapter probe.
    lock.languages[language]={state:'installed',resource_dirs:pins,capabilities:['edit'],fixture_symbols:probe.symbols,...(version?{version}: {})};
    writeLanguagePin(lockPath,lock);
    return {language,state:'installed',capabilities:['edit'],symbols:probe.symbols,resource_dirs:Object.keys(pins)};
  }catch(error){for(const path of installed)rmSync(path,{recursive:true,force:true});throw error;}
  finally{try{if(owned)rmSync(owned,{recursive:true,force:true,maxRetries:5});}finally{closeSync(fd);unlinkSync(mutex);}}
}
