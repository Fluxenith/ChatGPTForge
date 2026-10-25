import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {delimiter,isAbsolute,join,relative,resolve,sep} from 'node:path';

const [project,file]=process.argv.slice(2);if(!project||!file||process.argv.length!==4)throw Error('Usage: node export-classpath.mjs PROJECT CLASSPATH_FILE');
const root=await realpath(project),input=resolve(root,file),raw=await readFile(input,'utf8');
const paths=raw.replace(/^\uFEFF/,'').split(/\r?\n/).flatMap(line=>line.split(delimiter)).map(p=>p.trim()).filter(Boolean);
if(paths.length>256)throw Error('Java classpath exceeds 256 entries');
const classpath=paths.map(path=>{const absolute=isAbsolute(path)?path:resolve(root,path),rel=relative(root,absolute);return !rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)?rel.replaceAll('\\','/'):absolute;});
const names=new Set(['pom.xml','build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties','gradle.lockfile','libs.versions.toml','verification-metadata.xml']);
const excluded=new Set(['.git','.gradle','node_modules','target','build','out','dist','.venv','venv']);
const build_inputs=[],pending=[root];let visited=0;
while(pending.length){
  const directory=pending.pop();for(const entry of await readdir(directory,{withFileTypes:true})){
    if(++visited>20000)throw Error('Java build input discovery exceeds entry limit');
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink()){if(names.has(entry.name))throw Error('Java build input is a link');continue;}
    if(entry.isDirectory()){if(!excluded.has(entry.name))pending.push(path);continue;}
    if(entry.isFile()&&names.has(entry.name)){
      const first=await lstat(path);if(first.size>4*1024*1024||build_inputs.length>=256)throw Error('Java build inputs exceed bounds');
      const bytes=await readFile(path),last=await lstat(path);if(bytes.length!==first.size||first.size!==last.size||first.mtimeMs!==last.mtimeMs||first.ctimeMs!==last.ctimeMs)throw Error('Java build input changed during export');
      build_inputs.push({path:relative(root,path).replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex')});
    }
  }
}
build_inputs.sort((a,b)=>a.path.localeCompare(b.path));
const value=JSON.stringify({version:1,classpath,build_inputs},null,2)+'\n',destination=join(root,'forge.java.json');
try{await writeFile(destination,value,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||await readFile(destination,'utf8')!==value)throw error;}
console.log(JSON.stringify({state:'exported',classpath_entries:classpath.length,pinned_build_inputs:build_inputs.length,model:'forge.java.json'}));
