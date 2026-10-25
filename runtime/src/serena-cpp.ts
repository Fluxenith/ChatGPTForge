import {isAbsolute,relative,resolve,sep} from 'node:path';

// Rebase a real compilation database into the owned snapshot. Shell command
// strings are intentionally refused: compiler arguments must already be split.
export function privateCppCommands(raw:Buffer,root:string,project:string,files:Map<string,Buffer>):string {
 const data=JSON.parse(raw.toString('utf8'));
 if(!Array.isArray(data)||data.length>10000)throw Error('Invalid C++ compilation database');
 const inside=(p:string,base:string)=>{
  const absolute=resolve(base,p),r=relative(root,absolute);
  if(isAbsolute(r)||r==='..'||r.startsWith('..'+sep))throw Error('C++ compile path leaves captured project: '+p);
  return {name:r.split(sep).join('/'),path:resolve(project,r)};
 };
 return JSON.stringify(data.map(e=>{
  if(!e||typeof e.directory!=='string'||typeof e.file!=='string'||!Array.isArray(e.arguments)||!e.arguments.length||e.arguments.some((x:unknown)=>typeof x!=='string'||x.includes('\0')))throw Error('C++ compilation database requires directory, file and split arguments');
  const originalDir=resolve(root,e.directory),dir=inside(e.directory,root),source=inside(e.file,originalDir);
  if(!files.has(source.name))throw Error('C++ compilation database source is not captured: '+source.name);
  let pathNext=false,valueNext=false;
  const args=e.arguments.map((arg:string,i:number)=>{
   if(!i)return arg;
   if(valueNext){valueNext=false;return arg;}
   if(['-x','-target','--target','-D','-U','-std'].includes(arg)){valueNext=true;return arg;}
   if(pathNext){pathNext=false;return inside(arg,originalDir).path;}
   if(['-Xclang','-load','-plugin'].includes(arg))throw Error('C++ compiler forwarding/plugins require an explicit supported model');
   if(['-I','-isystem','-iquote','-include','-include-pch','-imacros','-idirafter','-o','--sysroot','-isysroot','-resource-dir','/I','/FI','/Fo'].includes(arg)){pathNext=true;return arg;}
   const attached=/^(-I|-isystem|-iquote|-include|-imacros|--sysroot=|-resource-dir=|\/I|\/FI|\/Fo)(.+)$/.exec(arg);
   if(attached)return attached[1]+inside(attached[2]!,originalDir).path;
   if(arg.startsWith('@'))throw Error('C++ response files require explicit expanded arguments');
   if(arg.split('=').slice(1).some(p=>isAbsolute(p)))throw Error('Unsupported C++ option contains an absolute path');
   if(/^\/(?:c|nologo|EH\w+|std:[\w+]+|[DU].*|M[DT]d?|W\d|O\w+|Z\w+|permissive-?|utf-8)$/i.test(arg))return arg;
   if(isAbsolute(arg)||!arg.startsWith('-')&&!arg.startsWith('/'))return inside(arg,originalDir).path;
   return arg;
  });
  if(pathNext||valueNext)throw Error('C++ compiler argument is missing');
  return {directory:dir.path,file:source.path,arguments:args,...(typeof e.output==='string'?{output:inside(e.output,originalDir).path}:{})};
 }));
}
