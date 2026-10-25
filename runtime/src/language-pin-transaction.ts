import {randomUUID} from 'node:crypto';
import {writeFileSync,renameSync,rmSync,cpSync,mkdirSync} from 'node:fs';

/** Caller holds the shared language installation mutex. */
export function writeLanguagePin(path:string,value:unknown){
  const temporary=path+'.'+randomUUID()+'.new';
  try{writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});renameSync(temporary,path);}
  finally{rmSync(temporary,{force:true});}
}

export async function copyLanguageTree(source:string,target:string,expected:{sha256:string;files:number;bytes:number},digest:(path:string)=>Promise<{sha256:string;files:number;bytes:number}>){
  // Exclusive creation establishes ownership before any cleanup is allowed.
  mkdirSync(target);
  try{
    cpSync(source,target,{recursive:true,errorOnExist:true,force:false});
    const actual=await digest(target);
    if(actual.sha256!==expected.sha256||actual.files!==expected.files||actual.bytes!==expected.bytes)throw Error('Copied language tree differs from its verified source');
  }catch(error){rmSync(target,{recursive:true,force:true,maxRetries:5});throw error;}
}
