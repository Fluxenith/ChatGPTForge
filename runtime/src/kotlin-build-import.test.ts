import assert from 'node:assert/strict';
import test from 'node:test';
import {kotlinWorkspace} from './serena-kotlin.js';
import {parsePom} from './java-maven-static.js';
const map=(f:Record<string,string|Buffer>)=>new Map(Object.entries(f).map(([k,v])=>[k,Buffer.from(v)]));
const emptyJar=Buffer.from('504b0506000000000000000000000000000000000000','hex');
const pom=(body:string)=>'<project><modelVersion>4.0.0</modelVersion>'+body+'</project>';
test('Kotlin Gradle auto import separates modules and tests, captures stdlib, refuses dynamic inputs',()=>{
 const f=map({'settings.gradle.kts':'include("core", "app")',
  'core/build.gradle.kts':'plugins { kotlin("jvm") version "2.2.0" }',
  'app/build.gradle.kts':'plugins { kotlin("jvm") version "2.2.0" }\ndependencies { implementation(project(":core")) }',
  'core/src/main/kotlin/Calc.kt':'fun twice()=2','app/src/main/kotlin/App.kt':'fun app()=twice()', 'app/src/test/kotlin/Test.kt':'fun test()=app()',
  'repo/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.pom':pom(''),
  'repo/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.jar':emptyJar});
 const w=JSON.parse(kotlinWorkspace(f,'core/src/main/kotlin/Calc.kt'));
 assert.equal(w.modules.length,3);assert.equal(w.libraries.length,1);
 assert.ok(w.modules[1].dependencies.some((d:any)=>d.type==='module'&&d.name==='m0_main'));
 assert.ok(w.modules[2].dependencies.some((d:any)=>d.name==='m1_main'));
 f.set('gradle.properties',Buffer.from('kotlin.stdlib.default.dependency=false'));
 assert.throws(()=>kotlinWorkspace(f,'core/src/main/kotlin/Calc.kt'),/dynamic Gradle/);f.delete('gradle.properties');
 f.delete('repo/org/jetbrains/kotlin/kotlin-stdlib/2.2.0/kotlin-stdlib-2.2.0.jar');
 assert.throws(()=>kotlinWorkspace(f,'core/src/main/kotlin/Calc.kt'),/missing captured JAR/);
});
test('Kotlin Maven reactor imports inherited properties, scopes and local transitive dependencies',()=>{
 const parent='<groupId>demo</groupId><artifactId>parent</artifactId><version>1</version>';
 const f=map({'pom.xml':pom(parent+'<packaging>pom</packaging><properties><lib.version>1</lib.version></properties><build><plugins><plugin><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-plugin</artifactId><extensions>true</extensions></plugin></plugins></build><modules><module>core</module><module>app</module></modules>'),
  'core/pom.xml':pom('<parent>'+parent+'</parent><artifactId>core</artifactId>'),
  'app/pom.xml':pom('<parent>'+parent+'</parent><artifactId>app</artifactId><dependencies><dependency><groupId>demo</groupId><artifactId>core</artifactId><version>1</version></dependency><dependency><groupId>local</groupId><artifactId>api</artifactId><version>${lib.version}</version></dependency></dependencies>'),
  'core/src/main/kotlin/Core.kt':'fun twice()=2','app/src/main/kotlin/App.kt':'fun app()=twice()',
  'repo/local/api/1/api-1.pom':pom('<dependencies><dependency><groupId>local</groupId><artifactId>base</artifactId><version>1</version></dependency></dependencies>'),
  'repo/local/api/1/api-1.jar':emptyJar,'repo/local/base/1/base-1.pom':pom(''),'repo/local/base/1/base-1.jar':emptyJar});
 const w=JSON.parse(kotlinWorkspace(f,'app/src/main/kotlin/App.kt'));assert.equal(w.modules.length,2);assert.equal(w.libraries.length,2);
 assert.ok(w.modules[1].dependencies.some((d:any)=>d.type==='module'&&d.name==='m1_main'));
 f.set('pom.xml',Buffer.from(pom(parent+'<profiles><profile/></profiles>')));
 assert.throws(()=>kotlinWorkspace(f,'app/src/main/kotlin/App.kt'),/profiles/);
});
test('Malformed Maven XML fails promptly instead of looping inside automatic import',()=>{
 for(const xml of ['<project name="unfinished','<project>unfinished','<project><?unfinished','<project></project extra>'])assert.throws(()=>parsePom(xml));
});
