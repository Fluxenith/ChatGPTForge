import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {compareDiagnosticProjects,parseGroupedDiagnostics} from './serena-diagnostics-compare.js';
import {SerenaBridge,registerSerenaTools,serenaDiagnosticsCompareSchema} from './serena-bridge.js';

const diag=(message:string,line=0,code='reportUndefinedVariable')=>({message,code,source:'Pyright',range:{
  start:{line,character:4},end:{line,character:16},
}});
const grouped=(items:Record<string,unknown[]>)=>JSON.stringify({'sample.py':{
  Error:{compute:items.Error??[]},Warning:{compute:items.Warning??[]},
}});

test('diagnostic comparison counts repeated warnings, resolves old errors and ignores line movement',()=>{
  const original=parseGroupedDiagnostics(grouped({Error:[diag('missing_a',1),diag('missing_a',3),diag('fixed_b',5)],Warning:[]}));
  const updated=parseGroupedDiagnostics(grouped({Error:[diag('missing_a',100),diag('new_c',40)],Warning:[]}));
  const comparison=compareDiagnosticProjects([
    {path:'old',status:'ok',diagnostics:original},{path:'new',status:'ok',diagnostics:updated},
  ],1);
  assert.equal(comparison.status,'completed');
  assert.deepEqual(comparison.comparisons[0]?.counts,{introduced:1,resolved:2,unchanged:1});
  assert.equal(comparison.comparisons[0]?.introduced[0]?.message,'new_c');
  assert.equal(comparison.comparisons[0]?.resolved[0]?.message,'fixed_b');
  assert.equal(comparison.comparisons[0]?.omitted?.resolved,1,'detail bound must not hide the exact count');
  assert.equal(comparison.comparisons[0]?.unchanged[0]?.location.line,100,
    'moved diagnostic keeps its candidate location without appearing introduced');
  assert.equal(original.length,2,'duplicate diagnostics are counted by identity');
  assert.equal(original.find(x=>x.message==='missing_a')?.count,2);
});

test('truncated, indexing, malformed and unsafe diagnostics are always inconclusive',()=>{
  for(const raw of [
    'The answer is too long (50000 characters).',
    '[Serena output truncated; narrow the query]',
    '{"status":"indexing","operation_id":"job-42"}',
    JSON.stringify({'../secrets.py':{Error:{compute:[diag('bad')]}}}),
    JSON.stringify({'sample.py':{Error:{compute:[{message:'bad',range:{start:{line:-1,character:0}}}]}}}),
    JSON.stringify({'sample.py':{Error:{compute:Array.from({length:121},()=>diag('too many'))}}}),
    'not JSON',
  ])assert.throws(()=>parseGroupedDiagnostics(raw),/truncated|indexing|invalid|exceeds|complete grouped|grouped by file/);
  const comparison=compareDiagnosticProjects([
    {path:'old',status:'ok',diagnostics:[]},
    {path:'new',status:'incomplete',diagnostics:[],error:'indexing'},
  ]);
  assert.equal(comparison.status,'incomplete');
  assert.equal(comparison.comparisons[0]?.status,'incomplete');
  assert.equal(comparison.comparisons[0]?.counts,null);
  const third=compareDiagnosticProjects([
    {path:'base',status:'ok',diagnostics:parseGroupedDiagnostics(grouped({Error:[],Warning:[]}))},
    {path:'verified',status:'ok',diagnostics:parseGroupedDiagnostics(grouped({Error:[diag('new_error')],Warning:[]}))},
    {path:'indexing',status:'incomplete',diagnostics:[],error:'Serena still indexing'},
  ]);
  assert.equal(third.status,'incomplete');
  assert.equal(third.comparisons[0]?.status,'completed', 'independent verified comparisons remain useful');
  assert.equal(third.comparisons[0]?.counts?.introduced,1);
  assert.equal(third.comparisons[1]?.status,'incomplete');
  assert.equal(third.comparisons[1]?.counts,null);
});

test('comparison validates every approved project and file before contacting either LSP',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-diag-diff-'));
  const old=join(root,'old'),updated=join(root,'updated');
  for(const dir of [old,updated]){await mkdir(dir);await writeFile(join(dir,'sample.py'),'def compute():\n    return 1\n');}
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const internal=bridge as unknown as {project(path:string):Promise<string>;sessions:Map<string,Promise<unknown>>};
  let calls=0;
  for(const [index,path] of [old,updated].entries()){
    internal.sessions.set(await internal.project(path),Promise.resolve({
      client:{callTool:async({name,arguments:args}:{name:string;arguments:Record<string,unknown>})=>{
        calls++;
        assert.ok(['get_diagnostics_for_symbol','get_diagnostics_for_file'].includes(name));
        assert.equal(args.max_answer_chars,20000);
        return {content:[{type:'text',text:grouped({Error:index===0?[diag('fixed_error')]:[diag('new_error')],Warning:[]})}]};
      },close:async()=>{}},
      transport:{close:async()=>{}},tools:new Set(['get_diagnostics_for_symbol','get_diagnostics_for_file']),lastUsed:Date.now(),
    }));
  }
  const original={paths:[old,updated],scope:'symbol' as const,name_path:'compute',reference_file:'sample.py'};
  await assert.rejects(bridge.compareDiagnostics({...original,paths:[old,old]}),/different approved directory/);
  await assert.rejects(bridge.compareDiagnostics({...original,paths:[old,join(root,'unapproved')]}),/ENOENT|directory/);
  await assert.rejects(bridge.compareDiagnostics({...original,reference_file:'../escape.py'}),/Serena path traversal/);
  await assert.rejects(bridge.compareDiagnostics({...original,scope:'file',name_path:undefined}),/File comparison/);
  assert.equal(calls,0,'invalid batch cannot trigger any project RPC');
  const diff=await bridge.compareDiagnostics({...original,check_symbol_references:true,min_severity:2,max_details:10});
  assert.equal(diff.status,'completed',JSON.stringify(diff));
  assert.equal(diff.comparisons[0]?.counts?.introduced,1);
  assert.equal(diff.comparisons[0]?.counts?.resolved,1);
  assert.equal(calls,2);
  const file=await bridge.compareDiagnostics({paths:[old,updated],scope:'file',relative_path:'sample.py'});
  assert.equal(file.status,'completed');assert.equal(calls,4);
});

test('MCP diagnostics comparison schema is bounded, scoped, and read-only',()=>{
  const registered=new Map<string,any>();
  registerSerenaTools({registerTool(name:string,def:any){registered.set(name,def);}} as any,{} as SerenaBridge);
  const tool=registered.get('serena_compare_diagnostics');
  assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);
  const schema=z.object(tool.inputSchema);
  const valid={paths:['C:/repo/old','C:/repo/new'],scope:'symbol',name_path:'compute'};
  assert.equal(schema.safeParse(valid).success,true);
  assert.equal(serenaDiagnosticsCompareSchema.safeParse({...valid,scope:'file',name_path:undefined,relative_path:'sample.py'}).success,true);
  assert.equal(serenaDiagnosticsCompareSchema.safeParse({...valid,scope:'file'}).success,false);
  assert.equal(serenaDiagnosticsCompareSchema.safeParse({...valid,paths:['C:/repo/old']}).success,false);
  assert.equal(serenaDiagnosticsCompareSchema.safeParse({...valid,min_severity:5}).success,false);
  assert.equal(serenaDiagnosticsCompareSchema.safeParse({...valid,max_details:51}).success,false);
});

test('live Python LSP comparison finds a newly introduced symbol and file diagnostic',{
  skip:process.env.FORGE_SERENA_LIVE!=='1',timeout:240_000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-diag-diff-live-'));
  const old=join(root,'old'),updated=join(root,'updated');
  for(const [path,broken] of [[old,false],[updated,true]] as const){
    await mkdir(path);
    await writeFile(join(path,'sample.py'),`def compute(value: int) -> int:\n    return ${broken?'missing_variable + ':''}value\n`);
    await writeFile(join(path,'pyproject.toml'),'[project]\nname="forge-diagnostic-diff"\nversion="0.1.0"\n');
  }
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  for(const query of [
    {paths:[old,updated],scope:'symbol' as const,name_path:'compute',reference_file:'sample.py'},
    {paths:[old,updated],scope:'file' as const,relative_path:'sample.py'},
  ]){
    const result=await bridge.compareDiagnostics(query);
    assert.equal(result.status,'completed',JSON.stringify(result));
    const candidate=result.comparisons[0]!;
    assert.equal(candidate.status,'completed');
    assert.ok((candidate.counts?.introduced??0)>=1,JSON.stringify(candidate));
    assert.ok(candidate.introduced.some(x=>x.message.includes('missing_variable')),JSON.stringify(candidate));
    assert.equal(candidate.counts?.resolved,0);
  }
});
