import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import test from 'node:test';
import {navigatePython} from './python-navigation.js';

// Oracles: the environment's own interpreter for sys.path (site.addpackage),
// and the pinned Pyright run directly on the original project with venvPath/venv.
const require=createRequire(import.meta.url);
const pyright=require.resolve('pyright');

type Item={file:string;line:number;column:number;code:string};
function pyrightOracle(root:string):Item[] {
  const real=realpathSync.native(root);let raw='';
  try{raw=execFileSync(process.execPath,[pyright,'--project',root,'--outputjson'],{cwd:root,encoding:'utf8'});}
  catch(error){raw=String((error as {stdout?:string}).stdout??'');}
  return (JSON.parse(raw) as {generalDiagnostics:{file:string;rule?:string;range:{start:{line:number;character:number}}}[]}).generalDiagnostics
    .map(item=>({file:relative(real,realpathSync.native(item.file)).replaceAll('\\','/'),line:item.range.start.line+1,column:item.range.start.character+1,code:item.rule??''}))
    .filter(item=>item.file==='app/main.py').sort((a,b)=>a.line-b.line||a.column-b.column);
}
const forgeItems=(results:unknown)=>(results as Item[]).filter(item=>item.file==='app/main.py')
  .map(item=>({file:item.file,line:item.line,column:item.column,code:item.code})).sort((a,b)=>a.line-b.line||a.column-b.column);

async function environmentFixture(t:{after:(callback:()=>Promise<void>|void)=>void}) {
  const parent=await mkdtemp(join(tmpdir(),'forge-python-env-'));
  t.after(()=>rm(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const root=join(parent,'project'),outside=join(parent,'outside');
  await mkdir(outside,{recursive:true});await mkdir(root);
  execFileSync('python',['-m','venv','--without-pip',join(root,'.venv')],{stdio:'ignore'});
  const site=join(root,'.venv','Lib','site-packages');
  const files:Record<string,string>={
    'pyproject.toml':'[project]\nname="envdemo"\nversion="0.0.0"\n',
    'app/main.py':'from corelib.util import helper\nfrom untyped import guess\nfrom vendored_tool import tool\n\nx: int = helper(1)\ny: str = guess()\nz: str = tool()\n',
    'libs/core/corelib/__init__.py':'',
    'libs/core/corelib/util.py':'def helper(value: int) -> str:\n    return str(value)\n',
    '.venv/Lib/site-packages/untyped/__init__.py':'def guess():\n    return 41 + 1\n',
    '.venv/Lib/site-packages/tools/vendored_tool.py':'def tool() -> int:\n    return 3\n',
    // A project-relative line, an absolute line into site-packages, code, a
    // missing directory and an escaping path, as installers and users write them.
    '.venv/Lib/site-packages/_forge_env.pth':'# editable paths\n../../../libs/core\n'+join(site,'tools')+'\nimport os\nmissing_dir\n'+outside+'\n../../../pyproject.toml\n',
  };
  for(const [file,text] of Object.entries(files)){await mkdir(join(root,file,'..'),{recursive:true});await writeFile(join(root,file),text);}
  return {root,site,outside};
}

test('Python .pth path entries and library inference match the environment interpreter and pinned Pyright',async t=>{
  const {root,site,outside}=await environmentFixture(t);
  const interpreter=join(root,'.venv','Scripts','python.exe');
  const sysPath=JSON.parse(execFileSync(interpreter,['-c','import json,sys;print(json.dumps(sys.path))'],{cwd:root,encoding:'utf8'})) as string[];
  const projectEntries=sysPath.filter(entry=>entry.toLowerCase().startsWith(root.toLowerCase())).map(entry=>relative(root,entry).replaceAll('\\','/'));
  // The interpreter adds every existing path, including the escaping directory
  // and a plain file, which Forge reports instead of reading.
  assert.deepEqual(projectEntries,['.venv','.venv/Lib/site-packages','libs/core','.venv/Lib/site-packages/tools','pyproject.toml']);
  assert.ok(sysPath.some(entry=>entry.toLowerCase()===outside.toLowerCase()));

  const config=join(root,'pyrightconfig.json');
  await writeFile(config,JSON.stringify({venvPath:'.',venv:'.venv',include:['app'],typeCheckingMode:'basic'}));
  const oracle=pyrightOracle(root);
  assert.deepEqual(oracle.map(item=>item.code),['reportAssignmentType','reportAssignmentType','reportAssignmentType']);

  const result=await navigatePython({path:root,action:'diagnostics'},[root]);
  const forge=forgeItems(result.results);
  assert.deepEqual(forge,oracle);
  const dependencies=result.project.environment.dependencies as {path_roots:{root:string;pth:string}[];path_ignored:{line:number;reason:string}[]};
  assert.deepEqual(dependencies.path_roots.map(item=>item.root),['libs/core','.venv/Lib/site-packages/tools']);
  assert.deepEqual(dependencies.path_ignored.map(item=>[item.line,item.reason]),[
    [4,'import line is code and is never executed'],
    [5,'path does not name an existing directory'],
    [6,'path is outside the project'],
    [7,'path is not a directory'],
  ]);

  const definition=await navigatePython({path:root,file:'app/main.py',action:'definition',line:5,column:10},[root]);
  assert.ok(definition.results.some(item=>item.file==='libs/core/corelib/util.py'&&!item.read_only));
  const vendored=await navigatePython({path:root,file:'app/main.py',action:'definition',line:7,column:10},[root]);
  assert.ok(vendored.results.some(item=>item.file==='.venv/Lib/site-packages/tools/vendored_tool.py'&&item.read_only===true));

  // Library code inference can be disabled explicitly, as in Pyright.
  await writeFile(config,JSON.stringify({venvPath:'.',venv:'.venv',include:['app'],typeCheckingMode:'basic',useLibraryCodeForTypes:false}));
  const strictLibrary=await navigatePython({path:root,action:'diagnostics'},[root]);
  const strictOracle=pyrightOracle(root);
  assert.notDeepEqual(strictOracle,oracle);
  assert.deepEqual(forgeItems(strictLibrary.results),strictOracle);
  await assert.rejects(writeFile(config,JSON.stringify({useLibraryCodeForTypes:'yes'})).then(()=>navigatePython({path:root,action:'diagnostics'},[root])),/boolean setting: useLibraryCodeForTypes/);

  // A fresh capture follows the edited .pth file: the removed root no longer resolves.
  const pth=join(site,'_forge_env.pth');await writeFile(pth,(await readFile(pth,'utf8')).replace('../../../libs/core\n',''));
  await writeFile(config,JSON.stringify({venvPath:'.',venv:'.venv',include:['app']}));
  const removed=await navigatePython({path:root,action:'diagnostics'},[root]);
  assert.ok((removed.results as {file:string;code:string}[]).some(item=>item.file==='app/main.py'&&item.code==='reportMissingImports'));
});
