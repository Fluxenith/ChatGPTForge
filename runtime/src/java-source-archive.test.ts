import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {mkdtemp,writeFile,rm,realpath,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {captureJavaSourceArchive,parseJavaSourceArchive,sourceArchiveLimits,parseJdkSourceArchiveEntry,jdkSourceLimits} from './java-source-archive.js';
function crc32(raw:Buffer){let value=0xffffffff;for(const byte of raw){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
// Independent ZIP producer makes native format, declared inflation size,
// local/central divergence and symlink metadata controllable without extraction.
function zip(entries:{name:string;data:Buffer;method?:number;flags?:number;size?:number;crc?:number;mode?:number;localName?:string}[]){
 const files:Buffer[]=[],directory:Buffer[]=[];let offset=0;
 for(const entry of entries){const name=Buffer.from(entry.name),localName=Buffer.from(entry.localName??entry.name),method=entry.method??8,flags=entry.flags??0,payload=method===8?deflateRawSync(entry.data):entry.data,size=entry.size??entry.data.length,crc=entry.crc??crc32(entry.data);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(flags,6);header.writeUInt16LE(method,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(payload.length,18);header.writeUInt32LE(size,22);header.writeUInt16LE(localName.length,26);const part=Buffer.concat([header,localName,payload]);files.push(part);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(((entry.mode??0x8000)<<16)>>>0,38);central.writeUInt32LE(offset,42);directory.push(central,name);offset+=part.length;
 }const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...files,central,end]);
}
const source=Buffer.from('package p;\r\n// 😀\r\npublic class 中文 {}\r\n');
test('JDK ZIP validates the whole module directory while expanding only the selected original source',()=>{
 const entry='java.base/p/中文.java',raw=zip([{name:entry,data:source},{name:'jdk.charsets/p/Large.java',data:Buffer.alloc(900000,65)}]);
 assert.deepEqual(parseJdkSourceArchiveEntry(raw,'java.base',entry),{entry,content:source.toString('utf8'),sha256:createHash('sha256').update(source).digest('hex'),bytes:source.length});
 assert.throws(()=>parseJavaSourceArchive(raw),/bounds/);
 assert.equal(parseJdkSourceArchiveEntry(raw,'java.base','java.base/p/Missing.java'),undefined);
 for(const other of ['java.base/../Secret.java','/Secret.java','java.base/p//Secret.java'])assert.throws(()=>parseJdkSourceArchiveEntry(zip([{name:entry,data:source},{name:other,data:source}]),'java.base',entry),/Unsafe/);
 assert.throws(()=>parseJdkSourceArchiveEntry(raw,'java.sql',entry),/module/);
 assert.throws(()=>parseJdkSourceArchiveEntry(zip([{name:entry,data:source,crc:1}]),'java.base',entry),/mismatch/);
 assert.throws(()=>parseJdkSourceArchiveEntry(zip([{name:entry,data:source,localName:'java.base/p/Other.java'}]),'java.base',entry),/range/);
 assert.throws(()=>parseJdkSourceArchiveEntry(zip([{name:entry,data:source,mode:0xa000}]),'java.base',entry),/Unsupported/);
 assert.throws(()=>parseJdkSourceArchiveEntry(zip([{name:entry,data:Buffer.alloc(jdkSourceLimits.sourceBytes+1,65)}]),'java.base',entry),/bounds/);
});
test('source ZIP supports stored/deflated UTF-8 CRLF and returns original byte pins without extraction',()=>{
 for(const method of [0,8]){const files=parseJavaSourceArchive(zip([{name:'p/中文.java',data:source,method}]));assert.equal(files.length,1);assert.equal(files[0]!.content,source.toString('utf8'));assert.equal(files[0]!.sha256,createHash('sha256').update(source).digest('hex'));assert.equal(files[0]!.bytes,source.length);}
});
test('source ZIP rejects traversal, absolute names, separators, duplicates, links and unsupported encryption/compression',()=>{
 for(const name of ['../Secret.java','/Secret.java','C:/Secret.java','p\\Secret.java','p/../Secret.java','p//Secret.java'])assert.throws(()=>parseJavaSourceArchive(zip([{name,data:source}])),/Unsafe/);
 assert.throws(()=>parseJavaSourceArchive(zip([{name:'Api.java',data:source},{name:'Api.java',data:source}])),/Duplicate/);
 for(const metadata of [{mode:0xa000},{flags:1},{flags:0x40},{method:12}])assert.throws(()=>parseJavaSourceArchive(zip([{name:'Api.java',data:source,...metadata}])),/Unsupported/);
});
test('source ZIP refuses unbounded inflation, false lengths/CRC, divergent local names and invalid UTF-8',()=>{
 assert.throws(()=>parseJavaSourceArchive(zip([{name:'Api.java',data:Buffer.alloc(sourceArchiveLimits.sourceBytes+1,65)}])),/bounds/);
 assert.throws(()=>parseJavaSourceArchive(zip([{name:'Api.java',data:Buffer.alloc(sourceArchiveLimits.sourceBytes+1,65),size:1}])),/too large|Buffer larger|length|buffer/i);
 for(const metadata of [{size:1},{crc:1},{localName:'Other.java'}])assert.throws(()=>parseJavaSourceArchive(zip([{name:'Api.java',data:source,...metadata}])),/mismatch|range/);
 assert.throws(()=>parseJavaSourceArchive(zip([{name:'Api.java',data:Buffer.from([255])}])),/UTF-8/);
 assert.throws(()=>parseJavaSourceArchive(Buffer.alloc(sourceArchiveLimits.archiveBytes+1)),/32 MiB/);
});
test('source archives capture only existing approved regular inputs and preserve caller bytes',async t=>{
 const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'forge-source-archive-')),outside=await mkdtemp(join(parent,'forge-source-outside-'));t.after(async()=>{for(const path of [root,outside]){assert.equal(await realpath(path),path);assert.ok(path.startsWith(parent+sep));await rm(path,{recursive:true,force:true,maxRetries:8,retryDelay:100});}});
 const raw=zip([{name:'p/中文.java',data:source}]);await writeFile(join(root,'sources.jar'),raw);await writeFile(join(outside,'sources.jar'),raw);const captured=await captureJavaSourceArchive(root,'sources.jar',[root]);assert.deepEqual(captured.raw,raw);assert.equal(captured.sources[0]!.entry,'p/中文.java');
 await assert.rejects(captureJavaSourceArchive(root,join(outside,'sources.jar'),[root]),/outside|allowed|approved/i);
 await symlink(join(root,'sources.jar'),join(root,'link.jar'));try{await assert.rejects(captureJavaSourceArchive(root,'link.jar',[root]),/link/);}finally{assert.equal(await realpath(root),root);await unlink(join(root,'link.jar'));}
 const controller=new AbortController();controller.abort();await assert.rejects(captureJavaSourceArchive(root,'sources.jar',[root],controller.signal),/abort/i);assert.deepEqual(await (await import('node:fs/promises')).readFile(join(root,'sources.jar')),raw);
});
