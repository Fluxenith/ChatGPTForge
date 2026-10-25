import assert from 'node:assert/strict';
import test from 'node:test';
import {join,resolve} from 'node:path';
import {CapturedMavenModels} from './kotlin-maven-model.js';
import {parsePom} from './java-maven-static.js';
import {kotlinWorkspace} from './serena-kotlin.js';
import {privateCppCommands} from './serena-cpp.js';
import {gradleCatalog} from './kotlin-gradle-catalog.js';
const pom=(s:string)=>'<project>'+s+'</project>';
const id=(a:string,v='1')=>`<groupId>demo</groupId><artifactId>${a}</artifactId><version>${v}</version>`;
const dep=(a:string,v='1')=>'<dependency>'+id(a,v)+'</dependency>';
const dm=(s:string)=>'<dependencyManagement><dependencies>'+s+'</dependencies></dependencyManagement>';
const files=(f:Record<string,string>)=>new Map(Object.entries(f).map(([p,s])=>[p,Buffer.from(s)]));
test('Gradle version catalog resolves plugin aliases, fixed libraries and bundles',()=>{
 const expand=gradleCatalog('[versions]\nkotlin = "2.2.0"\n[plugins]\nkotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }\n[libraries]\napi = { module = "demo:api", version = "1" }\nbase = "demo:base:2"\n[bundles]\nall = ["api", "base"]');
 assert.equal(expand('plugins { alias(libs.plugins.kotlin.jvm) }'),'plugins { id("org.jetbrains.kotlin.jvm") version "2.2.0" }');
 assert.equal(expand('implementation(libs.bundles.all)'),'implementation("demo:api:1")\nimplementation("demo:base:2")');
 assert.throws(()=>expand('implementation(libs.missing)'),/Unknown/);
 assert.throws(()=>gradleCatalog('[versions]\nv = { strictly = "1" }\n[libraries]\nx = { module = "demo:x", version.ref = "v" }')('implementation(libs.x)'),/fixed/);
});
test('Captured Maven parent and BOM precedence, interpolation, cycle and aggregation boundaries',()=>{
 const f=files({'repo/demo/parent/1/parent-1.pom':pom(id('parent')+'<properties><libVersion>2</libVersion></properties>'+dm(dep('lib','${libVersion}'))),
 'repo/demo/bom/1/bom-1.pom':pom(id('bom')+dm(dep('lib','3')+dep('other','4')))});
 const models=new CapturedMavenModels(f);
 const xml=pom(id('app')+'<parent>'+id('parent')+'</parent>'+dm('<dependency>'+id('bom')+'<type>pom</type><scope>import</scope></dependency>')+'<dependencies><dependency><groupId>demo</groupId><artifactId>lib</artifactId></dependency><dependency><groupId>demo</groupId><artifactId>other</artifactId></dependency></dependencies>');
 const m=models.model(parsePom(xml));
 assert.deepEqual(m.dependencies.map(d=>d.children.find(n=>n.name==='version')?.text),['2','4']);
 const overridden=models.model(parsePom(xml.replace('<parent>','<properties><libVersion>5</libVersion></properties><parent>')));
 assert.equal(overridden.dependencies[0]!.children.find(n=>n.name==='version')!.text,'5');
 const aggregate=models.model(parsePom(pom(id('aggregate')+'<properties><unrelated>no</unrelated></properties>')));
 assert.equal(models.model(parsePom(pom(id('child'))),aggregate).props.has('unrelated'),false);
 f.set('repo/demo/bom/1/bom-1.pom',Buffer.from(pom(id('bom')+dm('<dependency>'+id('bom')+'<type>pom</type><scope>import</scope></dependency>'))));
 assert.throws(()=>models.model(parsePom(xml)),/cyclic/);
});
test('Gradle api reaches consumers while implementation dependencies remain private',()=>{
 const f=files({'settings.gradle.kts':'include("base", "secret", "core", "app")',
  'base/build.gradle.kts':'plugins { java }','secret/build.gradle.kts':'plugins { java }',
  'core/build.gradle.kts':'plugins { `java-library` }\ndependencies {\napi(project(":base"))\nimplementation(project(":secret"))\n}',
  'app/build.gradle.kts':'plugins { java }\ndependencies { implementation(project(":core")) }'});
 for(const p of ['base','secret','core','app'])f.set(p+'/src/main/java/Main.java',Buffer.from('class Main {}'));
 const w=JSON.parse(kotlinWorkspace(f,'app/src/main/java/Main.java'));
 const deps=w.modules.find((m:any)=>m.name==='m3_main').dependencies.filter((d:any)=>d.type==='module').map((d:any)=>d.name);
 assert.deepEqual(deps,['m2_main','m0_main']);
});
test('C++ absolute database is rebased; external inputs and response files are refused',()=>{
 const root=resolve('fixture'),privateRoot=resolve('owned/project'),f=new Map([['src/main.cpp',Buffer.from('int main(){}')]]);
 const e={directory:join(root,'build'),file:join(root,'src/main.cpp'),arguments:['clang++','-I'+join(root,'include'),'-x','c++','-c',join(root,'src/main.cpp')]};
 const plan=JSON.parse(privateCppCommands(Buffer.from(JSON.stringify([e])),root,privateRoot,f));
 assert.equal(plan[0].file,join(privateRoot,'src/main.cpp'));assert.equal(plan[0].arguments[3],'c++');
 assert.throws(()=>privateCppCommands(Buffer.from(JSON.stringify([{...e,arguments:['clang++','-I',resolve(root,'../outside')]}])),root,privateRoot,f),/leaves/);
 assert.throws(()=>privateCppCommands(Buffer.from(JSON.stringify([{...e,arguments:['clang++','@flags.rsp']}])),root,privateRoot,f),/response/);
 assert.throws(()=>privateCppCommands(Buffer.from(JSON.stringify([{...e,arguments:['clang++','-fmodule-file='+resolve(root,'../outside.pcm')]}])),root,privateRoot,f),/absolute path/);
});
