import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SerenaBridge} from './serena-bridge.js';
import {compareMemoryGraphs,publicMemoryGraph,scanMemoryGraph} from './serena-memory-graph.js';

async function fixture(root:string,files:Record<string,string>){
  for(const [name,content] of Object.entries(files)){
    const target=join(root,'.serena','memories',name+'.md');
    await mkdir(join(target,'..'),{recursive:true});
    await writeFile(target,content);
  }
}

test('Serena graph resolves exact references, cycles, dangling targets and global exclusions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-graph-'));
  try{
    await fixture(root,{
      'main':'mem:topic/child mem:missing mem:global/other xmem:ghost mem:older mem:global',
      'topic/child':'mem:main mem:main mem:topic/child',
      'older':'mem:main',
      'isolated':'memory content is never returned',
    });
    const graph=scanMemoryGraph(root);
    assert.equal(graph.status,'complete');
    assert.deepEqual(graph.stale,[{from:'main',to:'missing'}]);
    assert.deepEqual(graph.external_global,[{from:'main',to:'global/other'},{from:'main',to:'global'}]);
    assert.equal(graph.edges.length,5);
    assert.deepEqual(graph.cycles,[['main','older','topic/child']]);
    assert.deepEqual(graph.unreferenced,['isolated']);
    const published=publicMemoryGraph(graph,1);
    assert.equal(published.memories.total,4);
    assert.equal(published.memories.items.length,1);
    assert.equal(published.memories.omitted,3);
    assert.equal(JSON.stringify(published).includes('memory content is never returned'),false);
    assert.equal(published.counts.cycles,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Serena graph compares byte changes and mem: link drift across approved projects',async()=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-compare-'));
  const left=join(root,'left'),right=join(root,'right');
  try{
    await fixture(left,{a:'mem:b mem:lost',b:'mem:a'});
    await fixture(right,{a:'mem:c',c:'mem:a'});
    const bridge=new SerenaBridge([left,right]);
    try{
      const result=await bridge.compareMemories([left,right],1);
      assert.equal(result.status,'complete');
      assert.equal(result.equivalence,'different_bytes');
      const diff=result.differences[0]!;
      assert.deepEqual(diff.counts,{added:1,removed:1,changed:1,unchanged:0});
      assert.deepEqual(diff.added.items,['c']);
      assert.deepEqual(diff.removed.items,['b']);
      assert.equal(diff.stale_references.resolved.total,1);
      assert.equal(diff.links.introduced.total,2);
      assert.equal(diff.links.resolved.total,2);
      assert.equal((await bridge.memoryGraph(left,3)).counts.stale,1);
      await assert.rejects(bridge.compareMemories([left,left]),/different approved directory/);
      await assert.rejects(bridge.compareMemories([left,root]),/allowed|approved/i);
    }finally{await bridge.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Serena graph proposes only exact existing unmarked topic and distinctive flat links without leaking content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-unmarked-'));
  try{
    await fixture(root,{
      main:'Read auth/tokens and (auth/tokens), then architecture_notes. Existing mem:auth/tokens stays. ' +
        'A URL https://auth/tokens, an unrelated xauth/tokens, and mem:architecture_notes are not suggestions. confidential prose',
      'auth/tokens':'topic content',
      architecture_notes:'architecture text',
      short:'short is ordinary prose',
    });
    const graph=scanMemoryGraph(root);
    assert.deepEqual(graph.unmarked.filter(c=>c.from==='main'),[
      {from:'main',to:'auth/tokens',occurrences:2,read_only:false},
      {from:'main',to:'architecture_notes',occurrences:1,read_only:false},
    ]);
    assert.equal(graph.unmarked_omitted,0);
    const publicView=publicMemoryGraph(graph,1);
    assert.equal(publicView.unmarked.total,2);
    assert.equal(publicView.unmarked.items.length,1);
    assert.equal(JSON.stringify(publicView).includes('confidential prose'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Serena graph honors ignored and read-only project policies and prevents certainty on partial results',async()=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-policy-'));
  const original=process.env.SERENA_USER_HOME;
  process.env.SERENA_USER_HOME=join(root,'missing-user-policy');
  try{
    await fixture(root,{visible:'mem:secret mem:readonly',secret:'private',readonly:'mem:visible'});
    await writeFile(join(root,'.serena','project.yml'),
      'ignored_memory_patterns:\n  - "^secret$"\nread_only_memory_patterns:\n  - "^readonly$"\n');
    const graph=scanMemoryGraph(root);
    assert.equal(graph.status,'partial_ignored');
    assert.deepEqual(graph.excluded_targets,[{from:'visible',to:'secret'}]);
    assert.equal(graph.excluded_count,1);
    assert.equal(graph.memories.find(m=>m.name==='readonly')?.read_only,true);
    assert.equal(graph.memories.some(m=>m.name==='secret'),false);
    assert.equal(compareMemoryGraphs([graph,graph]).equivalence,'unknown');
  }finally{
    if(original===undefined)delete process.env.SERENA_USER_HOME;
    else process.env.SERENA_USER_HOME=original;
    await rm(root,{recursive:true,force:true});
  }
});

test('Serena graph rejects unsafe names, symlinks, name ambiguity and oversized files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'forge-serena-unsafe-'));
  try{
    await fixture(root,{okay:'ok'});
    await writeFile(join(root,'.serena','memories','big.md'),'x'.repeat(256*1024+1));
    assert.throws(()=>scanMemoryGraph(root),/256 KiB/);
    await rm(join(root,'.serena','memories','big.md'));
    await writeFile(join(root,'.serena','memories','CON.md'),'unsafe');
    assert.throws(()=>scanMemoryGraph(root),/safe topic segments/);
    await rm(join(root,'.serena','memories','CON.md'));
    // Windows normally prohibits two case-only distinct files in one directory.
    if(process.platform!=='win32'){
      await writeFile(join(root,'.serena','memories','Okay.md'),'case collision');
      assert.throws(()=>scanMemoryGraph(root),/Ambiguous case-insensitive/);
      await rm(join(root,'.serena','memories','Okay.md'));
    }
    try{
      await symlink(join(root,'.serena','memories','okay.md'),join(root,'.serena','memories','link.md'));
      assert.throws(()=>scanMemoryGraph(root),/symlink/);
    }catch(error){
      if(!(error instanceof Error)||!('code' in error)||!['EPERM','EACCES'].includes(String(error.code)))throw error;
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
