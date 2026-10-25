import {spawnSync} from 'node:child_process';

/** Git identity complements the source-byte fingerprint (which excludes .git). */
export function sourceHead(root:string):string|null {
  const result=spawnSync('git',['-C',root,'rev-parse','--verify','HEAD'],{encoding:'utf8',windowsHide:true,timeout:5000});
  if(result.error)throw result.error;
  if(result.status===0&&/^[a-f0-9]{40,64}$/.test(result.stdout.trim()))return result.stdout.trim();
  if(/not a git repository|Needed a single revision|unknown revision/i.test(result.stderr))return null;
  throw Error('Cannot establish source HEAD: '+result.stderr.slice(0,200));
}
