// Installs Forge's private copy of the Eclipse JDT LS used by shared Serena
// rename for Java. Source: an already installed Red Hat vscode-java 1.54.0
// win32-x64 extension (the version Serena 1.7.0 pins). Nothing is downloaded.
// The copy is pinned by tree digest; Serena only reads it, and every writable
// JDT LS location (workspace, configuration copy, shared index) is per-run.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

export const JAVA_PARTS=['server','jre','lombok','LICENSE.txt','package.json'];
export const lock=JSON.parse(await readFile(new URL('java-lock.json',import.meta.url),'utf8'));
export const defaultJavaHome=()=>process.env.FORGE_SERENA_JAVA_DIR?.trim()||join(homedir(),'.chatgptforge','serena-java',lock.directory);

export async function treeDigest(root){
  const lines=[];let bytes=0;
  const walk=async dir=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
    const path=join(dir,entry.name);
    if(entry.isSymbolicLink())throw new Error('Private JDT LS refuses linked entries: '+path);
    if(entry.isDirectory())await walk(path);
    else if(entry.isFile()){const data=await readFile(path);bytes+=data.length;lines.push(relative(root,path).split('\\').join('/')+'\0'+createHash('sha256').update(data).digest('hex'));}
    else throw new Error('Private JDT LS has an unsupported entry: '+path);
  }};
  for(const part of JAVA_PARTS){const path=join(root,part);if((await stat(path)).isDirectory())await walk(path);else{const data=await readFile(path);bytes+=data.length;lines.push(part+'\0'+createHash('sha256').update(data).digest('hex'));}}
  return {sha256:createHash('sha256').update(lines.join('\n')).digest('hex'),files:lines.length,bytes};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const source=process.argv[2];
  if(!source)throw new Error('usage: node install-java.mjs <installed redhat.java-1.54.0-win32-x64 extension directory>');
  const manifest=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}@${manifest.version}`,lock.extension,'Unexpected vscode-java extension');
  const digest=await treeDigest(source);
  assert.deepEqual(digest,lock.tree,'Source extension does not match the pinned JDT LS tree');
  const target=defaultJavaHome(),staging=target+'.staging-'+process.pid;
  await mkdir(staging,{recursive:true});
  for(const part of JAVA_PARTS)await cp(join(source,part),join(staging,part),{recursive:true,errorOnExist:true,force:false});
  assert.deepEqual(await treeDigest(staging),lock.tree,'Copied JDT LS does not match the pinned tree');
  await rm(target,{recursive:true,force:true});await rename(staging,target);
  console.log(JSON.stringify({installed:target,...lock.tree}));
}
