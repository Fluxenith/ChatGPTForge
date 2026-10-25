import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import {createRequire} from 'node:module';
const compiler=createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
import { navigateCode } from './code-navigation.js';
import {loadCodeProject} from './code-project.js';

async function project(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'forge-project-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await mkdir(join(root, 'src'));
  return root;
}

test('project discovery follows inherited path aliases and respects config include/exclude', async t => {
  const root = await project(t);
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, 'config/base.json'), JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@/*': ['src/*'] }, strict: true } }));
  await writeFile(join(root, 'tsconfig.json'), '{// project settings\n"extends":"./config/base.json","include":["src/**/*"],"exclude":["src/excluded.ts"]}');
  await writeFile(join(root, 'src/math.ts'), 'export function double(n: number) { return n * 2; }');
  await writeFile(join(root, 'src/main.ts'), "import { double as twice } from '@/math';\ntwice(3);\nfunction unrelated(twice: (n:number)=>number) { return twice(9); }");
  await writeFile(join(root, 'src/excluded.ts'), 'export const excluded = 1;');
  await writeFile(join(root, 'ignored/other.ts'), 'export const ignored = 1;');
  await writeFile(join(root, 'src/second.ts'), "import { double as multiply } from '@/math';\nmultiply(2);");
  const input = { path: root, file: 'src/main.ts', action: 'definition' as const, line: 2, column: 2 };
  const result = await navigateCode(input, [root]);
  assert.equal(result.scope, 'project_files');
  assert.equal((result.results[0] as {file:string}).file.replaceAll('\\', '/'), 'src/math.ts');
  assert.deepEqual(result.snapshots.map(s => s.file.replaceAll('\\', '/')).sort(), ['src/main.ts', 'src/math.ts', 'src/second.ts']);
  assert.equal(result.project.config_snapshots.length, 2);
  const refs = await navigateCode({ ...input, action: 'references' }, [root]);
  assert.ok(refs.results.some(r => (r as {file:string;line:number}).file.endsWith('math.ts')));
  assert.ok(refs.results.some(r => (r as {file:string;line:number}).file.endsWith('second.ts') && (r as {line:number}).line === 2));
  assert.ok(!refs.results.some(r => (r as {line:number}).line === 3));
  const symbols = await navigateCode({ path: root, action: 'symbols', query: 'double' }, [root]);
  assert.ok(symbols.results.some(r => (r as {name:string}).name === 'double'));
  await writeFile(join(root, 'config/base.json'), JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@/*': ['missing/*'] } } }));
  const fresh = await navigateCode(input, [root]);
  assert.notDeepEqual(result.project.config_snapshots, fresh.project.config_snapshots);
  assert.ok(!fresh.results.some(r => (r as {file:string}).file.endsWith('math.ts')));
});

test('project diagnostics expose real type errors and rename preview preserves aliases and shadowing', async t => {
  const root = await project(t);
  await writeFile(join(root, 'src/math.ts'), 'export function double(n: number) { return n * 2; }');
  const caller = "import { double as twice } from './math';\nconst bad: number = 'wrong';\ntwice(3);\nfunction other(double: number) { return double; }";
  await writeFile(join(root, 'src/main.ts'), caller);
  const diagnostics = await navigateCode({ path: root, action: 'diagnostics' }, [root]);
  assert.ok(diagnostics.results.some(r => (r as {code:number}).code === 2322));
  const preview = await navigateCode({ path: root, file: 'src/math.ts', action: 'rename_preview', line: 1, column: 18, new_name: 'scale' }, [root]);
  assert.equal(preview.rename?.can_rename, true);
  assert.ok(preview.edits?.length);
  for (const change of preview.edits ?? []) {
    let text = await readFile(join(root, change.file), 'utf8');
    for (const edit of change.replacements) {
      assert.equal(text.slice(edit.start, edit.start + edit.length), edit.old_text);
      text = text.slice(0, edit.start) + edit.new_text + text.slice(edit.start + edit.length);
    }
    if (change.file.endsWith('main.ts')) {
      assert.match(text, /scale as twice/);
      assert.match(text, /function other\(double: number\) \{ return double; \}/);
    }
  }
  assert.equal(await readFile(join(root, 'src/main.ts'), 'utf8'), caller, 'preview must not write');
  await assert.rejects(navigateCode({ path: root, file: 'src/math.ts', action: 'rename_preview', line: 1, column: 18, new_name: 'for' }, [root]), /identifier/);
});

test('discovery skips generated folders and links; explicit targets and config escapes fail', async t => {
  const root = await project(t);
  const outside = await mkdtemp(join(tmpdir(), 'forge-project-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;');
  await writeFile(join(outside, 'config.json'), '{}');
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/huge.ts'), 'x'.repeat(512 * 1024 + 1));
  await writeFile(join(root, 'src/main.ts'), 'export const main = 1;');
  const result = await navigateCode({ path: root, action: 'symbols', query: 'main' }, [root]);
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.project.skipped_links, ['linked']);
  await assert.rejects(navigateCode({ path: root, file: 'linked/secret.ts', action: 'outline' }, [root]), /outside allowed roots/);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ extends: join(outside, 'config.json') }));
  await assert.rejects(navigateCode({ path: root, action: 'symbols', query: 'main' }, [root]), /outside|relative/);
  await writeFile(join(root, 'tsconfig.json'), '{"extends":"./tsconfig.json"}');
  await assert.rejects(navigateCode({ path: root, action: 'symbols', query: 'main' }, [root]), /cycle/);
});

test('project size limits reject the whole query rather than silently dropping callers', async t => {
  const root = await project(t);
  await writeFile(join(root, 'src/main.ts'), 'export const main = 1;');
  for (let i = 0; i < 2048; i++) await writeFile(join(root, `src/file${i}.ts`), `export const value${i} = ${i};`);
  await assert.rejects(navigateCode({ path: root, action: 'symbols', query: 'main' }, [root]), /2048/);
});

test('large local declarations resolve callers while implementation and declaration file bounds remain distinct',async t=>{
  const root=await project(t);
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,types:[]},include:['src']}));
  await writeFile(join(root,'src/api.d.ts'),'/*'+'x'.repeat(600*1024)+'*/\nexport declare function external(value:number):number;');
  await writeFile(join(root,'src/main.ts'),"import {external} from './api';\nexport const result=external(3);\n");
  const definition=await navigateCode({path:root,action:'definition',file:'src/main.ts',line:2,column:21},[root]);
  assert.ok(definition.results.some(value=>(value as {file:string}).file.replaceAll('\\','/')==='src/api.d.ts'));
  assert.deepEqual((await navigateCode({path:root,action:'diagnostics'},[root])).results,[]);
  await writeFile(join(root,'src/api.d.ts'),'x'.repeat(4*1024*1024+1));
  await assert.rejects(loadCodeProject({path:root},[root]),/4096 KiB/);
  await writeFile(join(root,'src/api.d.ts'),'export {};');
  await writeFile(join(root,'src/main.ts'),'x'.repeat(512*1024+1));
  await assert.rejects(loadCodeProject({path:root},[root]),/512 KiB/);
});

test('projects larger than eight MiB are captured completely but the shared thirty-two MiB budget rejects excess',async t=>{
  const root=await project(t);
  const content='/*'+'x'.repeat(500*1024)+'*/\nexport {};';
  for(let i=0;i<20;i++)await writeFile(join(root,`src/part${i}.ts`),content);
  const captured=await loadCodeProject({path:root},[root]);
  assert.equal(captured.texts.size,20);
  assert.ok([...captured.texts.values()].reduce((sum,text)=>sum+Buffer.byteLength(text),0)>8*1024*1024);
  for(let i=20;i<68;i++)await writeFile(join(root,`src/part${i}.ts`),content);
  await assert.rejects(loadCodeProject({path:root},[root]),/32 MiB/);
});

test('rename preview retains shorthand object keys and the edited program still produces the same results', async t => {
  const root = await project(t);
  await writeFile(join(root, 'src/math.ts'), 'export function double(n: number) { return n * 2; }\nexport const bag = { double };');
  await writeFile(join(root, 'src/main.ts'), "import { double as twice, bag } from './math';\nconsole.log([twice(3), bag.double(4)].join(','));");
  const preview = await navigateCode({ path: root, action: 'rename_preview', file: 'src/math.ts', line: 1, column: 18, new_name: 'scale' }, [root]);
  const transformed = new Map<string, string>();
  for (const file of ['src/math.ts', 'src/main.ts']) transformed.set(file, await readFile(join(root, file), 'utf8'));
  for (const change of preview.edits ?? []) {
    const name = change.file.replaceAll('\\', '/');
    let text = transformed.get(name)!;
    for (const edit of change.replacements) text = text.slice(0, edit.start) + edit.new_text + text.slice(edit.start + edit.length);
    transformed.set(name, text);
  }
  assert.match(transformed.get('src/math.ts')!, /double: scale/);
  for (const [file, text] of transformed) {
    const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    await writeFile(join(root, file.replace(/\.ts$/, '.js')), js);
  }
  assert.equal(execFileSync(process.execPath, [join(root, 'src/main.js')], { encoding: 'utf8' }).trim(), '6,8');
});

test('config chains, malformed settings and non-UTF-8 sources fail with explicit errors', async t => {
  const root = await project(t);
  await writeFile(join(root, 'src/main.ts'), 'export const main = 1;');
  for (let i = 0; i < 9; i++) await writeFile(join(root, `config${i}.json`), i === 8 ? '{}' : JSON.stringify({ extends: `./config${i + 1}.json` }));
  await writeFile(join(root, 'tsconfig.json'), '{"extends":"./config0.json"}');
  const input = { path: root, action: 'symbols' as const, query: 'main' };
  await assert.rejects(navigateCode(input, [root]), /8-file/);
  await writeFile(join(root, 'tsconfig.json'), '{"extends":"some-package/tsconfig"}');
  await assert.rejects(navigateCode(input, [root]), /relative JSON/);
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":"yes"}}');
  await assert.rejects(navigateCode(input, [root]), /boolean/);
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  await writeFile(join(root, 'src/main.ts'), Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(navigateCode(input, [root]), /UTF-8/);
});

test('large rename requests never return a partial edit plan', async t => {
  const root = await project(t);
  await writeFile(join(root, 'src/main.ts'), 'const count = 1;\n' + 'count;\n'.repeat(301));
  await assert.rejects(navigateCode({ path: root, action: 'rename_preview', file: 'src/main.ts', line: 1, column: 8, new_name: 'total' }, [root]), /no partial rename/);
});

test('config root selection precedes source capture and imports restore excluded reachable sources',async t=>{
  const root=await project(t);await mkdir(join(root,'unrelated'));
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,types:[]},include:['src/main.ts']}));
  await writeFile(join(root,'src/main.ts'),"import {answer} from './excluded';\nexport const value:number=answer;\n");
  await writeFile(join(root,'src/excluded.ts'),'export const answer=42;');
  await writeFile(join(root,'unrelated/invalid.ts'),Buffer.from([255,254]));
  await writeFile(join(root,'unrelated/huge.ts'),'x'.repeat(512*1024+1));
  for(let n=0;n<300;n++)await writeFile(join(root,`unrelated/file${n}.ts`),`export const ignored${n}=${n};`);
  assert.equal(execFileSync(process.execPath,[compiler,'-p',root],{encoding:'utf8'}),'');
  const result=await navigateCode({path:root,action:'diagnostics'},[root]);assert.deepEqual(result.results,[]);
  assert.deepEqual(result.snapshots.map(s=>s.file.replaceAll('\\','/')).sort(),['src/excluded.ts','src/main.ts']);
  const definition=await navigateCode({path:root,file:'src/main.ts',action:'definition',line:2,column:27},[root]);
  assert.ok(definition.results.some(value=>(value as {file:string}).file.replaceAll('\\','/')==='src/excluded.ts'));
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',composite:true,noEmit:true,types:[]},include:['src/main.ts']}));
  let output='';try{execFileSync(process.execPath,[compiler,'-p',root],{encoding:'utf8'});}catch(error){output=String((error as {stdout:string}).stdout);}
  assert.match(output,/TS6307/);
  const composite=await navigateCode({path:root,action:'diagnostics'},[root]);
  assert.ok(composite.results.some(value=>(value as {code:number}).code===6307),'imported source must not silently become a config root');
});

test('explicit external sources fail and internal project-reference solutions analyze their leaves',async t=>{
  const root=await project(t),outside=await mkdtemp(join(tmpdir(),'forge-source-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'external.ts'),'export const secret=1;');
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({files:[join(outside,'external.ts')]}));
  await assert.rejects(navigateCode({path:root,action:'diagnostics'},[root]),/outside the project/);
  await mkdir(join(root,'leaf'));await writeFile(join(root,'leaf/main.ts'),'export const answer=42;');
  await writeFile(join(root,'leaf/tsconfig.json'),JSON.stringify({compilerOptions:{composite:true},files:['main.ts']}));
  await writeFile(join(root,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'./leaf'}]}));
  const result=await navigateCode({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(result.results,[]);
  assert.equal(result.project.projects.length,2);
  assert.deepEqual(result.snapshots.map(item=>item.file.replaceAll('\\','/')),['leaf/main.ts']);
});
