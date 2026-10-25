import {mkdirSync,readFileSync,existsSync,renameSync,rmSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {copyLanguageTree} from './language-pin-transaction.js';

type Pin={sha256:string;files:number;bytes:number};
type Digest=(path:string)=>Promise<Pin>;
type Options={lockPath:string;home:string;cache:string;digest:Digest;language?:string};
const equal=(a:Pin,b:Pin)=>a.sha256===b.sha256&&a.files===b.files&&a.bytes===b.bytes;
function pins(path:string,language?:string){
  const lock=JSON.parse(readFileSync(path,'utf8')) as {languages:Record<string,{state:string;resource_dirs?:Record<string,Pin>}>};
  const entries=new Map<string,Pin>();
  if(language&&lock.languages[language]?.state!=='installed')throw Error('Language is not installed: '+language);
  for(const item of language?[lock.languages[language]!]:Object.values(lock.languages))if(item.state==='installed')for(const [name,pin] of Object.entries(item.resource_dirs??{})){
    if(!/^[A-Za-z0-9_-]+$/.test(name)||!/^[a-f0-9]{64}$/.test(pin.sha256)||!Number.isSafeInteger(pin.files)||pin.files<0||!Number.isSafeInteger(pin.bytes)||pin.bytes<0)throw Error('Invalid language tree pin');
    if(entries.has(name)&&!equal(entries.get(name)!,pin))throw Error('Conflicting language tree pins');
    entries.set(name,pin);
  }
  return entries;
}
async function matches(path:string,pin:Pin,digest:Digest){return existsSync(path)&&equal(await digest(path),pin);}

/** A cache is accepted by content, never trusted merely because its name matches. */
export async function cacheLanguageTrees(o:Options){
  const mutex=o.lockPath+'.install.lock',fd=openSync(mutex,'wx');
  try{
    mkdirSync(o.cache,{recursive:true});const saved:string[]=[];
    for(const [name,pin] of pins(o.lockPath,o.language)){
      const source=join(o.home,'language_servers','static',name),target=join(o.cache,pin.sha256);
      if(!await matches(source,pin,o.digest))throw Error('Installed tree does not match pin: '+name);
      if(existsSync(target)){if(!await matches(target,pin,o.digest))throw Error('Cached tree differs from pin: '+name);}
      else await copyLanguageTree(source,target,pin,o.digest);
      saved.push(name);
    }
    return {cached:saved};
  }finally{closeSync(fd);unlinkSync(mutex);}
}

export async function repairLanguageTrees(o:Options){
  const mutex=o.lockPath+'.install.lock',fd=openSync(mutex,'wx');
  const staged:{name:string;target:string;stage:string;backup:string;swapped:boolean;moved:boolean}[]=[];
  try{
    const root=join(o.home,'language_servers','static');mkdirSync(root,{recursive:true});
    // Prepare every required replacement before modifying any installed tree.
    for(const [name,pin] of pins(o.lockPath)){
      const target=join(root,name);if(await matches(target,pin,o.digest))continue;
      const source=join(o.cache,pin.sha256);
      if(!await matches(source,pin,o.digest))throw Error('No verified cache for '+name+'; existing installation preserved');
      const stage=join(root,name+'.repair-'+randomUUID());
      await copyLanguageTree(source,stage,pin,o.digest);
      staged.push({name,target,stage,backup:target+'.previous-'+randomUUID(),swapped:false,moved:false});
    }
    for(const item of staged){
      if(existsSync(item.target)){renameSync(item.target,item.backup);item.moved=true;}
      renameSync(item.stage,item.target);item.swapped=true;
    }
    return {repaired:staged.map(i=>i.name),previous:staged.filter(i=>i.moved).map(i=>i.backup)};
  }catch(error){
    for(const item of [...staged].reverse()){
      if(item.swapped)rmSync(item.target,{recursive:true,force:true,maxRetries:5});
      if(item.moved)renameSync(item.backup,item.target);
    }
    throw error;
  }finally{
    try{for(const item of staged)rmSync(item.stage,{recursive:true,force:true,maxRetries:5});}
    finally{closeSync(fd);unlinkSync(mutex);}
  }
}
