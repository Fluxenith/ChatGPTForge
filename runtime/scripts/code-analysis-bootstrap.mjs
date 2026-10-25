import {workerData} from 'node:worker_threads';
// Source tests register the installed transpiler inside this owned thread.
// The built product imports compiled JavaScript and does not require tsx.
if(workerData.source){const {register}=await import('tsx/esm/api');register({tsconfig:false});}
await import(workerData.module);
