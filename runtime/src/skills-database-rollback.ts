import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {componentHome,type ManagedRelease} from './managed-component-state.js';
const run=promisify(execFile);
/** Called while holding the managed component mutex. Both services are owned. */
export async function rollbackSkillsDatabase(previous:ManagedRelease,publish:()=>void,undo:()=>void){
  const profilePath=join(dirname(dirname(componentHome())),'skills-manager','profile.json');
  const profile=JSON.parse(readFileSync(profilePath,'utf8'));
  const snapshots=join(profile.state_dir,'migration-checkpoints');
  const candidates=existsSync(snapshots)?readdirSync(snapshots).map(n=>join(snapshots,n)).filter(p=>existsSync(join(p,'manifest.json'))&&JSON.parse(readFileSync(join(p,'manifest.json'),'utf8')).source_head===previous.version):[];
  if(!candidates.length)throw Error('No pre-migration database checkpoint for the target Skills release; source and database were not changed');
  const scripts=fileURLToPath(new URL('../../scripts/',import.meta.url));
  const python=async(action:string,path?:string)=>{
    const result=await run(profile.python_path,['-B',join(scripts,'forge_skills_migrations.py'),action,profilePath,...(path?[path]:[])],{windowsHide:true,timeout:60000});return JSON.parse(result.stdout);
  };
  let checkpoint:string|undefined,lastError:unknown;
  for(const path of candidates.reverse())try{await python('check',path);checkpoint=path;break;}catch(error){lastError=error;}
  if(!checkpoint)throw Error('No lossless Skills database rollback is available: '+String(lastError));
  const service=async(name:string)=>run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(scripts,name),'-ProfilePath',profilePath],{windowsHide:true,timeout:120000});
  await service('Stop-ForgeSkills.ps1');
  let rescue:string|undefined,published=false,restored=false;
  try{
    // Recheck after stopping writers, then preserve the complete current DB/audit.
    await python('check',checkpoint);rescue=(await python('snapshot')).snapshot;
    await python('restore',checkpoint);restored=true;
    publish();published=true;
    await service('Start-ForgeSkills.ps1');
    return {checkpoint,rescue,source_head:previous.version};
  }catch(error){
    await service('Stop-ForgeSkills.ps1');
    if(published)undo();
    if(restored&&rescue)await python('recover',rescue);
    await service('Start-ForgeSkills.ps1');
    throw error;
  }
}
