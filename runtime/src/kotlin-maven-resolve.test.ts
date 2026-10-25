import test from 'node:test';
import assert from 'node:assert/strict';
import {CapturedMavenModels} from './kotlin-maven-model.js';
import {resolveKotlinMaven} from './kotlin-maven-resolve.js';
import {kotlinWorkspace,KOTLIN_MODEL} from './serena-kotlin.js';
import {kotlinBuildInputs,kotlinInputHash} from './kotlin-model-inputs.js';
const jar=Buffer.from('504b0506000000000000000000000000000000000000','hex');
const dep=(a:string,v='1',extra='')=>`<dependency><groupId>x</groupId><artifactId>${a}</artifactId><version>${v}</version>${extra}</dependency>`;
const pom=(a:string,deps='',extra='')=>`<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>${a}</artifactId><version>1</version><dependencies>${deps}</dependencies>${extra}</project>`;
test('Maven nearest and same-depth order, exclusions, optional and scopes',()=>{
 const f=new Map<string,Buffer>();
 const add=(a:string,v:string,deps='')=>{const base=`repo/x/${a}/${v}/${a}-${v}`;f.set(base+'.pom',Buffer.from(pom(a,deps)));f.set(base+'.jar',jar);};
 add('a','1',dep('c','2')+dep('optional','1','<optional>true</optional>')+dep('hidden','1','<scope>provided</scope>'));add('b','1',dep('c','3'));add('c','1');add('c','2');add('c','3');add('run','1');
 const resolve=(deps:string,set:'main'|'test'='main')=>{f.set('pom.xml',Buffer.from(pom('root',deps)));return resolveKotlinMaven(f,new CapturedMavenModels(f).load('pom.xml'),set,new Map()).libraries.map(p=>p.split('/').at(-1));};
 assert.deepEqual(resolve(dep('a')+dep('b')+dep('c')),['a-1.jar','b-1.jar','c-1.jar']);
 assert.deepEqual(resolve(dep('b')+dep('a')),['b-1.jar','c-3.jar','a-1.jar']);
 assert.deepEqual(resolve(dep('a','1','<exclusions><exclusion><groupId>x</groupId><artifactId>c</artifactId></exclusion></exclusions>')+dep('b')),['a-1.jar','b-1.jar','c-3.jar']);
 f.delete('repo/x/run/1/run-1.jar');assert.deepEqual(resolve(dep('run','1','<scope>runtime</scope>')),[]);
 assert.throws(()=>resolve(dep('run','1','<scope>runtime</scope>'),'test'),/Missing captured/);
});
test('dynamic model rejects source drift and dependency tampering; legacy stays usable',()=>{
 const f=new Map([['src/A.kt',Buffer.from('fun a()=1')],['.forge/kotlin-import/run/a.jar',jar]]);
 const model={version:2,modules:[{name:'a',roots:['src'],libraries:['.forge/kotlin-import/run/a.jar']}],input_hashes:kotlinBuildInputs(f),library_hashes:{'.forge/kotlin-import/run/a.jar':kotlinInputHash(jar)}};
 f.set(KOTLIN_MODEL,Buffer.from(JSON.stringify(model)));assert.equal(JSON.parse(kotlinWorkspace(f,'src/A.kt')).modules.length,1);
 f.set('src/A.kt',Buffer.from('fun a()=2'));assert.throws(()=>kotlinWorkspace(f,'src/A.kt'),/stale/);
 f.set('src/A.kt',Buffer.from('fun a()=1'));f.set('.forge/kotlin-import/run/a.jar',Buffer.from('changed'));assert.throws(()=>kotlinWorkspace(f,'src/A.kt'),/library changed/);
});
