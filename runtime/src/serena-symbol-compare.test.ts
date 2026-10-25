import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {SerenaBridge,registerSerenaTools} from './serena-bridge.js';
import {compareSymbolProjects,parseComparedSymbols} from './serena-symbol-compare.js';

const symbol=(body:string,path='sample.py',name='score')=>({name_path:name,relative_path:path,kind:'Function',body,
  body_location:{start_line:1,end_line:2}});

test('canonical code compares across line-ending and location changes and reports missing symbols',()=>{
  const left=parseComparedSymbols(JSON.stringify([symbol('def score(x):\r\n    return x + 1'),symbol('return 0','only.py','only')]),6);
  const right=parseComparedSymbols(JSON.stringify([{...symbol('def score(x):\n    return x + 1'),body_location:{start_line:50,end_line:60}}]),6);
  const equal=compareSymbolProjects([{path:'one',status:'ok',symbols:left.filter(s=>s.name_path==='score')},{path:'two',status:'ok',symbols:right}]);
  assert.equal(equal.equivalence,'identical_source');
  assert.equal(equal.summary?.unchanged.length,1);
  const changed=compareSymbolProjects([{path:'one',status:'ok',symbols:left},{path:'two',status:'ok',symbols:parseComparedSymbols(JSON.stringify([symbol('def score(x):\n    return x - 1')]),6)}]);
  assert.equal(changed.equivalence,'different_source');
  assert.equal(changed.summary?.changed.length,1);
  assert.equal(changed.summary?.missing.length,1);
  assert.equal(changed.summary?.missing[0]?.missing_in[0],'two');
  assert.ok(!JSON.stringify(changed).includes('return x - 1'),'comparison includes digest, not implementation bodies');
  assert.equal(compareSymbolProjects([{path:'one',status:'ok',symbols:[]},{path:'two',status:'ok',symbols:[]}]).equivalence,'no_matches');
  assert.equal(compareSymbolProjects([{path:'one',status:'incomplete',symbols:[],error:'indexing'},{path:'two',status:'ok',symbols:right}]).equivalence,'unknown');
});

test('truncated, malformed and ambiguous symbol results never become successful evidence',()=>{
  for(const data of [
    'Matched 99>max_matches=5 symbols.\nShortened result: {}',
    JSON.stringify([symbol('a'),symbol('b')]),
    JSON.stringify([{name_path:'score',relative_path:'sample.py',kind:'Function'}]),
    'Serena currently indexing',
  ])assert.throws(()=>parseComparedSymbols(data,1),/truncated|more symbols|missing|complete JSON/);
  assert.throws(()=>parseComparedSymbols(JSON.stringify([symbol('a'),symbol('b')]),2),/Ambiguous duplicate/);
});

test('cross-project Serena comparison validates both grants before any RPC and compares actual backend outputs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-comparison-'));
  const one=join(root,'one'),two=join(root,'two');
  await mkdir(one);await mkdir(two);
  await writeFile(join(one,'sample.py'),'def score(x):\n    return x + 1\n');
  await writeFile(join(two,'sample.py'),'def score(x):\n    return x + 2\n');
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const internals=bridge as unknown as {project(path:string):Promise<string>;sessions:Map<string,Promise<unknown>>};
  const calls:{path:string;tool:string;arguments:Record<string,unknown>}[]=[];
  for(const [path,body] of [[one,'def score(x):\n    return x + 1'],[two,'def score(x):\n    return x + 2']] as const){
    const canonical=await internals.project(path);
    internals.sessions.set(canonical,Promise.resolve({
      client:{callTool:async ({name,arguments:args}:{name:string;arguments:Record<string,unknown>})=>{
        calls.push({path:canonical,tool:name,arguments:args});
        return {content:[{type:'text',text:JSON.stringify([symbol(body)])}]};
      },close:async()=>{}},
      transport:{close:async()=>{}},tools:new Set(['find_symbol']),lastUsed:Date.now(),
    }));
  }
  await assert.rejects(bridge.compareSymbols([one,join(root,'not-granted')],{name_path_pattern:'score'}),/ENOENT|Serena project path must be a directory/);
  await assert.rejects(bridge.compareSymbols([one,join(root,'..')],{name_path_pattern:'score'}),/outside allowed roots/i);
  await assert.rejects(bridge.compareSymbols([one,one],{name_path_pattern:'score'}),/different approved directory/);
  assert.equal(calls.length,0,'invalid project selection must not launch any backend');
  const diff=await bridge.compareSymbols([one,two],{name_path_pattern:'score',relative_path:'sample.py',max_matches:5});
  assert.equal(diff.status,'completed',JSON.stringify(diff));assert.equal(diff.equivalence,'different_source',JSON.stringify(diff));
  assert.equal(diff.summary?.changed.length,1);assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.tool==='find_symbol'&&c.arguments.name_path_pattern==='score'
    &&c.arguments.relative_path==='sample.py'&&c.arguments.include_body===true&&c.arguments.max_matches===5));
  assert.ok(!JSON.stringify(diff).includes('return x + 2'));
  const before=calls.length;
  await assert.rejects(bridge.compareSymbols([one,two],{name_path_pattern:'score',relative_path:'../secrets.py'}),/Serena path traversal/);
  assert.equal(calls.length,before);
});

test('comparison output is inconclusive when a project backend fails',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-partial-'));
  const one=join(root,'one'),two=join(root,'two');await mkdir(one);await mkdir(two);
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const internal=bridge as unknown as {project(path:string):Promise<string>;sessions:Map<string,Promise<unknown>>};
  for(const [i,path] of [one,two].entries()){
    internal.sessions.set(await internal.project(path),Promise.resolve({
      client:{callTool:async()=>i===0?{content:[{type:'text',text:JSON.stringify([symbol('return 1')])}]}:
        {isError:true,content:[{type:'text',text:'language server unavailable'}]},close:async()=>{}},
      transport:{close:async()=>{}},tools:new Set(['find_symbol']),lastUsed:Date.now(),
    }));
  }
  const result=await bridge.compareSymbols([one,two],{name_path_pattern:'score'});
  assert.equal(result.equivalence,'unknown');assert.equal(result.status,'incomplete');
  assert.equal(result.summary,null);
  assert.equal(result.projects[1]?.status,'error');
});

test('registered MCP tool accepts only approved bounded multi-project queries',()=>{
  const definitions=new Map<string,any>();
  registerSerenaTools({registerTool(name:string,definition:any){definitions.set(name,definition);}} as any,{} as SerenaBridge);
  const tool=definitions.get('serena_compare_symbols');
  assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);
  const schema=z.object(tool.inputSchema);
  assert.equal(schema.safeParse({paths:['C:/repo/a','C:/repo/b'],name_path_pattern:'Service/execute'}).success,true);
  assert.equal(schema.safeParse({paths:['C:/repo/a'],name_path_pattern:'Service/execute'}).success,false);
  assert.equal(schema.safeParse({paths:['C:/repo/a','C:/repo/b','C:/repo/c','C:/repo/d'],name_path_pattern:'Service/execute'}).success,false);
});

test('live Serena compares Python symbol bodies from independent real language servers',{
  skip:process.env.FORGE_SERENA_LIVE!=='1',timeout:240_000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-compare-live-'));
  const one=join(root,'one'),two=join(root,'two');await mkdir(one);await mkdir(two);
  for(const [path,constant] of [[one,1],[two,2]] as const){
    await writeFile(join(path,'sample.py'),`def score(value: int) -> int:\n    return value + ${constant}\n`);
    await writeFile(join(path,'pyproject.toml'),'[project]\nname = "forge-compare"\nversion = "0.1.0"\n');
  }
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const comparison=await bridge.compareSymbols([one,two],{name_path_pattern:'score',relative_path:'sample.py',max_matches:3});
  assert.equal(comparison.status,'completed',JSON.stringify(comparison));
  assert.equal(comparison.equivalence,'different_source',JSON.stringify(comparison));
  assert.equal(comparison.summary?.changed.length,1);
});
