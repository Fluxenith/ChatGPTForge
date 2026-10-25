import {createHash} from 'node:crypto';

// Serena's find_symbol(include_body=true) returns JSON. Locations vary across
// revisions, so comparisons use the symbol identity and source body, never
// line numbers or incidental editor state. This is a source-text comparison;
// equal hashes do not prove behavioral equivalence.
export type ComparedSymbol={
  key:string;
  relative_path:string;
  name_path:string;
  kind:string;
  body_sha256:string;
};
export type ComparedProject={
  path:string;
  status:'ok'|'error'|'incomplete';
  symbols:ComparedSymbol[];
  error?:string;
};

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const validString=(value:unknown,max=800):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;

export function parseComparedSymbols(raw:string,maxMatches:number):ComparedSymbol[]{
  if(raw.includes('[Serena output truncated; narrow the query]')||/^Matched \d+>max_matches=\d+ symbols/.test(raw)||raw.startsWith('Shortened result:'))
    throw Error('The Serena symbol result was truncated; narrow the symbol pattern or file');
  let value:unknown;
  try{value=JSON.parse(raw);}catch{throw Error('Serena did not return a complete JSON symbol list');}
  if(!Array.isArray(value))throw Error('Serena symbol result is not an array');
  if(value.length>maxMatches)throw Error('Serena returned more symbols than the requested bound');
  const symbols:ComparedSymbol[]=[];
  const seen=new Set<string>();
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Serena returned an invalid symbol');
    const symbol=item as Record<string,unknown>;
    if(!validString(symbol.name_path,300)||!validString(symbol.relative_path)||typeof symbol.body!=='string'||symbol.body.length>20000)
      throw Error('Serena symbol identity, file or source body is missing or too large');
    const kind=String(symbol.kind??'');
    if(!validString(kind,80))throw Error('Serena symbol kind is missing or too long');
    const key=JSON.stringify([symbol.relative_path,symbol.name_path,kind]);
    if(seen.has(key))throw Error('Ambiguous duplicate Serena symbol identity');
    seen.add(key);
    symbols.push({key,relative_path:symbol.relative_path,name_path:symbol.name_path,kind,
      body_sha256:digest(symbol.body.replace(/\r\n?/g,'\n').trim())});
  }
  return symbols.sort((a,b)=>a.key.localeCompare(b.key));
}

export function compareSymbolProjects(projects:ComparedProject[]){
  const complete=projects.every(item=>item.status==='ok');
  const allKeys=[...new Set(projects.flatMap(project=>project.symbols.map(symbol=>symbol.key)))].sort();
  const unchanged:string[]=[];
  const changed:string[]=[];
  const missing:{key:string;present_in:string[];missing_in:string[]}[]=[];
  if(complete)for(const key of allKeys){
    const present=projects.filter(project=>project.symbols.some(symbol=>symbol.key===key));
    if(present.length!==projects.length){
      missing.push({key,present_in:present.map(p=>p.path),missing_in:projects.filter(p=>!present.includes(p)).map(p=>p.path)});
      continue;
    }
    const variants=present.map(p=>p.symbols.find(symbol=>symbol.key===key)!.body_sha256);
    (variants.every(hash=>hash===variants[0])?unchanged:changed).push(key);
  }
  return {
    status:complete?'completed':'incomplete',
    // Empty matches cannot demonstrate equivalent implementations.
    equivalence:!complete?'unknown':!allKeys.length?'no_matches':!changed.length&&!missing.length?'identical_source':'different_source',
    projects:projects.map(project=>({path:project.path,status:project.status,count:project.symbols.length,
      ...('error' in project?{error:project.error}:{}) ,symbols:project.symbols.map(({key,body_sha256})=>({key,body_sha256}))})),
    summary:complete?{symbols:allKeys.length,unchanged,changed,missing}:null,
  };
}
