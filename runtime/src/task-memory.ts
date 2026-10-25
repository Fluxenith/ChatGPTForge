import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {parse} from 'yaml';
import {DurableTasks,snapshot} from './durable-tasks.js';
import {TaskFileBatches,type BatchChange} from './task-file-batches.js';
import {managedRelease} from './managed-component-state.js';

export const memoryNamePattern=/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;
export function memoryName(name:string){
  if(name.length>200||!memoryNamePattern.test(name)||name.split('/').some(s=>/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)))throw Error('Use a relative memory name with safe topic segments');
  return name;
}
// Python policy regexes are not interpreted as JavaScript regexes. Refuse rather
// than silently violating policies whose semantics this journal cannot prove.
function serenaPolicyPython(){
  const release=managedRelease('serena');
  const executable=process.env.FORGE_SERENA_EXECUTABLE??release?.command;
  const bundled=executable?join(dirname(executable),process.platform==='win32'?'python.exe':'python'):undefined;
  return bundled&&existsSync(bundled)?bundled:process.platform==='win32'?'python.exe':'python3';
}
export function policyForNames(root:string,names:string[]){
  const patterns:{readOnly:string[];ignored:string[]}={readOnly:[],ignored:[]};
  for(const file of [join(root,'.serena/project.yml'),join(root,'.serena/project.yaml'),join(process.env.SERENA_USER_HOME??join(homedir(),'.serena'),'serena_config.yml')]){
    if(!existsSync(file))continue;
    const config=parse(readFileSync(file,'utf8'));
    for(const [key,output] of [['read_only_memory_patterns','readOnly'],['ignored_memory_patterns','ignored']] as const){
      const entries=config?.[key];
      if(entries===undefined)continue;
      if(!Array.isArray(entries)||entries.some(v=>typeof v!=='string'||v.length>512)||entries.length>128)throw Error('Invalid Serena memory policy: '+key);
      patterns[output].push(...entries);
    }
  }
  if(!patterns.readOnly.length&&!patterns.ignored.length)return {readOnly:new Set<string>(),ignored:new Set<string>()};
  if(names.length>1024)throw Error('Too many project memories to validate Serena policy');
  // Serena 1.7.0 uses Python re.fullmatch, including Python-specific syntax.
  // Evaluate *only* regex data with its Python interpreter, in an isolated,
  // bounded subprocess; never execute project code or approximate in JS.
  const code='import json,re,sys\np=json.load(sys.stdin)\nprint(json.dumps({k:[n for n in p["names"] if any(re.fullmatch(pattern,n) for pattern in p[k])] for k in ("readOnly","ignored")}))';
  const child=spawnSync(serenaPolicyPython(),['-I','-c',code],{input:JSON.stringify({...patterns,names}),encoding:'utf8',timeout:3000,maxBuffer:65536,windowsHide:true});
  if(child.status!==0||child.error)throw Error('Serena memory policy verification unavailable or invalid');
  const result=JSON.parse(child.stdout) as {readOnly:string[];ignored:string[]};
  return {readOnly:new Set(result.readOnly),ignored:new Set(result.ignored)};
}
export function assertMemoryWritable(root:string,name:string){
  memoryName(name);
  if(name==='global'||name.startsWith('global/'))throw Error('Global Serena memories are outside the project memory journal');
  const policy=policyForNames(root,[name]);
  if(policy.readOnly.has(name)||policy.ignored.has(name))throw Error('Memory is protected by Serena memory policy');
}
export function renameMemory(engine:DurableTasks,id:string,op:string,from:string,to:string,expected:string,lease?:string){
  memoryName(from);memoryName(to);
  if([from,to].some(n=>n==='global'||n.startsWith('global/')))throw Error('Global Serena memories are outside the project memory journal');
  if(from.toLowerCase()===to.toLowerCase())throw Error('Memory rename requires distinct names');
  const request={kind:'memory-rename',from,to,expected},batch=new TaskFileBatches(engine);
  const replay=batch.replay(id,op,request,lease);if(replay)return replay;
  const task=engine.task(id);engine.assertLease(task,lease);engine.assertIdle(task);
  const captured=snapshot(task.root);if(captured.fingerprint!==expected)throw Error('Workspace conflict before memory rename');
  const prefix='.serena/memories/',source=prefix+from+'.md',dest=prefix+to+'.md';
  if(!captured.files[source])throw Error('Memory source does not exist');
  if(Object.keys(captured.files).some(p=>p.toLowerCase()===dest.toLowerCase()))throw Error('Memory destination already exists');
  const paths=Object.keys(captured.files).filter(p=>p.startsWith(prefix)&&p.endsWith('.md'));
  const memoryNames=paths.map(path=>path.slice(prefix.length,-3));
  const policy=policyForNames(task.root,[...new Set([...memoryNames,from,to])]);
  if(policy.readOnly.has(from)||policy.readOnly.has(to)||policy.ignored.has(from)||policy.ignored.has(to))throw Error('Source or destination is protected by Serena memory policy');
  // Ignored memories cannot be inspected for references. Leave the entire
  // operation untouched if referential integrity cannot be established.
  if(memoryNames.some(n=>policy.ignored.has(n)))throw Error('Ignored project memories prevent verifying all references');
  const pattern=new RegExp('(?<![A-Za-z0-9_\\-/])mem:'+from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9_\\-/])','g');
  const changes:BatchChange[]=[];
  for(const path of paths){
    const before=batch.readText(task.root,path),after=before.replace(pattern,()=> 'mem:'+to);
    if(policy.readOnly.has(path.slice(prefix.length,-3))&&(path===source||before!==after))throw Error('Reference update would modify a read-only Serena memory');
    if(path===source)changes.push({path:dest,content:after,expected_hash:null},{path,content:null,expected_hash:captured.files[path]!});
    else if(before!==after)changes.push({path,content:after,expected_hash:captured.files[path]!});
  }
  return batch.write(id,op,changes,expected,lease,request);
}

export interface MemoryReplace {
  name:string;
  needle:string;
  repl:string;
  mode:'literal'|'regex';
  expected_occurrences?:number;
}

// Python's regex semantics, including $!N capture references, are Serena's
// contract. Evaluate *data*, not project code, in a bounded isolated process.
// Literal replacements stay in JS and need no Python interpreter installed.
function replaceMemoryText(before:string,edit:MemoryReplace):string{
  const expected=edit.expected_occurrences??1;
  if(edit.mode==='literal'){
    const count=before.split(edit.needle).length-1;
    if(count!==expected)throw Error(`Memory ${edit.name} expected ${expected} occurrences but matched ${count}`);
    return before.split(edit.needle).join(edit.repl);
  }
  const code=`import json,re,sys
p=json.load(sys.stdin)
try:
    regex=re.compile(p['needle'], re.MULTILINE | re.DOTALL)
    def replace(match):
        value=match.group(0)
        if '\\n' in value and regex.search(value[1:]):
            raise ValueError('Ambiguous overlapping multiline memory replacement')
        def capture(m):
            index=int(m.group(1))
            return match.group(index) or ''
        return re.sub(r'\\$!(\\d+)',capture,p['repl'])
    result,count=regex.subn(replace,p['before'])
    print(json.dumps({'after':result,'count':count},ensure_ascii=False))
except Exception as error:
    print(json.dumps({'error':str(error)[:240]}))`;
  const child=spawnSync(serenaPolicyPython(),['-I','-c',code],{
    input:JSON.stringify({before,needle:edit.needle,repl:edit.repl}),encoding:'utf8',
    timeout:3000,maxBuffer:512*1024,windowsHide:true,
  });
  if(child.status!==0||child.error)throw Error(`Memory ${edit.name} regex verification unavailable or timed out`);
  let parsed:{after?:unknown;count?:unknown;error?:unknown};
  try{parsed=JSON.parse(child.stdout);}catch{throw Error(`Memory ${edit.name} regex response is invalid`);}
  if(typeof parsed.error==='string')throw Error(`Memory ${edit.name} regex: ${parsed.error}`);
  if(typeof parsed.count!=='number'||typeof parsed.after!=='string')throw Error(`Memory ${edit.name} regex response is incomplete`);
  if(parsed.count!==expected)throw Error(`Memory ${edit.name} expected ${expected} occurrences but matched ${parsed.count}`);
  return parsed.after;
}

// A single batch can apply distinct bounded literal/regex edits across 1–16
// Serena memories. Every expected match count, policy, and fingerprint is
// checked before journal intent. The batch has durable recovery and rollback.
export function editMemories(engine:DurableTasks,id:string,op:string,edits:MemoryReplace[],expected:string,lease?:string){
  if(edits.length<1||edits.length>16)throw Error('Memory edit requires 1..16 target memories');
  const names=new Set<string>();
  for(const edit of edits){
    memoryName(edit.name);
    if(edit.name==='global'||edit.name.startsWith('global/'))throw Error('Global Serena memories are outside the project memory journal');
    const key=edit.name.toLowerCase();
    if(names.has(key))throw Error('Each memory edit must target a different memory');
    names.add(key);
    const count=edit.expected_occurrences??1;
    if(!Number.isInteger(count)||count<1||count>256||!edit.needle||edit.needle.length>4096||edit.repl.length>8192||!['literal','regex'].includes(edit.mode))
      throw Error('Memory edit requires a nonempty bounded needle, replacement, mode and expected occurrences 1..256');
  }
  const request={kind:'memory-edit',edits,expected},batch=new TaskFileBatches(engine);
  const replay=batch.replay(id,op,request,lease);if(replay)return replay;
  const task=engine.task(id);engine.assertLease(task,lease);engine.assertIdle(task);
  const captured=snapshot(task.root);
  if(captured.fingerprint!==expected)throw Error('Workspace conflict before memory edit');
  const policy=policyForNames(task.root,edits.map(edit=>edit.name));
  if(edits.some(edit=>policy.readOnly.has(edit.name)||policy.ignored.has(edit.name)))throw Error('Memory edit is protected by Serena memory policy');
  const changes:BatchChange[]=[];
  for(const edit of edits){
    const path='.serena/memories/'+edit.name+'.md',hash=captured.files[path];
    if(!hash)throw Error(`Memory ${edit.name} does not exist`);
    const before=batch.readText(task.root,path);
    if(Buffer.byteLength(before,'utf8')>65536)throw Error(`Memory ${edit.name} exceeds 64 KiB edit limit`);
    const after=replaceMemoryText(before,edit);
    if(after===before)throw Error(`Memory ${edit.name} replacement produced no change`);
    if(Buffer.byteLength(after,'utf8')>65536)throw Error(`Memory ${edit.name} replacement exceeds 64 KiB`);
    changes.push({path,content:after,expected_hash:hash});
  }
  return batch.write(id,op,changes,expected,lease,request);
}
