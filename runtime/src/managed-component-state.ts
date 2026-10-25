import {existsSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
export type ManagedRelease={id:string;version:string;root:string;command:string;args:string[];python?:string;tree:string;recipe?:string;tools:string[];created:string};
export type ManagedState={version:1;active:Record<string,ManagedRelease>;history:Record<string,ManagedRelease[]>};
export const componentHome=()=>join(resolve(process.env.CHATGPTFORGE_CONFIG_DIR??join(homedir(),'.chatgptforge')),'components','managed');
export function readManagedState(home=componentHome()):ManagedState{
  const path=join(home,'state.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:1,active:{},history:{}};
}
export function managedRelease(id:string,home=componentHome()){
  const entry=readManagedState(home).active[id];if(!entry)return undefined;
  const rel=relative(join(home,'releases'),entry.root);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||entry.id!==id)throw Error('Managed component path is outside owned releases');
  return entry;
}
