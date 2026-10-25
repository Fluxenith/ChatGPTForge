// Search the owner's already-approved, LIVE MCP tool catalogs. Manifest text
// helps rank suggestions; it can never authorize or invoke a provider tool.
export type GatewayRouteKind='read'|'write'|'any';
export type GatewayRouteTool={
  name:string;
  classification:'read'|'write';
  description:string;
  input_schema:unknown;
};
export type GatewayRouteServer={
  id:string;
  status:'available'|'unavailable';
  manifest_status:'current'|'stale'|'invalid'|'missing';
  manifest?:{
    role:string;
    best_use_cases:string[];
    poor_use_cases:string[];
    goal_oriented_patterns:{goal:string;tool:string}[];
    performance_cost_notes:string[];
  };
  onboarding?:{
    status:string;
    verification?:string;
    verified_read_tools?:string[];
    write_gate?:{ready:boolean};
  };
  write_gate:'off'|'verified';
  tools:GatewayRouteTool[];
};

const allowed=(v:string)=>v.normalize('NFKC').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase();
const stopWords=new Set(['the','and','for','with','from','this','that','tool','mcp','use','using','into','when',
  'a','an','to','in','on','of','is','are','by','my','your','server','please','get','call','http','json','api']);
// Keep routing local and deterministic. These bounded aliases recognize common
// developer goals written in English or Chinese without invoking a model,
// trusting provider instructions, or claiming general-purpose translation.
const englishAliases:Record<string,string>={
  search:'search',find:'search',locate:'search',lookup:'search',query:'search',discover:'search',
  docs:'document',doc:'document',documents:'document',documentation:'document',manual:'document',
  repo:'repository',repos:'repository',repositories:'repository',
  files:'file',filenames:'file',
  read:'read',fetch:'read',retrieve:'read',open:'read',
  edit:'edit',modify:'edit',change:'edit',update:'edit',
  create:'create',add:'create',new:'create',
  delete:'delete',remove:'delete',
  tests:'test',testing:'test',
  errors:'error',issues:'issue',
  diagnostics:'diagnostic',diagnose:'diagnostic',
  symbols:'symbol',definitions:'definition',
  screenshots:'screenshot',capture:'screenshot',
  memories:'memory',
};
const chineseAliases:[RegExp,string][]=[
  [/搜尋|搜索|搜寻|查詢|查询|查找|檢索|检索|尋找|寻找|找出|找/,'search'],
  [/專案|项目|項目|工程/,'project'],
  [/文件|文檔|文档|說明|说明|手冊|手册/,'document'],
  [/檔案|档案|文件/,'file'],
  [/程式碼|程序碼|源碼|源码|原始碼|代码|程式|程序/,'code'],
  [/儲存庫|存储库|倉庫|仓库/,'repository'],
  [/讀取|读取|閱讀|阅读|查看|獲取|获取|打開|打开/,'read'],
  [/寫入|写入|儲存|保存/,'write'],
  [/編輯|编辑|修改|更新/,'edit'],
  [/建立|新增|新建|創建|创建/,'create'],
  [/刪除|删除|移除/,'delete'],
  [/測試|测试/,'test'],
  [/錯誤|错误|異常|异常/,'error'],
  [/診斷|诊断/,'diagnostic'],
  [/符號|符号/,'symbol'],
  [/定義|定义/,'definition'],
  [/截圖|截图|螢幕擷取|屏幕截图/,'screenshot'],
  [/記憶|记忆/,'memory'],
  [/瀏覽器|浏览器/,'browser'],
  [/資料庫|数据库/,'database'],
];
const words=(v:string)=>{
  const result=new Set<string>();
  for(const token of (allowed(v).match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)??[]).slice(0,80)){
    if(token.length>=3&&!stopWords.has(token))result.add(englishAliases[token]??token);
    if(/[\p{Script=Han}]/u.test(token))for(const [pattern,alias] of chineseAliases){
      if(pattern.test(token))result.add(alias);
    }
  }
  return result;
};
const quality=(a:string,b:string)=>{
  const left=allowed(a).trim(),right=allowed(b).trim();
  if(!left||!right)return 0;
  if(left===right)return 100;
  if(left.length>5&&right.length>5&&(left.includes(right)||right.includes(left)))return 75;
  const tokenA=words(left),tokenB=words(right);
  if(!tokenA.size||!tokenB.size)return 0;
  const common=[...tokenA].filter(t=>tokenB.has(t)).length;
  return common?Math.round(60*common/Math.max(tokenA.size,tokenB.size)):0;
};
const termOverlap=(goal:string,text:string)=>{
  const tokens=words(goal),target=words(text);
  return [...tokens].filter(w=>target.has(w)).length;
};

export function rankGatewayRoutes(servers:GatewayRouteServer[],goal:string,kind:GatewayRouteKind='read',max_results=5){
  if(!goal.trim()||goal.length>400)throw Error('Gateway routing goal must contain 1–400 characters');
  if(!['read','write','any'].includes(kind))throw Error('Gateway routing kind must be read, write or any');
  if(!Number.isInteger(max_results)||max_results<1||max_results>10)throw Error('Gateway routing returns at most 10 candidates');
  const candidates:{server:string;tool:string;classification:'read'|'write';route:string;
    score:number;matched_by:string[];verification:string;execution_status:string;requires_lease:boolean;
    parameters:string[];required_parameters:string[];notes:string[];manifest_status:string}[]=[];
  for(const server of servers){
    if(server.status!=='available')continue;
    for(const tool of server.tools){
      if(kind!=='any'&&kind!==tool.classification)continue;
      const pattern=server.manifest_status==='current'?server.manifest?.goal_oriented_patterns
        .filter(p=>p.tool===tool.name)??[]:[];
      const patternWeight=Math.max(0,...pattern.map(p=>quality(goal,p.goal)));
      const best=server.manifest_status==='current'
        ?Math.max(0,...(server.manifest?.best_use_cases??[]).map(p=>quality(goal,p))):0;
      const poor=server.manifest_status==='current'
        ?Math.max(0,...(server.manifest?.poor_use_cases??[]).map(p=>quality(goal,p))):0;
      const nameQuality=quality(goal,tool.name.replaceAll('_',' '));
      const direct=termOverlap(goal,tool.name.replaceAll('_',' '));
      // Provider descriptions are lower-trust and contribute only weak
      // lexical evidence; their instructions are never followed or surfaced.
      const description=termOverlap(goal,tool.description.slice(0,500));
      const score=Math.round(patternWeight*1.8+best*.55+nameQuality*.85+
        Math.min(direct,4)*8+Math.min(description,4)*3-poor*1.5);
      if(score<15)continue;
      const matched_by=[...(patternWeight>=20?['manifest_pattern']:[]),...(best>=20?['best_use_case']:[]),
        ...(nameQuality>=20||direct?['tool_name']:[]),...(description?['tool_description']:[])];
      const evidence=server.onboarding;
      const verifiedRead=tool.classification==='read'&&evidence?.status==='success'
        &&evidence.verified_read_tools?.includes(tool.name)===true;
      const blockedWrite=tool.classification==='write'&&server.write_gate==='verified'
        &&evidence?.write_gate?.ready!==true;
      const verification=verifiedRead?'content_verified':tool.classification==='read'?'not_content_verified':'not_applicable_to_write';
      const execution_status=blockedWrite?'write_gate_not_ready':tool.classification==='write'?'approved_write_requires_lease':
        verifiedRead?'approved_read_verified':'approved_read_unverified';
      const schema=tool.input_schema as {properties?:Record<string,unknown>;required?:unknown}|null;
      const parameters=schema?.properties&&typeof schema.properties==='object'
        ?Object.keys(schema.properties).slice(0,32).map(value=>value.slice(0,128)):[];
      const required_parameters=Array.isArray(schema?.required)
        ?schema.required.filter((x):x is string=>typeof x==='string').slice(0,32).map(value=>value.slice(0,128)):[];
      candidates.push({server:server.id,tool:tool.name,classification:tool.classification,
        route:tool.classification==='read'?'mcp_gateway_read':'mcp_gateway_write',
        score,matched_by,verification,execution_status,requires_lease:tool.classification==='write',
        parameters,required_parameters,manifest_status:server.manifest_status,
        notes:[...(blockedWrite?['Verified write admission needs fresh content-asserting read probes.']:[]),
          ...(server.manifest_status==='current'?(server.manifest?.performance_cost_notes??[]).slice(0,2):[])]});
    }
  }
  const executionRank=(status:string)=>status==='approved_read_verified'?0:status==='approved_read_unverified'?1:
    status==='approved_write_requires_lease'?2:3;
  candidates.sort((a,b)=>b.score-a.score||executionRank(a.execution_status)-executionRank(b.execution_status)||
    a.server.localeCompare(b.server)||a.tool.localeCompare(b.tool));
  return {
    kind,status:candidates.length?'matches':'no_matches',
    results:candidates.slice(0,max_results),matches:candidates.length,
    scanned_servers:servers.length,available_servers:servers.filter(s=>s.status==='available').length,
    omitted:Math.max(0,candidates.length-max_results),
    note:'Lexical recommendations from owner-approved live MCP catalogs and optional saved manifests. They never invoke a tool or grant permission. Review current tool schema, read verification and write lease/gate before calling. Scores are ranking hints, not measured reliability or safety.',
  };
}
