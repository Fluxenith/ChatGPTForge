import type {Frame,Page} from 'playwright-core';

// A bounded deterministic DOM diagnostic. These checks identify actionable
// accessibility candidates; no automated scan can certify WCAG compliance.
type Finding={rule:string;impact:'serious'|'moderate'|'minor';wcag:string;element:string;recommendation:string};
type FrameResult={nodes:number;truncated:boolean;findings:number;by_rule:Record<string,number>;examples:Finding[]};
const MAX_FRAMES=32,MAX_NODES=2000,MAX_EXAMPLES_PER_FRAME=100;
const description='Automated DOM checks cover only specified rules; a passing result is not a WCAG compliance certification. Accessible names, visual contrast, keyboard operation and assistive-technology behavior require additional review.';

function displayUrl(value:string){
  try{
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol)?url.origin+url.pathname.slice(0,240):'[inline-document]';
  }catch{return '[inline-document]';}
}

export async function auditAccessibility(
  page:Page, frameAllowed:(frame:Frame)=>boolean, maxIssues=30,
  selected?:Frame, frameVersions?:WeakMap<Frame,string>, signal?:AbortSignal,
){
  if(!Number.isInteger(maxIssues)||maxIssues<1||maxIssues>100)throw Error('Accessibility max_issues must be 1–100');
  const allFrames=page.frames(),targets=selected?[selected]:allFrames.slice(0,MAX_FRAMES);
  if(selected&&(!allFrames.includes(selected)||!frameAllowed(selected)))throw Error('Accessibility frame is no longer authorized');
  const origins=new Map<Frame,{url:string;version:string|undefined}>();
  for(const frame of targets)origins.set(frame,{url:frame.url(),version:frameVersions?.get(frame)});
  const changed=(frame:Frame)=>{
    const before=origins.get(frame)!;
    if(signal?.aborted||page.isClosed()||frame.isDetached()||frame.page()!==page||
       before.url!==frame.url()||frameVersions&&before.version!==frameVersions.get(frame)||
       !frameAllowed(frame))throw Error('Accessibility frame navigated, lost authorization or was cancelled during scan');
  };
  const issues:({frame_index:number;url:string}&Finding)[]=[];
  const counts:Record<string,number>={};
  let nodesScanned=0,findings=0,blocked=0,truncatedNodes=false,scanned=0;
  const frames:{index:number;url:string;status:string;nodes:number;findings:number;truncated:boolean}[]=[];
  for(let i=0;i<targets.length;i++){
    const frame=targets[i]!;
    if(signal?.aborted)throw Error('Accessibility audit cancelled');
    if(!frameAllowed(frame)){blocked++;frames.push({index:i,url:'[blocked-origin]',status:'blocked',nodes:0,findings:0,truncated:false});continue;}
    changed(frame);
    // Only fixed audit code runs in the page; no user input is evaluated.
    const scanFrame=({limit,examplesLimit}:{limit:number;examplesLimit:number}):FrameResult=>{
      type Impact='serious'|'moderate'|'minor';
      type Row={rule:string;impact:Impact;wcag:string;element:string;recommendation:string};
      const counts:Record<string,number>={},examples:Row[]=[];
      let findings=0,nodes=0,truncated=false;
      const locate=(node:Element)=>{
        const parts:string[]=[];let current:Element|null=node;
        while(current&&parts.length<7){
          const tag=current.tagName.toLowerCase();
          let nth=1;
          for(let sibling=current.previousElementSibling;sibling;sibling=sibling.previousElementSibling)
            if(sibling.tagName===current.tagName)nth++;
          parts.unshift(tag+':nth-of-type('+nth+')');
          current=current.parentElement;
        }
        return parts.join(' > ').slice(0,240);
      };
      const issue=(rule:string,impact:Impact,wcag:string,node:Element,recommendation:string)=>{
        findings++;counts[rule]=(counts[rule]??0)+1;
        if(examples.length<examplesLimit)examples.push({rule,impact,wcag,element:locate(node),recommendation});
      };
      const nameFromAria=(node:Element)=>{
        if(node.getAttribute('aria-label')?.trim())return true;
        const refs=node.getAttribute('aria-labelledby')?.trim().split(/\s+/)??[];
        if(refs.some(ref=>document.getElementById(ref)?.textContent?.trim()))return true;
        return !!node.getAttribute('title')?.trim();
      };
      const nameFromContent=(node:Element)=>{
        if(nameFromAria(node))return true;
        if(node.textContent?.trim())return true;
        if(node.querySelector('img[alt]:not([alt=""])'))return true;
        return false;
      };
      const visible=(node:Element)=>{
        if(node.closest('[hidden],[inert]'))return false;
        const style=getComputedStyle(node);
        return style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&node.getClientRects().length>0;
      };
      if(!document.documentElement.getAttribute('lang')?.trim())
        issue('document-lang','serious','3.1.1',document.documentElement,'Declare the primary page language on the html element.');
      if(!document.title.trim())
        issue('document-title','serious','2.4.2',document.documentElement,'Provide a descriptive document title.');
      const seenIds=new Set<string>();
      let priorHeading=0;
      const walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_ELEMENT);
      let node:Node|null;
      while((node=walker.nextNode())){
        nodes++;if(nodes>limit){truncated=true;nodes=limit;break;}
        const el=node as Element,tag=el.tagName.toLowerCase(),id=el.getAttribute('id');
        if(id){
          if(seenIds.has(id))issue('duplicate-id','moderate','4.1.2',el,'Assign unique IDs so labels and relationships resolve to one element.');
          else seenIds.add(id);
        }
        for(const attr of ['aria-labelledby','aria-describedby','aria-controls','aria-owns']){
          const tokens=el.getAttribute(attr)?.trim().split(/\s+/).filter(Boolean)??[];
          if(tokens.some(token=>!document.getElementById(token)))
            issue('broken-aria-reference','serious','4.1.2',el,'Make every ARIA ID reference resolve within this document.');
        }
        if(!visible(el))continue;
        if(tag==='img'&&!el.hasAttribute('alt')&&!nameFromAria(el))
          issue('image-alt','serious','1.1.1',el,'Provide alternative text, or alt="" for a decorative image.');
        if(tag==='iframe'&&!nameFromAria(el))
          issue('frame-title','serious','2.4.1',el,'Give each iframe a descriptive title or accessible name.');
        if(tag==='button'||(tag==='input'&&['button','submit','reset'].includes((el as HTMLInputElement).type))){
          const input=el as HTMLInputElement;
          if(!nameFromContent(el)&&!(tag==='input'&&input.value.trim()))
            issue('button-name','serious','4.1.2',el,'Give the button a nonempty accessible name.');
        }
        if(tag==='a'&&el.hasAttribute('href')&&!nameFromContent(el))
          issue('link-name','serious','2.4.4',el,'Give the link an accessible name that describes its purpose.');
        if(['input','select','textarea'].includes(tag)){
          const input=el as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;
          const type=tag==='input'?(input as HTMLInputElement).type:'';
          if(type==='image'&&!el.hasAttribute('alt')&&!nameFromAria(el))
            issue('image-button-name','serious','1.1.1',el,'Give the image submit button an accessible name.');
          else if(!['hidden','button','submit','reset','image'].includes(type)&&
            !nameFromAria(el)&&![...(input.labels??[])].some(label=>!!label.textContent?.trim()))
            issue('form-label','serious','3.3.2',el,'Associate a visible or accessible name with this field; placeholder alone is insufficient.');
        }
        if(/^h[1-6]$/.test(tag)){
          const level=Number(tag[1]);
          if(priorHeading&&level>priorHeading+1)
            issue('heading-order','minor','best-practice',el,'Keep heading levels sequential for clear document structure.');
          priorHeading=level;
        }
        if(el.matches('button,a[href],input:not([type="hidden"]),select,textarea,[tabindex]')&&
          (el as HTMLElement).tabIndex>=0&&el.closest('[aria-hidden="true"]'))
          issue('focusable-aria-hidden','serious','4.1.2',el,'Do not hide keyboard-focusable content from assistive technology.');
      }
      return {nodes,truncated,findings,by_rule:counts,examples};
    };
    // tsx/esbuild decorates nested functions with __name. Playwright sends
    // only the function source into the page, so define that harmless helper
    // in the evaluated scope. The source and numeric bounds are fixed locally.
    const source=`(() => { const __name = fn => fn; return (${scanFrame.toString()})({limit:${MAX_NODES},examplesLimit:${MAX_EXAMPLES_PER_FRAME}}); })()`;
    const report=await frame.evaluate<FrameResult>(source);
    changed(frame);
    scanned++;nodesScanned+=report.nodes;findings+=report.findings;
    truncatedNodes||=report.truncated;
    for(const [rule,count] of Object.entries(report.by_rule))counts[rule]=(counts[rule]??0)+count;
    const safe=displayUrl(frame.url());
    for(const candidate of report.examples){
      if(issues.length>=maxIssues)break;
      issues.push({frame_index:i,url:safe,...candidate});
    }
    frames.push({index:i,url:safe,status:report.truncated?'truncated':'scanned',nodes:report.nodes,findings:report.findings,truncated:report.truncated});
  }
  // Revalidate every frame before publishing evidence, including those scanned
  // early while an unrelated frame was still being inspected.
  for(const frame of targets)if(origins.has(frame)&&frameAllowed(frame))changed(frame);
  const framesTruncated=!selected&&allFrames.length>MAX_FRAMES;
  const completeEvidence=!framesTruncated&&!truncatedNodes&&!blocked;
  return {state:'completed',scope:selected?'frame':'current_tab',url:displayUrl(page.url()),
    passed:findings===0&&completeEvidence,complete_evidence:completeEvidence,
    frames_scanned:scanned,frames_blocked:blocked,frames_truncated:framesTruncated,
    nodes_scanned:nodesScanned,nodes_truncated:truncatedNodes,
    findings_total:findings,by_rule:counts,issues,issues_omitted:Math.max(0,findings-issues.length),
    frames,note:description};
}
