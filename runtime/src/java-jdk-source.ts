import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {jdkSourceLimits,parseJdkSourceArchiveEntry} from './java-source-archive.js';

export interface JavaJdkOrigin {
 home:string;module:string;binary_name:string;binary_sha256:string;
 archive_sha256:string;archive_bytes:number;
 modules_sha256:string;modules_bytes:number;
 release_sha256:string;release_bytes:number;
}
const hash=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
async function installedFile(home:string,parts:string[]){
 if(!isAbsolute(home)||(await realpath(home))!==home||(await lstat(home)).isSymbolicLink())throw Error('JDK runtime home must be canonical');
 let path=home;for(const part of parts){path=join(path,part);if((await lstat(path)).isSymbolicLink())throw Error('JDK runtime input is a link');}
 if((await realpath(path))!==path)throw Error('JDK runtime input redirects');return path;
}
async function verifyPin(home:string,parts:string[],expected:string,bytes:number,limit:number,signal?:AbortSignal,contents=false){
 if(!/^[a-f0-9]{64}$/.test(expected)||!Number.isSafeInteger(bytes)||bytes<0||bytes>limit)throw Error('Invalid JDK runtime pin');
 signal?.throwIfAborted();const path=await installedFile(home,parts),before=await lstat(path);
 if(!before.isFile()||before.size!==bytes)throw Error('JDK runtime input size changed');
 let raw:Buffer|undefined,digest:string;
 if(contents){raw=await readFile(path,{signal});digest=hash(raw);}
 else{const hasher=createHash('sha256');let count=0;for await(const chunk of createReadStream(path,{signal})){count+=(chunk as Buffer).length;if(count>limit)throw Error('JDK runtime input exceeds bounds');hasher.update(chunk as Buffer);}if(count!==bytes)throw Error('JDK runtime input size changed');digest=hasher.digest('hex');}
 const after=await lstat(await installedFile(home,parts));signal?.throwIfAborted();
 if(!after.isFile()||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.dev!==after.dev||before.ino!==after.ino||digest!==expected)throw Error('JDK runtime input changed since analysis');
 return {path,sha256:expected,bytes,...(raw?{raw}:{})};
}
// Only called with origin metadata produced by the owned compiler helper.
// The project cannot configure a different JDK source path or broaden roots.
export async function verifyJdkDefinition(origin:JavaJdkOrigin,entry:string,version:string,signal?:AbortSignal){
 if(!origin||typeof origin.home!=='string'||typeof origin.module!=='string'||!/^(java|jdk)\./.test(origin.module)||!/^[A-Za-z][A-Za-z0-9_.]*$/.test(origin.module)||typeof origin.binary_name!=='string'||!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(origin.binary_name)||!/^[a-f0-9]{64}$/.test(origin.binary_sha256)||typeof entry!=='string')throw Error('Invalid JDK source origin');
 const packagePath=origin.binary_name.slice(0,origin.binary_name.lastIndexOf('.')).replaceAll('.','/');
 if(!entry.startsWith(origin.module+'/'+packagePath+'/')||entry.slice((origin.module+'/'+packagePath+'/').length).includes('/'))throw Error('JDK source entry disagrees with binary package');
 const archive=await verifyPin(origin.home,['lib','src.zip'],origin.archive_sha256,origin.archive_bytes,jdkSourceLimits.archiveBytes,signal,true);
 const source=parseJdkSourceArchiveEntry(archive.raw!,origin.module,entry);if(!source)throw Error('JDK compiler returned an uncaptured source entry');
 const modules=await verifyPin(origin.home,['lib','modules'],origin.modules_sha256,origin.modules_bytes,512*1024*1024,signal);
 const release=await verifyPin(origin.home,['release'],origin.release_sha256,origin.release_bytes,65536,signal,true);
 const releaseVersion=release.raw!.toString('utf8').match(/^JAVA_VERSION="([^"]+)"\r?$/m)?.[1];
 if(!releaseVersion||!/^21(?:\.|$)/.test(releaseVersion)||!(version===releaseVersion||version.startsWith(releaseVersion+'+')))throw Error('JDK release and analysis runtime disagree');
 await verifyPin(origin.home,['lib','src.zip'],origin.archive_sha256,origin.archive_bytes,jdkSourceLimits.archiveBytes,signal);
 return {source,archive:{path:archive.path,sha256:archive.sha256,bytes:archive.bytes},inputs:[{path:modules.path,sha256:modules.sha256,bytes:modules.bytes},{path:release.path,sha256:release.sha256,bytes:release.bytes}]};
}
