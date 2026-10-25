import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile,symlink,unlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {navigateJava} from './java-navigation.js';
import {javaHash} from './java-project.js';
import {verifyJdkDefinition,type JavaJdkOrigin} from './java-jdk-source.js';
import {parseJdkSourceArchiveEntry} from './java-source-archive.js';
let home:string,archive:Buffer;
before(async()=>{const result=await promisify(execFile)('java',['-XshowSettings:properties','-version'],{windowsHide:true,env:{...process.env,JAVA_TOOL_OPTIONS:'',_JAVA_OPTIONS:'',JDK_JAVA_OPTIONS:''}});home=await realpath(result.stderr.match(/java.home = (.+)/)![1]!.trim());archive=await readFile(join(home,'lib/src.zip'));});
async function owned(t:{after:(fn:()=>Promise<void>)=>void}){const root=await mkdtemp(join(await realpath(tmpdir()),'forge-jdk-source-test-'));t.after(async()=>{assert.equal(await realpath(root),root);await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});return root;}
const app=`import java.util.*;
import java.sql.DriverManager;
class App {
 int length(String value){return value.length();}
 String part(String value){return value.substring(1,2);}
 ArrayList<String> construct(){return new ArrayList<String>(7);}
 String nested(Map.Entry<String,String> entry){return entry.getKey();}
 double field(){return Double.NaN;}
 java.io.PrintStream stream(){return System.out;}
 String module(){return DriverManager.getLoginTimeout()+"";}
 int inherited(ArrayList<String> list){return list.size();}
 Map.Entry<String,String> type(){return null;}
}
`;
async function at(root:string,needle:string){const index=app.indexOf(needle);assert.ok(index>=0);const lines=app.slice(0,index).split('\n');return navigateJava({path:root,file:'App.java',action:'definition',line:lines.length,column:lines.at(-1)!.length+1},[root]);}
test('JDK definitions bind methods, overloads, constructors, nested generic members, fields, types and a second module to exact runtime sources',async t=>{
 const root=await owned(t);await writeFile(join(root,'App.java'),app);
 for(const [needle,module,entry,key,name] of [
  ['length();','java.base','java/lang/String.java','M:java.lang.String#length():int','length'],
  ['substring(1,2)','java.base','java/lang/String.java','M:java.lang.String#substring(int,int):java.lang.String','substring'],
  ['ArrayList<String>(7)','java.base','java/util/ArrayList.java','M:java.util.ArrayList#<init>(int):void','ArrayList'],
  ['getKey();','java.base','java/util/Map.java','M:java.util.Map.Entry#getKey():java.lang.Object','getKey'],
  ['NaN;','java.base','java/lang/Double.java','F:java.lang.Double#NaN:double','NaN'],
  ['out;','java.base','java/lang/System.java','F:java.lang.System#out:java.io.PrintStream','out'],
  ['getLoginTimeout()','java.sql','java/sql/DriverManager.java','M:java.sql.DriverManager#getLoginTimeout():int','getLoginTimeout'],
  ['size();','java.base','java/util/ArrayList.java','M:java.util.ArrayList#size():int','size'],
  ['Entry<String,String> type','java.base','java/util/Map.java','T:INTERFACE:java.util.Map.Entry','Entry'],
 ] as const){
  const result=await at(root,needle),hit=result.results[0]!,source=hit.source as any,original=parseJdkSourceArchiveEntry(archive,module,module+'/'+entry)!;
  assert.equal(result.total,1,needle);assert.equal(hit.name,name);assert.equal(hit.read_only,true);assert.equal(hit.origin,'java_jdk_source');assert.equal(source.module,module);assert.equal(source.symbol_key,key);assert.equal(source.entry,module+'/'+entry);assert.equal(source.content,original.content);assert.equal(source.sha256,original.sha256);assert.equal(source.archive_sha256,javaHash(archive));assert.equal(source.archive,join(home,'lib/src.zip'));assert.match(source.binary,new RegExp('^jrt:/'+module+'/'));assert.match(source.binary_sha256,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result),/forge-java-analysis-/);
  const line=source.content.split(/\r\n|\r|\n/)[Number(hit.line)-1];assert.equal(line.slice(Number(hit.column)-1,Number(hit.end_column)-1),name);
 }
 assert.equal((await navigateJava({path:root,action:'diagnostics'},[root])).total,0);assert.equal(await readFile(join(root,'App.java'),'utf8'),app);
 const index=app.indexOf('length();'),lines=app.slice(0,index).split('\n');await assert.rejects(navigateJava({path:root,file:'App.java',action:'rename_preview',line:lines.length,column:lines.at(-1)!.length+1,new_name:'other'},[root]),/Read.only Java environment/);
});
test('JDK source verification refuses drift, mismatched runtime release, module metadata, linked paths and cancellation without touching the installed JDK',async t=>{
 const root=await owned(t);await mkdir(join(root,'lib'));await writeFile(join(root,'lib/src.zip'),archive);const modules=Buffer.from('controlled runtime image'),release=Buffer.from('JAVA_VERSION="21.0.4"\n');await writeFile(join(root,'lib/modules'),modules);await writeFile(join(root,'release'),release);
 const origin:JavaJdkOrigin={home:root,module:'java.base',binary_name:'java.lang.String',binary_sha256:'a'.repeat(64),archive_sha256:javaHash(archive),archive_bytes:archive.length,modules_sha256:javaHash(modules),modules_bytes:modules.length,release_sha256:javaHash(release),release_bytes:release.length};
 const entry='java.base/java/lang/String.java';assert.equal((await verifyJdkDefinition(origin,entry,'21.0.4+8-LTS-274')).source.entry,entry);
 await writeFile(join(root,'lib/modules'),Buffer.from('changed runtime image'));await assert.rejects(verifyJdkDefinition(origin,entry,'21.0.4+8-LTS-274'),/changed/);await writeFile(join(root,'lib/modules'),modules);
 await assert.rejects(verifyJdkDefinition(origin,entry,'21.0.5+1'),/disagree/);await assert.rejects(verifyJdkDefinition({...origin,module:'java.sql'},entry,'21.0.4'),/package/);
 await assert.rejects(verifyJdkDefinition({...origin,archive_sha256:'b'.repeat(64)},entry,'21.0.4'),/changed/);
 await rename(join(root,'lib/src.zip'),join(root,'lib/original.zip'));try{await symlink(join(root,'lib/original.zip'),join(root,'lib/src.zip'));await assert.rejects(verifyJdkDefinition(origin,entry,'21.0.4'),/link/);}finally{await unlink(join(root,'lib/src.zip'));await rename(join(root,'lib/original.zip'),join(root,'lib/src.zip'));}
 const controller=new AbortController();controller.abort();await assert.rejects(verifyJdkDefinition(origin,entry,'21.0.4',controller.signal),/abort/i);
});
