import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,openSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BrowserContext,Frame,Page} from 'playwright-core';
import {projectFilePath} from './forge-browser-files.js';

export const VIDEO_ACTIONS=['video_start','video_status','video_pause','video_resume','video_stop','video_chapter','video_show_actions','video_hide_actions'] as const;
export type VideoAction=(typeof VIDEO_ACTIONS)[number];
export const isVideoAction=(value:string):value is VideoAction=>(VIDEO_ACTIONS as readonly string[]).includes(value);
export const MAX_VIDEO_CLIPS=16;
const MAX_VIDEO_BYTES=128*1024*1024;
const MAX_RECORDING_MS=15*60_000;

interface Clip {
  page:Page;
  tabId:string;
  file:string;
  started:number;
  ended?:number;
  stopped:boolean;
  changed:(frame:Frame)=>void;
}
interface Chapter {tab_id:string;title:string;description?:string;offset_ms:number;duration_ms:number}
interface Capture {
  id:string;
  context:BrowserContext;
  started:number;
  size:{width:number;height:number};
  fps:number;
  dir:string;
  clips:Clip[];
  chapters:Chapter[];
  state:'recording'|'paused'|'finalized';
  reason?:'time_limit'|'unauthorized_frame';
  timer:ReturnType<typeof setTimeout>;
  stopping?:Promise<void>;
}

// One recording spans all explicitly owned tabs. Newly opened tabs receive
// their own WebM, so changes of active tab do not silently lose video frames.
// Page.screencast is Playwright's native capture/overlay implementation.
export class ForgeBrowserVideo {
  private captures=new WeakMap<BrowserContext,Capture>();
  constructor(private readonly permitted:(url:string)=>boolean,
    private readonly allowed:(frame:Frame)=>boolean){}

  has(context:BrowserContext){return this.captures.has(context);}
  active(context:BrowserContext){return this.captures.get(context)?.state==='recording';}
  paused(context:BrowserContext){return this.captures.get(context)?.state==='paused';}
  canResume(context:BrowserContext,tabs:number){
    const rec=this.captures.get(context);
    return !!rec&&rec.state==='paused'&&rec.clips.length+tabs<=MAX_VIDEO_CLIPS;
  }
  canAddPage(context:BrowserContext){
    const rec=this.captures.get(context);
    return !rec||rec.state!=='recording'||rec.clips.length<MAX_VIDEO_CLIPS;
  }
  private verify(page:Page){
    if(page.isClosed()||!this.permitted(page.url())||page.frames().some(frame=>!this.allowed(frame)))
      throw Error('Video requires an authorized page and authorized frames');
  }
  private capture(context:BrowserContext){
    const rec=this.captures.get(context);
    if(!rec)throw Error('Start video recording before using this action');
    return rec;
  }
  private async stopClips(rec:Capture){
    const errors:string[]=[];
    for(const clip of rec.clips){
      clip.page.off('framenavigated',clip.changed);
      if(clip.stopped)continue;
      clip.stopped=true;
      try{if(!clip.page.isClosed())await clip.page.screencast.stop();}
      catch(error){errors.push(String(error));}
      finally{clip.ended=Date.now();}
    }
    if(errors.length)throw Error('Video recording failed to finalize: '+errors[0]);
  }
  private async freeze(rec:Capture){
    if(rec.stopping)return rec.stopping;
    rec.state='finalized';clearTimeout(rec.timer);
    rec.stopping=this.stopClips(rec);
    return rec.stopping;
  }
  private changed(rec:Capture,page:Page){
    if(rec.state!=='recording'||page.isClosed())return;
    if(!this.permitted(page.url())||page.frames().some(frame=>!this.allowed(frame))){
      rec.reason='unauthorized_frame';
      void this.freeze(rec).catch(()=>{});
    }
  }
  async start(context:BrowserContext,tabs:Map<string,Page>,size?:{width:number;height:number},fps=15){
    if(this.captures.has(context))throw Error('Video recording is already present; stop it first');
    for(const page of tabs.values())this.verify(page);
    const dir=await mkdtemp(join(tmpdir(),'forge-screencast-'));
    const rec:Capture={id:randomUUID(),context,dir,clips:[],started:Date.now(),
      chapters:[],size:size??{width:1280,height:800},fps,state:'recording',timer:undefined!};
    // Set state first to give navigation events a concrete capture to abort.
    this.captures.set(context,rec);
    try{
      for(const [tabId,page] of tabs)await this.startPage(context,tabId,page);
      if(rec.state!=='recording')throw Error('Recording stopped while initializing tabs');
      rec.timer=setTimeout(()=>{rec.reason='time_limit';void this.freeze(rec).catch(()=>{});},MAX_RECORDING_MS);
      rec.timer.unref?.();
      return {state:'completed',recording:true,video_id:rec.id,tabs_recorded:rec.clips.length,
        size:rec.size,fps:rec.fps,max_duration_ms:MAX_RECORDING_MS};
    }catch(error){await this.discard(context);throw error;}
  }
  async startPage(context:BrowserContext,tabId:string,page:Page){
    const rec=this.captures.get(context);
    if(!rec||rec.state!=='recording')return;
    if(rec.clips.some(c=>c.page===page&&!c.stopped))return;
    if(rec.clips.length>=MAX_VIDEO_CLIPS)throw Error('A video can include at most 16 tab recordings');
    this.verify(page);
    const changed=()=>this.changed(rec,page);
    const clip:Clip={page,tabId,file:join(rec.dir,rec.clips.length+'.webm'),started:Date.now(),stopped:false,changed};
    page.on('framenavigated',changed);
    try{
      await page.screencast.start({path:clip.file,size:rec.size,fps:rec.fps});
      rec.clips.push(clip);
      this.changed(rec,page);
    }catch(error){page.off('framenavigated',changed);throw error;}
  }
  async closePage(context:BrowserContext,page:Page){
    const rec=this.captures.get(context),clip=rec?.clips.find(c=>c.page===page);
    if(!rec||!clip||clip.stopped)return;
    clip.page.off('framenavigated',clip.changed);
    clip.stopped=true;
    try{if(!page.isClosed())await page.screencast.stop();}
    finally{clip.ended=Date.now();}
  }
  async pause(context:BrowserContext){
    const rec=this.capture(context);
    if(rec.state!=='recording')throw Error('Only an active video recording can be paused');
    rec.state='paused';await this.stopClips(rec);
    return {state:'completed',video_id:rec.id,recording:false,paused:true,segments:rec.clips.length};
  }
  async resume(context:BrowserContext,tabs:Map<string,Page>){
    const rec=this.capture(context);
    if(rec.state!=='paused')throw Error('Pause video before resuming');
    if(rec.clips.length+tabs.size>MAX_VIDEO_CLIPS)throw Error('Video resume would exceed the 16-segment limit');
    for(const page of tabs.values())this.verify(page);
    rec.state='recording';
    try{for(const [tabId,page] of tabs)await this.startPage(context,tabId,page);}
    catch(error){rec.state='paused';await this.stopClips(rec);throw error;}
    return {state:'completed',video_id:rec.id,recording:true,paused:false,segments:rec.clips.length};
  }
  status(context:BrowserContext){
    const rec=this.captures.get(context);
    if(!rec)return {state:'completed',recording:false,tabs_recorded:0};
    return {state:'completed',recording:rec.state==='recording',paused:rec.state==='paused',finalized:rec.state==='finalized',video_id:rec.id,
      tabs_recorded:rec.clips.length,clips_finalized:rec.clips.filter(c=>c.stopped).length,
      chapters:rec.chapters.length,
      elapsed_ms:Date.now()-rec.started,expires_at:new Date(rec.started+MAX_RECORDING_MS).toISOString(),
      ...(rec.reason?{reason:rec.reason}:{}),size:rec.size,fps:rec.fps};
  }
  validateStop(context:BrowserContext,root:string,path:string|undefined){
    const rec=this.capture(context);
    if(!path||!/^.+\.webm$/i.test(path))throw Error('video_stop requires a new task-relative .webm path');
    if(rec.reason==='unauthorized_frame')throw Error('Video recording crossed an unapproved origin and cannot be exported');
    if(rec.clips.length===0)throw Error('Video recording contains no clips');
    return this.targets(root,path,rec.clips.length);
  }
  private targets(root:string,path:string,count:number){
    const base=path.slice(0,-5),destinations:string[]=[];
    for(let i=0;i<count;i++){
      const dest=projectFilePath(root,i===0?path:base+'-'+i+'.webm');
      try{lstatSync(dest);throw Error('Destination already exists; video overwrite is refused');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      destinations.push(dest);
    }
    return destinations;
  }
  async stop(context:BrowserContext,root:string,path:string){
    const rec=this.capture(context);
    this.validateStop(context,root,path);
    // Freeze video before reading from the private staging directory.
    const newlyCreated:string[]=[];
    try{
      await this.freeze(rec);
      if(rec.reason==='unauthorized_frame')throw Error('Video recording crossed an unapproved origin');
      const targets=this.targets(root,path,rec.clips.length);
      const files=rec.clips.map(c=>{
        if(!existsSync(c.file))throw Error('Recorded tab has no finalized video');
        const bytes=statSync(c.file).size;
        if(!bytes||bytes>MAX_VIDEO_BYTES)throw Error('Video clip is empty or exceeds 128 MiB');
        return {bytes,source:c.file};
      });
      const sum=files.reduce((v,item)=>v+item.bytes,0);
      if(sum>MAX_VIDEO_BYTES)throw Error('Combined video clips exceed 128 MiB');
      const saved:{tab_id:string;path:string;size:number;sha256:string;start_offset_ms:number;recorded_wall_ms:number}[]=[];
      for(let i=0;i<files.length;i++){
        const target=targets[i]!,source=files[i]!,data=readFileSync(source.source);
        const fd=openSync(target,'wx');
        newlyCreated.push(target);
        try{writeFileSync(fd,data);fsyncSync(fd);}
        catch(error){closeSync(fd);throw error;}
        closeSync(fd);
        saved.push({tab_id:rec.clips[i]!.tabId,path:i===0?path:path.slice(0,-5)+'-'+i+'.webm',
          size:data.length,sha256:createHash('sha256').update(data).digest('hex'),
          start_offset_ms:Math.max(0,rec.clips[i]!.started-rec.started),
          recorded_wall_ms:Math.max(0,(rec.clips[i]!.ended??Date.now())-rec.clips[i]!.started)});
      }
      const result={state:'completed',recording:false,video_id:rec.id,
        duration_ms:Date.now()-rec.started,videos:saved,chapters:rec.chapters,
        ...(rec.reason?{reason:rec.reason}:{})};
      await this.discard(context);
      return result;
    }catch(error){
      // Only remove destinations opened by this attempt. Keep finalized
      // staging video available for an explicit export recovery attempt.
      for(const created of newlyCreated)try{unlinkSync(created);}catch{}
      throw error;
    }
  }
  async chapter(context:BrowserContext,page:Page,title:string,description?:string,duration=2000){
    const rec=this.capture(context);
    if(rec.state!=='recording'||!rec.clips.some(c=>c.page===page&&!c.stopped))
      throw Error('Record this tab before adding a video chapter');
    this.verify(page);
    const startedAt=Date.now();
    await page.screencast.showChapter(title,{description,duration});
    this.verify(page);
    const tabId=[...rec.clips].reverse().find(c=>c.page===page)?.tabId;
    if(tabId)rec.chapters.push({tab_id:tabId,title,...(description?{description}:{}),
      offset_ms:startedAt-rec.started,duration_ms:duration});
    return {state:'completed',video_id:rec.id,chapter_added:true,duration_ms:duration};
  }
  async showActions(page:Page,options:{duration?:number;position?:'top-left'|'top'|'top-right'|'bottom-left'|'bottom'|'bottom-right';cursor?:'none'|'pointer'}){
    this.verify(page);
    await page.screencast.showActions(options);
    this.verify(page);
    return {state:'completed',action_overlays:true,
      position:options.position??'top-right',cursor:options.cursor??'pointer',duration_ms:options.duration??500};
  }
  async hideActions(page:Page){
    this.verify(page);await page.screencast.hideActions();
    return {state:'completed',action_overlays:false};
  }
  async discard(context:BrowserContext){
    const rec=this.captures.get(context);
    if(!rec)return;
    this.captures.delete(context);clearTimeout(rec.timer);
    try{await this.freeze(rec);}catch{}
    await rm(rec.dir,{recursive:true,force:true}).catch(()=>{});
  }
}
