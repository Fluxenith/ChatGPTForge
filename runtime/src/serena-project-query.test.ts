import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {SerenaBridge,registerSerenaTools,serenaProjectBatchSchema} from './serena-bridge.js';

test('Serena cross-project batch checks every grant and tool contract before invoking either backend',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-batch-'));
  const one=join(root,'one'),two=join(root,'two');
  await mkdir(one);await mkdir(two);
  for(const path of [one,two])await writeFile(join(path,'sample.py'),'def greet():\n    return 42\n');
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const inner=bridge as unknown as {project(path:string):Promise<string>;sessions:Map<string,Promise<unknown>>};
  const calls:{project:string;name:string;args:Record<string,unknown>}[]=[];
  for(const project of [one,two]){
    const canonical=await inner.project(project);
    inner.sessions.set(canonical,Promise.resolve({
      client:{callTool:async({name,arguments:args}:{name:string;arguments:Record<string,unknown>})=>{
        calls.push({project:canonical,name,args});
        return {content:[{type:'text',text:JSON.stringify({project:canonical,name,found:true})}]};
      },close:async()=>{}},
      transport:{close:async()=>{}},tools:new Set(['find_symbol','search_for_pattern']),lastUsed:Date.now(),
    }));
  }
  const valid={queries:[
    {path:one,tool:'find_symbol' as const,args:{name_path_pattern:'greet',relative_path:'sample.py'}},
    {path:two,tool:'search_for_pattern' as const,args:{substring_pattern:'42',relative_path:'sample.py'}},
  ]};
  await assert.rejects(bridge.queryProjects({queries:[valid.queries[0]!,{...valid.queries[1]!,args:{substring_pattern:'42',relative_path:'../outside.py'}}]}),/Serena path traversal/);
  await assert.rejects(bridge.queryProjects({queries:[valid.queries[0]!,{...valid.queries[1]!,path:join(root,'missing')}] }),/ENOENT|directory/);
  await assert.rejects(bridge.queryProjects({queries:[valid.queries[0]!,{...valid.queries[1]!,path:one}]}),/different approved directory/);
  await assert.rejects(bridge.queryProjects({queries:[valid.queries[0]!,{...valid.queries[1]!,args:{substring_pattern:'42',unknown:true}}]}),/Invalid Serena.*arguments/);
  assert.equal(calls.length,0,'no RPC may run if any query has an invalid tool contract or path');
  const data=await bridge.queryProjects(valid);
  assert.equal(data.status,'completed');
  assert.equal(data.complete,2);
  assert.deepEqual(data.projects.map(p=>p.tool),['find_symbol','search_for_pattern']);
  assert.ok(data.projects.every(p=>p.status==='ok'));
  assert.deepEqual(calls.map(c=>c.name),['find_symbol','search_for_pattern']);
  assert.equal(calls[1]?.args.relative_path,'sample.py');
});

test('Serena cross-project batch explicitly reports truncation and backend errors without claiming full coverage',async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-batch-status-'));
  const one=join(root,'one'),two=join(root,'two');await mkdir(one);await mkdir(two);
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const inner=bridge as unknown as {project(path:string):Promise<string>;sessions:Map<string,Promise<unknown>>};
  for(const [i,path] of [one,two].entries()){
    inner.sessions.set(await inner.project(path),Promise.resolve({
      client:{callTool:async()=>i===0?{content:[{type:'text',text:'A'.repeat(800)}]}:{isError:true,content:[{type:'text',text:'Server index unavailable'}]},close:async()=>{}},
      transport:{close:async()=>{}},tools:new Set(['list_memories']),lastUsed:Date.now(),
    }));
  }
  const response=await bridge.queryProjects({queries:[
    {path:one,tool:'list_memories',args:{}},{path:two,tool:'list_memories',args:{}},
  ],max_result_chars:150});
  assert.equal(response.status,'incomplete');
  assert.equal(response.complete,0);
  assert.deepEqual(response.projects.map(p=>p.status),['truncated','error']);
  assert.equal(response.projects[0]?.text?.length,150);
  assert.match(response.projects[1]?.error??'',/Server index unavailable/);
});

test('MCP batch schema supports all Serena read backends with typed arguments and rejects oversize requests',()=>{
  const defs=new Map<string,any>();
  registerSerenaTools({registerTool(name:string,def:any){defs.set(name,def);}} as any,{} as SerenaBridge);
  const definition=defs.get('serena_query_projects');
  assert.ok(definition);assert.equal(definition.annotations.readOnlyHint,true);
  assert.equal(defs.has('serena_find_symbol'),true);
  const schema=z.object(definition.inputSchema);
  const query={path:'C:/work/project-a',tool:'find_symbol',args:{name_path_pattern:'Service/doWork'}};
  assert.equal(schema.safeParse({queries:[query,{path:'C:/work/project-b',tool:'get_diagnostics_for_file',args:{relative_path:'app.py'}}]}).success,true);
  assert.equal(schema.safeParse({queries:[query]}).success,false);
  assert.equal(schema.safeParse({queries:[query,query,query,query]}).success,false);
  assert.equal(schema.safeParse({queries:[query,{...query,tool:'task_edit'}]}).success,false);
  assert.equal(serenaProjectBatchSchema.safeParse({queries:[query,{...query,path:'C:/work/b'}],max_result_chars:12001}).success,false);
});

test('live Serena query runs different LSP reads concurrently against two independent Python projects',{
  skip:process.env.FORGE_SERENA_LIVE!=='1',timeout:240_000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-batch-live-'));
  const one=join(root,'one'),two=join(root,'two');await mkdir(one);await mkdir(two);
  for(const [path,delta] of [[one,1],[two,2]] as const){
    await writeFile(join(path,'sample.py'),`def greet(x: int) -> int:\n    return x + ${delta}\n`);
    await writeFile(join(path,'pyproject.toml'),'[project]\nname="batch-example"\nversion="0.1.0"\n');
  }
  const bridge=new SerenaBridge([root]);
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true,maxRetries:10});});
  const response=await bridge.queryProjects({queries:[
    {path:one,tool:'find_symbol',args:{name_path_pattern:'greet',relative_path:'sample.py',include_body:true}},
    {path:two,tool:'get_symbols_overview',args:{relative_path:'sample.py'}},
  ],max_result_chars:9000});
  assert.equal(response.status,'completed',JSON.stringify(response).slice(0,2000));
  assert.ok(response.projects[0]?.text?.includes('greet'));
  assert.ok(response.projects[1]?.text?.includes('greet'));
});
