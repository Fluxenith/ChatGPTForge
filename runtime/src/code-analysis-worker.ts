import { parentPort, workerData } from 'node:worker_threads';
import { analyzeCode, type CodeNavigationInput } from './code-navigation.js';
import type {CodeProject} from './code-project.js';

const data=workerData as {input:CodeNavigationInput;roots:string[];includeProject:boolean};
try {
  let project:CodeProject|undefined;
  const result=await analyzeCode(data.input,data.roots,captured=>{
    if(data.includeProject)project=captured;
    parentPort!.postMessage({stage:'captured'});
  });
  parentPort!.postMessage({ok:true,reply:{result,project}});
}catch(error){parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
