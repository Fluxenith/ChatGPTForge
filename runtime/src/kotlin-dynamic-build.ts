import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rename,realpath,lstat,rm} from 'node:fs/promises';
import {dirname,join,relative,basename,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {captureSerenaProject} from './serena-workspace-edit.js';
import {startWindowsJob} from './durable-windows-job.js';
import {kotlinWorkspace,KOTLIN_MODEL} from './serena-kotlin.js';
import {validateJavaJar} from './java-archive.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
import {kotlinBuildInputs} from './kotlin-model-inputs.js';
import {captureKotlinRoots,kotlinModelFiles} from './kotlin-generated.js';
import {validateKotlinCompiler,type KotlinCompilerSettings} from './kotlin-compiler-settings.js';

// This is an explicit CLI build action, never called by a read/rename request.
// A Windows job owns descendants; it is not a filesystem/network sandbox.
export async function importDynamicGradle(root:string,tool:string,allowBuild:boolean,online=false,build:'gradle'|'maven'='gradle'){
 if(!allowBuild)throw Error('Dynamic import executes project build code; specify --allow-build');
 root=await realpath(root);tool=await realpath(tool);const initial=captureSerenaProject(root),inputs=kotlinBuildInputs(initial.files);
 const owned=await mkdtemp(join(await realpath(tmpdir()),'forge-kotlin-build-')),project=join(owned,'project');await mkdir(project);
 for(const [p,b]of initial.files){if(p===KOTLIN_MODEL||p.startsWith('.forge/kotlin-import/'))continue;const dest=join(project,...p.split('/'));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b);}
 const init=fileURLToPath(new URL('../scripts/serena-analysis/export-gradle-model.gradle',import.meta.url));
 const output=join(owned,'model.json'),log=join(owned,'build.log');
 let command:string;
 if(build==='maven'){
  const classes=join(owned,'extension'),metadata=join(classes,'META-INF','plexus');await mkdir(metadata,{recursive:true});
  await writeFile(join(metadata,'components.xml'),'<component-set><components><component><role>org.apache.maven.eventspy.EventSpy</role><role-hint>forge-model</role-hint><implementation>forge.ForgeMavenModel</implementation></component></components></component-set>');
  const source=fileURLToPath(new URL('../scripts/serena-analysis/ForgeMavenModel.java',import.meta.url)),extension=classes;
  command='& javac -cp '+quote(join(dirname(dirname(tool)),'lib','*')+';'+join(dirname(dirname(tool)),'boot','*'))+' -d '+quote(classes)+' '+quote(source)+'; if ($LASTEXITCODE) { exit $LASTEXITCODE }; $env:FORGE_MODEL_OUTPUT='+quote(output)+'; & '+[tool,'-B',...(online?[]:['-o']),'-Dmaven.ext.class.path='+extension,'-DskipTests','test-compile'].map(quote).join(' ')+'; exit $LASTEXITCODE';
 }else command='$env:FORGE_MODEL_OUTPUT='+quote(output)+'; & '+[tool,'--no-daemon',...(online?[]:['--offline']),'--console=plain','--init-script',init,'forgeExportJvmModel'].map(quote).join(' ')+'; exit $LASTEXITCODE';
 // Recent JDK Windows sockets require a short temporary address. Own a unique
 // directory; preserve existing VM options and never reuse another run's socket.
 const socketDir=build==='gradle'?await mkdtemp(join(process.env.SystemRoot??'C:\\Windows','Temp','fg-')):undefined;
 if(socketDir){const flag=' "-Djdk.net.unixdomain.tmpdir='+socketDir.replaceAll('\\','/')+'"';command='$env:JAVA_TOOL_OPTIONS = ($env:JAVA_TOOL_OPTIONS + '+quote(flag)+'); $env:GRADLE_OPTS = ($env:GRADLE_OPTS + '+quote(flag)+'); '+command;}
 const job=startWindowsJob(command,project,log,'ForgeKotlinBuild-'+randomUUID(),{memoryLimitMiB:4096});
 let complete=false;
 try{
  await job.input('',true);const deadline=Date.now()+600_000;let code:number|null=null;
  while((code=job.poll())===null){if(Date.now()>deadline)throw Error('Dynamic build timed out');if((await lstat(log)).size>16*1024*1024)throw Error('Dynamic build output exceeds limit');await new Promise(r=>setTimeout(r,100));}
  if(code!==0)throw Error('Dynamic build failed; inspect '+log);
  const outputInfo=await lstat(output).catch(()=>null);
  if(!outputInfo)throw Error('Build completed without an exportable JVM model; inspect '+log);
  if(outputInfo.size>4*1024*1024)throw Error('Dynamic build model exceeds limit');
  const exported=JSON.parse(await readFile(output,'utf8'));
  if(!Array.isArray(exported.modules)||exported.modules.length>128)throw Error('Invalid dynamic build modules');
  const runId=randomUUID(),prefix='.forge/kotlin-import/'+runId,additions=new Map<string,Buffer>(),libraryHashes:Record<string,string>={},generatedHashes:Record<string,string>={},generatedOrigins:Record<string,string>={};let total=0;
  const copyJar=async(p:string,plugin=false)=>{
    if(typeof p!=='string'||!p.endsWith('.jar'))throw Error('Dynamic model requires JAR dependencies');
    const info=await lstat(p);if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw Error('Invalid resolved build dependency');
    const b=await readFile(p);validateJavaJar(b);const sha=hash(b),path=prefix+'/'+(plugin?'plugins/'+sha+'-'+basename(p):sha+'.jar');
    if(!additions.has(path)){total+=b.length;if(total>128*1024*1024)throw Error('Build dependencies exceed 128 MiB');additions.set(path,b);}libraryHashes[path]=sha;return path;
  };
  const modules=[];
  for(const m of exported.modules){
   if(!Array.isArray(m.roots)||!Array.isArray(m.libraries))throw Error('Invalid exported source/dependency paths');
   const captured=await captureKotlinRoots(project,m.roots,m.generatedRoots??[],initial.files,prefix+'/m'+modules.length);
   for(const [p,b]of captured.additions)additions.set(p,b);Object.assign(generatedHashes,captured.hashes);Object.assign(generatedOrigins,captured.origins);
   const roots=captured.roots;
   const libraries=[];
   for(const p of m.libraries){
    libraries.push(await copyJar(p));
   }
   let compiler:KotlinCompilerSettings|undefined;
   if(m.compiler){validateKotlinCompiler(m.compiler);compiler={...m.compiler,pluginClasspaths:[]};for(const p of m.compiler.pluginClasspaths??[])compiler!.pluginClasspaths!.push(await copyJar(p,true));}
   modules.push({name:m.name,roots,dependencies:m.dependencies,libraries:[...new Set(libraries)],...(compiler?{compiler}:{})});
  }
  const unchanged=(files:Map<string,Buffer>)=>JSON.stringify(kotlinBuildInputs(files))===JSON.stringify(inputs)&&files.get(KOTLIN_MODEL)?.toString('base64')===initial.files.get(KOTLIN_MODEL)?.toString('base64');
  if(!unchanged(captureSerenaProject(root).files))throw Error('Source/model changed during build; model not published');
  const model={version:3,modules,input_hashes:inputs,library_hashes:libraryHashes,generated_hashes:generatedHashes,generated_origins:generatedOrigins};
  const candidate=new Map(initial.files);for(const [p,b]of additions)candidate.set(p,b);candidate.set(KOTLIN_MODEL,Buffer.from(JSON.stringify(model)));
  if(candidate.size>10000||[...candidate.values()].reduce((n,b)=>n+b.length,0)>128*1024*1024)throw Error('Published model would exceed capture limits; archive unused import receipts first');
  const active=kotlinModelFiles(candidate);
  const target=[...candidate.keys()].find(p=>active.copied(p)&&/\.(kt|java)$/.test(p));if(!target)throw Error('No captured JVM source');kotlinWorkspace(candidate,target);
  for(const [p,b]of additions){const dest=join(root,...p.split('/'));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,b,{flag:'wx'});}
  await mkdir(join(root,prefix),{recursive:true});await writeFile(join(root,prefix,'build.log'),await readFile(log));
  await writeFile(join(root,prefix,'receipt.json'),JSON.stringify({build,offline:!online,tool,tool_sha256:hash(await readFile(tool)),exported,created_at:new Date().toISOString()},null,2));
  const modelPath=join(root,KOTLIN_MODEL),staged=modelPath+'.'+runId+'.tmp';
  await writeFile(staged,JSON.stringify(model,null,2),{flag:'wx'});
  const fresh=captureSerenaProject(root).files;fresh.delete(relative(root,staged).split(sep).join('/'));
  if(!unchanged(fresh)){await rm(staged);throw Error('Source/model changed before model publication');}
  if(initial.files.has(KOTLIN_MODEL))await writeFile(join(root,prefix,'previous-model.json'),initial.files.get(KOTLIN_MODEL)!);
  await rename(staged,modelPath);complete=true;
  return {build,modules:modules.length,libraries:Object.keys(libraryHashes).length,generated_sources:Object.keys(generatedHashes).length,compiler_modules:modules.filter(m=>m.compiler).length,model:KOTLIN_MODEL,receipt:prefix+'/build.log',offline:!online,source_unchanged:true};
 }finally{job.stop();job.close();if(socketDir)await rm(socketDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});if(complete)await rm(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
