// Deliberately bounded literal TOML subset; never evaluate Gradle or rich versions.
export function gradleCatalog(text:string){
 const sections:Record<string,Map<string,unknown>>={versions:new Map(),libraries:new Map(),plugins:new Map(),bundles:new Map()};let section='';
 const literal=(s:string)=>{const m=/^(['"])([^'"\r\n\\]*)\1$/.exec(s.trim());if(!m)throw Error('Gradle catalog requires literal strings');return m[2]!;};
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  const line=raw.replace(/\s+#.*$/,'').trim();if(!line||line.startsWith('#'))continue;
  const head=/^\[(versions|libraries|plugins|bundles)\]$/.exec(line);if(head){section=head[1]!;continue;}
  const entry=/^([\w.-]+)\s*=\s*(.+)$/.exec(line);if(!entry||!sections[section])throw Error('Unsupported Gradle catalog TOML statement');
  const [,key,body]=entry;if(sections[section]!.has(key!))throw Error('Duplicate Gradle catalog key');let v:unknown;
  if(body!.startsWith('{')&&body!.endsWith('}')){
   const fields:Record<string,string>={};for(const part of body!.slice(1,-1).split(',')){
    const field=/^\s*([\w.]+)\s*=\s*(.+)\s*$/.exec(part);if(!field||Object.hasOwn(fields,field[1]!))throw Error('Invalid Gradle catalog inline table');fields[field[1]!]=literal(field[2]!);
   }v=fields;
  }else if(body!.startsWith('[')&&body!.endsWith(']'))v=body!.slice(1,-1).trim()?body!.slice(1,-1).split(',').map(literal):[];
  else v=literal(body!);
  sections[section]!.set(key!,v);
 }
 const accessor=(s:string)=>s.replaceAll('-','.').replaceAll('_','.');
 const table=(section:string,alias:string)=>{
  const matches=[...sections[section]!.entries()].filter(([k])=>accessor(k)===alias);if(matches.length!==1)throw Error('Unknown/ambiguous Gradle catalog alias '+alias);return matches[0]![1];
 };
 const version=(v:Record<string,string>)=>{const result=v.version??sections.versions!.get(v['version.ref']??'');if(typeof result!=='string'||!/^[\w.-]+$/.test(result))throw Error('Gradle catalog needs a fixed version');return result;};
 const library=(alias:string)=>{
  const v=table('libraries',alias);if(typeof v==='string'){if(!/^[\w.-]+:[\w.-]+:[\w.-]+$/.test(v))throw Error('Invalid catalog coordinate');return v;}
  if(!v||Array.isArray(v)||Object.keys(v).some(k=>!['module','group','name','version','version.ref'].includes(k)))throw Error('Unsupported catalog library');
  const f=v as Record<string,string>,module=f.module??`${f.group}:${f.name}`;if(!/^[\w.-]+:[\w.-]+$/.test(module))throw Error('Invalid catalog module');return module+':'+version(f);
 };
 return (script:string)=>{
  let result=script.replace(/alias\(libs\.plugins\.([\w.]+)\)/g,(_,a)=>{
   const v=table('plugins',a);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['id','version','version.ref'].includes(k)))throw Error('Unsupported catalog plugin');
   const f=v as Record<string,string>;if(!/^[\w.-]+$/.test(f.id??''))throw Error('Invalid catalog plugin id');return `id("${f.id}") version "${version(f)}"`;
  });
  result=result.replace(/(implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly)\(libs\.bundles\.([\w.]+)\)/g,(_,config,a)=>{
   const list=table('bundles',a);if(!Array.isArray(list)||list.some(x=>typeof x!=='string'))throw Error('Invalid catalog bundle');return list.map(x=>`${config}("${library(accessor(x))}")`).join('\n');
  });
  return result.replace(/\blibs\.([\w.]+)/g,(_,a)=>JSON.stringify(library(a)));
 };
}
