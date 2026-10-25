// Turn Serena's grouped LSP diagnostics into a bounded, location-independent
// comparison between an approved baseline project and candidate projects.
// Diagnostic ranges are useful for navigation but are not stable identities:
// inserting a line above a warning must not report a new warning.

export type DiagnosticLocation={line:number;character:number};
export type DiagnosticRecord={
  relative_path:string;
  severity:string;
  name_path:string;
  message:string;
  code?:string;
  source?:string;
  location:DiagnosticLocation;
  count:number;
};
export type ProjectDiagnostics={
  path:string;
  status:'ok'|'incomplete'|'error';
  diagnostics:DiagnosticRecord[];
  error?:string;
};

const LIMIT=120;
const DIAGNOSTICS_TOO_LONG=/\[Serena output truncated; narrow the query\]|^The answer is too long \(|^Shortened result:/;
const isObject=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const position=(v:unknown):v is DiagnosticLocation=>isObject(v)&&Number.isSafeInteger(v.line)&&Number(v.line)>=0
  &&Number.isSafeInteger(v.character)&&Number(v.character)>=0;
const severities=new Set(['Error','Warning','Information','Hint','Unknown']);
const validSeverity=(s:string)=>severities.has(s)||/^Severity_\d{1,4}$/.test(s);
const pathIsSafe=(path:string)=>safeText(path,800)&&!path.startsWith('/')&&!path.startsWith('\\')
  &&!/^[a-z]:/i.test(path)&&!path.includes('\0')
  &&path.replaceAll('\\','/').split('/').every(segment=>!!segment&&segment!=='.'&&segment!=='..');
const canonicalCode=(v:unknown):string|undefined=>{
  if(v===undefined||v===null)return undefined;
  if(typeof v==='string'||typeof v==='number'&&Number.isFinite(v)){
    const code=String(v);
    if(code.length>180)throw Error('Serena diagnostic code exceeds the comparison limit');
    return code;
  }
  if(isObject(v)&&safeText(v.value,180)&&Object.keys(v).every(k=>['value','target'].includes(k))){
    if(v.target!==undefined&&!safeText(v.target,300))throw Error('Invalid Serena diagnostic code target');
    return JSON.stringify({value:v.value,...(v.target?{target:v.target}:{})});
  }
  throw Error('Serena returned an invalid diagnostic code');
};
const identity=(d:DiagnosticRecord)=>JSON.stringify([
  d.relative_path,d.severity,d.name_path,d.message,d.code??null,d.source??null,
]);

export function parseGroupedDiagnostics(raw:string):DiagnosticRecord[]{
  if(DIAGNOSTICS_TOO_LONG.test(raw))throw Error('Serena diagnostic output was truncated');
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{throw Error('Serena did not return complete grouped diagnostics JSON');}
  if(isObject(parsed)&&parsed.status==='indexing')throw Error('Serena diagnostics are still indexing; retry the same query');
  if(!isObject(parsed))throw Error('Serena diagnostics must be grouped by file');
  const records=new Map<string,DiagnosticRecord>();
  let total=0;
  for(const [file,groups] of Object.entries(parsed)){
    if(!pathIsSafe(file)||!isObject(groups))throw Error('Serena diagnostic file path or group is invalid');
    for(const [severity,owners] of Object.entries(groups)){
      if(!validSeverity(severity)||!isObject(owners))throw Error('Serena diagnostic severity group is invalid');
      for(const [name_path,list] of Object.entries(owners)){
        if(!safeText(name_path,300)||!Array.isArray(list))throw Error('Serena diagnostic owner group is invalid');
        for(const item of list){
          if(++total>LIMIT)throw Error(`Serena diagnostic result exceeds ${LIMIT} items; narrow the symbol or file`);
          if(!isObject(item)||!safeText(item.message,2000)||!isObject(item.range)
            ||!position(item.range.start)||!position(item.range.end)
            ||item.source!==undefined&&(!safeText(item.source,180))){
            throw Error('Serena returned an invalid diagnostic message, source or range');
          }
          const record:DiagnosticRecord={relative_path:file.replaceAll('\\','/'),severity,name_path,
            message:item.message.replace(/\r\n?/g,'\n').trim(),
            ...(item.code===undefined?{}:{code:canonicalCode(item.code)}),
            ...(item.source===undefined?{}:{source:item.source as string}),
            location:{line:item.range.start.line as number,character:item.range.start.character as number},count:1};
          if(!record.message)throw Error('Serena diagnostic message is empty');
          const key=identity(record),previous=records.get(key);
          if(previous){previous.count++;if(record.location.line<previous.location.line)previous.location=record.location;}
          else records.set(key,record);
        }
      }
    }
  }
  return [...records.values()].sort((a,b)=>identity(a).localeCompare(identity(b)));
}

type Delta={introduced:DiagnosticRecord[];resolved:DiagnosticRecord[];unchanged:DiagnosticRecord[]};
const count=(records:DiagnosticRecord[])=>records.reduce((sum,r)=>sum+r.count,0);

export function compareDiagnosticProjects(projects:ProjectDiagnostics[],max_details=20){
  if(!Number.isInteger(max_details)||max_details<1||max_details>50)throw Error('Detail limit must be 1–50');
  if(projects.length<2||projects.length>3)throw Error('Compare 2–3 Serena projects');
  const base=projects[0]!;
  const comparisons=projects.slice(1).map(candidate=>{
    if(base.status!=='ok'||candidate.status!=='ok')return {
      path:candidate.path,status:'incomplete' as const,counts:null,introduced:[],resolved:[],unchanged:[],omitted:null,
    };
    const baseline=new Map(base.diagnostics.map(record=>[identity(record),record]));
    const current=new Map(candidate.diagnostics.map(record=>[identity(record),record]));
    const delta:Delta={introduced:[],resolved:[],unchanged:[]};
    for(const key of [...new Set([...baseline.keys(),...current.keys()])].sort()){
      const old=baseline.get(key),now=current.get(key);
      const common=Math.min(old?.count??0,now?.count??0);
      if(common&&now)delta.unchanged.push({...now,count:common});
      if((now?.count??0)>common&&now)delta.introduced.push({...now,count:now.count-common});
      if((old?.count??0)>common&&old)delta.resolved.push({...old,count:old.count-common});
    }
    return {
      path:candidate.path,status:'completed' as const,
      counts:{introduced:count(delta.introduced),resolved:count(delta.resolved),unchanged:count(delta.unchanged)},
      introduced:delta.introduced.slice(0,max_details),resolved:delta.resolved.slice(0,max_details),
      unchanged:delta.unchanged.slice(0,max_details),
      omitted:{introduced:Math.max(0,delta.introduced.length-max_details),
        resolved:Math.max(0,delta.resolved.length-max_details),unchanged:Math.max(0,delta.unchanged.length-max_details)},
    };
  });
  return {
    status:projects.every(p=>p.status==='ok')?'completed' as const:'incomplete' as const,
    baseline:base.path,
    projects:projects.map(p=>({path:p.path,status:p.status,count:count(p.diagnostics),
      ...(p.error?{error:p.error}:{})})),
    comparisons,
    interpretation:'Compare LSP diagnostics by file, owning symbol, severity, code, source and normalized message. Ignore line/column movement; repeated occurrences are counted. Results reflect the selected symbol or file and are not project-wide build verification.',
  };
}
