import {inflateRawSync} from 'node:zlib';

// javac expands Manifest Class-Path behind the file manager's classpath API.
// Refuse that hidden authority instead of letting a private copy open an
// uncaptured absolute URI or a path outside the owned analysis directory.
export function validateJavaJar(raw:Buffer,maxEntries=10000){
  let end=-1;
  for(let i=raw.length-22;i>=Math.max(0,raw.length-65557);i--)if(raw.readUInt32LE(i)===0x06054b50&&i+22+raw.readUInt16LE(i+20)===raw.length){end=i;break;}
  if(end<0||raw.readUInt16LE(end+4)!==0||raw.readUInt16LE(end+6)!==0||raw.readUInt16LE(end+8)!==raw.readUInt16LE(end+10))throw Error('Invalid or multi-disk Java JAR');
  const count=raw.readUInt16LE(end+10),size=raw.readUInt32LE(end+12),offset=raw.readUInt32LE(end+16);
  if(count>maxEntries||offset+size!==end)throw Error('Java JAR central directory is oversized or unsupported');
  let at=offset;const names=new Set<string>();
  for(let i=0;i<count;i++){
    if(at+46>end||raw.readUInt32LE(at)!==0x02014b50)throw Error('Invalid Java JAR directory');
    const flags=raw.readUInt16LE(at+8),method=raw.readUInt16LE(at+10),compressed=raw.readUInt32LE(at+20),bytes=raw.readUInt32LE(at+24),length=raw.readUInt16LE(at+28),extra=raw.readUInt16LE(at+30),comment=raw.readUInt16LE(at+32),local=raw.readUInt32LE(at+42);
    const next=at+46+length+extra+comment;if(next>end)throw Error('Invalid Java JAR entry');
    const name=raw.subarray(at+46,at+46+length).toString('utf8');if(names.has(name))throw Error('Duplicate Java JAR entry');names.add(name);
    if(name.toUpperCase()==='META-INF/MANIFEST.MF'){
      if(bytes>64*1024||flags&1||![0,8].includes(method)||local+30>offset||raw.readUInt32LE(local)!==0x04034b50)throw Error('Java JAR manifest exceeds supported bounds');
      const begin=local+30+raw.readUInt16LE(local+26)+raw.readUInt16LE(local+28);if(begin+compressed>offset)throw Error('Invalid Java JAR manifest range');
      const data=raw.subarray(begin,begin+compressed),manifest=method===8?inflateRawSync(data,{maxOutputLength:64*1024}):data;
      if(manifest.length!==bytes||manifest.length>64*1024)throw Error('Invalid Java JAR manifest size');
      if(/(?:^|\r\n|\r|\n)class-path\s*:/i.test(manifest.toString('utf8')))throw Error('Java JAR Manifest Class-Path requires an explicit captured dependency model; hidden paths are not supported');
    }
    at=next;
  }
  if(at!==end)throw Error('Invalid Java JAR central directory length');
}

