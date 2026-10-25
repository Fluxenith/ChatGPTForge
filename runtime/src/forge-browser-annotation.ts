import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,unlinkSync,writeFileSync} from 'node:fs';
import {extname} from 'node:path';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright-core';
import {projectFilePath} from './forge-browser-files.js';
import {annotationReviewHtml} from './forge-browser-annotation-ui.js';

export const ANNOTATION_ACTIONS=['annotate_begin','annotate_status','annotate_capture','annotate_export','annotate_cancel'] as const;
export const isAnnotationAction=(value:string)=> (ANNOTATION_ACTIONS as readonly string[]).includes(value);
const MAX_IMAGES=8,MAX_CAPTURES=64,MAX_PNG=12*1024*1024,MAX_MARKS=64;
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export interface AnnotationSource {
  png:Buffer;
  aria:string;
  title:string;
  url:string;
  tab_id:string;
}
type Coordinate={x:number;y:number};
type Mark={kind:'rect'|'arrow'|'pen'|'text';x:number;y:number;width:number;height:number;text:string;points:Coordinate[]};
type Submitted={frame_ids:string[];annotations:{id:string;annotations:Mark[]}[];feedback:string};
interface Shot extends AnnotationSource {id:string;width:number;height:number;created_at:string}
interface Review {
  browser:Browser;
  context:BrowserContext;
  page:Page;
  shots:Map<string,Shot>;
  state:'editing'|'submitted';
  submission?:Submitted;
  capture:()=>Promise<AnnotationSource>;
  capturing:boolean;
  captureCount:number;
}
interface Destination {relative:string;absolute:string}
export interface AnnotationExportPlan {manifest:Destination;files:{png:Destination;yaml:Destination}[]}

function verifyPng(value:Buffer){
  if(value.length<24||value.length>MAX_PNG||!value.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||value.toString('ascii',12,16)!=='IHDR')
    throw Error('Screenshot must be a PNG no larger than 12 MiB');
  const width=value.readUInt32BE(16),height=value.readUInt32BE(20);
  if(!width||!height||width>3840||height>2160)throw Error('Screenshot dimensions exceed review limits');
  return {width,height};
}
function coordinate(value:unknown,width:number,height:number){
  if(!value||typeof value!=='object')throw Error('Annotation point missing');
  const p=value as Coordinate;
  if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>width||p.y<0||p.y>height)throw Error('Annotation point outside screenshot');
  return {x:p.x,y:p.y};
}
function validMarks(raw:unknown,shot:Shot):Mark[]{
  if(!Array.isArray(raw)||raw.length>MAX_MARKS)throw Error('Too many screenshot annotations');
  return raw.map((item:unknown)=>{
    if(!item||typeof item!=='object')throw Error('Invalid screenshot annotation');
    const a=item as Mark;
    if(!['rect','arrow','pen','text'].includes(a.kind)||typeof a.text!=='string'||a.text.length>300||typeof a.width!=='number'||typeof a.height!=='number'||!Number.isFinite(a.width)||!Number.isFinite(a.height))throw Error('Invalid screenshot annotation values');
    const start=coordinate({x:a.x,y:a.y},shot.width,shot.height);
    coordinate({x:a.x+a.width,y:a.y+a.height},shot.width,shot.height);
    if(a.kind==='pen'&&(!Array.isArray(a.points)||a.points.length>256)||
      a.kind!=='pen'&&a.points!==undefined&&(!Array.isArray(a.points)||a.points.length!==0))throw Error('Invalid annotation stroke');
    const points=a.kind==='pen'?a.points.map(p=>coordinate(p,shot.width,shot.height)):[];
    if(a.kind==='pen'&&points.length<2)throw Error('Pen requires a stroke');
    if(a.kind==='text'&&!a.text.trim())throw Error('Text annotation requires a label');
    return {kind:a.kind,...start,width:a.width,height:a.height,text:a.text,points};
  });
}

/** Captures into an isolated review-only browser. Never navigates the source. */
export class ForgeBrowserAnnotation {
  private reviews=new WeakMap<BrowserContext,Review>();
  constructor(private readonly headless=false){}

  has(context:BrowserContext){return this.reviews.has(context);}
  private get(context:BrowserContext){
    const review=this.reviews.get(context);
    if(!review||review.page.isClosed())throw Error('Start an annotation review before using this action');
    return review;
  }
  canBegin(context:BrowserContext){
    if(this.has(context))throw Error('An annotation review is already open');
  }
  private async liveState(review:Review){
    const live=await review.page.evaluate(()=>{
      const bridge=window as unknown as {__forgeState:()=>unknown};return bridge.__forgeState();
    }) as {frame_ids?:unknown;annotations?:unknown;feedback?:unknown};
    const ids=live.frame_ids;
    if(!Array.isArray(ids)||ids.length>MAX_IMAGES||
      ids.some(id=>typeof id!=='string'||!review.shots.has(id))||new Set(ids).size!==ids.length)
      throw Error('Review screenshot selection is invalid');
    if(!Array.isArray(live.annotations)||live.annotations.length!==ids.length||
      live.annotations.some((entry,index)=>!entry||entry.id!==ids[index]||!Array.isArray(entry.annotations)||entry.annotations.length>MAX_MARKS))
      throw Error('Review annotations are invalid');
    return live as Submitted;
  }
  async canCapture(context:BrowserContext){
    const review=this.get(context);
    if(review.state!=='editing')throw Error('Reopen the submitted annotation before capturing another screenshot');
    if(review.capturing)throw Error('Another screenshot is being captured');
    if(review.captureCount>=MAX_CAPTURES)throw Error('Review capture limit reached');
    const live=await this.liveState(review);
    if(live.frame_ids.length>=MAX_IMAGES)throw Error('Review already contains 8 screenshots');
  }
  async status(context:BrowserContext){
    const review=this.reviews.get(context);
    if(!review||review.page.isClosed())return {state:'absent',review_open:false};
    const live=await this.liveState(review);
    const count=review.state==='submitted'?review.submission!.annotations.reduce((sum,item)=>sum+item.annotations.length,0):
      live.annotations.reduce((sum,item)=>sum+item.annotations.length,0);
    return {state:review.state,review_open:true,frames:live.frame_ids.length,
      annotations:count,
      submitted:review.state==='submitted',capture_limit:MAX_IMAGES,feedback:review.state==='submitted'?review.submission?.feedback:undefined};
  }

  private validateSubmission(review:Review,value:unknown):Submitted{
    if(!value||typeof value!=='object')throw Error('Invalid annotation submission');
    const v=value as Submitted;
    if(!Array.isArray(v.frame_ids)||v.frame_ids.length<1||v.frame_ids.length>MAX_IMAGES||new Set(v.frame_ids).size!==v.frame_ids.length||!Array.isArray(v.annotations)||v.annotations.length!==v.frame_ids.length)
      throw Error('Submit 1–8 distinct screenshots');
    if(typeof v.feedback!=='string'||v.feedback.length>3000)throw Error('Review feedback exceeds 3000 characters');
    const annotations=v.frame_ids.map((id,index)=>{
      const shot=review.shots.get(id),entry=v.annotations[index];
      if(!shot||!entry||entry.id!==id)throw Error('Annotation refers to an unknown screenshot');
      return {id,annotations:validMarks(entry.annotations,shot)};
    });
    return {frame_ids:[...v.frame_ids],annotations,feedback:v.feedback};
  }

  async begin(context:BrowserContext,capture:()=>Promise<AnnotationSource>){
    this.canBegin(context);
    const browser=await chromium.launch({channel:'chrome',headless:this.headless,chromiumSandbox:true,
      ...(process.platform==='win32'?{args:['--disable-gpu']}:{} )});
    try{
      const ownContext=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:false,serviceWorkers:'block'});
      await ownContext.route('**/*',route=>route.abort('blockedbyclient'));
      const page=await ownContext.newPage();
      ownContext.on('page',newPage=>{if(newPage!==page)void newPage.close().catch(()=>{});});
      const review:Review={browser,context:ownContext,page,shots:new Map(),state:'editing',capture,capturing:false,captureCount:0};
      await page.exposeBinding('__forgeCapture',async({page:callingPage})=>{
        if(callingPage!==page)return {ok:false,error:'Unexpected review page'};
        try{await this.captureShot(context);return {ok:true};}catch(error){return {ok:false,error:errorText(error)};}
      });
      await page.exposeBinding('__forgeTransition',async({page:callingPage},message:unknown)=>{
        if(callingPage!==page||!message||typeof message!=='object')return {ok:false,error:'Unexpected review transition'};
        const change=message as {state:string;value?:unknown};
        try{
          if(change.state==='cancelled'){void this.discard(context);return {ok:true};}
          if(this.get(context)!==review)throw Error('Review is no longer active');
          if(change.state==='editing'){
            review.state='editing';delete review.submission;
          }else if(change.state==='submitted'){
            if(review.state!=='editing'||review.capturing)throw Error('Review is not ready for submission');
            review.submission=this.validateSubmission(review,change.value);
            review.state='submitted';
          }else throw Error('Unsupported review transition');
          return {ok:true};
        }catch(error){return {ok:false,error:errorText(error)};}
      });
      page.on('close',()=>{if(this.reviews.get(context)===review){this.reviews.delete(context);void browser.close().catch(()=>{});}});
      await page.setContent(annotationReviewHtml,{waitUntil:'load'});
      this.reviews.set(context,review);
      await this.captureShot(context);
      return {state:'editing',review_open:true,frames:1,review_visible:!this.headless,
        message:'Draw rectangles, arrows, pen strokes or labels in the independent review window. Click Submit, then annotate_export(path.json).'};
    }catch(error){this.reviews.delete(context);await browser.close().catch(()=>{});throw error;}
  }

  async captureShot(context:BrowserContext){
    await this.canCapture(context);
    const review=this.get(context);
    review.capturing=true;
    try{
      const source=await review.capture(),size=verifyPng(source.png);
      if(typeof source.aria!=='string'||source.aria.length>65536||typeof source.url!=='string'||source.url.length>1000||typeof source.title!=='string'||source.title.length>200||!source.tab_id)
        throw Error('Screenshot provenance exceeds review limits');
      if(review.state!=='editing'||this.reviews.get(context)!==review)throw Error('Review changed while capturing');
      const id=randomUUID(),shot:Shot={...source,...size,id,created_at:new Date().toISOString()};
      const accepted=await review.page.evaluate(async data=>{
        const bridge=window as unknown as {__forgeAddShot:(s:unknown)=>Promise<boolean>};
        return bridge.__forgeAddShot(data);
      },{id,width:size.width,height:size.height,url:shot.url,title:shot.title,png:source.png.toString('base64')});
      if(!accepted)throw Error('Review is submitted or already contains 8 screenshots');
      review.shots.set(id,shot);
      review.captureCount++;
      const live=await this.liveState(review);
      for(const known of review.shots.keys())if(!live.frame_ids.includes(known))review.shots.delete(known);
      return {state:'captured',frame_id:id,frames:live.frame_ids.length,width:size.width,height:size.height};
    }finally{review.capturing=false;}
  }

  prepareExport(context:BrowserContext,root:string,path:string|undefined):AnnotationExportPlan{
    const review=this.get(context);
    if(review.state!=='submitted'||!review.submission)throw Error('Submit the screenshot review before exporting');
    if(!path||extname(path).toLowerCase()!=='.json')throw Error('annotate_export requires a task-relative .json path');
    const stem=path.slice(0,-5);
    const resolveNew=(relativePath:string):Destination=>{
      const absolute=projectFilePath(root,relativePath);
      try{lstatSync(absolute);throw Error('Destination already exists; overwrite is refused');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return {relative:relativePath,absolute};
    };
    const manifest=resolveNew(path),files=review.submission.frame_ids.map((_id,i)=>{
      const index=i+1;return {png:resolveNew(stem+'-'+index+'.png'),yaml:resolveNew(stem+'-'+index+'.yaml')};
    });
    return {manifest,files};
  }

  async export(context:BrowserContext,root:string,path:string,plan:AnnotationExportPlan){
    const review=this.get(context);
    if(review.state!=='submitted'||!review.submission)throw Error('Review has not been submitted');
    const checked=this.prepareExport(context,root,path);
    if(JSON.stringify(checked)!==JSON.stringify(plan))throw Error('Annotation export path changed before writing');
    const submitted=review.submission;
    const live=await review.page.evaluate(()=>{
      const bridge=window as unknown as {__forgeState:()=>unknown};return bridge.__forgeState();
    });
    const verified=this.validateSubmission(review,live);
    if(JSON.stringify(verified)!==JSON.stringify(submitted))throw Error('Review annotations changed after submission');
    const rendered=await review.page.evaluate(async()=>{
      const bridge=window as unknown as {__forgeRender:()=>Promise<{id:string;data:string}[]>};return bridge.__forgeRender();
    });
    if(rendered.length!==submitted.frame_ids.length)throw Error('Rendered screenshot count changed');
    const now=new Date().toISOString(),written:string[]=[];
    const entries=submitted.frame_ids.map((id,index)=>{
      const shot=review.shots.get(id)!;
      const candidate=rendered[index];
      if(candidate?.id!==id||!candidate.data||candidate.data.length>MAX_PNG*2||!/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.data))throw Error('Invalid annotated PNG export');
      const png=Buffer.from(candidate.data,'base64'),size=verifyPng(png);
      if(size.width!==shot.width||size.height!==shot.height)throw Error('Exported screenshot resolution changed');
      const marks=submitted.annotations[index].annotations;
      const annotations=marks.map(mark=>{
        const points=mark.kind==='pen'?mark.points:[{x:mark.x,y:mark.y},{x:mark.x+mark.width,y:mark.y+mark.height}];
        const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
        return {kind:mark.kind,x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y,text:mark.text,
          ...(mark.kind==='pen'?{points:mark.points}:mark.kind==='arrow'?{from:points[0],to:points[1]}:{})};
      });
      return {id,png,aria:shot.aria,source_url:shot.url,source_title:shot.title,tab_id:shot.tab_id,
        captured_at:shot.created_at,width:shot.width,height:shot.height,annotations,
        png_file:plan.files[index].png.relative.replaceAll('\\','/'),aria_file:plan.files[index].yaml.relative.replaceAll('\\','/'),
        png_size:png.length,png_sha256:digest(png)};
    });
    const manifest={version:1,exported_at:now,feedback:submitted.feedback,frames:entries.map(({png,aria,...metadata})=>metadata)};
    try{
      for(let i=0;i<entries.length;i++){
        const entry=entries[i],names=plan.files[i];
        writeFileSync(names.png.absolute,entry.png,{flag:'wx'});written.push(names.png.absolute);
        writeFileSync(names.yaml.absolute,entry.aria,{flag:'wx'});written.push(names.yaml.absolute);
      }
      writeFileSync(plan.manifest.absolute,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});written.push(plan.manifest.absolute);
    }catch(error){for(const path of written.reverse())try{unlinkSync(path);}catch{/* Retain original export error. */}throw error;}
    return {state:'exported',manifest:plan.manifest.relative,frames:manifest.frames.length,
      annotation_count:entries.reduce((sum,e)=>sum+e.annotations.length,0),feedback:submitted.feedback,
      artifacts:entries.map(e=>({image:e.png_file,aria:e.aria_file,sha256:e.png_sha256,size:e.png_size})),
      json_sha256:digest(Buffer.from(JSON.stringify(manifest,null,2)+'\n'))};
  }

  async discard(context:BrowserContext){
    const review=this.reviews.get(context);
    if(!review)return {state:'absent',review_open:false};
    this.reviews.delete(context);
    await review.browser.close().catch(()=>{});
    review.shots.clear();delete review.submission;
    return {state:'cancelled',review_open:false};
  }
}
