import type {Browser,BrowserContext,CDPSession,Frame,Page} from 'playwright-core';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {mkdirSync,lstatSync,realpathSync,openSync,readSync,fstatSync,closeSync,unlinkSync,writeFileSync,fsyncSync} from 'node:fs';
import type {DurableTasks} from './durable-tasks.js';
import {ownedDirectory,projectFilePath} from './forge-browser-files.js';

export const downloadNoticePrefix='_forge_download:';
const maxBytes=32*1024*1024;
type Tree={frame:{id:string,url:string},childFrames?:Tree[]};
type Pin={frame:Frame,url:string,version:string|undefined};
type Owner={task:string,context:BrowserContext,contextId:string,directory:string,pages:Map<Page,CDPSession>,frames:Set<string>,allowed:(frame:Frame)=>boolean,version:(frame:Frame)=>string|undefined,permitted:(url:string)=>boolean,lease:()=>string,count:number,total:number,stopped:boolean};
type Record={id:string,notice:string,owner:Owner,page:Page,frameId:string,pins:Pin[],url:string,name:string,received:number,state:string,source?:Pin[],ready:Promise<void>,timer?:ReturnType<typeof setTimeout>,terminal?:()=>void,done:Promise<void>,cancelReason?:string};
const frameIn=(tree:Tree,id:string):Tree|undefined=>tree.frame.id===id?tree:tree.childFrames?.map(t=>frameIn(t,id)).find(Boolean);
const digest=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('hex');
export class BrowserDownloads {
  private client?:CDPSession;
  private owners=new Map<BrowserContext,Owner>();
  private frames=new Map<string,{owner:Owner,page:Page}>();
  private records=new Map<string,Record>();
  constructor(private engine:DurableTasks){engine.db.prepare("UPDATE browser_operations SET state='unknown' WHERE state='waiting_download'").run();}
  async initialize(browser:Browser){
    this.client=await browser.newBrowserCDPSession();
    this.client.on('Browser.downloadWillBegin',event=>this.begin(event));
    this.client.on('Browser.downloadProgress',event=>{void this.progress(event).catch(error=>this.fail(event.guid,String(error)));});
  }
  async attach(task:string,context:BrowserContext,page:Page,allowed:Owner['allowed'],version:Owner['version'],permitted:Owner['permitted'],lease:Owner['lease']){
    const client=await context.newCDPSession(page);let owner=this.owners.get(context);
    if(!owner){
      const {targetInfo}=await client.send('Target.getTargetInfo');if(!targetInfo.browserContextId)throw Error('Owned browser context has no protocol identity');
      const parent=ownedDirectory(this.engine.stateDir,'browser-downloads'),directory=join(parent,randomUUID());mkdirSync(directory);
      owner={task,context,contextId:targetInfo.browserContextId,directory,pages:new Map(),frames:new Set(),allowed,version,permitted,lease,count:0,total:0,stopped:false};this.owners.set(context,owner);
      await this.client!.send('Browser.setDownloadBehavior',{behavior:'allowAndName',browserContextId:owner.contextId,downloadPath:directory,eventsEnabled:true});
      context.on('close',()=>this.abandon(context));
    }
    const current=owner;current.pages.set(page,client);
    const own=(id:string)=>{current.frames.add(id);this.frames.set(id,{owner:current,page});};
    client.on('Page.frameAttached',event=>own(event.frameId));
    client.on('Page.frameNavigated',event=>own(event.frame.id));
    client.on('Page.frameDetached',event=>{if(event.reason==='remove'){current.frames.delete(event.frameId);this.frames.delete(event.frameId);}});
    page.on('close',()=>{current.pages.delete(page);for(const [id,entry] of this.frames)if(entry.page===page){this.frames.delete(id);current.frames.delete(id);}});
    await client.send('Page.enable');const {frameTree}=await client.send('Page.getFrameTree');
    const collect=(tree:Tree)=>{own(tree.frame.id);tree.childFrames?.forEach(collect);};collect(frameTree);
  }
  private authority(owner:Owner){const task=this.engine.task(owner.task);this.engine.assertLease(task,owner.lease());if(task.status!=='active'||owner.stopped)throw Error('Download task or session is no longer active');}
  private valid(record:Record){return !!record.source?.length&&record.source.every(p=>!p.frame.isDetached()&&p.frame.url()===p.url&&record.owner.version(p.frame)===p.version&&record.owner.allowed(p.frame));}
  private begin(event:{guid:string,frameId:string,url:string,suggestedFilename:string}){
    if(!/^[a-f0-9-]{36}$/i.test(event.guid))return;
    const origin=this.frames.get(event.frameId);
    if(!origin){for(const owner of this.owners.values())void this.client!.send('Browser.cancelDownload',{guid:event.guid,browserContextId:owner.contextId}).catch(()=>{});return;}
    const {owner,page}=origin,id=event.guid,notice=downloadNoticePrefix+id;
    if(owner.count>=16){
      this.engine.db.prepare('INSERT OR IGNORE INTO browser_operations VALUES(?,?,?,?,?)').run(owner.task,downloadNoticePrefix+'overflow',JSON.stringify({action:'download_overflow'}),'unknown',JSON.stringify({state:'unknown',message:'Session download capacity exceeded; close the owned session and inspect receipts'}));
      void this.client!.send('Browser.cancelDownload',{guid:id,browserContextId:owner.contextId}).catch(()=>{});return;
    }
    let terminal:()=>void=()=>{};const done=new Promise<void>(resolve=>terminal=resolve);
    const record:Record={id,notice,owner,page,frameId:event.frameId,pins:page.frames().map(frame=>({frame,url:frame.url(),version:owner.version(frame)})),url:event.url,name:event.suggestedFilename.replace(/[\\/\x00-\x1f:<>"|?*]/g,'_').slice(0,160),received:0,state:'pending',ready:Promise.resolve(),done,terminal};
    this.records.set(id,record);owner.count++;
    this.engine.db.prepare('INSERT INTO browser_operations VALUES(?,?,?,?,?)').run(owner.task,notice,JSON.stringify({action:'download_notice',download_id:id}),'waiting_download',JSON.stringify({state:'pending',download_id:id}));
    record.timer=setTimeout(()=>{void this.cancelRecord(record,'download deadline exceeded').catch(error=>this.fail(id,String(error)));},60000);
    record.ready=(async()=>{
      this.authority(owner);const client=owner.pages.get(page);if(!client)throw Error('Download source tab closed');
      const {frameTree}=await client.send('Page.getFrameTree');let source=frameIn(frameTree,event.frameId);
      // The main target's frame tree omits OOPIF documents. Find the exact
      // native frame ID in a captured child target; never infer from the URL.
      if(!source)for(const pin of record.pins.slice(0,32)){
        if(pin.frame===page.mainFrame()||pin.frame.isDetached())continue;
        let child:CDPSession|undefined;
        try{child=await owner.context.newCDPSession(pin.frame);const tree=await child.send('Page.getFrameTree');source=frameIn(tree.frameTree,event.frameId);}
        catch(error){if(!String(error).includes('does not have a separate CDP session'))throw error;}
        finally{await child?.detach().catch(()=>{});}
        if(source)break;
      }
      if(!source)throw Error('Download initiator frame is unavailable');
      record.source=record.pins.filter(p=>p.url===source.frame.url);
      if(!this.valid(record)||(!owner.permitted(event.url)&&!event.url.startsWith('data:')))throw Error('Download source or destination origin is not authorized');
      if(owner.count>16||owner.total>=64*1024*1024)throw Error('Session download capacity exceeded (16 files / 64 MiB)');
    })();
    void record.ready.catch(error=>this.cancelRecord(record,String(error)).catch(error=>this.fail(id,String(error))));
  }
  private nativePath(record:Record){
    const path=join(record.owner.directory,record.id);
    if(realpathSync.native(record.owner.directory)!==record.owner.directory||lstatSync(record.owner.directory).isSymbolicLink())throw Error('Owned download directory was replaced');
    return path;
  }
  private remove(record:Record){const path=this.nativePath(record);for(const file of [path,path+'.crdownload'])try{const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Download artifact was replaced');unlinkSync(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  private finish(record:Record,result:object){
    if(record.state!=='pending')return;record.state='finished';if(record.timer)clearTimeout(record.timer);
    this.engine.db.prepare('UPDATE browser_operations SET state=?,result=? WHERE task_id=? AND id=?').run('completed',JSON.stringify({download_id:record.id,...result}),record.owner.task,record.notice);record.terminal?.();
  }
  private fail(id:string,error:string){const record=this.records.get(id);if(!record||record.state!=='pending')return;record.state='unknown';if(record.timer)clearTimeout(record.timer);this.engine.db.prepare("UPDATE browser_operations SET state='unknown',result=? WHERE task_id=? AND id=?").run(JSON.stringify({state:'unknown',download_id:id,message:'Inspect the owned download receipt; never resend automatically.'}),record.owner.task,record.notice);this.engine.event(record.owner.task,'browser_download_unknown',{download_id:id,error:error.slice(0,400)});record.terminal?.();}
  private async progress(event:{guid:string,state:string,totalBytes:number,receivedBytes:number}){
    const record=this.records.get(event.guid);if(!record||record.state!=='pending')return;
    record.received=Math.max(record.received,event.receivedBytes);
    if(event.state==='inProgress'){
      if(event.totalBytes>maxBytes||event.receivedBytes>maxBytes||record.owner.total+event.receivedBytes>64*1024*1024)await this.cancelRecord(record,'download size limit exceeded');
      return;
    }
    if(event.state==='canceled'){this.remove(record);this.finish(record,{state:'cancelled',reason:record.cancelReason??'native cancellation'});return;}
    if(event.state!=='completed')return;
    try{await record.ready;}catch(error){record.cancelReason=String(error);}
    if(record.state!=='pending')return;
    if(record.cancelReason||event.receivedBytes>maxBytes||record.owner.total+event.receivedBytes>64*1024*1024||!this.valid(record)){
      this.remove(record);this.finish(record,{state:'rejected',reason:record.cancelReason??'download source changed or size limit exceeded'});return;
    }
    this.authority(record.owner);const path=this.nativePath(record),info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maxBytes)throw Error('Invalid or oversized download artifact');
    const file=this.readArtifact(path,info.size);record.owner.total+=file.length;
    this.finish(record,{state:'completed',name:record.name,size:file.length,sha256:digest(file),artifact_path:path});
  }
  private readArtifact(path:string,size:number){
    const fd=openSync(path,'r');try{
      const before=fstatSync(fd);if(!before.isFile()||before.size!==size||before.nlink!==1||size>maxBytes)throw Error('Download artifact changed');
      const bytes=Buffer.alloc(size);let offset=0;while(offset<size){const n=readSync(fd,bytes,offset,size-offset,null);if(!n)throw Error('Download artifact truncated');offset+=n;}
      const after=fstatSync(fd),current=lstatSync(path);if([before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(':')!==[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':')||after.ino!==current.ino||current.isSymbolicLink())throw Error('Download artifact changed during capture');return bytes;
    }finally{closeSync(fd);}
  }
  pendingNotices(task:string){return [...this.records.values()].filter(r=>r.owner.task===task&&r.state==='pending').map(r=>r.notice);}
  list(task:string){return (this.engine.db.prepare('SELECT state,result FROM browser_operations WHERE task_id=? AND substr(id,1,?)=? ORDER BY rowid DESC LIMIT 16').all(task,downloadNoticePrefix.length,downloadNoticePrefix) as {state:string,result:string}[]).map(row=>({...JSON.parse(row.result),...(row.state==='unknown'?{state:'unknown'}:{})}));}
  async cancel(task:string,id:string){const record=this.records.get(id);if(!record||record.owner.task!==task||record.state!=='pending')throw Error('Unknown or already finished download');await this.cancelRecord(record,'explicit cancellation');await record.done;return this.list(task).find(d=>d.download_id===id);}
  private async cancelRecord(record:Record,reason:string){
    if(record.state!=='pending')return;record.cancelReason=reason;
    await this.client!.send('Browser.cancelDownload',{guid:record.id,browserContextId:record.owner.contextId});
  }
  prepareSave(task:string,id:string,path:string){
    const row=this.engine.db.prepare('SELECT state,result FROM browser_operations WHERE task_id=? AND id=?').get(task,downloadNoticePrefix+id) as {state:string,result:string}|undefined;
    if(!row||row.state!=='completed')throw Error('Download is unavailable, pending or unknown');
    const receipt=JSON.parse(row.result);if(receipt.state!=='completed')throw Error('Only a completed download can be saved');
    const root=this.engine.task(task).root,target=projectFilePath(root,path);
    try{lstatSync(target);throw Error('Download destination already exists; overwrite is refused');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const parent=ownedDirectory(this.engine.stateDir,'browser-downloads'),artifact=receipt.artifact_path as string;
    if(!artifact.startsWith(parent+'\\')&&!artifact.startsWith(parent+'/'))throw Error('Invalid owned download receipt');
    const info=lstatSync(artifact);if(!info.isFile()||info.isSymbolicLink()||realpathSync.native(artifact)!==artifact)throw Error('Download artifact was replaced');
    const bytes=this.readArtifact(artifact,receipt.size);if(digest(bytes)!==receipt.sha256)throw Error('Download artifact hash changed');
    return {root,path,target,bytes,receipt};
  }
  save(plan:ReturnType<BrowserDownloads['prepareSave']>){
    if(projectFilePath(plan.root,plan.path)!==plan.target)throw Error('Download destination changed');
    const fd=openSync(plan.target,'wx');try{writeFileSync(fd,plan.bytes);fsyncSync(fd);}finally{closeSync(fd);}
    return {download_id:plan.receipt.download_id,path:plan.path,size:plan.bytes.length,sha256:plan.receipt.sha256};
  }
  abandon(context:BrowserContext){
    const owner=this.owners.get(context);if(!owner)return;owner.stopped=true;
    for(const record of this.records.values())if(record.owner===owner&&record.state==='pending'){this.fail(record.id,'owned context closed');void this.client?.send('Browser.cancelDownload',{guid:record.id,browserContextId:owner.contextId}).catch(()=>{});}
    for(const id of owner.frames)this.frames.delete(id);this.owners.delete(context);
  }
  async close(){for(const context of this.owners.keys())this.abandon(context);await this.client?.detach().catch(()=>{});this.client=undefined;}
}
