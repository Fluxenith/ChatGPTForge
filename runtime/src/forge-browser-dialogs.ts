import {randomUUID} from 'node:crypto';
import type {Page,Dialog,Frame,CDPSession} from 'playwright-core';
import type {DurableTasks} from './durable-tasks.js';

export const dialogNoticePrefix='_forge_dialog:';
type Source={url:string;frameId:string;type:string;message:string;defaultPrompt?:string};
type Pin={frame:Frame;url:string;version:string};
type Pending={id:string;notice:string;page:Page;dialog:Dialog;source?:Source;pins:Pin[];choice:Promise<boolean>;resolveChoice:(accepted:boolean)=>void;rejectChoice:(error:Error)=>void;handling?:{operation:string;accept:boolean;text?:string};closed?:{result:boolean;userInput:string}};

// The protocol supplies the dialog's initiator URL. Public Playwright Dialog
// does not expose a Frame. When URLs are ambiguous, every matching frame must
// remain authorized and unchanged; never guess one of the candidates.
export class BrowserDialogs {
  readonly pending=new Map<string,Pending>();
  private sources=new Map<Page,Source[]>();
  private clients=new Map<Page,CDPSession>();
  private closing=false;
  get stopping(){return this.closing;}
  constructor(private engine:DurableTasks,private task:string,private version:(frame:Frame)=>string|undefined,private allowed:(frame:Frame)=>boolean,private tab:(page:Page)=>string|undefined,private notify:()=>void){}
  get hasPending(){return this.pending.size>0;}
  get notices(){return [...this.pending.values()].map(d=>d.notice);}
  async attach(page:Page){
    page.on('dialog',dialog=>{
      if(this.closing){void (dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss()).catch(()=>{});return;}
      const id=randomUUID(),notice=dialogNoticePrefix+id;
      let resolveChoice:(accepted:boolean)=>void=()=>{},rejectChoice:(error:Error)=>void=()=>{};
      const choice=new Promise<boolean>((resolve,reject)=>{resolveChoice=resolve;rejectChoice=reject;});void choice.catch(()=>{});
      const entry:Pending={id,notice,page,dialog,pins:[],choice,resolveChoice,rejectChoice};this.pending.set(id,entry);
      this.engine.db.prepare('INSERT INTO browser_operations VALUES(?,?,?,?,?)').run(this.task,notice,JSON.stringify({action:'dialog_notice',dialog_id:id,type:dialog.type()}),'waiting_dialog',JSON.stringify({state:'dialog_pending',dialog_id:id,type:dialog.type()}));
      this.engine.event(this.task,'browser_dialog_opened',{dialog_id:id,type:dialog.type()});this.pair(page);this.notify();
    });
    page.on('close',()=>{
      for(const [id,d] of this.pending)if(d.page===page){this.unknown(d);this.pending.delete(id);}
      this.sources.delete(page);this.clients.delete(page);this.notify();
    });
    const client=await page.context().newCDPSession(page);this.clients.set(page,client);
    client.on('Page.javascriptDialogOpening',(source:Source)=>{
      if(this.closing)return;
      const queue=this.sources.get(page)??[];queue.push(source);this.sources.set(page,queue.slice(-8));this.pair(page);this.notify();
    });
    client.on('Page.javascriptDialogClosed',(event:{frameId:string;result:boolean;userInput:string})=>{
      const d=[...this.pending.values()].find(d=>d.page===page&&d.source?.frameId===event.frameId);
      if(!d)return;
      d.closed={result:event.result,userInput:event.userInput};
      if(!d.handling)this.unknown(d);
      this.pending.delete(d.id);this.notify();
    });
    await client.send('Page.enable');
  }
  private pair(page:Page){
    const queue=this.sources.get(page);if(!queue)return;
    for(const d of this.pending.values()){
      if(d.page!==page||d.source)continue;
      const index=queue.findIndex(s=>s.type===d.dialog.type()&&s.message===d.dialog.message()&&(s.defaultPrompt??'')===d.dialog.defaultValue());
      if(index<0)continue;
      d.source=queue.splice(index,1)[0];
      d.pins=page.frames().filter(f=>f.url()===d.source!.url).map(frame=>({frame,url:frame.url(),version:this.version(frame)!}));
    }
  }
  authorized(d:Pending){
    if(!d.source||!d.pins.length||d.page.isClosed())return false;
    const matches=d.page.frames().filter(f=>f.url()===d.source!.url);
    return matches.length===d.pins.length&&d.pins.every(p=>matches.includes(p.frame)&&!p.frame.isDetached()&&p.frame.url()===p.url&&this.version(p.frame)===p.version&&this.allowed(p.frame));
  }
  view(){return [...this.pending.values()].filter(d=>!d.handling).map(d=>{
    const authorized=this.authorized(d);
    return {dialog_id:d.id,tab_id:this.tab(d.page),type:d.dialog.type(),authorized,message:authorized?d.dialog.message().slice(0,4000):'[unavailable-origin]',default_value:authorized?d.dialog.defaultValue().slice(0,1000):'',source_url:authorized?(d.source!.url.startsWith('data:')?'[inline-frame]':d.source!.url.slice(0,1600)):'[unavailable-origin]'};
  });}
  get(id:string){const d=this.pending.get(id);if(!d||d.handling)throw Error('Unknown or already handled dialog; inspect again');return d;}
  private unknown(d:Pending){this.engine.db.prepare("UPDATE browser_operations SET state='unknown' WHERE task_id=? AND id=? AND state='waiting_dialog'").run(this.task,d.notice);d.rejectChoice(Error('Dialog closed without an acknowledged decision; inspect its unknown receipt'));}
  async handle(id:string,operation:string,accept:boolean,text?:string){
    const d=this.get(id);if(!this.authorized(d))throw Error('Dialog origin or document is not authorized; close the owned session or inspect again');
    if(accept&&d.dialog.type()==='prompt'&&text===undefined)text=d.dialog.defaultValue();
    d.handling={operation,accept,text};
    try{
      if(accept)await d.dialog.accept(text);else await d.dialog.dismiss();
      // Some Chromium versions omit frameId from DialogClosed. A successful
      // native handler command is still an acknowledged decision on this exact
      // captured Dialog. It never refers to a newly opened, similar dialog.
      this.pending.delete(id);
      this.engine.db.prepare('UPDATE browser_operations SET state=?,result=? WHERE task_id=? AND id=?').run('completed',JSON.stringify({state:'dialog_handled',dialog_id:id,type:d.dialog.type(),accepted:accept,...(text===undefined?{}:{prompt_text:text})}),this.task,d.notice);
      this.engine.event(this.task,'browser_dialog_handled',{dialog_id:id,operation_id:operation,accepted:accept});this.notify();
      d.resolveChoice(accept);
      return {dialog_id:id,type:d.dialog.type(),accepted:accept};
    }catch(error){this.unknown(d);throw error;}
  }
  abandon(){this.closing=true;for(const d of this.pending.values())this.unknown(d);this.pending.clear();this.sources.clear();this.notify();}
}
