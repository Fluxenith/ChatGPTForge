import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,unlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {navigatePython} from './python-navigation.js';
import {runPythonAnalysis} from './python-analysis-runtime.js';
import {loadPythonProject,usesPythonNavigation,verifyPythonEnvironment,pythonHash} from './python-project.js';
import {windowsProcessIdentity} from './durable-windows-job.js';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches} from './task-file-batches.js';
import {renameTask} from './task-rename.js';
import {registerCodeNavigation} from './code-navigation.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';

async function fixture(t:{after:(callback:()=>Promise<void>|void)=>void},parent=tmpdir(),retain=false) {
  const root=await mkdtemp(join(parent,'forge-python-test-'));
  if(!retain)t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await mkdir(join(root,'pkg'));await writeFile(join(root,'pyproject.toml'),'[project]\nname="example"\nversion="0.0.0"\n');
  const files={
    'pkg/math.py':'def double(n):\n    return n * 2\n\nclass Counter:\n    def scale(self, n):\n        return double(n)\n',
    'pkg/__init__.py':'from .math import double\n',
    'caller.py':'from pkg import double as twice\ntwice(4)\ndef shadow(twice):\n    return twice(5)\n',
    'other.py':'from pkg.math import double\nvalue = double(3)\n',
  };
  for(const [file,text] of Object.entries(files))await writeFile(join(root,file),text);
  return {root,files};
}
function apply(before:string,edit:{replacements:{start:number;length:number;old_text:string;new_text:string}[]}) {
  for(const item of edit.replacements){assert.equal(before.slice(item.start,item.start+item.length),item.old_text);before=before.slice(0,item.start)+item.new_text+before.slice(item.start+item.length);}
  return before;
}

async function dependencyFixture(root:string,environment='.venv'){
  const site=join(root,environment,'Lib','site-packages');await mkdir(join(site,'dep_api'),{recursive:true});
  await writeFile(join(root,environment,'pyvenv.cfg'),'home = ignored-external-interpreter\ninclude-system-site-packages = false\nversion = 3.13.7\n');
  await writeFile(join(site,'dep_api/__init__.py'),'from .core import scale as public_scale\n');
  await writeFile(join(site,'dep_api/core.py'),'raise RuntimeError("Dependency modules must never execute during analysis")\ndef scale(n):\n    return n * 7\n');
  await writeFile(join(site,'activation.pth'),'import pathlib; pathlib.Path("executed-site-hook").write_text("unsafe")\n../../outside\n');
  await writeFile(join(site,'unreachable.py'),Buffer.from([35,255,10]));
  await writeFile(join(root,'dependency_client.py'),'from dep_api import public_scale as multiply\nvalue = multiply(4)\n');
  return {site,core:environment.replaceAll('\\','/')+'/Lib/site-packages/dep_api/core.py'};
}

async function stubFixture(root:string){
  const {site}=await dependencyFixture(root);
  const files:Record<string,string>={
    'dep_api-stubs/__init__.pyi':'from .core import scale as scale\n',
    'dep_api-stubs/core.pyi':'def scale(n: int) -> str: ...\n',
    'dep_api/extra.py':'def fallback():\n    return 4\n',
  };
  for(const [file,text] of Object.entries(files)){await mkdir(join(site,file,'..'),{recursive:true});await writeFile(join(site,file),text);}
  await writeFile(join(root,'stub_client.py'),'from dep_api import scale as multiply\nvalue = multiply(4)\nimport dep_api.core as api\nvalue2 = api.scale(5)\nfrom dep_api.extra import fallback\nvalue3 = fallback()\n');
  return {site,stub:'.venv/Lib/site-packages/dep_api-stubs/core.pyi',fallback:'.venv/Lib/site-packages/dep_api/extra.py'};
}

test('Python complete stub packages override installed sources for direct and qualified definitions without leaking view paths',async t=>{
  const {root}=await fixture(t),{site,stub,fallback}=await stubFixture(root);
  for(const [line,column] of [[2,9],[4,14]]){
    const result=await navigatePython({path:root,file:'stub_client.py',action:'definition',line,column},[root]);
    assert.ok(result.results.some(item=>item.file===stub&&item.name==='scale'&&item.read_only===true));
    assert.equal(result.project.import_settings.stub_packages[0]!.kind,'complete');
    assert.ok(result.results.every(item=>!String(item.file).includes('typing/')&&!String(item.file).includes('python_environment:dep_api')));
    assert.ok(!result.project.source_selection.analysis_files.includes(fallback));
  }
  const missing=await navigatePython({path:root,file:'stub_client.py',action:'definition',line:6,column:11},[root]);
  assert.ok(missing.results.every(item=>item.file!==fallback));
  await assert.rejects(navigatePython({path:root,file:'stub_client.py',action:'rename_preview',line:1,column:21,new_name:'changed'},[root]),/read-only/);
  const alias=await navigatePython({path:root,file:'stub_client.py',action:'rename_preview',line:2,column:9,new_name:'local_scale'},[root]);
  assert.equal(alias.total,2);assert.deepEqual(alias.edits!.map(item=>item.file),['stub_client.py']);
  const inspection=await navigatePython({path:root,file:'.venv/Lib/site-packages/dep_api/core.py',action:'outline'},[root]);
  assert.ok(inspection.results.some(item=>item.name==='scale'&&item.file==='.venv/Lib/site-packages/dep_api/core.py'&&item.read_only===true));
  assert.equal(await readFile(join(site,'dep_api-stubs/core.pyi'),'utf8'),'def scale(n: int) -> str: ...\n');
  await assert.rejects(readFile(join(root,'executed-site-hook')),/ENOENT/);
});

test('Python partial stub packages fall back by module while preserving stub symbol boundaries and inline priority',async t=>{
  const {root}=await fixture(t),{site,stub,fallback}=await stubFixture(root);
  await writeFile(join(site,'dep_api-stubs/py.typed'),'partial\r\n');
  await writeFile(join(site,'dep_api/extra.pyi'),'def fallback() -> str: ...\n');
  const direct=await navigatePython({path:root,file:'stub_client.py',action:'definition',line:2,column:9},[root]);
  assert.ok(direct.results.some(item=>item.file===stub));assert.equal(direct.project.import_settings.stub_packages[0]!.kind,'partial');
  const missing=await navigatePython({path:root,file:'stub_client.py',action:'definition',line:6,column:11},[root]);
  assert.ok(missing.results.some(item=>item.file===fallback+'i'&&item.read_only===true));
  await unlink(join(site,'dep_api/extra.pyi'));
  const implementation=await navigatePython({path:root,file:'stub_client.py',action:'definition',line:6,column:11},[root]);
  assert.ok(implementation.results.some(item=>item.file===fallback&&item.read_only===true));
  await writeFile(join(site,'dep_api/core.py'),'def runtime_only():\n    return 9\n');
  await writeFile(join(root,'only.py'),'from dep_api.core import runtime_only\nruntime_only()\n');
  const symbol=await navigatePython({path:root,file:'only.py',action:'definition',line:2,column:3},[root]);
  assert.ok(symbol.results.every(item=>item.name!=='runtime_only'||item.file==='only.py'));
});

test('Python namespace stub packages merge siblings and keep regular subpackages complete unless partial',async t=>{
  const {root}=await fixture(t),{site}=await dependencyFixture(root);
  const files={
    'shapes-stubs/polygons/square/__init__.pyi':'def area() -> int: ...\n',
    'shapes/polygons/circle.py':'def area():\n    return 3\n',
    'shapes/polygons/square/extra.py':'def missing():\n    return 7\n',
  };
  for(const [file,text] of Object.entries(files)){await mkdir(join(site,file,'..'),{recursive:true});await writeFile(join(site,file),text);}
  await writeFile(join(root,'shapes_client.py'),'from shapes.polygons.square import area\narea()\nfrom shapes.polygons.circle import area as circle\ncircle()\nfrom shapes.polygons.square.extra import missing\nmissing()\n');
  const square=await navigatePython({path:root,file:'shapes_client.py',action:'definition',line:2,column:2},[root]);
  assert.ok(square.results.some(item=>item.file==='.venv/Lib/site-packages/shapes-stubs/polygons/square/__init__.pyi'));
  assert.equal(square.project.import_settings.stub_packages[0]!.kind,'namespace');
  const circle=await navigatePython({path:root,file:'shapes_client.py',action:'definition',line:4,column:2},[root]);
  assert.ok(circle.results.some(item=>item.file==='.venv/Lib/site-packages/shapes/polygons/circle.py'));
  const complete=await navigatePython({path:root,file:'shapes_client.py',action:'definition',line:6,column:2},[root]);
  assert.ok(complete.results.every(item=>!String(item.file).endsWith('square/extra.py')));
  await writeFile(join(site,'shapes-stubs/polygons/square/py.typed'),'partial\n');
  const partial=await navigatePython({path:root,file:'shapes_client.py',action:'definition',line:6,column:2},[root]);
  assert.ok(partial.results.some(item=>item.file==='.venv/Lib/site-packages/shapes/polygons/square/extra.py'));
});

test('Python project packages retain precedence over installed stub packages and rename writable qualified callers',async t=>{
  const {root}=await fixture(t);await stubFixture(root);
  await mkdir(join(root,'dep_api'));await writeFile(join(root,'dep_api/__init__.py'),'from .core import scale\n');
  await writeFile(join(root,'dep_api/core.py'),'def scale(n):\n    return n * 2\n');
  await writeFile(join(root,'local_client.py'),'import dep_api.core as api\napi.scale(4)\n');
  const definition=await navigatePython({path:root,file:'local_client.py',action:'definition',line:2,column:6},[root]);
  assert.ok(definition.results.some(item=>item.file==='dep_api/core.py'&&item.read_only===false));
  const rename=await navigatePython({path:root,file:'local_client.py',action:'rename_preview',line:2,column:6,new_name:'project_scale'},[root]);
  assert.ok(rename.edits!.some(item=>item.file==='dep_api/core.py'));
  assert.ok(rename.edits!.some(item=>item.file==='local_client.py'));
  assert.ok(rename.edits!.every(item=>!item.file.startsWith('.venv/')));
});

test('Python stub-only packages preserve original UTF-16 positions and do not require runtime implementations',async t=>{
  const {root}=await fixture(t),{site}=await dependencyFixture(root);
  await mkdir(join(site,'only_stubs-stubs'));await writeFile(join(site,'only_stubs-stubs/__init__.pyi'),'\uFEFFlabel = "😀"; exported: int\r\n');
  await writeFile(join(root,'only_stub_client.py'),'import only_stubs\nvalue = only_stubs.exported\n');
  const result=await navigatePython({path:root,file:'only_stub_client.py',action:'definition',line:2,column:23},[root]);
  const entry=result.results.find(item=>item.name==='exported');assert.ok(entry);
  assert.equal(entry.file,'.venv/Lib/site-packages/only_stubs-stubs/__init__.pyi');assert.equal(entry.read_only,true);
  assert.equal(entry.column,'\uFEFFlabel = "😀"; '.length+1);assert.equal(entry.end_column,Number(entry.column)+8);
});

test('Python typed marker changes invalidate captured environments and malformed markers refuse analysis',async t=>{
  const {root}=await fixture(t),{site}=await stubFixture(root);
  const marker=join(site,'dep_api-stubs/py.typed');await writeFile(marker,'partial\n');
  const project=await loadPythonProject({path:root},[root]);assert.equal(project.dependencies.typed_markers[0]!.partial,true);
  assert.ok(project.environment.pins.some(item=>item.path.endsWith('typing_views.py')));
  await writeFile(marker,'');assert.throws(()=>verifyPythonEnvironment(project),/environment changed/);
  await writeFile(marker,Buffer.from([255]));await assert.rejects(loadPythonProject({path:root},[root]),/typing marker requires UTF-8/);
});

test('Python local namespace modules override installed stub children for qualified callers',async t=>{
  const {root}=await fixture(t);await stubFixture(root);
  await mkdir(join(root,'dep_api'));await writeFile(join(root,'dep_api/core.py'),'def scale(n):\n    return n * 2\ndef local_only(n):\n    return n + 1\n');
  await writeFile(join(root,'namespace_client.py'),'import dep_api.core as api\napi.scale(4)\napi.local_only(5)\n');
  const result=await navigatePython({path:root,file:'namespace_client.py',action:'definition',line:2,column:6},[root]);
  assert.ok(result.results.some(item=>item.file==='dep_api/core.py'&&item.read_only===false));
  await assert.rejects(navigatePython({path:root,file:'namespace_client.py',action:'rename_preview',line:2,column:6,new_name:'namespace_scale'},[root]),/read-only/);
  const rename=await navigatePython({path:root,file:'namespace_client.py',action:'rename_preview',line:3,column:6,new_name:'namespace_local'},[root]);
  assert.ok(rename.edits!.some(item=>item.file==='namespace_client.py'));assert.ok(rename.edits!.every(item=>!item.file.startsWith('.venv/')));
});

test('Python stub packages merge namespace contributors across site roots and prefer later stubs over earlier implementations',async t=>{
  const {root}=await fixture(t),{site}=await dependencyFixture(root);
  const second=join(root,'.venv/lib/python3.13/site-packages');await mkdir(second,{recursive:true});
  const files={
    'dep_api-stubs/__init__.pyi':'from .core import scale as scale\n',
    'dep_api-stubs/core.pyi':'def scale(n: int) -> str: ...\n',
    'dep_api-stubs/py.typed':'partial\n',
  };
  for(const [file,text] of Object.entries(files)){await mkdir(join(site,file,'..'),{recursive:true});await writeFile(join(site,file),text);}
  await mkdir(join(second,'dep_api'));await writeFile(join(second,'dep_api/__init__.py'),'from .core import scale\n');await writeFile(join(second,'dep_api/core.py'),'def scale(n):\n    return n * 8\n');await writeFile(join(second,'dep_api/extra.py'),'def fallback():\n    return 5\n');
  await mkdir(join(second,'shapes-stubs/right'),{recursive:true});await writeFile(join(second,'shapes-stubs/right/__init__.pyi'),'def right() -> int: ...\n');
  await mkdir(join(site,'shapes-stubs/left'),{recursive:true});await writeFile(join(site,'shapes-stubs/left/__init__.pyi'),'def left() -> int: ...\n');
  await writeFile(join(site,'dep_api/extra.py'),'def fallback():\n    return 5\n');
  await writeFile(join(root,'multi_client.py'),'import dep_api.core as api\napi.scale(4)\nimport dep_api.extra as extra\nextra.fallback()\nfrom shapes.left import left\nleft()\nfrom shapes.right import right\nright()\n');
  const definition=await navigatePython({path:root,file:'multi_client.py',action:'definition',line:2,column:6},[root]);
  assert.ok(definition.results.some(item=>item.file==='.venv/Lib/site-packages/dep_api-stubs/core.pyi'));
  assert.ok(definition.project.environment.dependencies.site_packages[0]!.endsWith('/python3.13/site-packages'));
  const fallback=await navigatePython({path:root,file:'multi_client.py',action:'definition',line:4,column:9},[root]);
  assert.ok(fallback.results.some(item=>String(item.file).endsWith('/python3.13/site-packages/dep_api/extra.py')));
  for(const [line,name] of [[6,'left'],[8,'right']] as const){const result=await navigatePython({path:root,file:'multi_client.py',action:'definition',line,column:2},[root]);assert.ok(result.results.some(item=>item.name===name&&item.read_only===true));}
});

test('Python virtual environment definitions are captured read-only without executing packages or site hooks',async t=>{
  const {root}=await fixture(t),{site,core}=await dependencyFixture(root);
  const original=await readFile(join(site,'dep_api/core.py'));
  const definition=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(definition.results.some(item=>item.file===core&&item.line===2&&item.read_only===true));
  assert.equal(definition.project.environment.dependencies.root,'.venv');
  assert.equal(definition.project.environment.dependencies.selection,'auto');
  assert.equal(definition.project.source_files,5);
  assert.equal(definition.project.environment.dependencies.files,3);
  assert.ok(definition.project.source_selection.read_only_files.includes(core));
  assert.ok(!definition.project.source_selection.analysis_files.includes('.venv/Lib/site-packages/unreachable.py'));
  const outline=await navigatePython({path:root,file:core,action:'outline'},[root]);
  assert.ok(outline.results.some(item=>item.name==='scale'&&item.read_only===true));
  await assert.rejects(navigatePython({path:root,file:core,action:'rename_preview',line:2,column:6,new_name:'modified'},[root]),/read-only/);
  await assert.rejects(navigatePython({path:root,file:'dependency_client.py',action:'rename_preview',line:1,column:21,new_name:'modified'},[root]),/read-only/);
  const alias=await navigatePython({path:root,file:'dependency_client.py',action:'rename_preview',line:2,column:11,new_name:'local_multiply'},[root]);
  assert.equal(alias.total,2);assert.deepEqual(alias.edits!.map(item=>item.file),['dependency_client.py']);
  assert.equal(apply(await readFile(join(root,'dependency_client.py'),'utf8'),alias.edits![0]!),'from dep_api import public_scale as local_multiply\nvalue = local_multiply(4)\n');
  assert.deepEqual(await readFile(join(site,'dep_api/core.py')),original);
  await assert.rejects(readFile(join(root,'executed-site-hook')),/ENOENT/);
  const selected=await navigatePython({path:root,file:'dependency_client.py',files:['dependency_client.py'],action:'definition',line:2,column:11},[root]);
  assert.equal(selected.project.environment.dependencies.root,null);assert.equal(selected.project.environment.dependencies.files,0);
  assert.ok(selected.results.every(item=>!String(item.file).startsWith('.venv/')));
});

test('Python configured virtual environments use inherited JSONC and TOML paths and exclude the entire environment from source roots',async t=>{
  const {root}=await fixture(t),{core}=await dependencyFixture(root,'environments/custom');
  await dependencyFixture(root,'.venv');
  await mkdir(join(root,'configs'));
  await writeFile(join(root,'configs/base.json'),'{"venvPath":"../environments","venv":"custom"}');
  await writeFile(join(root,'pyrightconfig.json'),'{"extends":"configs/base.json"}');
  const json=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(json.results.some(item=>item.file===core));assert.equal(json.project.environment.dependencies.selection,'configured');
  assert.ok(json.snapshots.every(item=>!item.file.startsWith('environments/custom/')));
  assert.ok(!json.project.import_settings.ignored_options.includes('venv'));
  await unlink(join(root,'pyrightconfig.json'));
  await writeFile(join(root,'pyproject.toml'),'[tool.pyright]\nvenvPath="environments"\nvenv="custom"\n');
  const toml=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(toml.results.some(item=>item.file===core));
  await writeFile(join(root,'pyrightconfig.json'),'{"venv":".venv"}');
  const precedence=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(precedence.results.some(item=>item.file==='.venv/Lib/site-packages/dep_api/core.py'));
});

test('Python dependency capture refuses external roots, linked inventories, malformed configuration and excessive files',async t=>{
  const {root}=await fixture(t);await dependencyFixture(root);
  for(const settings of [{venvPath:'../external',venv:'env'},{venvPath:'C:/outside',venv:'env'},{venv:42},{venv:'../env'},{venvPath:'.'},{venv:'missing'}]){
    await writeFile(join(root,'pyrightconfig.json'),JSON.stringify(settings));
    await assert.rejects(loadPythonProject({path:root},[root]),/virtual environment/);
  }
  await writeFile(join(root,'pyrightconfig.json'),'{"venv":".venv"}');
  const linked=join(root,'.venv/Lib/site-packages/linked');await symlink(join(root,'pkg'),linked,'junction');
  try{await assert.rejects(loadPythonProject({path:root},[root]),/linked/);}finally{await unlink(linked);}
  await writeFile(join(root,'.venv/Lib/site-packages/oversized.py'),'#'.repeat(512*1024+1));
  await assert.rejects(loadPythonProject({path:root},[root]),/capture boundary/);
});

test('Python dependency source, metadata, inventory and same-byte ancestor changes invalidate durable rename before intent',async t=>{
  const {root}=await fixture(t),{site}=await dependencyFixture(root);
  const captured=await loadPythonProject({path:root},[root]);
  await writeFile(join(site,'new_module.py'),'value=1\n');assert.throws(()=>verifyPythonEnvironment(captured),/inventory changed/);
  await unlink(join(site,'new_module.py'));verifyPythonEnvironment(captured);
  const config=await readFile(join(root,'.venv/pyvenv.cfg'));
  await writeFile(join(root,'.venv/pyvenv.cfg'),Buffer.concat([config,Buffer.from('# changed\n')]));assert.throws(()=>verifyPythonEnvironment(captured),/environment changed/);
  await writeFile(join(root,'.venv/pyvenv.cfg'),config);
  const hook=await readFile(join(site,'activation.pth'));
  await writeFile(join(site,'activation.pth'),'import changed\n');assert.throws(()=>verifyPythonEnvironment(captured),/environment changed/);
  await writeFile(join(site,'activation.pth'),hook);
  await rename(join(site,'dep_api'),join(site,'dep_api-original'));await symlink(join(site,'dep_api-original'),join(site,'dep_api'),'junction');
  try{assert.throws(()=>verifyPythonEnvironment(captured),/inventory changed|linked/);}finally{await unlink(join(site,'dep_api'));await rename(join(site,'dep_api-original'),join(site,'dep_api'));}
  const state=await mkdtemp(join(tmpdir(),'forge-python-dependency-state-')),engine=new DurableTasks(state),batches=new TaskFileBatches(engine);
  t.after(()=>{engine.close();return rm(state,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(root,'dependency-fence','rename local alias',['echo ok'],true),read=batches.readText,original=await readFile(join(site,'dep_api/core.py')),client=await readFile(join(root,'dependency_client.py'));
  batches.readText=function(project,file){const value=read.call(this,project,file);writeFileSync(join(site,'dep_api/core.py'),Buffer.concat([original,Buffer.from('# changed after analysis\n')]));return value;};
  try{
    await assert.rejects(renameTask(engine,batches,{task_id:task.task_id,operation_id:'dependency-changed',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'dependency_client.py',line:2,column:11,new_name:'local_multiply'},[root]),/environment changed/);
    assert.equal(engine.status(task.task_id).operations.length,0);assert.deepEqual(await readFile(join(root,'dependency_client.py')),client);
  }finally{await writeFile(join(site,'dep_api/core.py'),original);batches.readText=read;}
  assert.equal(snapshot(root).fingerprint,task.fingerprint);
});

test('Python local modules shadow installed dependencies while inline stubs remain read-only and syntax diagnostics include reached dependencies',async t=>{
  const {root}=await fixture(t),{site,core}=await dependencyFixture(root);
  await writeFile(join(root,'dep_api.py'),'def public_scale(n):\n    return n * 3\n');
  const local=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(local.results.some(item=>item.file==='dep_api.py'&&item.read_only===false));
  await unlink(join(root,'dep_api.py'));
  await writeFile(join(site,'dep_api/core.pyi'),'def scale(n: int) -> int: ...\n');
  const stub=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(stub.results.some(item=>item.file===core.replace('.py','.pyi')&&item.read_only===true));
  await unlink(join(site,'dep_api/core.pyi'));await writeFile(join(site,'dep_api/core.py'),'def broken(\n');
  const syntax=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.ok(syntax.results.some(item=>item.file===core&&item.read_only===true));
  await assert.rejects(navigatePython({path:root,file:'dependency_client.py',action:'rename_preview',line:2,column:11,new_name:'local_multiply'},[root]),/syntax errors/);
});

test('Python virtual environment source and metadata counts and bytes are bounded independently of project capture',async t=>{
  const {root}=await fixture(t),{site}=await dependencyFixture(root);
  await writeFile(join(root,'pyrightconfig.json'),'{"venv":".venv"}');
  for(let index=0;index<4094;index+=32)await Promise.all(Array.from({length:Math.min(32,4094-index)},(_,offset)=>writeFile(join(site,`bounded_${index+offset}.py`),'value=1\n')));
  await assert.rejects(loadPythonProject({path:root},[root]),/4,096 source files/);
  for(let index=0;index<4094;index+=32)await Promise.all(Array.from({length:Math.min(32,4094-index)},(_,offset)=>unlink(join(site,`bounded_${index+offset}.py`))));
  const data='#'.repeat(512*1024);
  for(let index=0;index<128;index+=8)await Promise.all(Array.from({length:8},(_,offset)=>writeFile(join(site,`large_${index+offset}.py`),data)));
  await assert.rejects(loadPythonProject({path:root},[root]),/64 MiB/);
  for(let index=0;index<128;index+=16)await Promise.all(Array.from({length:16},(_,offset)=>unlink(join(site,`large_${index+offset}.py`))));
  for(let index=0;index<256;index+=16)await Promise.all(Array.from({length:16},(_,offset)=>writeFile(join(site,`hook_${index+offset}.pth`),'../../external\n')));
  await assert.rejects(loadPythonProject({path:root},[root]),/metadata exceeds 256 files/);
});

test('Python POSIX environment layouts and unsupported dependency encodings are captured without following interpreter links',async t=>{
  // Retain this tiny platform-specific link fixture in our ignored workspace
  // directory as evidence; rejected link cleanup must not be retried by a test.
  const {root}=await fixture(t,fileURLToPath(new URL('../node_modules/',import.meta.url)),true),{site}=await dependencyFixture(root,'envs/portable');
  await mkdir(join(root,'envs/portable/lib/python3.13'),{recursive:true});
  await rename(site,join(root,'envs/portable/lib/python3.13/site-packages'));
  await mkdir(join(root,'envs/portable/bin'));await symlink(join(root,'caller.py'),join(root,'envs/portable/bin/python'),'file');
  await writeFile(join(root,'pyrightconfig.json'),'{"venvPath":"envs","venv":"portable"}');
  const result=await navigatePython({path:root,file:'dependency_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(result.results.some(item=>String(item.file).toLowerCase()==='envs/portable/lib/python3.13/site-packages/dep_api/core.py'&&item.read_only===true));
  await writeFile(join(root,'dependency_client.py'),'import unreachable\nvalue=1\n');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/UTF-8.*unreachable.py/);
  t.diagnostic('Retained portable environment evidence: '+root);
});

test('Python environment selection and layout changes require recapture even when dependency bytes remain unchanged',async t=>{
  const {root}=await fixture(t);
  const absent=await loadPythonProject({path:root},[root]);
  await dependencyFixture(root);
  assert.throws(()=>verifyPythonEnvironment(absent),/environment selection changed/);
  const present=await loadPythonProject({path:root},[root]);
  await mkdir(join(root,'.venv/Lib/python3.14'));
  assert.throws(()=>verifyPythonEnvironment(present),/environment layout changed/);
  const refreshed=await loadPythonProject({path:root},[root]);
  assert.notEqual(refreshed.environment.fingerprint,present.environment.fingerprint);
  assert.equal(refreshed.dependencies.sources.size,present.dependencies.sources.size);
});

test('Python project source filters retain imported dependencies while excluding unrelated syntax data and callers',async t=>{
  const {root}=await fixture(t);
  for(const folder of ['app','libpkg','bad_data'])await mkdir(join(root,folder));
  await writeFile(join(root,'app/client.py'),'from libpkg import public_scale as twice\nvalue = twice(4)\n');
  await writeFile(join(root,'libpkg/__init__.py'),'from .core import compute as public_scale\n');
  await writeFile(join(root,'libpkg/core.py'),'from .helper import offset\ndef compute(n):\n    return n * 2 + offset\n');
  await writeFile(join(root,'libpkg/helper.py'),'offset = 0\n');
  await writeFile(join(root,'excluded_caller.py'),'from libpkg.core import compute\nvalue = compute(5)\n');
  await writeFile(join(root,'bad_data/broken.py'),'def intentional(\n');
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["app"],"exclude":["libpkg","bad_data"]}');
  const diagnostics=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(diagnostics.results,[]);
  assert.deepEqual(diagnostics.project.source_selection.root_files,['app/client.py']);
  assert.deepEqual(diagnostics.project.source_selection.analysis_files,['app/client.py','libpkg/__init__.py','libpkg/core.py','libpkg/helper.py']);
  const preview=await navigatePython({path:root,file:'libpkg/core.py',action:'rename_preview',line:2,column:6,new_name:'scale'},[root]);
  assert.deepEqual(preview.edits!.map(item=>item.file).sort(),['libpkg/__init__.py','libpkg/core.py']);
  assert.equal(preview.total,2);
  const refs=await navigatePython({path:root,file:'libpkg/core.py',action:'references',line:2,column:6},[root]);
  assert.ok(!refs.results.some(item=>item.file==='excluded_caller.py'));
  await assert.rejects(navigatePython({path:root,file:'excluded_caller.py',action:'outline'},[root]),/analysis.*source|source.*filter/i);
  const selected=await navigatePython({path:root,file:'bad_data/broken.py',files:['bad_data/broken.py'],action:'diagnostics'},[root]);
  assert.equal(selected.results[0]?.file,'bad_data/broken.py');
  assert.equal(selected.project.source_selection.applied,false);
  await writeFile(join(root,'libpkg/helper.py'),'def imported_broken(\n');
  const importedError=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.ok(importedError.results.some(item=>item.file==='libpkg/helper.py'));
  await assert.rejects(navigatePython({path:root,file:'libpkg/core.py',action:'rename_preview',line:2,column:6,new_name:'scale'},[root]),/syntax errors/);
});

test('Python source-filter inheritance and TOML settings select config-relative globs with JSON precedence',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'configs'));
  await mkdir(join(root,'app/deep'),{recursive:true});
  for(const file of ['app/main.py','app/deep/main1.py','app/deep/other.py'])await writeFile(join(root,file),'value = 4\n');
  await writeFile(join(root,'app/deep/broken.py'),'def data(\n');
  await writeFile(join(root,'configs/base.json'),'{"include":["../app/**/main?.py","../app/main.py"],"exclude":["../app/deep/other.py"]}');
  await writeFile(join(root,'pyrightconfig.json'),'{"extends":"configs/base.json","reportMissingImports":"error"}');
  await writeFile(join(root,'pyproject.toml'),'[tool.pyright]\ninclude=["pkg"]\nexclude=["pkg"]\n');
  const inherited=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(inherited.results,[]);
  assert.deepEqual(inherited.project.source_selection.root_files,['app/deep/main1.py','app/main.py']);
  assert.ok(!inherited.project.import_settings.ignored_options.includes('include'));
  assert.equal(inherited.project.import_settings.checker_options.reportMissingImports,'error');
  await writeFile(join(root,'pyrightconfig.json'),'{"extends":"configs/base.json","include":["APP/MAIN.PY"]}');
  const override=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(override.project.source_selection.root_files,['app/main.py']);
  await unlink(join(root,'pyrightconfig.json'));
  await writeFile(join(root,'pyproject.toml'),'[tool.pyright]\ninclude=["app/**/*.py"]\nexclude=["app/deep"]\n');
  const toml=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(toml.results,[]);
  assert.deepEqual(toml.project.source_selection.root_files,['app/main.py']);
});

test('Python source roots include qualified and star-import dependencies and preserve the explicit capture boundary',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'app'));await mkdir(join(root,'dep'));
  await writeFile(join(root,'dep/__init__.py'),'from .core import compute\n');
  await writeFile(join(root,'dep/core.py'),'def compute(n):\n    return n * 2\n');
  await writeFile(join(root,'app/qualified.py'),'import dep.core as tools\nvalue = tools.compute(4)\n');
  await writeFile(join(root,'app/star.py'),'from dep.core import *\nvalue = compute(4)\n');
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["app"],"exclude":["dep"]}');
  const result=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(result.project.source_selection.analysis_files,['app/qualified.py','app/star.py','dep/__init__.py','dep/core.py']);
  const definition=await navigatePython({path:root,file:'app/qualified.py',action:'definition',line:2,column:16},[root]);
  assert.ok(definition.results.some(item=>item.file==='dep/core.py'));
  const preview=await navigatePython({path:root,file:'dep/core.py',action:'rename_preview',line:1,column:6,new_name:'scale'},[root]);
  assert.ok(preview.edits!.some(item=>item.file==='app/qualified.py'));
  assert.ok(preview.edits!.some(item=>item.file==='app/star.py'));
  const selected=await navigatePython({path:root,file:'app/qualified.py',files:['app/qualified.py'],action:'diagnostics'},[root]);
  assert.deepEqual(selected.project.source_selection.analysis_files,['app/qualified.py']);
  assert.equal(selected.snapshots.length,1);
});

test('Python malformed source filters refuse analysis and excluded data still obey capture bounds',async t=>{
  const {root}=await fixture(t);
  for(const setting of [
    {include:'pkg'},{include:[42]},{include:['../outside']},{exclude:['C:/outside']},
    {include:['~']},{include:['a'.repeat(513)]},{exclude:Array(257).fill('pkg')},
  ]){
    await writeFile(join(root,'pyrightconfig.json'),JSON.stringify(setting));
    await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/source filter|source filters/i);
  }
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["absent"]}');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/No Python analysis sources/);
  await writeFile(join(root,'pyrightconfig.json'),'{"include":[],"exclude":["pkg"]}');
  const empty=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.ok(empty.project.source_selection.root_files.includes('caller.py'));
  assert.ok(empty.project.source_selection.analysis_files.includes('pkg/math.py'));
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["caller.py"],"exclude":["oversized.py"]}');
  await writeFile(join(root,'oversized.py'),'#'.repeat(513*1024));
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/512 KiB/);
});

test('Python default hidden-root exclusions and skipped links do not widen source access',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'.hidden'));
  await writeFile(join(root,'.hidden/data.py'),'def data(\n');
  await symlink(join(root,'pkg'),join(root,'linked'),'junction');
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["**"],"exclude":[]}');
  const result=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(result.results,[]);
  assert.ok(result.project.skipped_links.includes('linked'));
  assert.ok(result.project.source_selection.excluded_files.includes('.hidden/data.py'));
  await assert.rejects(navigatePython({path:root,file:'.hidden/data.py',action:'outline'},[root]),/source filters/);
  const explicit=await navigatePython({path:root,file:'.hidden/data.py',files:['.hidden/data.py'],action:'diagnostics'},[root]);
  assert.ok(explicit.results.some(item=>item.file==='.hidden/data.py'));
  assert.equal(explicit.project.source_selection.applied,false);
  await unlink(join(root,'linked'));
});

test('Python filtered dependency closure resolves same-name imports in each execution environment',async t=>{
  const {root}=await fixture(t);
  for(const name of ['a','b']){
    await mkdir(join(root,'apps',name),{recursive:true});await mkdir(join(root,'libs',name),{recursive:true});
    await writeFile(join(root,'apps',name,'caller.py'),'from shared import compute as twice\nvalue = twice(4)\n');
    await writeFile(join(root,'libs',name,'shared.py'),`def compute(n):\n    return n * ${name==='a'?2:3}\n`);
  }
  await mkdir(join(root,'libs','default'),{recursive:true});
  await writeFile(join(root,'libs/default/shared.py'),'def unused_bad(\n');
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["apps"],"exclude":["libs"],"extraPaths":["libs/default"],"executionEnvironments":[{"root":"apps/a","extraPaths":["libs/a"]},{"root":"apps/b","extraPaths":["libs/b"]}]}');
  const result=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(result.results,[]);
  assert.deepEqual(result.project.source_selection.analysis_files,['apps/a/caller.py','apps/b/caller.py','libs/a/shared.py','libs/b/shared.py']);
  const preview=await navigatePython({path:root,file:'libs/a/shared.py',action:'rename_preview',line:1,column:6,new_name:'scale'},[root]);
  assert.equal(preview.total,2);
  assert.deepEqual(preview.edits!.map(item=>item.file).sort(),['apps/a/caller.py','libs/a/shared.py']);
});

test('Python excluded non-UTF8 test data remains pinned while required analysis sources refuse unsupported encoding',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'data'));
  const raw=Buffer.from([35,32,255,10,118,97,108,117,101,32,61,32,49,10]);
  await writeFile(join(root,'data/non_utf8.py'),raw);
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["caller.py"],"exclude":["data"]}');
  const captured=await loadPythonProject({path:root},[root]);
  assert.ok(captured.opaque_sources.has('data/non_utf8.py'));
  assert.equal(captured.snapshots.find(item=>item.file==='data/non_utf8.py')?.sha256,pythonHash(raw));
  const result=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(result.results,[]);
  assert.deepEqual(result.project.opaque_sources,['data/non_utf8.py']);
  assert.ok(result.project.source_selection.excluded_files.includes('data/non_utf8.py'));
  assert.equal(result.snapshots.find(item=>item.file==='data/non_utf8.py')?.sha256,pythonHash(raw));
  await assert.rejects(navigatePython({path:root,file:'data/non_utf8.py',files:['data/non_utf8.py'],action:'diagnostics'},[root]),/UTF-8/);
  await writeFile(join(root,'data/non_utf8.py'),Buffer.concat([raw,Buffer.from('# changed')]));
  assert.throws(()=>verifyPythonEnvironment(captured),/environment changed/);
  const refreshed=await loadPythonProject({path:root},[root]);
  assert.notEqual(refreshed.environment.fingerprint,captured.environment.fingerprint);
  await writeFile(join(root,'data/non_utf8.py'),raw);
  await rename(join(root,'data'),join(root,'data-original'));
  await symlink(join(root,'data-original'),join(root,'data'),'junction');
  try { assert.throws(()=>verifyPythonEnvironment(captured),/linked project path/); }
  finally { await unlink(join(root,'data'));await rename(join(root,'data-original'),join(root,'data')); }
  await writeFile(join(root,'opaque.py'),raw);
  await writeFile(join(root,'caller.py'),'import opaque\nvalue = opaque.value\n');
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["caller.py"],"exclude":["opaque.py","data"]}');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/UTF-8.*opaque.py/);
});

test('Python configured package roots resolve custom layouts and preserve downstream public aliases',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'python-lib','pkg_api'),{recursive:true});
  await writeFile(join(root,'python-lib','pkg_api','math.py'),'def compute(n):\n    return n * 2\n');
  await writeFile(join(root,'python-lib','pkg_api','__init__.py'),'from .math import compute as public_compute\n');
  await writeFile(join(root,'configured.py'),'from pkg_api import public_compute\nvalue = public_compute(4)\n');
  await writeFile(join(root,'pyproject.toml'),'[project]\nname="custom-layout"\nversion="0.0.0"\n[tool.setuptools.package-dir]\n"" = "python-lib"\n');
  const definition=await navigatePython({path:root,file:'configured.py',action:'definition',line:2,column:11},[root]);
  assert.ok(definition.results.some(item=>item.file==='python-lib/pkg_api/math.py'&&item.line===1));
  const preview=await navigatePython({path:root,file:'python-lib/pkg_api/math.py',action:'rename_preview',line:1,column:6,new_name:'scale'},[root]);
  assert.deepEqual(preview.edits!.map(item=>item.file).sort(),['python-lib/pkg_api/__init__.py','python-lib/pkg_api/math.py']);
  assert.equal(apply(await readFile(join(root,'python-lib','pkg_api','__init__.py'),'utf8'),preview.edits!.find(item=>item.file.endsWith('__init__.py'))!),'from .math import scale as public_compute\n');
});

test('Python execution environments isolate same-name modules and rename only their actual callers',async t=>{
  const {root}=await fixture(t);
  for(const name of ['a','b','default']){await mkdir(join(root,'deps',name),{recursive:true});await writeFile(join(root,'deps',name,'shared.py'),`def compute(n):\n    return n * ${name==='a'?2:name==='b'?3:5}\n`);}
  for(const name of ['a','b']){await mkdir(join(root,'apps',name),{recursive:true});await writeFile(join(root,'apps',name,'client.py'),'from shared import compute\nvalue = compute(4)\n');}
  await writeFile(join(root,'apps','a','alias.py'),'from shared import compute as twice\nvalue = twice(4)\ndef shadow(compute):\n    return compute(5)\n');
  await writeFile(join(root,'apps','a','qualified.py'),'import shared as tools\nvalue = tools.compute(4)\n');
  await writeFile(join(root,'default_client.py'),'from shared import compute\nvalue = compute(4)\n');
  await writeFile(join(root,'pyrightconfig.json'),'// Shared global paths are overridden per environment.\n{"extraPaths":["deps/default"],"executionEnvironments":[{"root":"apps/a","extraPaths":["deps/a"]},{"root":"apps/b","extraPaths":["deps/b"]},],}\n');
  for(const name of ['a','b']){
    const result=await navigatePython({path:root,file:`apps/${name}/client.py`,action:'definition',line:2,column:11},[root]);
    assert.ok(result.results.some(item=>item.file===`deps/${name}/shared.py`));
    assert.ok(!result.results.some(item=>item.file===`deps/${name==='a'?'b':'a'}/shared.py`));
  }
  const fallback=await navigatePython({path:root,file:'default_client.py',action:'definition',line:2,column:11},[root]);
  assert.ok(fallback.results.some(item=>item.file==='deps/default/shared.py'));
  const refs=await navigatePython({path:root,file:'deps/a/shared.py',action:'references',line:1,column:6},[root]);
  assert.ok(refs.results.some(item=>item.file==='apps/a/qualified.py'&&item.line===2));
  assert.ok(!refs.results.some(item=>item.file==='apps/b/client.py'||item.file==='default_client.py'));
  const preview=await navigatePython({path:root,file:'deps/a/shared.py',action:'rename_preview',line:1,column:6,new_name:'scale'},[root]);
  assert.deepEqual(preview.edits!.map(item=>item.file).sort(),['apps/a/alias.py','apps/a/client.py','apps/a/qualified.py','deps/a/shared.py']);
  assert.equal(preview.total,5);
  assert.equal(apply(await readFile(join(root,'apps','a','alias.py'),'utf8'),preview.edits!.find(item=>item.file==='apps/a/alias.py')!),'from shared import scale as twice\nvalue = twice(4)\ndef shadow(compute):\n    return compute(5)\n');
  assert.equal(apply(await readFile(join(root,'apps','a','qualified.py'),'utf8'),preview.edits!.find(item=>item.file==='apps/a/qualified.py')!),'import shared as tools\nvalue = tools.scale(4)\n');
});

test('Python import configuration refuses unsafe or malformed roots and selected mode remains independent',async t=>{
  const {root}=await fixture(t);
  for(const setting of ['{"extraPaths":["../external"]}','{"extraPaths":[".venv"]}','{"extraPaths":[42]}','{"executionEnvironments":[{"extraPaths":[]}]}']){
    await writeFile(join(root,'pyrightconfig.json'),setting);
    await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/configuration|import path|environment/i);
  }
  await writeFile(join(root,'pyrightconfig.json'),'broken {');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/configuration/i);
  assert.equal((await navigatePython({path:root,files:['pkg/math.py'],action:'diagnostics'},[root])).results.length,0);
  await writeFile(join(root,'pyrightconfig.json'),'{"extraPaths":["linked"]}');
  await symlink(join(root,'pkg'),join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/import path|link/i);
  await unlink(join(root,'linked'));
});

test('Python captured import configuration changes invalidate its environment before a durable write',async t=>{
  const {root}=await fixture(t);
  await writeFile(join(root,'pyrightconfig.json'),'{"extraPaths":["pkg"]}');
  const result=await runPythonAnalysis({path:root,action:'diagnostics'},[root]);
  await writeFile(join(root,'pyrightconfig.json'),'{"extraPaths":[]}');
  assert.throws(()=>verifyPythonEnvironment(result.project),/environment changed/);
});

test('Python TOML, setup.cfg and inherited JSONC roots resolve in config-relative order with JSON precedence',async t=>{
  const {root}=await fixture(t);
  for(const name of ['one','two']){await mkdir(join(root,`lib-${name}`));await writeFile(join(root,`lib-${name}`,'config_api.py'),`def compute(n):\n    return n * ${name==='one'?2:3}\n`);}
  await writeFile(join(root,'config_client.py'),'from config_api import compute\nvalue = compute(4)\n');
  await writeFile(join(root,'pyproject.toml'),'[project]\nname="configuration"\n[tool.pyright]\nextraPaths=["lib-one"]\ninclude=["config_client.py"]\n');
  const input={path:root,file:'config_client.py',action:'definition' as const,line:2,column:11};
  assert.ok((await navigatePython(input,[root])).results.some(item=>item.file==='lib-one/config_api.py'));
  await mkdir(join(root,'configs'));
  await writeFile(join(root,'configs','base.json'),'{"extraPaths":["../lib-two"],"reportMissingImports":"error"}');
  await writeFile(join(root,'pyrightconfig.json'),'{"extends":"configs/base.json"}');
  const inherited=await navigatePython(input,[root]);
  assert.ok(inherited.results.some(item=>item.file==='lib-two/config_api.py'));
  assert.deepEqual(inherited.project.configs.map(item=>item.file).sort(),['configs/base.json','pyproject.toml','pyrightconfig.json']);
  assert.equal(inherited.project.import_settings.checker_options.reportMissingImports,'error');
  await unlink(join(root,'pyrightconfig.json'));
  await writeFile(join(root,'pyproject.toml'),'[project]\nname="configuration"\n');
  await writeFile(join(root,'setup.cfg'),'[metadata]\nname=configuration\n[options]\npackage_dir=\n    =lib-two\n');
  assert.ok((await navigatePython(input,[root])).results.some(item=>item.file==='lib-two/config_api.py'));
});

test('Python config cycles, external inheritance, root bounds and unsafe glob expansion fail completely',async t=>{
  const {root}=await fixture(t);
  for(const config of ['{"extends":"pyrightconfig.json"}','{"extends":"../outside.json"}','{"extraPaths":'+JSON.stringify(Array(33).fill('.'))+'}']){
    await writeFile(join(root,'pyrightconfig.json'),config);
    await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/configuration|outside allowed roots/i);
  }
  await mkdir(join(root,'libs'));await mkdir(join(root,'libs','safe'));
  await symlink(join(root,'pkg'),join(root,'libs','linked'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(root,'pyrightconfig.json'),'{"extraPaths":["libs/*"]}');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/glob.*link/);
  await unlink(join(root,'libs','linked'));
  const expanded=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.ok(expanded.project.import_settings.default_roots.includes('libs/safe'));
});

test('Python static navigation resolves reexports, aliases and methods without executing project code',async t=>{
  const {root}=await fixture(t);
  await writeFile(join(root,'poison.py'),'from pathlib import Path\nPath("executed.txt").write_text("bad")\nfrom pkg.math import double\n');
  const definition=await navigatePython({path:root,file:'caller.py',action:'definition',line:2,column:2},[root]);
  assert.ok(definition.results.some(item=>item.file==='pkg/math.py'&&item.line===1));
  const refs=await navigatePython({path:root,file:'pkg/math.py',action:'references',line:1,column:6},[root]);
  assert.ok(refs.results.some(item=>item.file==='caller.py'&&item.line===2));
  assert.ok(!refs.results.some(item=>item.file==='caller.py'&&(item.line===3||item.line===4)));
  const outline=await navigatePython({path:root,file:'pkg/math.py',action:'outline'},[root]);
  assert.ok(outline.results.some(item=>item.name==='scale'&&item.parent==='Counter'));
  await writeFile(join(root,'method.py'),'from pkg.math import Counter\nc = Counter()\nc.scale(3)\n');
  const method=await navigatePython({path:root,file:'method.py',action:'definition',line:3,column:4},[root]);
  assert.ok(method.results.some(item=>item.file==='pkg/math.py'&&item.line===5));
  assert.equal(definition.project.language,'python');assert.equal(definition.project.environment.jedi_version,'0.19.2');
  await assert.rejects(readFile(join(root,'executed.txt')),/ENOENT/);
});

test('Python local rename covers annotated and conditional assignments while preserving nested and comprehension shadows',async t=>{
  const {root}=await fixture(t);
  const source=[
    'idx = 100',
    'def choose(values):',
    '    def sort_key(item):',
    '        try:',
    '            idx: float = values.index(item)',
    '        except ValueError:',
    '            idx = float("inf")',
    '        def shadow(idx):',
    '            idx += 1',
    '            return idx',
    '        def closure():',
    '            return idx',
    '        shadows = [idx for idx in range(2)]',
    '        return idx + closure() + shadow(5) + sum(shadows)',
    '    return [sort_key(item) for item in values]',
    'def unrelated():',
    '    global idx',
    '    idx += 1',
    '    return idx',
    '',
  ].join('\n');
  await writeFile(join(root,'branches.py'),source);
  const expected=source.split('\n').map((line,index)=>[4,6,11,13].includes(index)?line.replace(/\bidx\b/g,'invocation_index'):line).join('\n');
  for(const line of [5,7,14]){
    const column=source.split('\n')[line-1]!.indexOf('idx')+1;
    const preview=await navigatePython({path:root,file:'branches.py',action:'rename_preview',line,column,new_name:'invocation_index'},[root]);
    assert.equal(preview.total,4);assert.deepEqual(preview.edits!.map(item=>item.file),['branches.py']);
    assert.equal(apply(source,preview.edits![0]!),expected);
  }
  const refs=await navigatePython({path:root,file:'branches.py',action:'references',line:5,column:13},[root]);
  assert.ok(refs.results.some(item=>item.line===5&&item.is_definition));
  assert.ok(refs.results.some(item=>item.line===7&&item.is_definition));
});

test('Python exported rename follows callers and transparent reexports while preserving explicit aliases and shadows',async t=>{
  const {root,files}=await fixture(t);
  const preview=await navigatePython({path:root,file:'pkg/math.py',action:'rename_preview',line:1,column:6,new_name:'scale_value'},[root]);
  const changed=Object.fromEntries(preview.edits!.map(edit=>[edit.file,apply(files[edit.file as keyof typeof files],edit)]));
  assert.deepEqual(Object.keys(changed).sort(),Object.keys(files).sort());
  assert.equal(changed['caller.py'],'from pkg import scale_value as twice\ntwice(4)\ndef shadow(twice):\n    return twice(5)\n');
  assert.equal(changed['pkg/__init__.py'],'from .math import scale_value\n');
  assert.equal(changed['other.py'],'from pkg.math import scale_value\nvalue = scale_value(3)\n');
  assert.match(changed['pkg/math.py']!,/return scale_value\(n\)/);
  const imported=await navigatePython({path:root,file:'caller.py',action:'rename_preview',line:1,column:19,new_name:'scale_value'},[root]);
  assert.deepEqual(Object.fromEntries(imported.edits!.map(edit=>[edit.file,apply(files[edit.file as keyof typeof files],edit)])),changed);
  const local=await navigatePython({path:root,file:'caller.py',action:'rename_preview',line:2,column:2,new_name:'local_twice'},[root]);
  assert.deepEqual(local.edits!.map(item=>item.file),['caller.py']);
  assert.equal(apply(files['caller.py'],local.edits![0]!),'from pkg import double as local_twice\nlocal_twice(4)\ndef shadow(twice):\n    return twice(5)\n');
});

test('Python UTF-16 positions and rename preserve BOM, mixed newline bytes and non-BMP text',async t=>{
  const {root}=await fixture(t),source='\uFEFFdef 測試(n):\r\n    return n + 1\nvalue = "😀"; result = 測試(4)\r\n';
  await writeFile(join(root,'unicode.py'),source);
  const line=source.split(/\r?\n/)[2]!,column=line.indexOf('測試')+1;
  const def=await navigatePython({path:root,file:'unicode.py',action:'definition',line:3,column},[root]);
  assert.ok(def.results.some(item=>item.file==='unicode.py'&&item.line===1&&item.column===6));
  const preview=await navigatePython({path:root,file:'unicode.py',action:'rename_preview',line:3,column,new_name:'新函式'},[root]);
  assert.equal(apply(source,preview.edits![0]!),source.replaceAll('測試','新函式'));
  await assert.rejects(navigatePython({path:root,file:'unicode.py',action:'definition',line:3,column:line.indexOf('😀')+2},[root]),/surrogate/);
  await assert.rejects(navigatePython({path:root,file:'unicode.py',action:'definition',line:99,column:1},[root]),/Line outside/);
});

test('Python renamed exports preserve chained public aliases while renaming an alias updates its downstream API only',async t=>{
  const {root,files}=await fixture(t);
  const init='from .math import double as public_double\n',caller='from pkg import public_double\npublic_double(4)\n',other='from pkg import public_double as kept\nkept(3)\n';
  await writeFile(join(root,'pkg/__init__.py'),init);await writeFile(join(root,'caller.py'),caller);await writeFile(join(root,'other.py'),other);
  let preview=await navigatePython({path:root,file:'pkg/math.py',action:'rename_preview',line:1,column:6,new_name:'scale_value'},[root]);
  assert.deepEqual(preview.edits!.map(edit=>edit.file).sort(),['pkg/__init__.py','pkg/math.py']);
  const changes=Object.fromEntries(preview.edits!.map(edit=>[edit.file,apply(edit.file==='pkg/math.py'?files['pkg/math.py']:init,edit)]));
  assert.equal(changes['pkg/__init__.py'],'from .math import scale_value as public_double\n');
  preview=await navigatePython({path:root,file:'caller.py',action:'rename_preview',line:2,column:3,new_name:'public_scale'},[root]);
  assert.deepEqual(preview.edits!.map(edit=>edit.file).sort(),['caller.py','other.py','pkg/__init__.py']);
  const aliasChanges=Object.fromEntries(preview.edits!.map(edit=>[edit.file,apply(edit.file==='caller.py'?caller:edit.file==='other.py'?other:init,edit)]));
  assert.equal(aliasChanges['pkg/__init__.py'],'from .math import double as public_scale\n');
  assert.equal(aliasChanges['other.py'],'from pkg import public_scale as kept\nkept(3)\n');
  await writeFile(join(root,'pkg/__init__.py'),'from .math import double as double\n');await writeFile(join(root,'caller.py'),'from pkg import double\ndouble(4)\n');
  preview=await navigatePython({path:root,file:'pkg/math.py',action:'rename_preview',line:1,column:6,new_name:'scale_value'},[root]);
  assert.deepEqual(preview.edits!.map(edit=>edit.file).sort(),['pkg/__init__.py','pkg/math.py']);
  assert.equal(apply('from .math import double as double\n',preview.edits!.find(edit=>edit.file==='pkg/__init__.py')!),'from .math import scale_value as double\n');
});

test('Python AST diagnostics preserve syntax errors; stubs, file moves and invalid identifiers cannot become partial rename plans',async t=>{
  const {root}=await fixture(t);
  await writeFile(join(root,'broken.py'),'def broken(:\n    pass\n');
  const diagnostic=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.equal(diagnostic.project.diagnostics_kind,'syntax_and_type');assert.equal(diagnostic.project.type_checker?.name,'pyright');
  assert.ok(diagnostic.results.some(item=>item.file==='broken.py'&&item.code==='PY_SYNTAX'));
  await assert.rejects(navigatePython({path:root,file:'pkg/math.py',action:'rename_preview',line:1,column:6,new_name:'next'},[root]),/syntax errors/);
  await unlink(join(root,'broken.py'));
  await writeFile(join(root,'api.pyi'),'def external(n: int) -> int: ...\n');
  await assert.rejects(navigatePython({path:root,file:'api.pyi',action:'rename_preview',line:1,column:6,new_name:'changed'},[root]),/read-only/);
  for(const name of ['class','bad-name'])await assert.rejects(navigatePython({path:root,file:'pkg/math.py',action:'rename_preview',line:1,column:6,new_name:name},[root]),/identifier/);
  const base={path:root,file:'other.py',action:'rename_preview' as const,line:1,column:6,new_name:'renamed_pkg'};
  await assert.rejects(navigatePython(base,[root]),/module\/file moves/);
});

test('Python Pyright diagnostics find type errors in bounded snapshots and respect selected roots',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'app'));
  await writeFile(join(root,'app/typed.py'),'value: int = "incorrect"\nvalue2: int = 42\n');
  await writeFile(join(root,'outside.py'),'outside: int = "not selected"\n');
  await writeFile(join(root,'pyrightconfig.json'),'{"include":["app"],"typeCheckingMode":"strict","reportAssignmentType":"error"}');
  const before=await readFile(join(root,'app/typed.py'));
  const diagnostics=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.equal(diagnostics.project.diagnostics_kind,'syntax_and_type');
  assert.equal(diagnostics.project.type_checker?.version,'1.1.414');
  assert.equal(diagnostics.project.import_settings.checker_options.typeCheckingMode,'strict');
  assert.ok(diagnostics.results.some(item=>item.file==='app/typed.py'&&item.code==='reportAssignmentType'&&item.severity==='error'));
  assert.ok(diagnostics.results.every(item=>item.file!=='outside.py'));
  assert.equal((await navigatePython({path:root,file:'outside.py',files:['outside.py'],action:'diagnostics'},[root])).project.diagnostics_kind,'syntax_and_type');
  assert.ok((await navigatePython({path:root,file:'app/typed.py',action:'diagnostics'},[root])).results.every(item=>item.file==='app/typed.py'));
  assert.deepEqual(await readFile(join(root,'app/typed.py')),before);
  await writeFile(join(root,'app/typed.py'),'value: int = 1\nvalue2: int = 42\n');
  const fixed=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.ok(!fixed.results.some(item=>item.code==='reportAssignmentType'));
});

test('Python Pyright execution environments honor per-root Python version and platform overrides',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'modern'));await mkdir(join(root,'legacy'));
  const source='import sys\nif sys.version_info >= (3, 11):\n    modern_only: int = "incorrect"\nif sys.platform == "win32":\n    windows_only: int = "incorrect"\n';
  await writeFile(join(root,'modern/sample.py'),source);
  await writeFile(join(root,'legacy/sample.py'),source);
  const config={
    include:['modern','legacy'],typeCheckingMode:'basic',pythonVersion:'3.8',pythonPlatform:'Linux',
    executionEnvironments:[
      {root:'modern',pythonVersion:'3.11',pythonPlatform:'Windows'},
      {root:'legacy',pythonVersion:'3.8',pythonPlatform:'Linux'},
    ],
  };
  await writeFile(join(root,'pyrightconfig.json'),JSON.stringify(config));
  const diagnostics=await navigatePython({path:root,action:'diagnostics'},[root]);
  const errors=diagnostics.results.filter(item=>item.severity==='error');
  assert.equal(errors.length,2);
  assert.ok(errors.every(item=>item.file==='modern/sample.py'&&item.code==='reportAssignmentType'));
  assert.deepEqual(diagnostics.project.import_settings.execution_environments.map(item=>({
    root:item.root,python_version:item.python_version,python_platform:item.python_platform,
  })),[
    {root:'modern',python_version:'3.11',python_platform:'Windows'},
    {root:'legacy',python_version:'3.8',python_platform:'Linux'},
  ]);
  assert.ok(!diagnostics.project.import_settings.ignored_options.includes('executionEnvironments.pythonVersion'));
  assert.ok(!diagnostics.project.import_settings.ignored_options.includes('executionEnvironments.pythonPlatform'));
  await unlink(join(root,'pyrightconfig.json'));
  await writeFile(join(root,'pyproject.toml'),[
    '[project]','name="example"','version="0.0.0"','[tool.pyright]',
    'include = ["modern", "legacy"]','typeCheckingMode = "basic"',
    'pythonVersion = "3.8"','pythonPlatform = "Linux"',
    '[[tool.pyright.executionEnvironments]]','root = "modern"',
    'pythonVersion = "3.11"','pythonPlatform = "Windows"',
    '[[tool.pyright.executionEnvironments]]','root = "legacy"',
    'pythonVersion = "3.8"','pythonPlatform = "Linux"','',
  ].join('\n'));
  const toml=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.deepEqual(toml.results.filter(item=>item.severity==='error').map(item=>item.file),[
    'modern/sample.py','modern/sample.py',
  ]);
  for(const bad of [
    {root:'modern',pythonVersion:3.11},{root:'modern',pythonPlatform:'Unknown'},
  ]){
    await writeFile(join(root,'pyrightconfig.json'),JSON.stringify({...config,executionEnvironments:[bad]}));
    await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/pythonVersion|pythonPlatform/);
  }
});

test('Python project-local inherited stubPath drives both import navigation and Pyright diagnostics',async t=>{
  const {root}=await fixture(t);
  await mkdir(join(root,'app'));await mkdir(join(root,'typings/lib'),{recursive:true});await mkdir(join(root,'configs'));
  await writeFile(join(root,'app/client.py'),'from lib.api import scale\nvalue: int = scale("incorrect")\n');
  await writeFile(join(root,'typings/lib/__init__.pyi'),'');
  await writeFile(join(root,'typings/lib/api.pyi'),'def scale(amount: int) -> int: ...\n');
  await writeFile(join(root,'configs/base.json'),'{"stubPath":"../typings"}');
  await writeFile(join(root,'pyrightconfig.json'),'{"extends":"configs/base.json","include":["app"],"reportArgumentType":"error"}');
  const unchanged=await readFile(join(root,'typings/lib/api.pyi'));
  const diagnostic=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.equal(diagnostic.project.import_settings.stub_path,'typings');
  assert.equal(diagnostic.project.import_settings.ignored_options.includes('stubPath'),false);
  assert.deepEqual(diagnostic.project.source_selection.root_files,['app/client.py']);
  assert.ok(diagnostic.project.source_selection.analysis_files.includes('typings/lib/api.pyi'));
  assert.ok(diagnostic.project.source_selection.read_only_files.includes('typings/lib/api.pyi'));
  assert.ok(diagnostic.results.some(item=>item.file==='app/client.py'&&item.code==='reportArgumentType'));
  const definition=await navigatePython({path:root,file:'app/client.py',action:'definition',line:2,column:15},[root]);
  assert.ok(definition.results.some(item=>item.file==='typings/lib/api.pyi'&&item.read_only===true));
  await assert.rejects(navigatePython({path:root,file:'typings/lib/api.pyi',action:'rename_preview',line:1,column:6,new_name:'factor'},[root]),/read-only/);
  assert.deepEqual(await readFile(join(root,'typings/lib/api.pyi')),unchanged);
  for(const bad of ['../outside','C:/outside','missing',42]) {
    await writeFile(join(root,'pyrightconfig.json'),JSON.stringify({stubPath:bad,include:['app']}));
    await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/configuration|import path|invalid/i);
  }
  await unlink(join(root,'pyrightconfig.json'));
  await writeFile(join(root,'pyproject.toml'),'[tool.pyright]\nstubPath = "typings"\ninclude = ["app"]\nreportArgumentType = "error"\n');
  const toml=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.equal(toml.project.import_settings.stub_path,'typings');
  assert.ok(toml.results.some(item=>item.file==='app/client.py'&&item.code==='reportArgumentType'));
  await symlink(join(root,'typings'),join(root,'linked-stubs'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(root,'pyrightconfig.json'),'{"stubPath":"linked-stubs","include":["app"]}');
  await assert.rejects(navigatePython({path:root,action:'diagnostics'},[root]),/skipped link|missing or excluded|link/i);
  await unlink(join(root,'linked-stubs'));
});

test('Python discovery excludes virtual environments and links, enforces bounds and routes mixed projects explicitly',async t=>{
  const {root}=await fixture(t);await mkdir(join(root,'.venv'));await writeFile(join(root,'.venv','not_source.py'),'bad syntax(');
  await symlink(join(root,'pkg'),join(root,'linked'),process.platform==='win32'?'junction':'dir');
  const project=await loadPythonProject({path:root},[root]);
  assert.equal(project.sources.size,4);assert.deepEqual(project.skipped_links,['linked']);
  await assert.rejects(loadPythonProject({path:root,files:['.venv/not_source.py']},[root]),/installed dependency directories/);
  await assert.rejects(loadPythonProject({path:root,files:['../outside.py']},[root]),/outside allowed roots/);
  await assert.rejects(loadPythonProject({path:root,files:['linked/math.py']},[root]),/refuses links/);
  await writeFile(join(root,'large.py'),'#'.repeat(512*1024+1));
  await assert.rejects(loadPythonProject({path:root,files:['large.py']},[root]),/512 KiB/);
  await assert.rejects(loadPythonProject({path:root,files:['caller.py','main.ts']},[root]),/only supports/);
  assert.equal(await usesPythonNavigation({path:root},[root]),true);await writeFile(join(root,'tsconfig.json'),'{}');
  assert.equal(await usesPythonNavigation({path:root},[root]),false);assert.equal(await usesPythonNavigation({path:root,file:'caller.py'},[root]),true);
  await unlink(join(root,'linked'));
});

test('Python environment changes after analysis refuse durable writes without a persisted intent',async t=>{
  const {root}=await fixture(t),state=await mkdtemp(join(tmpdir(),'forge-python-environment-')),engine=new DurableTasks(state),batches=new TaskFileBatches(engine);
  t.after(()=>{engine.close();return rm(state,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const task=engine.create(root,'python-environment','inspect fresh environment',['echo ok'],true);
  const pin=fileURLToPath(new URL('../scripts/python-analysis/vendor/parso-0.8.5.dist-info/METADATA',import.meta.url)),original=readFileSync(pin),read=batches.readText;
  let changed=false;
  batches.readText=function(project,file){const text=read.call(this,project,file);if(!changed){writeFileSync(pin,Buffer.concat([original,Buffer.from('\nchanged after analysis\n')]));changed=true;}return text;};
  try {
    await assert.rejects(renameTask(engine,batches,{task_id:task.task_id,operation_id:'changed-environment',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'pkg/math.py',line:1,column:6,new_name:'updated'},[root]),/environment changed/);
    assert.equal(changed,true);assert.equal(engine.status(task.task_id).operations.length,0);assert.equal(snapshot(root).fingerprint,task.fingerprint);
  }finally{writeFileSync(pin,original);batches.readText=read;}
});

test('owned Python cancellation and overload terminate the launched job, leave sources intact and release capacity',async t=>{
  const {root}=await fixture(t),before=snapshot(root).fingerprint,controller=new AbortController();let identity:{pid:number;time:string}|undefined;
  await assert.rejects(runPythonAnalysis({path:root,file:'caller.py',action:'references',line:2,column:2},[root],{signal:controller.signal,onLaunched:(pid,time)=>{identity={pid,time};controller.abort();}}),/cancelled/);
  assert.ok(identity);assert.notEqual(windowsProcessIdentity(identity.pid),identity.time);
  await assert.rejects(runPythonAnalysis({path:root,action:'diagnostics'},[root],{timeoutMs:1}),/timed out/);
  const controllers=Array.from({length:10},()=>new AbortController());
  const runs=Promise.allSettled(controllers.map(item=>runPythonAnalysis({path:root,action:'diagnostics'},[root],{signal:item.signal})));
  for(const item of controllers)item.abort();const settled=await runs;
  assert.equal(settled.filter(item=>item.status==='rejected'&&/queue is full/.test(String(item.reason))).length,1);
  assert.equal(settled.filter(item=>item.status==='rejected'&&/cancelled/.test(String(item.reason))).length,9);
  assert.equal((await navigatePython({path:root,action:'diagnostics'},[root])).results.length,0);assert.equal(snapshot(root).fingerprint,before);
});

test('public navigation and durable Python rename retain lease, replay and cancellation write fences',async t=>{
  const {root,files}=await fixture(t),state=await mkdtemp(join(tmpdir(),'forge-python-state-')),engine=new DurableTasks(state),batches=new TaskFileBatches(engine);
  t.after(()=>{engine.close();return rm(state,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const handlers=new Map<string,(input:unknown,extra:{signal:AbortSignal})=>Promise<{isError?:boolean;content:{text:string}[]}>>();
  registerCodeNavigation({registerTool:(name:string,_definition:unknown,handler:typeof handlers extends Map<string,infer H>?H:never)=>handlers.set(name,handler)} as unknown as McpRegistrationTarget,[root]);
  const publicResult=await handlers.get('code_navigate')!({path:root,file:'caller.py',action:'definition',line:2,column:2},{signal:new AbortController().signal});
  assert.equal(publicResult.isError,undefined);assert.equal(JSON.parse(publicResult.content[0]!.text).project.language,'python');
  const task=engine.create(root,'python-rename','rename python export',['echo ok'],true);
  const input={task_id:task.task_id,operation_id:'python-change',expected_fingerprint:task.fingerprint,lease_token:task.lease_token!,file:'pkg/math.py',line:1,column:6,new_name:'scale_value'};
  await assert.rejects(renameTask(engine,batches,{...input,lease_token:'wrong'},[root]),/lease/i);
  const controller=new AbortController(),read=batches.readText;
  batches.readText=function(project,file){const text=read.call(this,project,file);controller.abort();return text;};
  try{await assert.rejects(renameTask(engine,batches,input,[root],controller.signal),/cancelled/);}finally{batches.readText=read;}
  assert.equal(engine.status(task.task_id).operations.length,0);assert.equal(snapshot(root).fingerprint,task.fingerprint);
  const result=await renameTask(engine,batches,input,[root]);assert.equal(result.state,'completed');
  const after=snapshot(root).fingerprint;assert.equal((await renameTask(engine,batches,input,[root],controller.signal)).state,'completed');
  assert.equal(snapshot(root).fingerprint,after);assert.equal(engine.status(task.task_id).operations.length,1);
  assert.equal(await readFile(join(root,'caller.py'),'utf8'),files['caller.py'].replace('import double','import scale_value'));
});
