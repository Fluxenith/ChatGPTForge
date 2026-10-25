import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {SerenaBridge,registerSerenaTools} from './serena-bridge.js';

test('Serena symbol/reference diagnostics validates paths and forwards exact optional-tool arguments',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-symbol-diag-'));
  const one=join(root,'one'),two=join(root,'two');
  await mkdir(one);await mkdir(two);
  await writeFile(join(one,'sample.py'),'def compute(x):\n    return x + 1\n');
  const bridge=new SerenaBridge([one,two]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const internals=bridge as unknown as {project(path:string):Promise<string>;sessions:Map<string,Promise<unknown>>};
  const calls:{name:string;args:Record<string,unknown>}[]=[];
  internals.sessions.set(await internals.project(one),Promise.resolve({
    client:{callTool:async({name,arguments:args}:{name:string;arguments:Record<string,unknown>})=>{
      calls.push({name,args});
      return {content:[{type:'text',text:JSON.stringify({'sample.py':{'1':{'compute':[{'message':'undefined symbol'}]}}})}]};
    },close:async()=>{}},
    transport:{close:async()=>{}},tools:new Set(['get_diagnostics_for_symbol']),lastUsed:Date.now(),
  }));
  internals.sessions.set(await internals.project(two),Promise.resolve({
    client:{callTool:async()=>{throw Error('This optional Serena backend must not be invoked');},close:async()=>{}},
    transport:{close:async()=>{}},tools:new Set(['get_diagnostics_for_file']),lastUsed:Date.now(),
  }));

  const output=await bridge.invoke(one,'get_diagnostics_for_symbol',{
    name_path:'compute',reference_file:'sample.py',check_symbol_references:true,min_severity:2,max_answer_chars:3000,
  });
  assert.match(output,/undefined symbol/);
  assert.deepEqual(calls,[{name:'get_diagnostics_for_symbol',args:{
    name_path:'compute',reference_file:'sample.py',check_symbol_references:true,min_severity:2,max_answer_chars:3000,
  }}]);
  await assert.rejects(bridge.invoke(one,'get_diagnostics_for_symbol',{
    name_path:'compute',reference_file:'../outside.py',
  }),/Serena path traversal/);
  await assert.rejects(bridge.invoke(one,'get_diagnostics_for_symbol',{
    name_path:'compute',reference_file:join(root,'outside.py'),
  }),/project-relative/);
  assert.equal(calls.length,1);
  await assert.rejects(bridge.invoke(two,'get_diagnostics_for_symbol',{name_path:'compute'}),
    /does not expose get_diagnostics_for_symbol/);

  await assert.rejects(bridge.queryProjects({queries:[
    {path:one,tool:'get_diagnostics_for_symbol',args:{name_path:'compute',reference_file:'sample.py'}},
    {path:two,tool:'get_diagnostics_for_symbol',args:{name_path:'compute',reference_file:'../escape.py'}},
  ]}),/Serena path traversal/);
  assert.equal(calls.length,1,'failed preflight must prevent all backend calls');
  const batch=await bridge.queryProjects({queries:[
    {path:one,tool:'get_diagnostics_for_symbol',args:{name_path:'compute',reference_file:'sample.py'}},
    {path:two,tool:'get_diagnostics_for_symbol',args:{name_path:'compute'}},
  ]});
  assert.equal(batch.status,'incomplete');
  assert.deepEqual(batch.projects.map(p=>p.status),['ok','error']);
  assert.match(batch.projects[1]?.error??'',/does not expose get_diagnostics_for_symbol/);
});

test('public Serena symbol diagnostics schema is bounded and read-only',()=>{
  const registered=new Map<string,any>();
  registerSerenaTools({registerTool(name:string,definition:any){registered.set(name,definition);}} as any,{} as SerenaBridge);
  const definition=registered.get('serena_symbol_diagnostics');
  assert.ok(definition);
  assert.equal(definition.annotations.readOnlyHint,true);
  const schema=z.object(definition.inputSchema);
  const basic={path:'C:/project',name_path:'Service/execute',reference_file:'main.py'};
  assert.equal(schema.safeParse({...basic,check_symbol_references:true,min_severity:4}).success,true);
  assert.equal(schema.safeParse({...basic,name_path:''}).success,false);
  assert.equal(schema.safeParse({...basic,min_severity:5}).success,false);
  assert.equal(schema.safeParse({...basic,max_answer_chars:25}).success,false);
  assert.equal(schema.safeParse({...basic,reference_file:'a'.repeat(801)}).success,false);
});

test('live Serena provides actual LSP diagnostics for a Python symbol and its references',{
  skip:process.env.FORGE_SERENA_LIVE!=='1',timeout:240_000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-symbol-live-'));
  const source='def compute(value: int) -> int:\n    return missing_variable + value\n\nresult = compute(4)\n';
  await writeFile(join(root,'sample.py'),source);
  await writeFile(join(root,'pyproject.toml'),'[project]\nname="forge-diagnostic-test"\nversion="0.1.0"\n');
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const text=await bridge.invoke(root,'get_diagnostics_for_symbol',{
    name_path:'compute',reference_file:'sample.py',check_symbol_references:true,min_severity:4,
  });
  const parsed=JSON.parse(text);
  assert.equal(typeof parsed,'object');
  assert.match(text,/missing_variable/,'the real language server should report the missing name');
});
