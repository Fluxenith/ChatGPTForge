import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export const deploymentToolsFile=()=>join(resolve(process.env.CHATGPTFORGE_CONFIG_DIR??join(homedir(),'.chatgptforge')),'deployment-tools.json');
export function deploymentUv(){
  if(process.env.FORGE_UV)return process.env.FORGE_UV;
  const file=deploymentToolsFile();
  return existsSync(file)?String(JSON.parse(readFileSync(file,'utf8')).uv??'uv'):'uv';
}
export function saveDeploymentUv(path:string){
  const file=deploymentToolsFile(),stage=file+'.'+randomUUID();mkdirSync(resolve(file,'..'),{recursive:true});
  writeFileSync(stage,JSON.stringify({version:1,uv:path},null,2),{mode:0o600,flag:'wx'});renameSync(stage,file);
}
