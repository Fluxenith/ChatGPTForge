import {createHash} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,relative} from 'node:path';

// Forge's private Eclipse JDT LS for shared Serena rename. It is installed once
// by scripts/serena-analysis/install-java.mjs from a local vscode-java 1.54.0
// extension and pinned by tree digest. Serena only reads it: the JDT LS
// workspace, its configuration copy and shared index live in the owned run.
const LOCK=new URL('../scripts/serena-analysis/java-lock.json',import.meta.url);
const PARTS=['server','jre','lombok','LICENSE.txt','package.json'];
export interface SerenaJavaLock {extension:string;directory:string;jdtls:string;lombok:string;java_home:string;tree:{sha256:string;files:number;bytes:number}}
export const serenaJavaLock=():SerenaJavaLock=>JSON.parse(readFileSync(LOCK,'utf8'));
export function serenaJavaDir(lock=serenaJavaLock()):string {
  return process.env.FORGE_SERENA_JAVA_DIR?.trim()||join(homedir(),'.chatgptforge','serena-java',lock.directory);
}

export async function serenaJavaDigest(root:string) {
  const lines:string[]=[];let bytes=0;
  const add=async(path:string)=>{const data=await readFile(path);bytes+=data.length;lines.push(relative(root,path).split('\\').join('/')+'\0'+createHash('sha256').update(data).digest('hex'));};
  const walk=async(dir:string):Promise<void>=>{
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
      const path=join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error('Private JDT LS refuses linked entries');
      if(entry.isDirectory())await walk(path);else if(entry.isFile())await add(path);
      else throw Error('Private JDT LS has an unsupported entry');
    }
  };
  for(const part of PARTS){const path=join(root,part);if((await stat(path)).isDirectory())await walk(path);else await add(path);}
  return {sha256:createHash('sha256').update(lines.join('\n')).digest('hex'),files:lines.length,bytes};
}

export async function verifiedSerenaJava() {
  const lock=serenaJavaLock(),root=serenaJavaDir(lock);
  let tree;
  try{tree=await serenaJavaDigest(root);}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')
      throw Error('Forge private JDT LS is not installed; run node runtime/scripts/serena-analysis/install-java.mjs <installed redhat.java-1.54.0-win32-x64 extension>');
    throw error;
  }
  if(tree.sha256!==lock.tree.sha256||tree.files!==lock.tree.files||tree.bytes!==lock.tree.bytes)
    throw Error('Forge private JDT LS does not match its pinned tree; reinstall it');
  return {root,tree,settings:{jdtls_path:join(root,lock.jdtls),lombok_path:join(root,lock.lombok),java_home:join(root,lock.java_home)}};
}

// Build definitions are not given to JDT LS, so it never runs a Maven or
// Gradle import (which could download); sources are analyzed as one project.
export const javaBuildFile=(path:string)=>
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew(\.bat)?|mvnw(\.cmd)?|\.classpath|\.project|\.factorypath)$/i.test(path)||
  /(^|\/)(\.mvn|\.settings)\/|(^|\/)gradle\/wrapper\//i.test(path);

// A deterministic Eclipse Java project for the private copy: source roots are
// derived from each file's package declaration, so JDT LS indexes every source
// instead of guessing an "invisible project" from the opened file.
const xml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function javaSourceRoots(files:Iterable<[string,Buffer]>):string[] {
  const roots=new Set<string>();
  for(const [path,data] of files){
    if(!/\.java$/i.test(path))continue;
    const text=data.toString('utf8').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,' ');
    const match=/^\s*(?:@[\s\S]*?\s)?package\s+([\p{L}_$][\p{L}\p{N}_$]*(?:\s*\.\s*[\p{L}_$][\p{L}\p{N}_$]*)*)\s*;/u.exec(text);
    const dir=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
    const suffix=match?match[1]!.replace(/\s+/g,'').split('.').join('/'):'';
    if(!suffix)roots.add(dir);
    else if(dir===suffix)roots.add('');
    else if(dir.toLowerCase().endsWith('/'+suffix.toLowerCase()))roots.add(dir.slice(0,dir.length-suffix.length-1));
    else roots.add(dir); // Mismatched package: keep the file analyzable on its own.
  }
  if(roots.size>256)throw Error('Serena Java rename supports at most 256 source roots');
  return [...roots].sort();
}
export function eclipseJavaProject(roots:string[],libraries:string[]=[]):Record<string,string> {
  const entries=roots.map(root=>{
    const nested=roots.filter(other=>other!==root&&(root===''||other.startsWith(root+'/'))).map(other=>(root===''?other:other.slice(root.length+1))+'/');
    return `\t<classpathentry kind="src" path="${xml(root)}"${nested.length?` excluding="${xml(nested.join('|'))}"`:''}/>`;
  });
  for(const library of libraries)entries.push(`\t<classpathentry kind="lib" path="${xml(library.replaceAll('\\','/'))}"/>`);
  return {
    '.project':'<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n\t<name>forge-serena-java</name>\n\t<comment></comment>\n\t<projects></projects>\n\t<buildSpec>\n\t\t<buildCommand>\n\t\t\t<name>org.eclipse.jdt.core.javabuilder</name>\n\t\t\t<arguments></arguments>\n\t\t</buildCommand>\n\t</buildSpec>\n\t<natures>\n\t\t<nature>org.eclipse.jdt.core.javanature</nature>\n\t</natures>\n</projectDescription>\n',
    '.classpath':'<?xml version="1.0" encoding="UTF-8"?>\n<classpath>\n'+entries.join('\n')+'\n\t<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>\n\t<classpathentry kind="output" path="forge-serena-bin"/>\n</classpath>\n',
  };
}
