import {createHash} from 'node:crypto';
import {crc32,inflateRawSync} from 'node:zlib';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {resolveCanonicalAllowedPath} from './roots.js';
import {validateJavaJar} from './java-archive.js';

// Captured source archives are never extracted or used by primary project attribution.
export const sourceArchiveLimits={archiveBytes:32*1024*1024,sourceBytes:512*1024,totalSourceBytes:64*1024*1024,sources:4096,entries:10000};
export interface JavaArchiveSource {entry:string;sha256:string;bytes:number;content:string}
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function parseSourceArchive(raw:Buffer,limits:typeof sourceArchiveLimits,wanted?:string):JavaArchiveSource[]{
 if(raw.length>limits.archiveBytes)throw Error(limits===sourceArchiveLimits?'Java source archive exceeds 32 MiB':'JDK source archive exceeds 64 MiB');validateJavaJar(raw,limits.entries);
 let end=-1;for(let offset=raw.length-22;offset>=Math.max(0,raw.length-65557);offset--)if(raw.readUInt32LE(offset)===0x06054b50&&offset+22+raw.readUInt16LE(offset+20)===raw.length){end=offset;break;}
 if(end<0)throw Error('Invalid Java source archive');let offset=raw.readUInt32LE(end+16),total=0;const sources:JavaArchiveSource[]=[];
 for(let index=0;index<raw.readUInt16LE(end+10);index++){
  const flags=raw.readUInt16LE(offset+8),method=raw.readUInt16LE(offset+10),crc=raw.readUInt32LE(offset+16),compressed=raw.readUInt32LE(offset+20),size=raw.readUInt32LE(offset+24),length=raw.readUInt16LE(offset+28),extra=raw.readUInt16LE(offset+30),comment=raw.readUInt16LE(offset+32),local=raw.readUInt32LE(offset+42),nameBytes=raw.subarray(offset+46,offset+46+length),name=nameBytes.toString('utf8');
  const mode=(raw.readUInt32LE(offset+38)>>>16)&0xf000;
  if(!Buffer.from(name).equals(nameBytes)||!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').some((part,i,parts)=>part==='.'||part==='..'||(!part&&i!==parts.length-1))||/^[A-Za-z]:/.test(name))throw Error('Unsafe or invalid Java source archive entry');
  offset+=46+length+extra+comment;if(!name.endsWith('.java')||(wanted!==undefined&&name!==wanted))continue;
  if((flags&0x41)||![0,8].includes(method)||(mode!==0&&mode!==0x8000))throw Error('Unsupported Java source archive entry');
  if(size>limits.sourceBytes||sources.length>=limits.sources||(total+=size)>limits.totalSourceBytes)throw Error('Java source archive sources exceed bounds');
  if(local+30>raw.readUInt32LE(end+16)||raw.readUInt32LE(local)!==0x04034b50||raw.readUInt16LE(local+6)!==flags||raw.readUInt16LE(local+8)!==method)throw Error('Invalid Java source local header');
  const localNameLength=raw.readUInt16LE(local+26),begin=local+30+localNameLength+raw.readUInt16LE(local+28);if(!raw.subarray(local+30,local+30+localNameLength).equals(nameBytes)||begin+compressed>raw.readUInt32LE(end+16))throw Error('Invalid Java source archive range');
  const payload=raw.subarray(begin,begin+compressed),data=method===8?inflateRawSync(payload,{maxOutputLength:limits.sourceBytes}):payload;
  if(data.length!==size||crc32(data)!==crc)throw Error('Java source archive data mismatch');const text=data.toString('utf8');if(!Buffer.from(text).equals(data))throw Error('Java source archive must contain UTF-8 sources');
  // Do not expand Java Unicode escapes or normalize newlines: public ranges use
  // the original UTF-16 source contents and hashes refer to original bytes.
  sources.push({entry:name,sha256:hash(data),bytes:data.length,content:text});
 }
 return sources;
}
export function parseJavaSourceArchive(raw:Buffer):JavaArchiveSource[]{return parseSourceArchive(raw,sourceArchiveLimits);}
// The installed JDK is a runtime input, not an approved project dependency.
// Validate its full directory but expand only the compiler-selected module entry.
// Ordinary source JAR limits above remain unchanged.
export const jdkSourceLimits={archiveBytes:64*1024*1024,sourceBytes:2*1024*1024,totalSourceBytes:2*1024*1024,sources:1,entries:40000};
export function parseJdkSourceArchiveEntry(raw:Buffer,module:string,entry:string):JavaArchiveSource|undefined{
 if(!/^[A-Za-z][A-Za-z0-9_.]*$/.test(module)||!entry.startsWith(module+'/')||!entry.endsWith('.java'))throw Error('Invalid JDK source module entry');
 return parseSourceArchive(raw,jdkSourceLimits,entry)[0];
}
async function checkedSourcePath(projectRoot:string,name:string,roots:string[]){
 const path=resolve(projectRoot,name),allowed=await Promise.all(roots.map(root=>realpath(root)));await resolveCanonicalAllowedPath(path,projectRoot,allowed);
 const boundary=allowed.filter(root=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}).sort((a,b)=>b.length-a.length)[0];if(!boundary)throw Error('Java source archive is outside approved roots');
 let current=boundary;if((await lstat(current)).isSymbolicLink())throw Error('Java source archive root is a link');for(const part of relative(boundary,path).split(sep).filter(Boolean)){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('Java source archive path is a link');}
 if((await realpath(path)).toLowerCase()!==path.toLowerCase())throw Error('Java source archive path redirects');return path;
}
export async function captureJavaSourceArchive(projectRoot:string,name:string,roots:string[],signal?:AbortSignal){
 signal?.throwIfAborted();const path=await checkedSourcePath(projectRoot,name,roots),before=await lstat(path);if(!before.isFile()||before.size>sourceArchiveLimits.archiveBytes)throw Error('Java source archive must be a bounded regular file');
 signal?.throwIfAborted();const raw=await readFile(path),after=await lstat(path);await checkedSourcePath(projectRoot,name,roots);signal?.throwIfAborted();if(!after.isFile()||raw.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.dev!==after.dev||before.ino!==after.ino)throw Error('Java source archive changed during capture');
 return {path,sha256:hash(raw),bytes:raw.length,raw,sources:parseJavaSourceArchive(raw)};
}
