import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { navigateCode } from './code-navigation.js';
import { loadCodeProject } from './code-project.js';
import { verifyCodeEnvironment } from './code-environment.js';

const navigate:typeof navigateCode=process.env.FORGE_CODE_ENVIRONMENT_BASELINE
  ? (await import(pathToFileURL(resolve(process.env.FORGE_CODE_ENVIRONMENT_BASELINE)).href)).navigateCode : navigateCode;
const compiler=createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
function compile(root:string) {
  try { return execFileSync(process.execPath,[compiler,'-p',root],{encoding:'utf8'}); }
  catch(error) { throw new Error(`TypeScript compiler rejected fixture:\n${String((error as {stdout?:string}).stdout??error)}`); }
}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},config:Record<string,unknown>={}) {
  const root=await mkdtemp(join(tmpdir(),'forge-environment-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,types:[],...config},include:['main.*']}));
  return root;
}
async function packageFiles(root:string) {
  const directory=join(root,'node_modules/typed-math/types');await mkdir(directory,{recursive:true});
  await writeFile(join(root,'node_modules/typed-math/package.json'),JSON.stringify({name:'typed-math',type:'module',exports:{'.':{types:'./types/index.d.mts',import:'./index.mjs'}}}));
  await writeFile(join(directory,'index.d.mts'),"import type { Count } from './shared.mjs';\nexport declare function multiply(value: Count): number;\n");
  await writeFile(join(directory,'shared.d.mts'),'export type Count = number;');
}

test('project diagnostics load standard libraries and match a successful actual compiler run',async t=>{
  const root=await fixture(t);
  const line='const count: number = [1,2,3].map(n => n + 1).length;';
  await writeFile(join(root,'main.ts'),line+"\nconst unique: Set<number> = new Set([1,1]);\nPromise.resolve(count).then(value => value.toFixed(2));\n");
  assert.equal(compile(root),'');
  const diagnostics=await navigate({path:root,action:'diagnostics'},[root]);
  assert.equal(diagnostics.project.libraries_loaded,true);assert.deepEqual(diagnostics.results,[]);
  const definition=await navigate({path:root,action:'definition',file:'main.ts',line:1,column:line.indexOf('.map')+2},[root]);
  assert.ok(definition.results.some(value=>(value as {file:string;read_only:boolean}).file.startsWith('typescript:') && (value as {read_only:boolean}).read_only));
});

test('NodeNext package exports and transitive declarations resolve read-only and match actual type errors',async t=>{
  const root=await fixture(t,{module:'NodeNext',moduleResolution:'NodeNext'});await packageFiles(root);
  await writeFile(join(root,'main.mts'),"import { multiply } from 'typed-math';\nconst ok = multiply(3);\nconst wrong: string = multiply(4);\nconst values: number[] = [1,2].map(multiply);\n");
  let compilerOutput='';try{execFileSync(process.execPath,[compiler,'-p',root],{encoding:'utf8'});}catch(error){compilerOutput=String((error as {stdout:string}).stdout);}
  assert.match(compilerOutput,/error TS2322/);assert.equal((compilerOutput.match(/error TS/g)??[]).length,1);
  const diagnostic=await navigate({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(diagnostic.results.map(value=>(value as {code:number}).code),[2322]);
  assert.equal(diagnostic.project.dependencies_loaded,true);
  const definition=await navigate({path:root,action:'definition',file:'main.mts',line:2,column:13},[root]);
  assert.ok(definition.results.some(value=>(value as {file:string;read_only:boolean}).file.replaceAll('\\','/').endsWith('node_modules/typed-math/types/index.d.mts') && (value as {read_only:boolean}).read_only));
  assert.ok(diagnostic.project.environment.snapshots.some(value=>value.file.endsWith('shared.d.mts')));
});

test('explicit ambient types and lib settings are honored without making them editable',async t=>{
  const root=await fixture(t,{types:['fixture'],lib:['ES2022']});
  await mkdir(join(root,'node_modules/@types/fixture'),{recursive:true});
  await writeFile(join(root,'node_modules/@types/fixture/package.json'),' {"name":"@types/fixture","types":"index.d.ts"} ');
  await writeFile(join(root,'node_modules/@types/fixture/index.d.ts'),'declare const envValue: number;');
  await writeFile(join(root,'main.ts'),'const value: number = envValue;');
  const result=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(result.results,[]);
  assert.ok(!result.project.environment.snapshots.some(value=>value.file==='typescript:lib.dom.d.ts'));
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['ES2022'],strict:true,noEmit:true},include:['main.ts']}));
  assert.throws(()=>compile(root),/TS2304/);
  const omitted=await navigate({path:root,action:'diagnostics'},[root]);
  assert.ok(omitted.results.some(value=>(value as {code:number}).code===2304));assert.equal(omitted.project.dependencies_loaded,false);
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',lib:['ES2022'],types:['*'],strict:true,noEmit:true},include:['main.ts']}));
  assert.equal(compile(root),'');
  const automatic=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(automatic.results,[]);
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',types:[],strict:true,noEmit:true},include:['main.ts']}));
  const restricted=await navigate({path:root,action:'diagnostics'},[root]);
  assert.ok(restricted.results.some(value=>(value as {code:number}).code===2304));
});

test('declaration changes refresh diagnostics and invalidate a captured semantic environment',async t=>{
  const root=await fixture(t);await packageFiles(root);
  await writeFile(join(root,'main.ts'),"import { multiply } from 'typed-math';\nmultiply(3);\n");
  const project=await loadCodeProject({path:root},[root]);
  verifyCodeEnvironment(project.environment);
  const before=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(before.results,[]);
  await writeFile(join(root,'node_modules/typed-math/types/shared.d.mts'),'export type Count = string;');
  assert.throws(()=>verifyCodeEnvironment(project.environment),/environment changed/);
  const after=await navigate({path:root,action:'diagnostics'},[root]);
  assert.ok(after.results.some(value=>(value as {code:number}).code===2345));
  assert.notEqual(before.project.environment.fingerprint,after.project.environment.fingerprint);
});

test('renaming a local package alias preserves the dependency export and selected mode stays bounded',async t=>{
  const root=await fixture(t);await packageFiles(root);
  const original="import { multiply as twice } from 'typed-math';\ntwice(3);\n";
  await writeFile(join(root,'main.ts'),original);
  const preview=await navigate({path:root,action:'rename_preview',file:'main.ts',line:2,column:2,new_name:'scale'},[root]);
  assert.ok(preview.edits?.length);
  for(const file of preview.edits??[])assert.equal(file.file,'main.ts');
  let updated=original;for(const edit of preview.edits![0]!.replacements)updated=updated.slice(0,edit.start)+edit.new_text+updated.slice(edit.start+edit.length);
  assert.match(updated,/multiply as scale/);
  assert.equal(await readFile(join(root,'node_modules/typed-math/types/shared.d.mts'),'utf8'),'export type Count = number;');
  await writeFile(join(root,'main.ts'),"import { multiply } from 'typed-math';\nmultiply(3);\n");
  try {
    const external=await navigate({path:root,action:'rename_preview',file:'main.ts',line:2,column:2,new_name:'scale'},[root]);
    assert.equal(external.rename?.can_rename,false);assert.ok(!external.edits?.length);
  } catch(error) { assert.match(String(error),/read-only environment/); }
  const selected=await navigate({path:root,files:['main.ts'],action:'outline',file:'main.ts'},[root]);
  assert.equal(selected.project.libraries_loaded,false);assert.equal(selected.project.dependencies_loaded,false);
});

test('dependency bounds, links and external type roots fail before reading unapproved declarations',async t=>{
  const root=await fixture(t);await packageFiles(root);
  await writeFile(join(root,'main.ts'),"import { multiply } from 'typed-math';\nmultiply(3);");
  await writeFile(join(root,'node_modules/typed-math/types/index.d.mts'),'//'+ 'x'.repeat(4*1024*1024));
  await assert.rejects(navigate({path:root,action:'diagnostics'},[root]),/capture limit/);
  const outside=await mkdtemp(join(tmpdir(),'forge-types-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'package.json'),' {"name":"linked-types","types":"index.d.ts"} ');
  await writeFile(join(outside,'index.d.ts'),'export declare const secret: string;');
  await symlink(outside,join(root,'node_modules/linked-types'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(root,'main.ts'),"import { secret } from 'linked-types';\nsecret;");
  await assert.rejects(navigate({path:root,action:'symbols',query:'secret'},[root]),/symbolic links/);
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{typeRoots:[outside]},include:['main.ts']}));
  await assert.rejects(navigate({path:root,action:'diagnostics'},[root]),/External typeRoots/);
});

test('actual large TypeScript declarations and package manifests analyze without weakening capacity rejection',async t=>{
  const root=await fixture(t);const dependency=join(root,'node_modules/large-types');await mkdir(dependency,{recursive:true});
  await copyFile(join(dirname(compiler),'typescript.d.ts'),join(dependency,'index.d.ts'));
  const manifest={name:'large-types',types:'index.d.ts',description:'x'.repeat(80*1024)};
  await writeFile(join(dependency,'package.json'),JSON.stringify(manifest));
  await writeFile(join(root,'main.ts'),"import type ts from 'large-types';\ndeclare const kind:ts.SyntaxKind;\nconst numeric:number=kind;\n");
  assert.equal(compile(root),'');
  const result=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(result.results,[]);
  assert.ok(result.project.environment.bytes>512*1024);
  const captured=await loadCodeProject({path:root},[root]);verifyCodeEnvironment(captured.environment);
  await writeFile(join(dependency,'package.json'),JSON.stringify({...manifest,description:'y'.repeat(80*1024)}));
  assert.throws(()=>verifyCodeEnvironment(captured.environment),/environment changed/);
  await writeFile(join(dependency,'package.json'),JSON.stringify({...manifest,description:'x'.repeat(1024*1024)}));
  await assert.rejects(navigate({path:root,action:'diagnostics'},[root]),/1024 KiB capture limit.*manifest:node_modules\/large-types\/package.json/);
});

test('automatic JSX runtimes follow compiler mode, import-source pragmas and classic override',async t=>{
  const root=await fixture(t,{jsx:'react-jsx'});
  async function runtime(name:string,value:string,subpath='jsx-runtime') {
    const directory=join(root,'node_modules',name);await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'package.json'),JSON.stringify({name,exports:{[`./${subpath}`]:{types:'./runtime.d.ts'}}}));
    await writeFile(join(directory,'runtime.d.ts'),`export namespace JSX { interface Element {} interface IntrinsicElements { demo:{value:${value}} } }`);
  }
  await runtime('react','number');await runtime('custom-ui','string');await runtime('dev-ui','boolean','jsx-dev-runtime');
  await writeFile(join(root,'main.tsx'),'export const view=<demo value={1}/>;');
  assert.equal(compile(root),'');assert.deepEqual((await navigate({path:root,action:'diagnostics'},[root])).results,[]);
  await writeFile(join(root,'main.tsx'),'/** @jsxImportSource custom-ui */\nexport const view=<demo value={"ok"}/>;');
  assert.equal(compile(root),'');assert.deepEqual((await navigate({path:root,action:'diagnostics'},[root])).results,[]);
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsxdev',jsxImportSource:'dev-ui',types:[],strict:true,noEmit:true},include:['main.tsx']}));
  await writeFile(join(root,'main.tsx'),'export const view=<demo value={true}/>;');
  assert.equal(compile(root),'');assert.deepEqual((await navigate({path:root,action:'diagnostics'},[root])).results,[]);
  await writeFile(join(root,'main.tsx'),'/** @jsxRuntime classic */\ndeclare namespace React { namespace JSX {interface Element {} interface IntrinsicElements {demo:{value:number}}} function createElement(...args:unknown[]):JSX.Element; }\nexport const view=<demo value={1}/>;');
  assert.equal(compile(root),'');const classic=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(classic.results,[]);
  assert.equal(classic.project.dependencies_loaded,false);
});

test('unavailable dependency lib directives remain inspectable and match skipLibCheck compiler behavior',async t=>{
  const root=await fixture(t,{skipLibCheck:true});await packageFiles(root);
  await writeFile(join(root,'node_modules/typed-math/types/index.d.mts'),'/// <reference lib="esnext.float16" />\nexport declare function multiply(value:number):number;');
  await writeFile(join(root,'main.ts'),"import {multiply} from 'typed-math';\nmultiply(3);");
  assert.equal(compile(root),'');
  const result=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(result.results,[]);
  assert.ok(result.project.environment.unresolved.includes('library:lib.esnext.float16.d.ts'));
});

test('implicit tslib helpers resolve for downlevel asynchronous modules without executing helper code',async t=>{
  const root=await fixture(t,{target:'ES2015',lib:['ES2022'],importHelpers:true});
  await mkdir(join(root,'node_modules/tslib'),{recursive:true});
  await writeFile(join(root,'node_modules/tslib/package.json'),' {"name":"tslib","types":"index.d.ts"} ');
  await writeFile(join(root,'node_modules/tslib/index.d.ts'),'export declare function __awaiter(...args:unknown[]):Promise<unknown>;\nexport declare function __generator(...args:unknown[]):unknown;');
  await writeFile(join(root,'main.ts'),'export async function answer(){return 42;}');
  assert.equal(compile(root),'');const result=await navigate({path:root,action:'diagnostics'},[root]);assert.deepEqual(result.results,[]);
  assert.ok(result.project.environment.snapshots.some(value=>value.file==='node_modules/tslib/index.d.ts'));
});
