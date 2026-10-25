import {spawn} from 'node:child_process';
import {managedRelease} from './managed-component-state.js';
const [id,home,...args]=process.argv.slice(2);
const entry=id?managedRelease(id,home):undefined;
if(!entry)throw Error('Managed component is not installed');
const child=spawn(entry.command,[...entry.args,...args],{stdio:'inherit',windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
