// Ranked hints are deliberately conservative: the caller must select a target
// and the writer validates that target against a fresh full memory scan.
export type MemoryTargetHint={name:string;score:number;reason:'version_variant'|'same_basename'|'likely_typo'|'related_name'};

const withoutVersion=(name:string)=>name.toLowerCase().replace(/_(?:v\d+|old|new|legacy|bak)$/,'');
const basename=(name:string)=>name.split('/').at(-1)!;

// Bounded edit distance: long/very different names are not compared character
// by character. A typo needs at most two edits, not a generic fuzzy match.
function typoDistance(a:string,b:string){
  if(a.length>80||b.length>80||Math.abs(a.length-b.length)>2)return 3;
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const current=[i];let smallest=i;
    for(let j=1;j<=b.length;j++){
      const distance=Math.min(previous[j]!+1,current[j-1]!+1,previous[j-1]!+(a[i-1]===b[j-1]?0:1));
      current.push(distance);smallest=Math.min(smallest,distance);
    }
    if(smallest>2)return 3;
    previous=current;
  }
  return previous[b.length]!;
}

function scoreTarget(missing:string,candidate:string):Omit<MemoryTargetHint,'name'>|null{
  const old=withoutVersion(missing),next=withoutVersion(candidate);
  if(old===next)return {score:1,reason:'version_variant'};
  const a=basename(old),b=basename(next);
  if(a===b)return {score:missing.includes('/')&&candidate.includes('/')?0.84:0.96,reason:'same_basename'};
  if(Math.min(a.length,b.length)<4)return null;
  const distance=typoDistance(a,b);
  if(distance===1||distance===2){
    const sameTopic=old.slice(0,-a.length)===next.slice(0,-b.length);
    return {score:(sameTopic?0.89:0.75)-(distance-1)*0.13,reason:'likely_typo'};
  }
  const short=Math.min(a.length,b.length),long=Math.max(a.length,b.length);
  if(short>=5&&(a.includes(b)||b.includes(a))&&short/long>=0.55)
    return {score:Math.round((0.55+short/long*0.23)*100)/100,reason:'related_name'};
  return null;
}

export function suggestMemoryTargets(missing:string,existing:string[],limit=3):MemoryTargetHint[]{
  return existing.flatMap(name=>{
    const ranked=scoreTarget(missing,name);
    return ranked?[{name,...ranked}]:[];
  }).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'en')).slice(0,limit);
}
