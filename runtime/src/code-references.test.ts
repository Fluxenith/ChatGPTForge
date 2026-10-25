import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {navigateCode} from './code-navigation.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';

const compiler=createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
const clean=(file:string)=>file.replaceAll('\\','/');
async function graph(t:test.TestContext) {
  const parent=await mkdtemp(join(tmpdir(),'forge-references-')),root=join(parent,'中文 專案');
  const cleanup:(()=>void)[]=[];
  await mkdir(root);t.after(async()=>{for(const dispose of cleanup)dispose();await rm(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const files:Record<string,string>={
    'tsconfig.json':JSON.stringify({files:[],references:[{path:'./core'},{path:'./domain'},{path:'./app'},{path:'./browser/custom.json'}]}),
    'base.json':JSON.stringify({compilerOptions:{target:'ES2022',module:'Node16',moduleResolution:'Node16',strict:true,types:[]}}),
    'package.json':'{"private":true,"type":"commonjs"}',
    'core/tsconfig.json':JSON.stringify({extends:'../base.json',compilerOptions:{composite:true,rootDir:'src',outDir:'../dist/core',tsBuildInfoFile:'../dist/core.tsbuildinfo',lib:['ES2022']},include:['src/**/*.ts']}),
    'core/src/index.ts':'export function double(n:number) { return n*2; }\nexport const bag={double};\n',
    'domain/tsconfig.json':JSON.stringify({extends:'../base.json',compilerOptions:{composite:true,rootDir:'src',outDir:'../dist/domain',tsBuildInfoFile:'../dist/domain.tsbuildinfo',lib:['ES2022']},include:['src/**/*.ts'],references:[{path:'../core'}]}),
    'domain/src/index.ts':"import {double as twice,bag} from '../../dist/core/index';\nexport {double} from '../../dist/core/index';\nexport const total=twice(3)+bag.double(4);\nfunction unrelated(double:string) {return double;}\n",
    'app/tsconfig.json':JSON.stringify({extends:'../base.json',compilerOptions:{composite:true,rootDir:'src',outDir:'../dist/app',tsBuildInfoFile:'../dist/app.tsbuildinfo',lib:['ES2022'],strictNullChecks:false},include:['src/**/*.ts'],references:[{path:'../domain'}]}),
    'app/src/index.ts':"import {double,total} from '../../dist/domain/index';\nexport const result=double(5)+total;\nexport const nullable:number=null;\n",
    'browser/custom.json':JSON.stringify({extends:'../base.json',compilerOptions:{composite:true,rootDir:'src',outDir:'../dist/browser',lib:['ES2022','DOM']},include:['src/**/*.ts']}),
    'browser/src/index.ts':"export const title=document.title;\n",
    'unselected/not-in-project.ts':'const ignored:number="bad";\n',
  };
  for(const [name,text]of Object.entries(files)){await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),text);}
  return {parent,root,files,addCleanup:(dispose:()=>void)=>cleanup.push(dispose)};
}
function build(root:string) {return execFileSync(process.execPath,[compiler,'--build',root,'--force'],{encoding:'utf8'});}

test('unbuilt reference graph resolves source definitions, transitive callers and per-project diagnostics',async t=>{
  const {root}=await graph(t);
  const input={path:root,file:'app/src/index.ts',line:2,column:21};
  const definition=await navigateCode({...input,action:'definition'},[root]);
  assert.ok(definition.results.some(value=>clean((value as {file:string}).file)==='core/src/index.ts'));
  const refs=await navigateCode({path:root,file:'core/src/index.ts',line:1,column:18,action:'references'},[root]);
  assert.ok(refs.results.some(value=>clean((value as {file:string}).file)==='app/src/index.ts'&&(value as {line:number}).line===2));
  assert.ok(refs.results.some(value=>clean((value as {file:string}).file)==='domain/src/index.ts'&&(value as {line:number}).line===3));
  assert.ok(!refs.results.some(value=>clean((value as {file:string}).file)==='domain/src/index.ts'&&(value as {line:number}).line===4));
  const diagnostics=await navigateCode({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(diagnostics.results,[],'DOM and strictNullChecks must stay specific to each project');
  assert.equal(diagnostics.project.projects.length,5);
  assert.equal(diagnostics.snapshots.length,4);
  assert.equal(build(root),'');
  await writeFile(join(root,'core/src/index.ts'),'export function double(n:number) { return n*2; }\nexport const bag={double};\nconst wrong:number="bad";\n');
  let output='';try{build(root);}catch(error){output=String((error as {stdout:string}).stdout);}
  assert.match(output,/TS2322/);
  const bad=await navigateCode({path:root,action:'diagnostics'},[root]);
  assert.ok(bad.results.some(value=>(value as {code:number}).code===2322&&clean((value as {file:string}).file)==='core/src/index.ts'));
});

test('durable graph rename reaches downstream reexports and preserves aliases, shadowing and runtime behavior',async t=>{
  const {parent,root,addCleanup}=await graph(t);
  const preview=await navigateCode({path:root,file:'core/src/index.ts',line:1,column:18,action:'rename_preview',new_name:'scale'},[root]);
  assert.deepEqual(preview.edits?.map(item=>clean(item.file)).sort(),['app/src/index.ts','core/src/index.ts','domain/src/index.ts']);
  const alias=await navigateCode({path:root,file:'domain/src/index.ts',line:3,column:20,action:'rename_preview',new_name:'localScale'},[root]);
  assert.deepEqual(alias.edits?.map(item=>clean(item.file)),['domain/src/index.ts'],'renaming a local alias must not rename its export');
  assert.ok(alias.edits?.[0]?.replacements.every(edit=>edit.old_text==='twice'));
  assert.match(await readFile(join(root,'domain/src/index.ts'),'utf8'),/double as twice/,'preview cannot write');
  const engine=new DurableTasks(join(parent,'state'));addCleanup(()=>engine.close());
  const task=engine.create(root,'reference-rename','cross-project rename',['node build.mjs'],true);
  const batches=new TaskFileBatches(engine);
  const input={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'core/src/index.ts',line:1,column:18,new_name:'scale'};
  const result=await renameTask(engine,batches,input,[root]);assert.equal(result.state,'completed');
  const after=snapshot(root).fingerprint;
  assert.match(await readFile(join(root,'domain/src/index.ts'),'utf8'),/scale as twice/);
  assert.match(await readFile(join(root,'domain/src/index.ts'),'utf8'),/function unrelated\(double:string\)/);
  assert.match(await readFile(join(root,'core/src/index.ts'),'utf8'),/double: scale/);
  assert.equal((await renameTask(engine,batches,input,[root])).state,'completed');
  assert.equal(snapshot(root).fingerprint,after,'receipt replay must not edit again');
  assert.equal(build(root),'');
  // Execute actual tsc --build output, independently of the language service.
  const output=execFileSync(process.execPath,['-e',"console.log(require('./dist/app/index.js').result)"],{cwd:root,encoding:'utf8'});
  assert.equal(output.trim(),'24');
});

test('reference cycles, missing configs, escapes, links and graph bounds reject the whole query',async t=>{
  const {parent,root}=await graph(t);
  const query={path:root,action:'diagnostics' as const};
  await writeFile(join(root,'core/tsconfig.json'),JSON.stringify({files:['src/index.ts'],references:[{path:'../app'}]}));
  await assert.rejects(navigateCode(query,[root]),/reference cycle/i);
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'./missing'}]}));
  await assert.rejects(navigateCode(query,[root]),/ENOENT|missing/i);
  await writeFile(join(parent,'tsconfig.json'),'{}');
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'..'}]}));
  await assert.rejects(navigateCode(query,[root]),/outside allowed roots|outside the project/i);
  await symlink(join(root,'domain'),join(root,'link'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'./link'}]}));
  await assert.rejects(navigateCode(query,[root]),/linked|symbolic|junction/i);await unlink(join(root,'link'));
  const references=[];for(let i=0;i<32;i++){await mkdir(join(root,`p${i}`));await writeFile(join(root,`p${i}/tsconfig.json`),' {"files":["main.ts"]} ');await writeFile(join(root,`p${i}/main.ts`),'export {};');references.push({path:`./p${i}`});}
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({files:[],references}));
  await assert.rejects(navigateCode(query,[root]),/32.*project|project.*32/i);
});

test('explicit export aliases remain public while the underlying declaration is renamed',async t=>{
  const {root}=await graph(t);
  await writeFile(join(root,'domain/src/index.ts'),"import {double as twice,bag} from '../../dist/core/index';\nexport {double as published} from '../../dist/core/index';\nexport const total=twice(3)+bag.double(4);\n");
  const caller="import {published,total} from '../../dist/domain/index';\nexport const result=published(5)+total;\n";
  await writeFile(join(root,'app/src/index.ts'),caller);
  const preview=await navigateCode({path:root,file:'core/src/index.ts',line:1,column:18,action:'rename_preview',new_name:'scale'},[root]);
  assert.deepEqual(preview.edits?.map(item=>clean(item.file)).sort(),['core/src/index.ts','domain/src/index.ts']);
  for(const edit of preview.edits??[]){let text=await readFile(join(root,edit.file),'utf8');for(const replacement of edit.replacements)text=text.slice(0,replacement.start)+replacement.new_text+text.slice(replacement.start+replacement.length);await writeFile(join(root,edit.file),text);}
  assert.match(await readFile(join(root,'domain/src/index.ts'),'utf8'),/scale as published/);
  assert.equal(await readFile(join(root,'app/src/index.ts'),'utf8'),caller);
  assert.equal(build(root),'');
  assert.equal(execFileSync(process.execPath,['-e',"console.log(require('./dist/app/index.js').result)"],{cwd:root,encoding:'utf8'}).trim(),'24');
});

test('graph analysis respects disabled source redirects and refuses an incomplete source rename',async t=>{
  const {root}=await graph(t);assert.equal(build(root),'');
  const path=join(root,'app/tsconfig.json'),config=JSON.parse(await readFile(path,'utf8'));
  config.compilerOptions.disableSourceOfProjectReferenceRedirect=true;await writeFile(path,JSON.stringify(config));
  const diagnostics=await navigateCode({path:root,action:'diagnostics'},[root]);assert.deepEqual(diagnostics.results,[]);
  const definition=await navigateCode({path:root,file:'app/src/index.ts',line:2,column:21,action:'definition'},[root]);
  assert.ok(definition.results.some(value=>clean((value as {file:string}).file).includes('dist/core/index.d.ts')&&(value as {read_only:boolean}).read_only));
  await assert.rejects(navigateCode({path:root,file:'core/src/index.ts',line:1,column:18,action:'rename_preview',new_name:'scale'},[root]),/source.*redirect|redirect.*rename/i);
});

test('each project resolves its own default ambient type directory without leaking globals to siblings',async t=>{
  const {root}=await graph(t);
  const configPath=join(root,'core/tsconfig.json'),config=JSON.parse(await readFile(configPath,'utf8'));
  config.compilerOptions.types=['*'];await writeFile(configPath,JSON.stringify(config));
  await mkdir(join(root,'core/node_modules/@types/coreenv'),{recursive:true});
  await writeFile(join(root,'core/node_modules/@types/coreenv/index.d.ts'),'declare const coreEnv:number;');
  await writeFile(join(root,'core/src/index.ts'),'export function double(n:number) { return n*2; }\nexport const bag={double};\nconst envOnly:number=coreEnv;\n');
  assert.equal(build(root),'');
  const valid=await navigateCode({path:root,action:'diagnostics'},[root]);assert.deepEqual(valid.results,[]);
  await writeFile(join(root,'browser/src/index.ts'),'export const title=document.title;\nconst bad:number=coreEnv;\n');
  let output='';try{build(root);}catch(error){output=String((error as {stdout:string}).stdout);}
  assert.match(output,/TS2304/);
  const bad=await navigateCode({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(bad.results.map(value=>(value as {code:number}).code),[2304]);
  assert.equal(clean((bad.results[0] as {project_config:string}).project_config),'browser/custom.json');
});
