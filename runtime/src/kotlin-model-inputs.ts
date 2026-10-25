import {createHash} from 'node:crypto';
export const kotlinInputHash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export const kotlinBuildInputs=(files:Map<string,Buffer>)=>Object.fromEntries([...files].filter(([p])=>p!=='.forge/kotlin-workspace.json'&&!p.startsWith('.forge/kotlin-import/')).sort(([a],[b])=>a.localeCompare(b)).map(([p,b])=>[p,kotlinInputHash(b)]));
