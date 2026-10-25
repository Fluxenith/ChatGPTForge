import {BrowserExtras,EXTRA_ACTIONS,EXTRA_FRAME_ACTIONS,EXTRA_READ_ONLY,isExtraAction,type ExtraInput} from './forge-browser-extras.js';
import {ForgeBrowserVideo,VIDEO_ACTIONS,isVideoAction} from './forge-browser-video.js';
import {ForgeBrowserAnnotation,ANNOTATION_ACTIONS,isAnnotationAction,type AnnotationExportPlan} from './forge-browser-annotation.js';
import {chromium,type Browser,type BrowserContext,type Page,type Request,type ElementHandle,type Frame,type JSHandle} from 'playwright-core';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as z from 'zod/v4';
import type {McpRegistrationTarget} from './mcp-modern-server.js';
import {DurableTasks} from './durable-tasks.js';
import {resolveCanonicalAllowedPath} from './roots.js';
import {BrowserDialogs,dialogNoticePrefix} from './forge-browser-dialogs.js';
import {BrowserFileChoosers,PreparedUpload,chooserNoticePrefix,projectFilePath} from './forge-browser-files.js';
import {BrowserDownloads,downloadNoticePrefix} from './forge-browser-downloads.js';
import {createBrowserNetwork} from './forge-browser-network.js';
import {browserNetworkJsonCheckSchema,checkNetworkAssertion,networkAssertionReceipt,validateNetworkAssertion,type BrowserNetworkAssertion} from './forge-browser-network-assert.js';
import {browserNetworkFlowSchema,checkNetworkFlow,networkFlowReceipt,validateNetworkFlow,type BrowserNetworkFlow,type NetworkJsonEvidence} from './forge-browser-network-flow.js';
import {browserNetworkAuditSchema,checkNetworkAudit,networkAuditReceipt,validateNetworkAudit,type BrowserNetworkAudit,type NetworkAuditObservation} from './forge-browser-network-audit.js';
import {browserNetworkListSchema,checkNetworkList,networkListReceipt,validateNetworkList,type BrowserNetworkList,type NetworkListObservation} from './forge-browser-network-list.js';

type BrowserConsoleEntry={type:string;text:string};
type BrowserReceipt={request:string;state:string;result:string};
type BrowserNetworkEntry={index:number;method:string;url:string;status:number|null;state:'pending'|'response'|'completed'|'failed';duration_ms?:number;failure?:string;started_ms:number};
type TabDiagnostics={console:BrowserConsoleEntry[];network:BrowserNetworkEntry[];requests:WeakMap<Request,BrowserNetworkEntry>;requestHandles:Map<number,Request>;nextRequestIndex:number;console_dropped:number;network_dropped:number};
type FramePin={frame:Frame;version:string;url:string};
type Suspended={id:string;execution:Promise<unknown>};
type Session={task:string,lease:string,signedIn?:boolean,visibleBrowser?:Browser,videoDir?:string,network:Awaited<ReturnType<typeof createBrowserNetwork>>,uploadStages:Set<()=>void>,uploadBytes:number,choosers:BrowserFileChoosers,dialogs:BrowserDialogs,suspended?:Suspended,context:BrowserContext,page:Page,revision:string,refs:Map<string,string>,nodes:Map<string,ElementHandle<HTMLElement|SVGElement>>,frames:Map<string,FramePin>,frameIds:WeakMap<Frame,string>,frameVersions:WeakMap<Frame,string>,tabs:Map<string,Page>,opening?:Promise<Page>,errors:string[],diagnostics:Map<Page,TabDiagnostics>};
type VideoInput={video_size?:{width:number;height:number};video_fps?:number;title?:string;description?:string;video_duration_ms?:number;video_position?:'top-left'|'top'|'top-right'|'bottom-left'|'bottom'|'bottom-right';video_cursor?:'none'|'pointer'};
const controlSelector='button,a,input,textarea,select,ul,ol,[role],[contenteditable="true"],[contenteditable="plaintext-only"],[draggable="true" i],[ondrop],[aria-label],[data-testid]';
const textLimit=(value:string,max:number)=>value.slice(0,max);
const sensitiveNetworkKey=/authorization|cookie|password|passwd|secret|api.?key|access.?token|refresh.?token|id.?token|session|credential|set-cookie|proxy-authorization/i;
const sensitiveNetworkValue=/\bBearer\s+\S+|\bsk-[\w-]{8,}|(?:secret|password|token|credential)[=:][^\s,;]+/gi;
function sanitizeNetworkValue(value:string){
  if(/secret|private.?key|password|credential/i.test(value)&&value.length<500)return '[redacted]';
  if(/^https?:\/\//i.test(value))try{const url=new URL(value);return url.origin+url.pathname.slice(0,300);}catch{/* Return redacted text below. */}
  return value.slice(0,2048).replace(sensitiveNetworkValue,'[redacted]');
}
function sanitizedNetworkHeaders(raw:Record<string,string>){
  return Object.fromEntries(Object.entries(raw).slice(0,80).map(([key,value])=>[key.toLowerCase(),sensitiveNetworkKey.test(key)?'[redacted]':sanitizeNetworkValue(value)]));
}
function sanitizedNetworkBody(raw:string){
  if(raw.length>32768)return {redacted:true,reason:'body_exceeds_32k_characters'};
  let source:unknown;
  try{source=JSON.parse(raw);}catch{return {text:sanitizeNetworkValue(raw),redacted:true};}
  try{
    let fields=0;
    const clean=(value:unknown,key=''):unknown=>{
      if(++fields>512)throw Error('Body JSON has too many fields');
      if(sensitiveNetworkKey.test(key))return '[redacted]';
      if(typeof value==='string')return sanitizeNetworkValue(value);
      if(Array.isArray(value))return value.slice(0,100).map(item=>clean(item));
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([k,v])=>[k,clean(v,k)]));
      return value;
    };
    return {text:JSON.stringify(clean(source)),redacted:true};
  }catch{return {redacted:true,reason:'body_json_exceeds_sanitizer_limits'};}
}
export class ForgeBrowser {
  private browser?:Browser;
  private sessions=new Map<string,Session>();
  private busy=new Set<string>();
  private dialogWaiters=new Map<string,Set<()=>void>>();
  readonly origins=new Set<string>();
  private readonly extras=new BrowserExtras(url=>this.permitted(url),()=>[...this.origins],frame=>this.frameAllowed(frame));
  private readonly videos=new ForgeBrowserVideo(url=>this.permitted(url),frame=>this.frameAllowed(frame));
  private readonly annotations:ForgeBrowserAnnotation;
  private downloads:BrowserDownloads;
  private networks=new Set<Awaited<ReturnType<typeof createBrowserNetwork>>>();
  constructor(private engine:DurableTasks,private roots:string[],private signedIn?:{userDataDir:string;headless?:boolean},options?:{annotationHeadless?:boolean}){
    this.annotations=new ForgeBrowserAnnotation(options?.annotationHeadless??false);
    engine.db.exec('CREATE TABLE IF NOT EXISTS browser_operations(task_id TEXT, id TEXT, request TEXT, state TEXT, result TEXT, PRIMARY KEY(task_id,id))');
    // Physical browser sessions do not survive process restart. Their pending
    // modal receipts must remain uncertain, never treated as a new dialog.
    engine.db.prepare("UPDATE browser_operations SET state='unknown' WHERE state IN ('waiting_dialog','waiting_upload')").run();
    this.downloads=new BrowserDownloads(engine);
  }
  allow(value:string){
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('請輸入完整網站來源，例如 http://127.0.0.1:3000');
    this.origins.add(u.origin);return [...this.origins];
  }
  resolvedConfig(){
    // Never expose the signed-in profile path, cookies or auth material.
    return {browser:'chromium',mode:'owned_context',default_profile:'isolated',
      signed_in_profile_available:!!this.signedIn,
      allowed_origins:[...this.origins].sort(),
      viewport:{width:1280,height:800},max_tabs:8,max_frames:32,max_snapshot_controls:150,
      file_upload_max_bytes:32*1024*1024,storage_state_max_bytes:1024*1024,
      supported_actions:['open','inspect','tabs','click','fill','select','press','check','hover','drag','drop','scroll','upload','downloads','screenshot','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit','close',...EXTRA_ACTIONS,...VIDEO_ACTIONS,...ANNOTATION_ACTIONS],
      profile_notes:'Signed-in mode uses an owner-enabled dedicated Chrome profile; ordinary Chrome is not attached.'};
  }
  private async closeSession(s:Session){s.dialogs.abandon();s.choosers.close();this.downloads.abandon(s.context);this.extras.discardRecording(s.context);await this.annotations.discard(s.context);await this.videos.discard(s.context);for(const page of s.tabs.values())await this.extras.releasePointer(page);await s.context.close();await s.visibleBrowser?.close();await s.network.close();this.networks.delete(s.network);for(const close of s.uploadStages)close();s.uploadStages.clear();}
  async close(){for(const s of this.sessions.values())await this.closeSession(s);this.sessions.clear();for(const network of this.networks)await network.close();this.networks.clear();await this.downloads.close();await this.browser?.close();this.browser=undefined;}
  private notifyDialogs(task:string){
    const s=this.sessions.get(task);if(s?.dialogs.hasPending){s.revision='';s.refs.clear();}
    for(const waiter of this.dialogWaiters.get(task)??[])waiter();
  }
  private pendingView(s:Session,operation?:string){return {state:s.dialogs.hasPending?'dialog_pending':'action_pending',operation_id:operation??s.suspended?.id,url:this.safeDiagnosticUrl(s.page.url()),revision:'',controls:[],dialogs:s.dialogs.view(),file_choosers:s.choosers.view(),downloads:this.downloads.list(s.task),tabs:[...s.tabs].map(([tab_id,page])=>({tab_id,url:this.safeDiagnosticUrl(page.url()),active:page===s.page}))};}
  private async readyDialogs(s:Session){
    if(![...s.dialogs.pending.values()].some(d=>!d.source))return;
    await new Promise<void>(resolve=>{
      let timer:ReturnType<typeof setTimeout>;
      const finish=()=>{clearTimeout(timer);this.dialogWaiters.get(s.task)?.delete(check);resolve();};
      const check=()=>{if(![...s.dialogs.pending.values()].some(d=>!d.source))finish();};
      const waiters=this.dialogWaiters.get(s.task)??new Set();this.dialogWaiters.set(s.task,waiters);waiters.add(check);timer=setTimeout(finish,1000);check();
    });
  }
  private async waitForDialogs(s:Session){
    if(!s.dialogs.hasPending)return;
    await new Promise<void>(resolve=>{
      const check=()=>{if(!s.dialogs.hasPending){this.dialogWaiters.get(s.task)?.delete(check);resolve();}};
      const waiters=this.dialogWaiters.get(s.task)??new Set();this.dialogWaiters.set(s.task,waiters);waiters.add(check);check();
    });
  }
  private monitor(task:string,execution:Promise<unknown>,milliseconds:number,ignoreDialog?:string){
    let remaining=milliseconds,started=Date.now(),paused=false,finished=false,timer:ReturnType<typeof setTimeout>|undefined;
    let notice:()=>void=()=>{};
    const pending=new Promise<{pending:true}>(resolve=>{notice=()=>resolve({pending:true});});
    let timeout:(error:Error)=>void=()=>{};
    const expired=new Promise<never>((_resolve,reject)=>{timeout=reject;});void expired.catch(()=>{});
    const update=()=>{
      if(finished)return;
      if(!paused)remaining-=Date.now()-started;
      if(timer)clearTimeout(timer);
      const s=this.sessions.get(task);paused=!!s?.dialogs.hasPending;started=Date.now();
      if(s&&[...s.dialogs.pending.values()].some(d=>d.id!==ignoreDialog&&!d.handling))notice();
      if(!paused)timer=setTimeout(()=>{
        finished=true;timeout(Error('Browser operation timed out; its owned session is closed and the receipt remains unknown'));
        const current=this.sessions.get(task);this.sessions.delete(task);current?.dialogs.abandon();current?.choosers.close();if(current)this.downloads.abandon(current.context);
        if(current)void this.closeSession(current).catch(()=>{});
      },Math.max(0,remaining));
    };
    const waiters=this.dialogWaiters.get(task)??new Set();this.dialogWaiters.set(task,waiters);waiters.add(update);update();
    const clean=()=>{finished=true;if(timer)clearTimeout(timer);waiters.delete(update);if(!waiters.size)this.dialogWaiters.delete(task);};
    void execution.then(clean,clean);
    return {outcome:Promise.race([execution.then(value=>({value})),pending,expired]),finished:()=>finished};
  }
  private async navigate(s:Session,operation:()=>Promise<unknown>){
    const page=s.page,url=page.url(),version=s.frameVersions.get(page.mainFrame());
    let dialog:ReturnType<BrowserDialogs['get']>|undefined,notify:(d:ReturnType<BrowserDialogs['get']>)=>void=()=>{};
    const seen=new Promise<{dialog:ReturnType<BrowserDialogs['get']>}>(resolve=>{notify=d=>resolve({dialog:d});});
    const check=()=>{dialog=[...s.dialogs.pending.values()].find(d=>d.page===page&&d.dialog.type()==='beforeunload');if(dialog)notify(dialog);};
    const waiters=this.dialogWaiters.get(s.task)??new Set();this.dialogWaiters.set(s.task,waiters);waiters.add(check);
    const native=operation(),settled=native.then(()=>({completed:true} as const),error=>({error}));check();
    try{
      const outcome=await Promise.race([settled,seen]);
      if('completed' in outcome)return true;
      if('error' in outcome){
        if(!/ERR_ABORTED|beforeunload|navigation cancelled/i.test(String(outcome.error)))throw outcome.error;
        await new Promise<void>(resolve=>setTimeout(resolve,50));check();if(!dialog)throw outcome.error;
      }else dialog=outcome.dialog;
      // Join the exact acknowledged native choice, without resending the
      // navigation even when Page.navigate reports ERR_ABORTED early.
      if(!await dialog!.choice){
        if(page.url()!==url||s.frameVersions.get(page.mainFrame())!==version)throw Error('Document changed while cancelling navigation');
        return false;
      }
      const after=await settled;
      if('error' in after&&!/ERR_ABORTED|beforeunload|navigation cancelled/i.test(String(after.error)))throw after.error;
      // An acknowledged navigation may redirect within the granted origins.
      // Wait for the native document transition, not the requested URL string.
      if('error' in after)await page.waitForURL(()=>page.url()!==url||s.frameVersions.get(page.mainFrame())!==version,{waitUntil:'domcontentloaded',timeout:0});
      else await page.waitForLoadState('domcontentloaded',{timeout:0});
      return true;
    }finally{waiters.delete(check);}
  }
  private permitted(value:string){try{return this.origins.has(new URL(value).origin);}catch{return false;}}
  // Diagnostic logs belong to one owned tab. Do not expose request/response bodies,
  // headers, query parameters, fragments or off-origin destinations.
  private safeDiagnosticUrl(value:string){
    try{
      if(!this.permitted(value))return '[blocked-origin]';
      const u=new URL(value);
      return u.origin+u.pathname.slice(0,300);
    }catch{return '[invalid-url]';}
  }
  private async networkJsonEvidence(request:Request,entry:BrowserNetworkEntry):Promise<NetworkJsonEvidence>{
    if(entry.state!=='completed')return {available:false,reason:'response_not_completed'};
    const response=await request.response();
    const headers=response?.headers(),mime=headers?.['content-type']?.split(';')[0]?.trim().toLowerCase()??'';
    const size=Number(headers?.['content-length']);
    if(!response)return {available:false,reason:'response_unavailable'};
    if(!/^application\/(?:json|[a-z0-9.+_-]+\+json)$/.test(mime))return {available:false,reason:'not_json_content_type'};
    if(headers?.['content-length']===undefined||!Number.isSafeInteger(size)||size<0||size>65536)return {available:false,reason:'json_size_unknown_or_too_large'};
    try{
      const body=await response.body();
      if(body.length>65536)return {available:false,reason:'json_too_large'};
      // Never allow a body assertion to reveal or correlate private fields.
      const clean=sanitizedNetworkBody(body.toString('utf8'));
      return typeof clean.text==='string'?{available:true,value:JSON.parse(clean.text)}:{available:false,reason:'json_sanitizer_limits'};
    }catch{return {available:false,reason:'invalid_or_unavailable_json'};}
  }
  private async historyEntry(session:Session,action:'back'|'forward'){
    const cdp=await session.context.newCDPSession(session.page);
    try{
      const history=await cdp.send('Page.getNavigationHistory');
      const entry=history.entries[history.currentIndex+(action==='back'?-1:1)];
      if(!entry)throw Error('No '+action+' history entry');
      if(!this.permitted(entry.url))throw Error('History destination origin is not authorized');
      return {id:entry.id,url:entry.url};
    }finally{await cdp.detach();}
  }
  private async checkedControl(session:Session,ref:string){
    const entry=JSON.parse(session.refs.get(ref)!);
    const pin=session.frames.get(entry.frame_id)!;this.assertFrame(session,pin);
    const node=session.nodes.get(ref)!;
    const current=await node.evaluate(e=>({tag:e.tagName,text:(e.textContent??'').trim().slice(0,120),type:e.getAttribute('type')?.toLowerCase()??'',editable:e instanceof HTMLElement&&e.isContentEditable,label:e.getAttribute('aria-label')??e.getAttribute('placeholder')??'',role:(e.getAttribute('role')??'').slice(0,80),test_id:(e.getAttribute('data-testid')??'').slice(0,160),draggable:e instanceof HTMLElement&&e.draggable,...(e instanceof HTMLInputElement&&e.type==='file'?{file:{multiple:e.multiple,directory:e.hasAttribute('webkitdirectory'),accept:e.accept.slice(0,200)}}:{}),connected:e.isConnected}));
    const expected={tag:entry.tag,text:entry.text,type:entry.type,editable:entry.editable,label:entry.label,role:entry.role,test_id:entry.test_id,draggable:entry.draggable,...(entry.file?{file:entry.file}:{})};
    if(!current.connected||JSON.stringify({...current,connected:undefined})!==JSON.stringify(expected))throw Error('Page changed; inspect again');
    this.assertFrame(session,pin);return {node,current,pin};
  }
  private frameAllowed(frame:Frame){
    for(let current:Frame|null=frame;current;current=current.parentFrame()){
      if(current.isDetached())return false;
      const url=current.url();
      if(this.permitted(url))continue;
      // Inline documents are authored by their parent. Every non-inline
      // ancestor must still have an explicit origin grant.
      if(current.parentFrame()&&(/^about:(blank|srcdoc)(?:[?#]|$)/.test(url)||url.startsWith('data:')))continue;
      return false;
    }
    return true;
  }
  private assertFrame(session:Session,pin:FramePin){
    if(!pin||pin.frame.page()!==session.page||pin.frame.isDetached()||pin.frame.url()!==pin.url||session.frameVersions.get(pin.frame)!==pin.version)throw Error('Frame changed; inspect again');
    if(!this.frameAllowed(pin.frame))throw Error('Frame origin is not authorized');
  }
  private frameId(session:Session,frame:Frame){
    let id=session.frameIds.get(frame);if(!id){id=randomUUID();session.frameIds.set(frame,id);}return id;
  }
  private frameUrl(frame:Frame){return frame.url().startsWith('data:')?'[inline-frame]':frame.url().slice(0,1600);}
  private async snapshot(session:Session,selected?:string){
    await this.waitForDialogs(session);await session.choosers.ready();
    session.revision=randomUUID();session.refs.clear();
    await Promise.all([...session.nodes.values()].map(n=>n.dispose().catch(()=>{})));session.nodes.clear();session.frames.clear();
    const all=session.page.frames(),frames=all.slice(0,32),views:any[]=[],refs:any[]=[];let text='';
    try{
      for(const frame of frames){
        const frame_id=this.frameId(session,frame),parent=frame.parentFrame();
        const pin={frame,version:session.frameVersions.get(frame)!,url:frame.url()};session.frames.set(frame_id,pin);
        const authorized=this.frameAllowed(frame);
        const view={frame_id,parent_id:parent?this.frameId(session,parent):null,url:authorized?this.frameUrl(frame):'[blocked-origin]',name:authorized?frame.name().slice(0,160):'',authorized,state:authorized?'not-selected':'blocked',text:''};views.push(view);
        if(!authorized||(selected&&frame_id!==selected))continue;
        let captured:JSHandle<Element[]>|undefined;
        let handles:Map<string,JSHandle>|undefined;
        try{
          captured=await frame.evaluateHandle(({selector,limit})=>Array.from(document.querySelectorAll(selector)).filter(e=>!['IFRAME','FRAME'].includes(e.tagName)).slice(0,limit),{selector:controlSelector,limit:150-refs.length});
          const controls=await captured.evaluate(nodes=>nodes.map((e,index)=>({index,tag:e.tagName,text:(e.textContent??'').trim().slice(0,120),type:e.getAttribute('type')?.toLowerCase()??'',editable:e instanceof HTMLElement&&e.isContentEditable,label:e.getAttribute('aria-label')??e.getAttribute('placeholder')??'',role:(e.getAttribute('role')??'').slice(0,80),test_id:(e.getAttribute('data-testid')??'').slice(0,160),draggable:e instanceof HTMLElement&&e.draggable,...(e instanceof HTMLInputElement&&e.type==='file'?{file:{multiple:e.multiple,directory:e.hasAttribute('webkitdirectory'),accept:e.accept.slice(0,200)}}:{}),...(e instanceof HTMLInputElement&&e.type==='checkbox'?{checked:e.checked}:{}),...(e instanceof HTMLSelectElement?{options:Array.from(e.options).slice(0,100).map(o=>({value:o.value,label:o.label,selected:o.selected}))}:{})})));
          const body=await frame.evaluate(()=>document.body?.innerText.slice(0,16000)??'');
          handles=await captured.getProperties();this.assertFrame(session,pin);
          for(const c of controls){
            const node=handles.get(String(c.index))!.asElement() as ElementHandle<HTMLElement|SVGElement>;
            const ref=String(refs.length+1),entry={...c,frame_id};session.nodes.set(ref,node);session.refs.set(ref,JSON.stringify(entry));refs.push({ref,...entry});
            handles.delete(String(c.index));
          }
          view.state=refs.length>=150?'bounded':'captured';view.text=body.slice(0,Math.max(0,16000-text.length));text+=(text?'\n':'')+view.text;text=text.slice(0,16000);
        }catch(error){
          // A child navigating during traversal must not turn a successful
          // parent action into an unknown result. Publish no content or refs
          // from its lost document. Unrelated failures still retain unknown.
          const changed=frame.isDetached()||frame.url()!==pin.url||session.frameVersions.get(frame)!==pin.version||!this.frameAllowed(frame);
          if(!changed||frame===session.page.mainFrame())throw error;
          view.state='changed';view.authorized=false;view.url='[changed-frame]';view.name='';
        }finally{await captured?.dispose().catch(()=>{});if(handles)await Promise.all([...handles.values()].map(h=>h.dispose().catch(()=>{})));}
      }
      // A later frame read can overlap a navigation in an earlier frame. Do not
      // publish its stale nodes or text after the full traversal.
      for(const view of views){
        const pin=session.frames.get(view.frame_id)!;
        if(pin.frame.isDetached()||pin.frame.url()!==pin.url||session.frameVersions.get(pin.frame)!==pin.version||(view.authorized&&!this.frameAllowed(pin.frame))){
          view.text='';view.state='changed';view.authorized=false;view.url='[changed-frame]';view.name='';
          for(let i=refs.length-1;i>=0;i--)if(refs[i].frame_id===view.frame_id){const ref=refs[i].ref;await session.nodes.get(ref)?.dispose().catch(()=>{});session.nodes.delete(ref);session.refs.delete(ref);refs.splice(i,1);}
        }
      }
      this.assertFrame(session,session.frames.get(this.frameId(session,session.page.mainFrame()))!);
      if(!this.permitted(session.page.url()))throw Error('Current page origin is not authorized');
      return {state:'completed',profile:session.signedIn?'signed_in':'isolated',url:session.page.url(),revision:session.revision,text:views.map(v=>v.text).filter(Boolean).join('\n').slice(0,16000),controls:refs,frames:views,frames_truncated:all.length>32,errors:session.errors,file_choosers:session.choosers.view(),downloads:this.downloads.list(session.task),tabs:[...session.tabs].map(([tab_id,page])=>({tab_id,url:page.url(),active:page===session.page}))};
    }catch(error){session.revision='';session.refs.clear();await Promise.all([...session.nodes.values()].map(n=>n.dispose().catch(()=>{})));session.nodes.clear();throw error;}
  }
  private async observePage(session:Session,page:Page){
    const d:TabDiagnostics={console:[],network:[],requests:new WeakMap(),requestHandles:new Map(),nextRequestIndex:0,console_dropped:0,network_dropped:0};
    session.diagnostics.set(page,d);
    const recordConsole=(type:string,value:string)=>{
      d.console.push({type:textLimit(type,32),text:textLimit(value,700)});
      if(d.console.length>60){d.console.shift();d.console_dropped++;}
    };
    // The outer active-time watchdog cancels the owned context on timeout.
    // Native actions can wait through a human modal decision without expiring.
    page.setDefaultTimeout(0);
    const version=(frame:Frame)=>{this.frameId(session,frame);session.frameVersions.set(frame,randomUUID());};
    for(const frame of page.frames())version(frame);
    page.on('frameattached',version);page.on('framenavigated',version);page.on('framedetached',version);
    page.on('pageerror',e=>{
      session.errors.push(e.message.slice(0,1000));session.errors=session.errors.slice(-20);
      recordConsole('pageerror',e.message);
    });
    page.on('console',m=>{
      if(m.type()==='error'){session.errors.push(m.text().slice(0,1000));session.errors=session.errors.slice(-20);}
      recordConsole(m.type(),m.text());
    });
    page.on('request',request=>{
      const index=++d.nextRequestIndex,entry:BrowserNetworkEntry={index,method:textLimit(request.method(),16),url:this.safeDiagnosticUrl(request.url()),status:null,state:'pending',started_ms:Date.now()};
      d.requests.set(request,entry);d.network.push(entry);d.requestHandles.set(index,request);
      if(d.network.length>80){const evicted=d.network.shift()!;d.requestHandles.delete(evicted.index);d.network_dropped++;}
    });
    page.on('response',response=>{
      const entry=d.requests.get(response.request());
      if(entry){entry.status=response.status();entry.state='response';}
    });
    page.on('requestfinished',request=>{
      const entry=d.requests.get(request);
      if(entry){entry.state='completed';entry.duration_ms=Math.max(0,Date.now()-entry.started_ms);}
    });
    page.on('requestfailed',request=>{
      const entry=d.requests.get(request);
      if(entry){entry.state='failed';entry.failure=textLimit(request.failure()?.errorText??'request-failed',160);entry.duration_ms=Math.max(0,Date.now()-entry.started_ms);}
    });
    await session.dialogs.attach(page);
    session.choosers.attach(page);
    // Downloads are disabled in the signed-in profile (no shared browser CDP).
    if(!session.signedIn)await this.downloads.attach(session.task,session.context,page,frame=>this.frameAllowed(frame),frame=>session.frameVersions.get(frame),url=>this.permitted(url),()=>session.lease);
  }
  async run(task:string,id:string,lease:string,input:{action:string,url?:string,ref?:string,target_ref?:string,frame_id?:string,dialog_id?:string,accept?:boolean,chooser_id?:string,paths?:string[],mime_data?:Record<string,string>,index?:number,part?:string,download_id?:string,path?:string,revision?:string,text?:string,key?:string,value?:string,checked?:boolean,delta_y?:number,tab_id?:string,profile?:string,visible?:boolean,record_video?:boolean,flow?:BrowserNetworkFlow,audit?:BrowserNetworkAudit,list?:BrowserNetworkList}&Omit<ExtraInput,'action'>&BrowserNetworkAssertion&VideoInput,signal?:AbortSignal){
    if([dialogNoticePrefix,chooserNoticePrefix,downloadNoticePrefix].some(prefix=>id.startsWith(prefix)))throw Error('Reserved browser operation ID');
    const gesture=['drag','drop','mouse_stroke','mouse_down','mouse_move','mouse_up','mouse_cancel','mouse_path'].includes(input.action);
    const cancelled=()=>{if(gesture&&signal?.aborted)throw Error('Browser gesture cancelled; inspect its receipt before any retry');};
    cancelled();
    const row=this.engine.task(task);await resolveCanonicalAllowedPath(row.root,row.root,await Promise.all(this.roots.map(r=>realpath(r))));
    this.engine.assertLease(row,lease);
    if(row.status!=='active')throw Error('Task is not active');
    if(input.action==='network_flow_assert')validateNetworkFlow(input.flow!);
    if(input.action==='network_audit')validateNetworkAudit(input.audit);
    if(input.action==='network_list')validateNetworkList(input.list??{});
    const request=JSON.stringify(input.action==='network_assert'?networkAssertionReceipt(input):
      input.action==='network_flow_assert'?{...input,flow:networkFlowReceipt(input.flow!)}:
      input.action==='network_audit'?{...input,audit:networkAuditReceipt(input.audit!)}:
      input.action==='network_list'?{...input,list:networkListReceipt(input.list??{})}:input);
    const prior=this.engine.db.prepare('SELECT * FROM browser_operations WHERE task_id=? AND id=?').get(task,id) as BrowserReceipt|undefined;
    if(prior){if(prior.request!==request)throw Error('Operation ID already used with different arguments');return ['completed','waiting_dialog'].includes(prior.state)?JSON.parse(prior.result):{state:'unknown',message:'Previous action may have executed. Inspect state; never resend automatically.'};}
    const currentSession=this.sessions.get(task),nativeHandler=input.action==='dialog'||(input.action==='upload'&&!!input.chooser_id)||input.action==='download_cancel';
    if(currentSession&&input.action==='close_tab'&&currentSession.tabs.get(input.tab_id??'')===this.extras.recordedPage(currentSession.context))
      throw Error('Stop code recording or close the owned browser session before closing the recorded tab');
    if(currentSession&&this.extras.pointerHeld(currentSession.page)&&!['mouse_move','mouse_path','mouse_up','mouse_cancel','mouse_state','inspect','screenshot','tabs','console','network','network_list','network_request','network_assert','network_flow_assert','network_audit','downloads','close','dialog','annotate_status','annotate_cancel'].includes(input.action))
      throw Error('A pointer is held: move it with hold_id, release/cancel it, or close the owned session first');
    const allowedWaiting=nativeHandler&&currentSession?[...currentSession.dialogs.notices,...currentSession.choosers.notices,...this.downloads.pendingNotices(task),...(currentSession.suspended?[currentSession.suspended.id]:[])]:[];
    this.engine.assertIdle(row,(['inspect','tabs','screenshot','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit','downloads','close','video_status','annotate_status'].includes(input.action)||EXTRA_READ_ONLY.includes(input.action)),allowedWaiting);
    // Reject invalid input before recording an operation as unknown. A rejected
    // parameter never reached the browser and must not lock subsequent actions.
    if(!['open','back','forward','reload','inspect','tabs','new_tab','switch_tab','close','close_tab','click','fill','select','press','check','hover','drag','drop','scroll','dialog','upload','downloads','download_save','download_cancel','screenshot','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit'].includes(input.action)&&!isExtraAction(input.action)&&!isVideoAction(input.action)&&!isAnnotationAction(input.action))
      throw Error('Unsupported browser action');
    if(input.action==='dialog'){
      if(!input.dialog_id||typeof input.accept!=='boolean'||!currentSession)throw Error('Dialog requires a captured dialog_id and boolean accept');
      const dialog=currentSession.dialogs.get(input.dialog_id);
      if(!currentSession.dialogs.authorized(dialog))throw Error('Dialog origin or document is not authorized; close the owned session or inspect again');
      if(input.text!==undefined&&(dialog.dialog.type()!=='prompt'||!input.accept))throw Error('Text is supported only when accepting a prompt');
    }else if(input.dialog_id!==undefined||input.accept!==undefined)throw Error('Dialog parameters require the dialog action');
    if(currentSession?.dialogs.hasPending&&!['inspect','tabs','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit','downloads','close','dialog','annotate_status','annotate_cancel'].includes(input.action))throw Error('Handle the pending dialog or close the owned session first');
    if(input.action==='network_audit'&&!currentSession?.diagnostics.has(currentSession.page))throw Error('Open a browser session with a network collector first');
    if(['network_list','network_clear'].includes(input.action)&&!currentSession?.diagnostics.has(currentSession.page))throw Error('Open a browser session with a network collector first');
    if(input.action==='network_flow_assert'){
      if(input.index!==undefined||input.part!==undefined)throw Error('Network flow requires indexes inside flow.steps, without index or part');
      const d=currentSession?.diagnostics.get(currentSession.page);
      if(!d)throw Error('Open a browser session with a network collector first');
      for(const step of input.flow!.steps){
        const req=d.requestHandles.get(step.index);
        if(!req)throw Error('Unknown or expired current-tab network request index');
        if(!this.permitted(req.url()))throw Error('Network request origin is not authorized');
        try{if(!this.frameAllowed(req.frame()))throw Error('Network request frame origin is not authorized');}
        catch{throw Error('Network request frame no longer authorized');}
      }
    }
    if(input.action==='network_request'||input.action==='network_assert'){
      if(input.action==='network_assert'){
        validateNetworkAssertion(input);
        if(input.part!==undefined)throw Error('Network assertion does not accept a response part');
      }
      const d=currentSession?.diagnostics.get(currentSession.page);
      if(!d||!Number.isInteger(input.index)||!d.requestHandles.has(input.index!))throw Error('Unknown or expired current-tab network request index');
      const request=d.requestHandles.get(input.index!)!;
      if(!this.permitted(request.url()))throw Error('Network request origin is not authorized');
      try{if(!this.frameAllowed(request.frame()))throw Error('Network request frame origin is not authorized');}
      catch{throw Error('Network request frame no longer authorized');}
      if(input.part!==undefined&&!['request-headers','request-body','response-headers','response-body'].includes(input.part))throw Error('Invalid network request part');
    }else if(input.index!==undefined||input.part!==undefined)throw Error('Network index and part require network_request or network_assert');
    if(input.action!=='network_flow_assert'&&input.flow!==undefined)throw Error('Network flow parameters require network_flow_assert');
    if(input.action!=='network_audit'&&input.audit!==undefined)throw Error('Network audit parameters require network_audit');
    if(input.action!=='network_list'&&input.list!==undefined)throw Error('Network list filters require network_list');
    if(input.action!=='accessibility_audit'&&input.max_issues!==undefined)throw Error('max_issues is only valid for accessibility_audit');
    if(input.action!=='network_assert'&&[input.expected_state,input.expected_status,input.status_min,input.status_max,input.expected_method,input.expected_path,input.max_duration_ms,input.json_checks].some(value=>value!==undefined))
      throw Error('Network assertion parameters require network_assert');
    if(input.action!=='upload'&&input.chooser_id!==undefined)throw Error('File chooser parameters require the upload action');
    if(!['mouse_stroke','mouse_path'].includes(input.action)&&input.points!==undefined)throw Error('Gesture points require mouse_stroke or mouse_path');
    if(!['mouse_move','mouse_path','mouse_up','mouse_cancel'].includes(input.action)&&input.hold_id!==undefined)throw Error('hold_id requires a held-pointer action');
    if(!['upload','drop'].includes(input.action)&&input.paths!==undefined)throw Error('File paths require upload or drop');
    if(input.action!=='drop'&&input.mime_data!==undefined)throw Error('MIME data requires the drop action');
    if(!['download_save','download_cancel'].includes(input.action)&&(input.download_id!==undefined||(input.path!==undefined&&!['trace_stop','pdf','close','storage_state','set_storage_state','record_stop','record_export','video_stop','annotate_export'].includes(input.action))))throw Error('Download parameters require an artifact-producing action');
    if([input.video_size,input.video_fps].some(value=>value!==undefined)&&input.action!=='video_start')throw Error('Video size and FPS require video_start');
    if([input.title,input.description].some(value=>value!==undefined)&&input.action!=='video_chapter')throw Error('Chapter title and description require video_chapter');
    if([input.video_position,input.video_cursor].some(value=>value!==undefined)&&input.action!=='video_show_actions')throw Error('Video action position and cursor require video_show_actions');
    if(input.video_duration_ms!==undefined&&!['video_chapter','video_show_actions'].includes(input.action))throw Error('Video duration requires video_chapter or video_show_actions');
    if(input.action==='video_start'){
      if(!currentSession)throw Error('Open a browser session before video_start');
      if(currentSession.videoDir)throw Error('The session is already using open(record_video); close(path) to save it');
      if(this.videos.has(currentSession.context))throw Error('Video recording is already present; stop it first');
      if(!videoRecorderAvailable())throw Error('Video recording needs the Playwright ffmpeg component, which is not installed');
      for(const page of currentSession.tabs.values())if(!this.permitted(page.url())||page.frames().some(frame=>!this.frameAllowed(frame)))throw Error('Video tabs require authorized origins and frames');
      if(input.video_size!==undefined&&(!Number.isInteger(input.video_size.width)||!Number.isInteger(input.video_size.height)||input.video_size.width<320||input.video_size.width>1920||input.video_size.height<200||input.video_size.height>1080))throw Error('Video size must be 320..1920 by 200..1080');
      if(input.video_fps!==undefined&&(!Number.isInteger(input.video_fps)||input.video_fps<5||input.video_fps>30))throw Error('Video FPS must be between 5 and 30');
    }
    if(input.action==='video_stop'){
      if(!currentSession)throw Error('Open a browser session before video_stop');
      this.videos.validateStop(currentSession.context,row.root,input.path);
    }
    if(['video_chapter','video_show_actions','video_hide_actions','video_status','video_pause','video_resume'].includes(input.action)&&!currentSession)
      throw Error('Open a browser session before video actions');
    if(input.action==='video_pause'&&currentSession&&!this.videos.active(currentSession.context))
      throw Error('Only an active video recording can be paused');
    if(input.action==='video_resume'&&currentSession){
      if(!this.videos.paused(currentSession.context))throw Error('Pause video before resuming');
      if(!this.videos.canResume(currentSession.context,currentSession.tabs.size))throw Error('Video resume would exceed the 16-segment limit');
      for(const page of currentSession.tabs.values())if(!this.permitted(page.url())||page.frames().some(frame=>!this.frameAllowed(frame)))
        throw Error('Video resume requires authorized origins and frames');
    }
    if(input.action==='video_chapter'&&(!input.title||input.title.length>120||input.description!==undefined&&input.description.length>400))
      throw Error('video_chapter requires a title up to 120 characters and description up to 400');
    if(input.video_duration_ms!==undefined&&(!Number.isInteger(input.video_duration_ms)||input.video_duration_ms<100||input.video_duration_ms>12000))
      throw Error('Video overlay duration must be between 100 and 12000 ms');
    if(['video_chapter','video_show_actions','video_hide_actions'].includes(input.action)&&currentSession&&
      (!this.permitted(currentSession.page.url())||currentSession.page.frames().some(frame=>!this.frameAllowed(frame))))
      throw Error('Video overlays require an authorized current page and frames');
    let annotationPlan:AnnotationExportPlan|undefined;
    if(isAnnotationAction(input.action)){
      if(!currentSession)throw Error('Open a browser session before annotation review');
      if(input.action==='annotate_begin')this.annotations.canBegin(currentSession.context);
      if(input.action==='annotate_capture')await this.annotations.canCapture(currentSession.context);
      if(['annotate_begin','annotate_capture'].includes(input.action)&&
        (!this.permitted(currentSession.page.url())||currentSession.page.frames().some(frame=>!this.frameAllowed(frame))))
        throw Error('Annotation requires an authorized page and frames');
      if(input.action==='annotate_export')annotationPlan=this.annotations.prepareExport(currentSession.context,row.root,input.path);
      if(input.action!=='annotate_export'&&input.path!==undefined)throw Error('Only annotate_export accepts a path');
    }
    let upload:PreparedUpload|undefined,uploadNode:ElementHandle<HTMLElement|SVGElement>|undefined,uploadPin:FramePin|undefined,uploadChooser:Awaited<ReturnType<BrowserFileChoosers['get']>>|undefined,uploadFile:{multiple:boolean,directory:boolean}|undefined;
    let dropFile:PreparedUpload|undefined,dropNode:ElementHandle<HTMLElement|SVGElement>|undefined,dropPin:FramePin|undefined;
    if(input.action==='drop'){
      if(!currentSession||!input.ref||input.revision!==currentSession.revision||!currentSession.refs.has(input.ref))throw Error('Stale page reference; inspect again');
      if(!input.paths?.length&&!input.mime_data)throw Error('Drop requires paths or MIME data');
      if(input.paths!==undefined&&(!Array.isArray(input.paths)||input.paths.length>16||input.paths.some(p=>typeof p!=='string'||!p)))throw Error('Drop file paths must be a nonempty string array of at most 16 task files');
      if(input.mime_data!==undefined){
        if(!input.mime_data||Array.isArray(input.mime_data)||typeof input.mime_data!=='object')throw Error('MIME data must be an object');
        const entries=Object.entries(input.mime_data);
        if(entries.length>16||entries.some(([type,value])=>!/^[-\w.+]+\/[-\w.+]+$/.test(type)||typeof value!=='string'||Buffer.byteLength(value)>16384)||Buffer.byteLength(JSON.stringify(input.mime_data))>65536)throw Error('Drop MIME data exceeds 16 types, 16 KiB per value, or 64 KiB total');
      }
      const checked=await this.checkedControl(currentSession,input.ref);
      if(['password','file'].includes(checked.current.type))throw Error('Cannot drop onto a password or file input');
      dropNode=checked.node;dropPin=checked.pin;
      if(input.paths?.length){
        dropFile=new PreparedUpload(row.root,input.paths,false);
        if(currentSession.uploadStages.size>=16||currentSession.uploadBytes+dropFile.files.reduce((sum,f)=>sum+f.size,0)>64*1024*1024)throw Error('Session file staging exceeds 16 selections or 64 MiB');
      }
    }
    if(input.action==='upload'){
      if(!currentSession)throw Error('Open a browser session first');
      if(input.chooser_id){if(input.ref!==undefined||input.revision!==undefined)throw Error('File chooser upload does not use ref or revision');uploadChooser=await currentSession.choosers.get(input.chooser_id);uploadNode=uploadChooser.node;}
      else{
        if(currentSession.choosers.pending.size)throw Error('Use the pending chooser_id before another upload');
        if(!input.ref||!currentSession.refs.has(input.ref)||input.revision!==currentSession.revision)throw Error('Stale page reference; inspect again');
        const target=await this.checkedControl(currentSession,input.ref);if(target.current.tag!=='INPUT'||target.current.type!=='file')throw Error('Upload requires a captured file input');uploadNode=target.node;uploadPin=target.pin;
      }
      uploadFile=await uploadNode.evaluate(e=>({multiple:e instanceof HTMLInputElement&&e.multiple,directory:e.hasAttribute('webkitdirectory')}));
      if(uploadPin){this.assertFrame(currentSession,uploadPin);if(input.revision!==currentSession.revision)throw Error('Stale page reference; inspect again');}
      if(uploadChooser&&(!currentSession.choosers.authorized(uploadChooser)||uploadChooser.chooser.isMultiple()!==uploadFile.multiple))throw Error('File chooser document or options changed');
      if(input.paths===undefined){if(!uploadChooser)throw Error('Upload requires paths; omitted paths cancel only a captured chooser');}
      else{
        if(!Array.isArray(input.paths)||input.paths.some(p=>typeof p!=='string'))throw Error('Upload paths must be a string array');
        if(!uploadFile.multiple&&!uploadFile.directory&&input.paths.length>1)throw Error('This file input does not accept multiple files');
        upload=new PreparedUpload(row.root,input.paths,uploadFile.directory);
        if(currentSession.uploadStages.size>=16||currentSession.uploadBytes+upload.files.reduce((sum,f)=>sum+f.size,0)>64*1024*1024)throw Error('Session upload staging exceeds 16 selections or 64 MiB; close and open a new owned session');
      }
    }
    if(input.record_video!==undefined&&(input.action!=='open'||typeof input.record_video!=='boolean'||this.sessions.has(task)))throw Error('record_video is only valid when open starts a new session');
    if(input.record_video&&!videoRecorderAvailable())throw Error('Session recording needs the Playwright ffmpeg component, which is not installed; nothing was recorded');
    if(input.visible!==undefined&&(input.action!=='open'||typeof input.visible!=='boolean'||!!this.sessions.has(task)||input.profile==='signed_in'))
      throw Error('visible is supported only for a new isolated open; the dedicated signed-in profile is already visible');
    let videoTarget:string|undefined;
    if(input.action==='close'&&input.path!==undefined){
      const current=this.sessions.get(task);
      if(!current?.videoDir)throw Error('close(path) saves a recording; open the session with record_video first');
      videoTarget=projectFilePath(row.root,input.path);
      try{lstatSync(videoTarget);throw Error('Destination already exists; overwrite is refused');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    let save:ReturnType<BrowserDownloads['prepareSave']>|undefined;
    if(input.action==='download_save'){if(!input.download_id||!input.path)throw Error('Download save requires a completed download_id and relative path');save=this.downloads.prepareSave(task,input.download_id,input.path);}
    if(input.action==='download_cancel'&&(!input.download_id||input.path!==undefined||!this.downloads.pendingNotices(task).includes(downloadNoticePrefix+input.download_id)))throw Error('Download cancel requires a pending download_id without path');
    if(input.action==='scroll'&&(!Number.isInteger(input.delta_y)||Math.abs(input.delta_y!)>2000||input.delta_y===0))throw Error('Scroll delta must be a nonzero integer within 2000 pixels');
    if(input.action==='press'&&!['Tab','Enter','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Backspace','Delete'].includes(input.key??''))throw Error('Unsupported browser key');
    if(input.action==='select'&&typeof input.value!=='string')throw Error('Select requires an option value');
    if(input.action==='check'&&typeof input.checked!=='boolean')throw Error('Check requires a boolean checked state');
    if(['open','new_tab'].includes(input.action)&&(!input.url||!this.permitted(input.url)))throw Error('網站尚未由本機管理頁授權');
    if(input.profile!==undefined){
      if(input.action!=='open'||!['isolated','signed_in'].includes(input.profile))throw Error('profile is only valid for open: isolated or signed_in');
      if(input.profile==='signed_in'){
        if(!this.signedIn)throw Error('The signed-in browser profile is not enabled in the local configuration');
        const current=this.sessions.get(task);
        if(current&&!current.signedIn)throw Error('Close the isolated session before opening the signed-in profile');
        if(!current&&[...this.sessions.values()].some(other=>other.signedIn))throw Error('The signed-in profile is in use by another task');
      }
    }
    if(['new_tab','switch_tab','close_tab','tabs'].includes(input.action)){
      const current=this.sessions.get(task);if(!current)throw Error('Open a browser session first');
      if(input.action==='new_tab'&&current.tabs.size>=8)throw Error('At most 8 test tabs per task');
      if(input.action==='new_tab'&&!this.videos.canAddPage(current.context))throw Error('A video can include at most 16 tab recordings; stop video before opening another tab');
      if(['switch_tab','close_tab'].includes(input.action)&&(!input.tab_id||!current.tabs.has(input.tab_id)))throw Error('Unknown task tab');
      if(input.action==='close_tab'&&current.tabs.size===1)throw Error('Use close to close the final tab and session');
    }
    if(['click','fill','select','press','check','hover','drag'].includes(input.action)){
      const current=this.sessions.get(task);if(!current||input.revision!==current.revision||!input.ref||!current.refs.has(input.ref))throw Error('Stale page reference; inspect again');
      const target=JSON.parse(current.refs.get(input.ref)!) as {tag:string;type:string;editable:boolean};
      this.assertFrame(current,current.frames.get(JSON.parse(current.refs.get(input.ref)!).frame_id)!);
      if(input.action==='select'&&target.tag!=='SELECT')throw Error('Select requires an accessible dropdown');
      if(input.action==='check'&&(target.tag!=='INPUT'||target.type!=='checkbox'))throw Error('Check requires a checkbox input');
      if(input.action==='fill'&&((!['INPUT','TEXTAREA'].includes(target.tag)&&!target.editable)||['password','file'].includes(target.type)))
        throw Error('Fill requires a non-secret form control');
      if(input.action==='press'&&((!['INPUT','TEXTAREA','SELECT'].includes(target.tag)&&!target.editable)||['password','file'].includes(target.type)))
        throw Error('Key press requires a non-secret form control');
      if(input.action==='drag'){
        if(!input.target_ref||!current.refs.has(input.target_ref)||input.target_ref===input.ref)throw Error('Drag requires a distinct target_ref from the current snapshot');
        const destination=JSON.parse(current.refs.get(input.target_ref)!) as {type:string};
        this.assertFrame(current,current.frames.get(JSON.parse(current.refs.get(input.target_ref)!).frame_id)!);
        if(['password','file'].includes(target.type)||['password','file'].includes(destination.type))throw Error('Password and file inputs require manual handling');
      }
    }
    let selectedFrame:FramePin|undefined;
    if(input.frame_id){
      if(!['inspect','scroll',...EXTRA_FRAME_ACTIONS].includes(input.action))throw Error('frame_id is supported only by inspect, scroll, storage, evaluate, assert, find, wait_for and related frame actions');
      const current=this.sessions.get(task);selectedFrame=current?.frames.get(input.frame_id);
      if(!current||!selectedFrame||selectedFrame.frame.page()!==current.page||selectedFrame.frame.isDetached())throw Error('Unknown current-tab frame; inspect again');
      if(!this.frameAllowed(selectedFrame.frame))throw Error('Frame origin is not authorized');
      if(input.action==='scroll'){if(input.revision!==current.revision)throw Error('Stale page reference; inspect again');this.assertFrame(current,selectedFrame);}
    }
    const extraPrepared=isExtraAction(input.action)?this.extras.validate(input,row.root,this.sessions.get(task),selectedFrame?.frame):undefined;
    if(input.action==='screenshot'){
      const current=this.sessions.get(task);
      if(current&&current.page.frames().some(frame=>!this.frameAllowed(frame)))throw Error('Screenshot contains a frame without an origin grant');
    }
    let navigation:{page:Page;entry?:{id:number;url:string}}|undefined;
    if(['back','forward','reload'].includes(input.action)){
      const current=this.sessions.get(task);
      if(!current||input.revision!==current.revision||!current.revision)throw Error('Stale page reference; inspect again');
      if(!this.permitted(current.page.url()))throw Error('Current page origin is not authorized');
      const page=current.page;
      const entry=input.action==='reload'?undefined:await this.historyEntry(current,input.action as 'back'|'forward');
      if(this.sessions.get(task)!==current||current.page!==page||input.revision!==current.revision)throw Error('Page changed during history inspection; inspect again');
      navigation={page,entry};
    }
    if(this.busy.has(task))throw Error('Browser operation already running');
    cancelled();
    // Root and history inspection await I/O. Recheck authority and persist the
    // intent under the same database lock so a competing handoff cannot slip in.
    const raced=this.engine.db.transaction(()=>{
      const latest=this.engine.task(task);this.engine.assertLease(latest,lease);
      if(latest.status!=='active')throw Error('Task is not active');
      const previous=this.engine.db.prepare('SELECT request,state,result FROM browser_operations WHERE task_id=? AND id=?').get(task,id) as BrowserReceipt|undefined;
      if(previous){if(previous.request!==request)throw Error('Operation ID already used with different arguments');return previous;}
      this.engine.assertIdle(latest,(['inspect','tabs','screenshot','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit','downloads','close','video_status','annotate_status'].includes(input.action)||EXTRA_READ_ONLY.includes(input.action)),allowedWaiting);
      upload?.revalidate();dropFile?.revalidate();
      if(uploadPin)this.assertFrame(currentSession!,uploadPin);
      if(dropPin)this.assertFrame(currentSession!,dropPin);
      if(uploadChooser&&!currentSession!.choosers.authorized(uploadChooser))throw Error('File chooser document changed before dispatch');
      this.engine.db.prepare('INSERT INTO browser_operations VALUES(?,?,?,?,NULL)').run(task,id,request,'unknown');
      this.engine.event(task,'browser_started',{operation_id:id,action:input.action});
      return undefined;
    }).immediate();
    if(raced)return ['completed','waiting_dialog'].includes(raced.state)?JSON.parse(raced.result):{state:'unknown',message:'Previous action may have executed. Inspect state; never resend automatically.'};
    this.busy.add(task);
    this.engine.interactionBusy.add(task);
    let abortCleanup:Promise<void>|undefined;
    const onAbort=()=>{
      const session=this.sessions.get(task);this.sessions.delete(task);
      session?.dialogs.abandon();
      session?.choosers.close();if(session)this.downloads.abandon(session.context);
      if(session)abortCleanup=this.closeSession(session).catch(error=>{this.engine.event(task,'browser_cancel_cleanup_failed',{operation_id:id,error:String(error)});});
    };
    if(gesture)signal?.addEventListener('abort',onAbort,{once:true});
    let handled:unknown,handling:Promise<unknown>|undefined,navigationCancelled=false,ownedSession:Session|undefined;
    const finish=(result:unknown)=>{
      if(input.action!=='close'&&ownedSession?.dialogs.stopping)throw Error('Browser session closed; inspect its unknown receipt');
      this.engine.db.transaction(()=>{
        cancelled();
        this.engine.db.prepare('UPDATE browser_operations SET state=?,result=? WHERE task_id=? AND id=?').run('completed',JSON.stringify(result),task,id);
        this.engine.event(task,'browser_completed',{operation_id:id,action:input.action});
      }).immediate();return result;
    };
    const execution=(async()=>{try{
      cancelled();
      let s=this.sessions.get(task);
      if(s)s.lease=lease;
      ownedSession=s;
      if(input.action==='open'){
        if(!input.url||!this.permitted(input.url))throw Error('網站尚未由本機管理頁授權');
        if(input.profile!=='signed_in'&&!input.visible&&!this.browser){
          // On Windows, headless Chrome's GPU compositor can stop producing
          // frames while DOM reads still work. Use software rendering for this
          // owned browser; keep native actionability checks and the watchdog.
          this.browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,...(process.platform==='win32'?{args:['--disable-gpu']}:{} )});
          await this.downloads.initialize(this.browser);
        }
        if(!s){
          const network=await createBrowserNetwork(url=>this.permitted(url));this.networks.add(network);
          // The signed-in profile is a dedicated persistent Chrome profile in a
          // visible window; its sign-ins persist. Origin grants still apply and
          // downloads stay disabled for it.
          const signedIn=input.profile==='signed_in';
          const visibleBrowser=!signedIn&&input.visible
            ?await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,...(process.platform==='win32'?{args:['--disable-gpu']}:{} )})
            :undefined;
          // Optional session recording into an owned directory; saved by close(path).
          const videoDir=input.record_video?await mkdtemp(join(tmpdir(),'forge-browser-video-')):undefined;
          const recordVideo=videoDir?{recordVideo:{dir:videoDir,size:{width:1280,height:800}}}:{};
          const context=signedIn
            ?await chromium.launchPersistentContext(this.signedIn!.userDataDir,{channel:'chrome',headless:this.signedIn!.headless??false,proxy:network.proxy,acceptDownloads:false,serviceWorkers:'block',viewport:{width:1280,height:800},...recordVideo})
            :await (visibleBrowser??this.browser)!.newContext({proxy:network.proxy,acceptDownloads:true,serviceWorkers:'block',viewport:{width:1280,height:800},...recordVideo});
          await context.route('**/*',route=>this.permitted(route.request().url())?route.continue():route.abort('blockedbyclient'));
          const page=signedIn&&context.pages().length?context.pages()[0]!:await context.newPage();
          s={task,lease,signedIn,visibleBrowser,videoDir,network,uploadStages:new Set(),uploadBytes:0,choosers:undefined!,dialogs:undefined!,context,page,revision:'',refs:new Map(),nodes:new Map(),frames:new Map(),frameIds:new WeakMap(),frameVersions:new WeakMap(),tabs:new Map([[randomUUID(),page]]),errors:[],diagnostics:new Map()};
          s.dialogs=new BrowserDialogs(this.engine,task,frame=>s!.frameVersions.get(frame),frame=>this.frameAllowed(frame),page=>[...s!.tabs].find(([,value])=>value===page)?.[0],()=>this.notifyDialogs(task));
          s.choosers=new BrowserFileChoosers(this.engine,task,frame=>s!.frameVersions.get(frame),frame=>this.frameAllowed(frame),page=>[...s!.tabs].find(([,value])=>value===page)?.[0]);
          ownedSession=s;
          this.sessions.set(task,s);await this.observePage(s,page);
          // Unrequested popup tabs are closed; only explicit new_tab calls are adopted.
          context.on('page',p=>{void (async()=>{
            await s?.opening;
            if(s&&!Array.from(s.tabs.values()).includes(p))await p.close();
          })().catch(()=>{});});
          this.sessions.set(task,s);
        }
        navigationCancelled=!await this.navigate(s,()=>s!.page.goto(input.url!,{waitUntil:'domcontentloaded',timeout:0}));
      }else if(navigation){
        if(!s||s.page!==navigation.page)throw Error('Browser session changed; inspect before any retry');
        s.revision='';s.refs.clear();
        if(input.action==='reload')navigationCancelled=!await this.navigate(s,()=>s!.page.reload({waitUntil:'domcontentloaded',timeout:0}));
        else {
          const entry=navigation.entry!,cdp=await s.context.newCDPSession(s.page);
          try{
            if(!this.permitted(entry.url))throw Error('History destination origin is not authorized');
            const history=await cdp.send('Page.getNavigationHistory');
            if(!history.entries.some(e=>e.id===entry.id&&e.url===entry.url))throw Error('History changed before navigation');
            let moved:(frame:Frame)=>void=()=>{};
            const observed=new Promise<void>(resolve=>{moved=frame=>{if(frame===s!.page.mainFrame()&&frame.url()===entry.url)resolve();};s!.page.on('framenavigated',moved);});
            try{
              navigationCancelled=!await this.navigate(s,()=>Promise.all([observed,cdp.send('Page.navigateToHistoryEntry',{entryId:entry.id})]));
              if(!navigationCancelled)await s.page.waitForLoadState('domcontentloaded',{timeout:0});
            }finally{s.page.off('framenavigated',moved);}
          }finally{await cdp.detach();}
        }
        if(!this.permitted(s.page.url()))throw Error('Navigation ended outside authorized origins');
      }else if(input.action==='new_tab'){
        if(!s)throw Error('Browser session lost');
        s.opening=s.context.newPage().then(page=>{s!.tabs.set(randomUUID(),page);return page;});
        let page:Page;
        try{page=await s.opening;}finally{delete s.opening;}
        s.page=page;
        await this.observePage(s,page);
        await page.goto(input.url!,{waitUntil:'domcontentloaded',timeout:0});
        await this.videos.startPage(s.context,[...s.tabs].find(([,value])=>value===page)![0],page);
      }else if(input.action==='switch_tab'||input.action==='close_tab'){
        if(!s)throw Error('Browser session lost');
        const page=s.tabs.get(input.tab_id!)!;
        if(input.action==='switch_tab')s.page=page;
        else {await this.videos.closePage(s.context,page);await page.close();s.diagnostics.delete(page);s.tabs.delete(input.tab_id!);if(s.page===page)s.page=s.tabs.values().next().value!;}
      }else if(input.action==='close'){
        // Cleanup must work after navigation fails or the session disappears.
        // Do not clear unknown receipts: closing is not reconciliation.
        const video=videoTarget&&s?s.page.video():null,videoDir=s?.videoDir;
        if(s)await this.closeSession(s);
        this.sessions.delete(task);s=undefined;
        let saved:{path:string,size:number,sha256:string}|undefined;
        try{
          if(video&&videoTarget){
            if(projectFilePath(row.root,input.path!)!==videoTarget)throw Error('Destination changed');
            await video.saveAs(videoTarget);const data=readFileSync(videoTarget);
            saved={path:input.path!,size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
          }
        }finally{if(videoDir)await rm(videoDir,{recursive:true,force:true}).catch(()=>{});}
        if(saved)return finish({state:'closed',video:saved});
      }else if(input.action==='downloads')return finish({state:'completed',downloads:this.downloads.list(task)});
      else if(input.action==='download_save')return finish({state:'completed',saved_download:this.downloads.save(save!)});
      else if(input.action==='download_cancel')return finish({state:'completed',download:await this.downloads.cancel(task,input.download_id!)});
      else{
        if(!s)throw Error('Browser session lost or not opened; use open then inspect. No action replay.');
        if(input.action!=='dialog'&&!this.permitted(s.page.url()))throw Error('Current page origin is not authorized');
        if(input.action==='dialog'){
          const suspended=s.suspended;
          handling=s.dialogs.handle(input.dialog_id!,id,input.accept!,input.text).then(value=>{handled=value;return value;});await handling;
          if(suspended){const value=await suspended.execution;return finish({...value as object,handled_dialog:handled});}
        }else if(input.action==='upload'){
          if(uploadChooser){
            if(!s.choosers.authorized(uploadChooser))throw Error('File chooser origin or document changed');
          }else{
            if(input.revision!==s.revision||!input.ref)throw Error('Stale page reference; inspect again');
            const captured=await this.checkedControl(s,input.ref);if(captured.node!==uploadNode)throw Error('File input changed');
          }
          const current=await uploadNode!.evaluate(e=>({connected:e.isConnected,tag:e.tagName,type:e.getAttribute('type')?.toLowerCase(),multiple:e instanceof HTMLInputElement&&e.multiple,directory:e.hasAttribute('webkitdirectory')}));
          if(!current.connected||current.tag!=='INPUT'||current.type!=='file'||current.multiple!==uploadFile!.multiple||current.directory!==uploadFile!.directory)throw Error('File input changed before upload');
          if(uploadChooser&&!s.choosers.authorized(uploadChooser))throw Error('File chooser document changed');
          if(uploadChooser)s.choosers.complete(uploadChooser,upload===undefined);
          if(upload){
            const staged=upload.stage(this.engine.stateDir);
            s.uploadStages.add(staged.close);s.uploadBytes+=upload.files.reduce((sum,f)=>sum+f.size,0);
            await uploadNode!.setInputFiles(staged.paths);
          }
        }else if(input.action==='drop'){
          if(input.revision!==s.revision||!input.ref||!dropNode||!dropPin||s.nodes.get(input.ref)!==dropNode)throw Error('Stale drop target; inspect again');
          const target=await this.checkedControl(s,input.ref);
          if(target.node!==dropNode||target.pin!==dropPin)throw Error('Drop target changed; inspect again');
          // A replacement node cannot inherit the locator's identity while
          // Playwright dispatches native drag events.
          const marker='data-forge-drop-'+randomUUID().replaceAll('-','');
          await target.node.evaluate((element,attribute)=>element.setAttribute(attribute,''),marker);
          try{
            this.assertFrame(s,target.pin);cancelled();dropFile?.revalidate();
            const staged=dropFile?.stage(this.engine.stateDir);
            if(staged){s.uploadStages.add(staged.close);s.uploadBytes+=dropFile!.files.reduce((sum,f)=>sum+f.size,0);}
            const payload:{files?:string|string[];data?:Record<string,string>}={};
            if(staged)payload.files=staged.paths;
            if(input.mime_data)payload.data=input.mime_data;
            s.revision='';s.refs.clear();
            await target.pin.frame.locator(`[${marker}]`).drop(payload,{timeout:7000});
            cancelled();this.assertFrame(s,target.pin);
            if(!await target.node.evaluate(e=>e.isConnected))throw Error('Drop target changed during dispatch; inspect its unknown receipt');
          }finally{await target.node.evaluate((element,attribute)=>element.removeAttribute(attribute),marker).catch(()=>{});}
        }else if(input.action==='drag'){
          if(input.revision!==s.revision||!input.ref||!input.target_ref||!s.refs.has(input.ref)||!s.refs.has(input.target_ref))throw Error('Stale page reference; inspect again');
          const source=await this.checkedControl(s,input.ref),destination=await this.checkedControl(s,input.target_ref),page=s.page;
          s.revision='';s.refs.clear();
          let pressed=false;
          const connected=async(checkSource=false)=>{
            cancelled();
            this.assertFrame(s!,source.pin);this.assertFrame(s!,destination.pin);
            if(s!.page!==page||!this.permitted(page.url())||(checkSource&&!await source.node.evaluate(e=>e.isConnected))||!await destination.node.evaluate(e=>e.isConnected))throw Error('Drag page or element changed; inspect before any retry');
          };
          try{
            await source.node.hover();await connected(true);
            if(source.current.draggable&&(source.pin.frame!==destination.pin.frame||source.pin.frame!==page.mainFrame())){
              await this.crossFrameDrag(s,source.node,source.pin,destination.node,destination.pin,connected,signal);
            }else{
            pressed=true;await page.mouse.down();await connected();
            // Chromium starts an iframe's HTML5 drag inside that frame. A
            // single jump straight into another frame can miss dragstart.
            if(source.pin.frame!==destination.pin.frame){
              const box=await source.node.boundingBox();
              if(!box)throw Error('Drag source has no visible bounds');
              await page.mouse.move(box.x+box.width/2+Math.min(16,box.width/4),box.y+box.height/2);
              await connected();
            }
            await destination.node.hover();await connected();
            // Native HTML5 dragover requires a second move in Chromium.
            await destination.node.hover();await connected();
            await page.mouse.up();pressed=false;
            }
          }finally{
            // Never leave a mouse button held after an interrupted gesture.
            // Releasing is cleanup; it does not make an uncertain drag replayable.
            if(pressed){
              await page.keyboard.press('Escape').catch(()=>{});
              await page.mouse.move(-1,-1).catch(()=>{});
              await page.mouse.up().catch(()=>{});
            }
          }
        }else if(['click','fill','select','press','check','hover'].includes(input.action)){
          if(input.revision!==s.revision||!input.ref||!s.refs.has(input.ref))throw Error('Stale page reference; inspect again');
          // Retain the captured DOM node, not an index that a replacement can inherit.
          const {node:target,current}=await this.checkedControl(s,input.ref);
          s.revision='';s.refs.clear();
          if(input.action==='fill'){
            if(current.type==='password'||current.type==='file')throw Error('Password and file inputs require manual handling');
            await target.fill(input.text??'');
          }else if(input.action==='select'){
            if(current.tag!=='SELECT')throw Error('Select requires an accessible dropdown');
            await target.selectOption(input.value!);
          }else if(input.action==='press'){
            if((!['INPUT','TEXTAREA','SELECT'].includes(current.tag)&&!current.editable)||current.type==='password'||current.type==='file')throw Error('Key press requires a non-secret form control');
            await target.press(input.key!);
          }else if(input.action==='check'){
            if(current.tag!=='INPUT'||current.type!=='checkbox')throw Error('Check requires a checkbox input');
            await target.setChecked(input.checked!);
          }else if(input.action==='hover'){
            await target.hover();
          }else await target.click({noWaitAfter:true});
        }else if(input.action==='scroll'){
          if(selectedFrame){this.assertFrame(s,selectedFrame);await selectedFrame.frame.evaluate(delta=>window.scrollBy(0,delta),input.delta_y!);this.assertFrame(s,selectedFrame);}
          else await s.page.mouse.wheel(0,input.delta_y!);
        }else if(isAnnotationAction(input.action)){
          const context=s.context;
          const capture=async()=>{
            const latest=this.engine.task(task);this.engine.assertLease(latest,lease);
            if(latest.status!=='active'||this.sessions.get(task)!==s||s!.context!==context)throw Error('Annotation session or task lease changed');
            const page=s!.page;
            if(page.isClosed()||!this.permitted(page.url()))throw Error('Annotation source is no longer authorized');
            const pins=page.frames().map(frame=>({frame,version:s!.frameVersions.get(frame)!,url:frame.url()}));
            for(const pin of pins)this.assertFrame(s!,pin);
            const png=await page.screenshot({type:'png',animations:'disabled'});
            for(const pin of pins)this.assertFrame(s!,pin);
            const aria=await page.locator('body').ariaSnapshot({timeout:7000});
            for(const pin of pins)this.assertFrame(s!,pin);
            const title=(await page.title()).slice(0,200);
            for(const pin of pins)this.assertFrame(s!,pin);
            const check=this.engine.task(task);this.engine.assertLease(check,lease);
            if(check.status!=='active'||this.sessions.get(task)!==s||s!.page!==page||page.frames().some(frame=>!this.frameAllowed(frame)))throw Error('Annotation source changed during capture');
            const tab_id=[...s!.tabs].find(([,tab])=>tab===page)?.[0];
            if(!tab_id)throw Error('Annotation source tab no longer exists');
            return {png,aria,url:this.safeDiagnosticUrl(page.url()),title,tab_id};
          };
          const result=input.action==='annotate_begin'
            ?await this.annotations.begin(context,capture)
            :input.action==='annotate_capture'
            ?await this.annotations.captureShot(context)
            :input.action==='annotate_export'
            ?await this.annotations.export(context,row.root,input.path!,annotationPlan!)
            :input.action==='annotate_cancel'
            ?await this.annotations.discard(context)
            :await this.annotations.status(context);
          return finish(result);
        }else if(isVideoAction(input.action)){
          const result=input.action==='video_start'
            ?await this.videos.start(s.context,s.tabs,input.video_size,input.video_fps)
            :input.action==='video_pause'
            ?await this.videos.pause(s.context)
            :input.action==='video_resume'
            ?await this.videos.resume(s.context,s.tabs)
            :input.action==='video_stop'
            ?await this.videos.stop(s.context,row.root,input.path!)
            :input.action==='video_status'
            ?this.videos.status(s.context)
            :input.action==='video_chapter'
            ?await this.videos.chapter(s.context,s.page,input.title!,input.description,input.video_duration_ms)
            :input.action==='video_show_actions'
            ?await this.videos.showActions(s.page,{duration:input.video_duration_ms,position:input.video_position,cursor:input.video_cursor})
            :await this.videos.hideActions(s.page);
          return finish(result);
        }else if(extraPrepared){
          if(selectedFrame)this.assertFrame(s,selectedFrame);
          const extraResult=await this.extras.execute(extraPrepared,s,signal);
          if(selectedFrame)this.assertFrame(s,selectedFrame);
          if(input.action==='wait_for')return finish({...await this.snapshot(s,input.frame_id),waited_for:extraResult.waited_for});
          return finish(extraResult);
        }else if(!['inspect','tabs','screenshot','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit'].includes(input.action))throw Error('Unsupported action');
      }
      let result:unknown={state:'closed'};
      cancelled();
      if(s){
        if(input.action==='screenshot'){
          const pins=s.page.frames().map(frame=>({frame,version:s!.frameVersions.get(frame)!,url:frame.url()}));
          for(const pin of pins)this.assertFrame(s,pin);
          const image=await s.page.screenshot();
          for(const pin of pins)this.assertFrame(s,pin);
          if(s.page.frames().some(frame=>!this.frameAllowed(frame)))throw Error('Screenshot contains a frame without an origin grant');
          result={state:'completed',url:s.page.url(),image:image.toString('base64')};
        }
        else if(input.action==='network_flow_assert'){
          const page=s.page,d=s.diagnostics.get(page);
          if(!d)throw Error('Current tab has no network collector');
          const linked=new Set((input.flow!.links??[]).flatMap(link=>[link.from_index,link.to_index]));
          const observations=[];
          const authorized:{index:number;request:Request;entry:BrowserNetworkEntry;frame:Frame}[]=[];
          for(const step of input.flow!.steps){
            const req=d.requestHandles.get(step.index),entry=d.network.find(item=>item.index===step.index);
            if(!req||!entry)throw Error('Network flow request index expired');
            if(!this.permitted(req.url()))throw Error('Network request origin is not authorized');
            let frame:Frame;
            try{frame=req.frame();}catch{throw Error('Network request frame no longer authorized');}
            if(!this.frameAllowed(frame))throw Error('Network request frame origin is not authorized');
            const evidence=step.json_checks?.length||linked.has(step.index)
              ?await this.networkJsonEvidence(req,entry)
              :{available:false as const,reason:'not_requested'};
            // The tab, retained diagnostic, and every frame must still be the
            // one that passed the owner-grant checks after async body reads.
            if(s.page!==page||d.requestHandles.get(step.index)!==req||!d.network.includes(entry)
              ||!this.permitted(req.url())||!this.frameAllowed(frame))
              throw Error('Network flow request origin or tab changed during assertion');
            authorized.push({index:step.index,request:req,entry,frame});
            observations.push({index:step.index,started_ms:entry.started_ms,method:entry.method,
              path:new URL(req.url()).pathname,state:entry.state,status:entry.status,
              duration_ms:entry.duration_ms,evidence});
          }
          if(s.page!==page||authorized.some(pin=>d.requestHandles.get(pin.index)!==pin.request
            ||!d.network.includes(pin.entry)||!this.permitted(pin.request.url())||!this.frameAllowed(pin.frame)))
            throw Error('Network flow request authorization changed before comparison');
          const verdict=checkNetworkFlow(input.flow!,observations);
          result={state:'completed',...verdict};
        }
        else if(input.action==='network_assert'){
          const page=s.page,d=s.diagnostics.get(page);
          if(!d)throw Error('Current tab has no network collector');
          const request=d.requestHandles.get(input.index!),entry=d.network.find(item=>item.index===input.index);
          if(!request||!entry)throw Error('Network request index expired');
          if(!this.permitted(request.url()))throw Error('Network request origin is not authorized');
          let frame:Frame;
          try{frame=request.frame();}catch{throw Error('Network request frame no longer available');}
          if(!this.frameAllowed(frame))throw Error('Network request frame origin is not authorized');
          const evidence=input.json_checks?.length?await this.networkJsonEvidence(request,entry):{available:false as const,reason:'not_requested'};
          // An async response read can overlap navigation or diagnostic
          // eviction. Never use a previously authorized request after either.
          if(s.page!==page||d.requestHandles.get(input.index!)!==request||!d.network.includes(entry)||!this.permitted(request.url())||!this.frameAllowed(frame))
            throw Error('Network request origin or tab changed during assertion');
          const verdict=checkNetworkAssertion(input,{...entry,path:new URL(request.url()).pathname},evidence);
          result={state:'completed',passed:verdict.passed,index:input.index,network_state:entry.state,status:entry.status,
            method:entry.method,url:this.safeDiagnosticUrl(request.url()),duration_ms:entry.duration_ms??null,checks:verdict.checks};
        }
        else if(input.action==='network_request'){
          const d=s.diagnostics.get(s.page);
          if(!d)throw Error('Current tab has no network collector');
          const request=d.requestHandles.get(input.index!);
          if(!request)throw Error('Network request index expired');
          if(!this.permitted(request.url()))throw Error('Network request origin is not authorized');
          let frame:Frame;
          try{frame=request.frame();}catch{throw Error('Network request frame no longer available');}
          if(!this.frameAllowed(frame))throw Error('Network request frame origin is not authorized');
          const entry=d.network.find(item=>item.index===input.index);
          // A request can remain pending indefinitely. Reading its details
          // must not wait for a response that has not arrived.
          const response=entry?.status===null?null:await request.response();
          if(!this.permitted(request.url())||!this.frameAllowed(frame))throw Error('Network request origin changed during read');
          const summary={state:'completed',index:input.index,method:request.method(),url:this.safeDiagnosticUrl(request.url()),
            resource_type:request.resourceType(),status:response?.status()??null,failed:request.failure()?.errorText??null,
            content_type:response?.headers()['content-type']?.split(';')[0]??null,
            request_headers:sanitizedNetworkHeaders(request.headers()),response_headers:response?sanitizedNetworkHeaders(response.headers()):null,
            available_parts:['request-headers','request-body',...(response?['response-headers','response-body']:[])]};
          if(!input.part)result=summary;
          else if(input.part==='request-headers')result={state:'completed',index:input.index,part:input.part,headers:summary.request_headers};
          else if(input.part==='response-headers')result={state:'completed',index:input.index,part:input.part,headers:summary.response_headers};
          else if(input.part==='request-body')result={state:'completed',index:input.index,part:input.part,body:sanitizedNetworkBody(request.postData()??'')};
          else if(entry?.state!=='completed')result={state:'completed',index:input.index,part:input.part,body:{redacted:true,reason:'Response is not completed'}};
          else{
            const rawLength=response?.headers()['content-length'];
            const length=rawLength===undefined?NaN:Number(rawLength);
            const mime=summary.content_type??'';
            const textual=/^(application\/(json|[^/]+\+json|xml)|text\/(plain|html|css|xml)|application\/javascript)$/.test(mime);
            if(!response||!textual||!Number.isFinite(length)||length<0||length>65536)
              result={state:'completed',index:input.index,part:input.part,body:{redacted:true,reason:'Response body must have a textual MIME type and declared size <= 64 KiB'}};
            else{
              let bytes:Buffer|undefined;
              try{bytes=await response.body();}catch{/* Response was unavailable after the request settled. */}
              if(!this.permitted(request.url())||!this.frameAllowed(frame))throw Error('Network response origin changed during read');
              result={state:'completed',index:input.index,part:input.part,body:!bytes?{redacted:true,reason:'Response body no longer available'}:bytes.length>65536?{redacted:true,reason:'Body exceeds 64 KiB'}:sanitizedNetworkBody(bytes.toString('utf8'))};
            }
          }
        }
        else if(input.action==='network_list'){
          const page=s.page,d=s.diagnostics.get(page);
          if(!d)throw Error('Current tab has no network collector');
          const observations:NetworkListObservation[]=d.network.map(entry=>{
            const req=d.requestHandles.get(entry.index),permitted=!!req&&this.permitted(req.url());
            let authorized=false;
            if(req){try{authorized=permitted&&this.frameAllowed(req.frame());}catch{/* Detached frame, no diagnostic access. */}}
            return {index:entry.index,method:entry.method,url:entry.url,path:authorized&&req?new URL(req.url()).pathname:'',
              resource_type:req?.resourceType()??'',state:entry.state,status:entry.status,duration_ms:entry.duration_ms,
              authorized,frame_unavailable:permitted&&!authorized};
          });
          result={...checkNetworkList(input.list??{},observations,d.network_dropped),url:this.safeDiagnosticUrl(page.url())};
        }
        else if(input.action==='network_clear'){
          const d=s.diagnostics.get(s.page);
          if(!d)throw Error('Current tab has no network collector');
          const cleared=d.network.length,dropped_before_clear=d.network_dropped,last_index=d.nextRequestIndex;
          for(const request of d.requestHandles.values())d.requests.delete(request);
          d.requestHandles.clear();d.network.length=0;d.network_dropped=0;
          // Never reuse an index: a stale assertion must not point to a new request.
          result={state:'completed',url:this.safeDiagnosticUrl(s.page.url()),cleared,dropped_before_clear,last_index,next_index:last_index+1};
        }
        else if(input.action==='network_audit'){
          const page=s.page,d=s.diagnostics.get(page);
          if(!d)throw Error('Current tab has no network collector');
          const observations:NetworkAuditObservation[]=d.network.map(entry=>{
            const request=d.requestHandles.get(entry.index);
            const permitted=!!request&&this.permitted(request.url());
            let authorized=false;
            if(request){
              try{authorized=permitted&&this.frameAllowed(request.frame());}catch{/* The initiating frame was detached or revoked. */}
            }
            return {index:entry.index,method:entry.method,resource_type:request?.resourceType()??'',
              path:authorized&&request?new URL(request.url()).pathname:'',authorized,frame_unavailable:permitted&&!authorized,
              state:entry.state,status:entry.status,duration_ms:entry.duration_ms};
          });
          result={...checkNetworkAudit(input.audit!,observations,d.network_dropped),url:this.safeDiagnosticUrl(page.url())};
        }
        else if(input.action==='console'||input.action==='network'){
          const d=s.diagnostics.get(s.page);
          if(!d)throw Error('Current tab has no diagnostic collector');
          result=input.action==='console'
            ? {state:'completed',url:this.safeDiagnosticUrl(s.page.url()),entries:d.console,truncated:d.console_dropped>0,dropped:d.console_dropped}
            : {state:'completed',url:this.safeDiagnosticUrl(s.page.url()),entries:d.network.map(({started_ms,...entry})=>entry),truncated:d.network_dropped>0,dropped:d.network_dropped};
          // Reading diagnostics must not invalidate a previously inspected DOM reference.
        }
        else if((s.dialogs.hasPending||(s.suspended&&s.suspended.id!==id))&&input.action!=='dialog')result=this.pendingView(s);
        else {
          result=await this.snapshot(s,input.action==='inspect'?input.frame_id:undefined);
        }
      }
      if(handled)result={...result as object,handled_dialog:handled};
      if(input.action==='upload')result={...result as object,uploaded_files:upload?.metadata??[],chooser_cancelled:upload===undefined};
      if(input.action==='drop')result={...result as object,dropped_files:dropFile?.metadata??[],dropped_mime_types:Object.keys(input.mime_data??{})};
      if(navigationCancelled)result={...result as object,state:'navigation_cancelled'};
      return finish(result);
    }catch(e){
      const error=gesture&&signal?.aborted?Error('Browser gesture cancelled; inspect its unknown receipt before any retry'):e;
      this.engine.db.prepare("UPDATE browser_operations SET state='unknown' WHERE task_id=? AND id=?").run(task,id);
      this.engine.event(task,'browser_unknown',{operation_id:id,error:String(error)});throw error;
    }})();
    const savedExecution=execution;void savedExecution.catch(()=>{});
    const monitor=this.monitor(task,savedExecution,input.action==='wait_for'?95000:['open','new_tab','back','forward','reload'].includes(input.action)?15000:8000,input.action==='dialog'?input.dialog_id:undefined);
    let suspended=false;
    void savedExecution.then(()=>{const s=this.sessions.get(task);if(s?.suspended?.id===id)delete s.suspended;},()=>{const s=this.sessions.get(task);if(s?.suspended?.id===id)delete s.suspended;});
    try{
      const outcome=await monitor.outcome;
      if('value' in outcome)return outcome.value;
      if(handling)await handling;
      const s=this.sessions.get(task);if(!s)throw Error('Browser session lost while waiting for dialog');
      await this.readyDialogs(s);
      if(monitor.finished())return await savedExecution;
      suspended=true;
      if(!s.suspended)s.suspended={id,execution:savedExecution};
      const result={...this.pendingView(s,s.suspended.id),...(handled?{handled_dialog:handled}:{})};
      this.engine.db.prepare('UPDATE browser_operations SET state=?,result=? WHERE task_id=? AND id=?').run(handled&&s.suspended.id!==id?'completed':'waiting_dialog',JSON.stringify(result),task,id);
      return result;
    }finally{
      try{
        if(gesture){
          const cleanup=async()=>{signal?.removeEventListener('abort',onAbort);if(signal?.aborted)onAbort();await abortCleanup;};
          if(suspended)void savedExecution.then(cleanup,cleanup).catch(()=>{});else await cleanup();
        }
      }finally{this.busy.delete(task);this.engine.interactionBusy.delete(task);}
    }
  }
  private async crossFrameDrag(session:Session,source:ElementHandle<HTMLElement|SVGElement>,sourcePin:FramePin,destination:ElementHandle<HTMLElement|SVGElement>,destinationPin:FramePin,connected:()=>Promise<void>,signal?:AbortSignal){
    const targetSession=async(frame:Frame):Promise<{client:Awaited<ReturnType<BrowserContext['newCDPSession']>>;frame:Frame}>=>{
      if(frame===session.page.mainFrame())return {client:await session.context.newCDPSession(session.page),frame};
      try{return {client:await session.context.newCDPSession(frame),frame};}
      catch(error){if(String(error).includes('does not have a separate CDP session')&&frame.parentFrame())return targetSession(frame.parentFrame()!);throw error;}
    };
    // Mouse input and drag interception belong to the page target, including
    // when the source is in an OOPIF. Destination drag events use its target.
    const sourceTarget=await targetSession(session.page.mainFrame()),from=sourceTarget.client;
    let to:Awaited<ReturnType<BrowserContext['newCDPSession']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined,pressed=false;
    let receive:(event:any)=>void=()=>{},aborted=()=>{},changed=()=>{};
    try{
      const destinationTarget=await targetSession(destinationPin.frame);to=destinationTarget.client;
      const point=async(targetSession:{client:typeof from;frame:Frame},node:typeof source)=>{
        const {client,frame}=targetSession;
        const target=await client.send('Target.getTargetInfo');
        const box=await node.boundingBox();if(!box)throw Error('Drag element has no visible bounds');
        if(target.targetInfo.type==='iframe'){
          const owner=await frame.frameElement();
          try{
            const bounds=await owner.boundingBox();if(!bounds)throw Error('Drag frame has no visible bounds');
            const metrics=await owner.evaluate(e=>({left:(e as Element).clientLeft,top:(e as Element).clientTop,width:(e as HTMLElement).offsetWidth,height:(e as HTMLElement).offsetHeight}));
            const scaleX=bounds.width/metrics.width,scaleY=bounds.height/metrics.height;
            return {x:(box.x+box.width/2-bounds.x)/scaleX-metrics.left,y:(box.y+box.height/2-bounds.y)/scaleY-metrics.top,width:box.width/scaleX};
          }finally{await owner.dispose();}
        }
        return {x:box.x+box.width/2,y:box.y+box.height/2,width:box.width};
      };
      const start=await point(sourceTarget,source);await connected();
      // Capture Chromium's actual DataTransfer from a real dragstart. No page
      // script creates an event or supplies invented drag data.
      const intercepted=new Promise<any>((resolve,reject)=>{
        receive=event=>resolve(event.data);from.on('Input.dragIntercepted',receive);
        aborted=()=>reject(Error('Browser drag cancelled'));
        changed=()=>{try{this.assertFrame(session,sourcePin);this.assertFrame(session,destinationPin);}catch(error){reject(error);}};
        signal?.addEventListener('abort',aborted,{once:true});session.page.on('framenavigated',changed);session.page.on('framedetached',changed);
        timer=setTimeout(()=>reject(Error('Native iframe drag did not start')),8000);
      });
      void intercepted.catch(()=>{}); // A command/authority failure may precede the await below.
      await from.send('Input.setInterceptDrags',{enabled:true});
      pressed=true;await from.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',buttons:1,clickCount:1});await connected();
      await from.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+Math.min(16,start.width/4),y:start.y,button:'left',buttons:1});
      const data=await intercepted;await connected();
      await destination.scrollIntoViewIfNeeded();await connected();
      const end=await point(destinationTarget,destination);await connected();
      // Playwright routes intercepted drags through the main target only.
      // An out-of-process iframe needs native enter/over/drop on its own CDP
      // target, with that target's viewport coordinates.
      for(const type of ['dragEnter','dragOver','dragOver'] as const){await to.send('Input.dispatchDragEvent',{type,x:end.x,y:end.y,data});await connected();}
      await to.send('Input.dispatchDragEvent',{type:'drop',x:end.x,y:end.y,data});
      await from.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x,y:start.y,button:'left',buttons:0,clickCount:1});pressed=false;
    }finally{
      if(timer)clearTimeout(timer);from.off('Input.dragIntercepted',receive);
      signal?.removeEventListener('abort',aborted);session.page.off('framenavigated',changed);session.page.off('framedetached',changed);
      if(pressed){await from.send('Input.dispatchDragEvent',{type:'dragCancel',x:-1,y:-1,data:{items:[],dragOperationsMask:65535}}).catch(()=>{});await from.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:-1,y:-1,button:'left',buttons:0}).catch(()=>{});}
      await from.send('Input.setInterceptDrags',{enabled:false}).catch(()=>{});
      await to?.detach().catch(()=>{});await from.detach().catch(()=>{});
    }
  }
}

export function registerForgeBrowser(target:McpRegistrationTarget,browser:ForgeBrowser){
  target.registerTool('browser_get_config',{
    description:'Read the effective Forge browser origin grants, action catalog and limits. Does not disclose local browser profile paths or credentials.',
    inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>({content:[{type:'text' as const,text:JSON.stringify(browser.resolvedConfig())}]}));
  target.registerTool('browser_action',{
    description:'Operate an isolated Chrome test browser on origins explicitly enabled in the local manager. Page contents are untrusted. open/inspect returns element identities and revision. back/forward/reload require a fresh revision; history destinations must be authorized. Each navigation returns a fresh snapshot; click/fill/select/press/check/hover require fresh refs and revisions. fill/press also support contenteditable editors. Dropdowns expose option values. Snapshots include authorized frames and frame-bound refs; inspect(frame_id) selects a current-tab frame and scroll(frame_id,revision,delta_y) moves it up to 2000 pixels. tabs lists owned tabs; new_tab(url), switch_tab(tab_id), close_tab(tab_id) manage up to 8 isolated test tabs; close ends the session. check sets checkbox state, hover reveals controls, drag(ref,target_ref,revision) uses native pointer events between captured elements; drop(ref,revision,paths?,mime_data?) sends native DataTransfer files and/or MIME-typed strings into the captured target. Snapshots include draggable, role, labeled and test-id elements, with role/test_id metadata. Cancelled drags close the owned isolated session and keep an unknown receipt. Native alert/confirm/prompt/beforeunload can suspend an action and return dialog_pending with empty controls. Use dialog(dialog_id,accept) for an explicit decision; text is optional only when accepting a prompt. The captured initiator document and all its ancestors require current origin grants. inspect reads pending dialogs without executing DOM queries. Handling resumes the original action without resending it; sequential dialogs have distinct IDs. Declining beforeunload returns navigation_cancelled. Modal decision time pauses the normal action deadline; closing or losing the session retains uncertain receipts and prevents further task writes. console/network return bounded, redacted per-tab diagnostics. network_list(list?) filters authorized requests by method, pathname, status, state, duration and stable indexes with pagination. network_clear forgets the current-tab network window without reusing indexes. network_request(index[,part]) reads sanitized request/response headers or explicitly requested small textual bodies from authorized frames; secrets, queries, cookies and Authorization are redacted. They do not invalidate DOM refs. network_assert(index,expected_status/status_min/status_max,expected_state,expected_method,expected_path,max_duration_ms,json_checks) verifies an already observed request without sending network traffic; failed assertions return passed=false and reason codes without response data. Status checks implicitly require a finished request unless an explicit state is supplied. JSON pointer checks require a completed application/json response with a declared body <=64 KiB. Exact expected JSON values are hashed in local receipts. network_flow_assert(flow) checks an ordered sequence of 2–8 retained current-tab network requests, step-level HTTP/JSON assertions, maximum request-start gaps/span, and optional sanitized JSON-pointer equality across two different responses. Results contain no body values. network_audit(audit) validates retained API request cohorts against completion, failed/HTTP error/pending budgets and optional p95/maximum latency thresholds; incomplete or unapproved evidence fails closed. Use stable operation_id; unknown actions must never be replayed. screenshot returns an image. upload(ref,revision,paths) selects task files, or upload(chooser_id,paths) handles a captured native chooser; omitted paths cancel that chooser. uploads are capped at 32 MiB and use pinned bytes. downloads lists up to 16 native receipts; completed receipts include immutable artifact paths and hashes. download_save(download_id,path) imports to a new task-relative file; download_cancel(download_id) explicitly cancels a pending native transfer. Pending transfers block other task writes. No access to the everyday user browser profile or passwords. When the owner enables it locally, open(profile=signed_in) uses a separate dedicated persistent Chrome profile in a visible window whose sign-ins the owner made by hand; all origin grants, receipts and replay rules still apply and downloads are disabled there. Extra test capabilities in the same isolated context: resize(width,height,revision) changes the viewport; network_state_set(offline,revision) toggles offline mode for the entire owned browser context; both invalidate references. storage_state(path) exports authorized exact-host cookies and localStorage to a new task file (contains credentials); set_storage_state(path,revision) replaces context cookies/storage from that file and invalidates refs; reload pages to consume restored storage. highlight(ref,revision) outlines an element; hide_highlight(ref,revision) restores its original outline. annotate(text,revision) displays a caption visible in screenshots and recordings; clear_annotations(revision) removes it. Codegen: record_start begins a 15-minute, 256-action Playwright TypeScript recording on the current authorized tab (including real manual clicks and form changes); record_status reports action counts, record_export(path.ts|py|java|cs) snapshots, record_stop(path.ts|py|java|cs) exports final code with environment variable placeholders for input values, never saving passwords, input values, URL queries or fragments. In the isolated profile use open(visible=true) to show a private interactive Chrome window for demonstrations. Other actions: cookies lists cookies of authorized origins; cookie_set(url,name,value[,http_only,secure,same_site,expires]) and cookie_clear([name]); storage/storage_set/storage_clear(kind[,storage_key,value]) read or change localStorage/sessionStorage of the current page or frame_id (changes need a fresh revision and invalidate it); route(url_pattern,status,body[,content_type,times]) mocks matching requests of authorized origins, routes lists them, unroute(route_id) removes one; trace_start/trace_stop(path) save a Playwright trace and pdf(path) a PDF to new task-relative files; evaluate(expression,revision[,frame_id]) runs page JavaScript and returns its JSON result; assert(assertion: text_visible(text) | element_visible(ref,revision) | list_visible(ref,revision,items) | value(ref,revision,value)) checks state read-only. find(text|regex[,frame_id]) searches an accessible snapshot; wait_for(time?,text?,text_gone?[,frame_id]) waits for page state and returns a fresh snapshot. accessibility_audit(max_issues?[,frame_id]) checks the currently authorized page or one selected frame for missing image alternatives, accessible control names, document metadata, broken ARIA references, duplicate IDs, heading order and hidden focusable controls. It returns bounded element paths, counts and incomplete-evidence flags without claiming full WCAG conformance or revealing input values; it preserves existing DOM revisions. mouse_click(x,y[,button,click_count]), mouse_move(x,y[,hold_id]), mouse_down(x,y[,button]), mouse_up(hold_id), mouse_cancel(hold_id), mouse_path(hold_id,points), mouse_state, mouse_drag(x,y,to_x,to_y), mouse_stroke(points,revision[,button]) and mouse_wheel(x,y,delta_y) use page viewport coordinates with a fresh revision (except mouse_up/cancel and held mouse_move/mouse_path, which require the active hold_id) and invalidate it; mouse_down creates a 30-second held pointer for multi-call drawing, move or mouse_path requires hold_id while pressed (without revision); mouse_path moves 2–64 waypoints while keeping the button held; up releases, cancel moves it outside the viewport before release, and mouse_state inspects the current hold; only safe reads and pointer controls are allowed until release; locator(ref,revision) suggests Playwright locators; webmcp_list / webmcp_call(tool_name,input_json) use tools the page registers through WebMCP (document or navigator modelContext), when the page provides them; open(visible=true) creates a new owner-visible isolated Chrome. record_start captures actual user clicks, text edits, select and check events on authorized frames for up to 15 minutes; record_status inspects it; record_export(path) snapshots without stopping; record_stop(path) exports then stops. Code is generated as .ts, .py, .java or .cs with environment variable placeholders for inputs. video_start(video_size?,video_fps?) begins immediate multi-tab screencast; video_status inspects clips; video_pause/video_resume pauses and resumes capture into additional video segments; video_chapter(title,description?,video_duration_ms?) adds a blurred chapter card; video_show_actions(video_duration_ms?,video_position?,video_cursor?) annotates future browser actions and highlights targets; video_hide_actions stops annotations; video_stop(path.webm) finalizes the WebM files. Annotation review: annotate_begin opens an independent interactive Chrome with rectangle, arrow, pen and text tools. Its Take screenshot button or annotate_capture adds up to 8 current-tab captures, each with an ARIA snapshot. After the user clicks Submit, annotate_status reports progress and annotate_export(path.json) saves marked PNGs, matching ARIA YAML files and a structured JSON manifest under the task root; annotate_cancel dismisses the review. The review has no shared website DOM or credentials. The legacy open(record_video) records a full session and close(path) saves it.',
    inputSchema:{max_issues:z.number().int().min(1).max(100).describe('accessibility_audit: maximum returned finding details; total counts remain complete within scan limits.').optional(),list:browserNetworkListSchema.describe('network_list: authorized request listing filters with stable indexes and pagination.').optional(),audit:browserNetworkAuditSchema.describe('network_audit: bounded current-tab API latency/error budgets for retained requests; no body reads.').optional(),flow:browserNetworkFlowSchema.describe('network_flow_assert: 2–8 bounded current-tab HTTP request contracts with ordered capture, response JSON links, and start-time limits.').optional(),width:z.number().int().min(320).max(3840).optional(),height:z.number().int().min(200).max(2160).optional(),offline:z.boolean().optional(),task_id:z.string(),operation_id:z.string().min(1).max(160),lease_token:z.string().uuid(),action:z.enum(['open','back','forward','reload','inspect','tabs','new_tab','switch_tab','close_tab','click','fill','select','press','check','hover','drag','drop','scroll','dialog','upload','downloads','download_save','download_cancel','screenshot','console','network','network_list','network_clear','network_request','network_assert','network_flow_assert','network_audit','close',...EXTRA_ACTIONS,...VIDEO_ACTIONS,...ANNOTATION_ACTIONS]),url:z.string().optional(),tab_id:z.string().uuid().optional(),frame_id:z.string().uuid().describe('Current-tab frame ID from a snapshot. inspect selects its content; scroll also requires a fresh revision. Element refs already identify their frame.').optional(),dialog_id:z.string().uuid().describe('Pending dialog ID returned by open/inspect or an interrupted action. The dialog action requires this ID and accept.').optional(),accept:z.boolean().optional(),chooser_id:z.string().uuid().optional(),paths:z.array(z.string().min(1).max(1000)).max(16).describe('Task-relative upload file paths; [] clears a file input. One directory for webkitdirectory. For drop, use task-relative individual files. Omit only to cancel a captured chooser.').optional(),mime_data:z.record(z.string().max(128),z.string().max(16384)).describe('drop only: MIME type to string, e.g. text/plain or text/uri-list; 16 types and 64 KiB total').optional(),index:z.number().int().min(1).describe('network_request: current-tab 1-based bounded index from network entries').optional(),part:z.enum(['request-headers','request-body','response-headers','response-body']).optional(),expected_state:z.enum(['pending','response','completed','failed']).describe('network_assert expected request lifecycle state').optional(),expected_status:z.number().int().min(100).max(599).optional(),status_min:z.number().int().min(100).max(599).optional(),status_max:z.number().int().min(100).max(599).optional(),expected_method:z.string().regex(/^[A-Z]{1,16}$/).optional(),expected_path:z.string().regex(/^\/[^?#]{0,299}$/).optional(),max_duration_ms:z.number().int().min(1).max(120000).optional(),json_checks:z.array(browserNetworkJsonCheckSchema).min(1).max(8).describe('network_assert: bounded RFC 6901 JSON body contracts, with redacted results').optional(),download_id:z.string().uuid().optional(),path:z.string().min(1).max(1000).describe('Task-relative new destination for download_save, trace_stop, pdf, storage_state, record_export, record_stop, video_stop, close video, or annotate_export; never overwrites.').optional(),ref:z.string().optional(),target_ref:z.string().optional(),revision:z.string().optional(),text:z.string().max(10000).optional(),regex:z.string().max(200).optional(),text_gone:z.string().max(500).optional(),time:z.number().positive().max(30).optional(),items:z.array(z.string().min(1).max(500)).min(1).max(100).describe('assert list_visible: ordered visible items contained in a captured ul/ol/role=list').optional(),value:z.string().max(262144).describe('select option value; cookie_set/storage_set value; expected value for assert value.').optional(),checked:z.boolean().optional(),key:z.enum(['Tab','Enter','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Backspace','Delete']).optional(),delta_y:z.number().int().min(-2000).max(2000).optional(),profile:z.enum(['isolated','signed_in']).describe('open only: signed_in uses the owner-enabled dedicated persistent Chrome profile (visible window, persisted sign-ins); default isolated.').optional(),name:z.string().max(256).describe('Cookie name for cookie_set/cookie_clear.').optional(),kind:z.enum(['local','session']).describe('Web Storage area for storage actions.').optional(),storage_key:z.string().max(1024).optional(),url_pattern:z.string().max(2048).describe('route: glob that must start with an authorized origin and /.').optional(),status:z.number().int().min(100).max(599).optional(),body:z.string().max(1048576).optional(),content_type:z.string().max(200).optional(),times:z.number().int().min(1).max(1000).optional(),route_id:z.string().uuid().optional(),http_only:z.boolean().optional(),secure:z.boolean().optional(),same_site:z.enum(['Strict','Lax','None']).optional(),expires:z.number().optional(),expression:z.string().max(16384).describe('evaluate: JavaScript expression run in the current page or frame_id; requires a fresh revision and invalidates it.').optional(),assertion:z.enum(['text_visible','element_visible','list_visible','value']).optional(),x:z.number().describe('Page viewport x for mouse_* actions (CSS pixels, as in screenshot).').optional(),y:z.number().optional(),to_x:z.number().optional(),to_y:z.number().optional(),points:z.array(z.object({x:z.number().finite(),y:z.number().finite()}).strict()).min(2).max(64).describe('mouse_stroke/mouse_path: 2–64 viewport waypoints, neighboring points at most 250 CSS pixels apart.').optional(),button:z.enum(['left','right','middle']).optional(),hold_id:z.string().uuid().describe('mouse_up/mouse_cancel: active mouse_down hold_id. mouse_move/mouse_path require it while held.').optional(),click_count:z.number().int().min(1).max(3).optional(),tool_name:z.string().max(200).describe('webmcp_call: tool registered by the page.').optional(),input_json:z.string().max(65536).describe('webmcp_call: JSON input for the page tool.').optional(),video_size:z.object({width:z.number().int().min(320).max(1920),height:z.number().int().min(200).max(1080)}).strict().describe('video_start only: video frame dimensions.').optional(),video_fps:z.number().int().min(5).max(30).describe('video_start only: FPS, default 15.').optional(),title:z.string().min(1).max(120).describe('video_chapter only: chapter headline.').optional(),description:z.string().max(400).describe('video_chapter only: optional chapter description.').optional(),video_duration_ms:z.number().int().min(100).max(12000).describe('video_chapter/video_show_actions overlay duration.').optional(),video_position:z.enum(['top-left','top','top-right','bottom-left','bottom','bottom-right']).describe('video_show_actions title position.').optional(),video_cursor:z.enum(['none','pointer']).describe('video_show_actions animated pointer decoration.').optional(),visible:z.boolean().describe('open only: launch a new owner-visible, isolated Chrome window for manual demonstrations.').optional(),record_video:z.boolean().describe('open only: record the new session; close(path) saves the video to a new task file.').optional()},
    annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true},
  },async(i,extra)=>{try{const {task_id,operation_id,lease_token,...action}=i;const result=await browser.run(task_id,operation_id,lease_token,action,extra.signal) as {image?:string};return result.image?{content:[{type:'image' as const,mimeType:'image/png',data:result.image}]}:{content:[{type:'text' as const,text:JSON.stringify(result)}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:String(e)}]};}});
}

// Playwright renders video with its own ffmpeg build in the browsers cache.
// Forge never downloads it on demand; recording is refused when it is absent.
export function videoRecorderAvailable(){
  const base=process.env.PLAYWRIGHT_BROWSERS_PATH||join(process.env.LOCALAPPDATA??'','ms-playwright');
  try{
    // The exact ffmpeg revision this playwright-core build expects.
    const manifest=JSON.parse(readFileSync(new URL('../node_modules/playwright-core/browsers.json',import.meta.url),'utf8')) as {browsers:{name:string;revision:string}[]};
    const revision=manifest.browsers.find(b=>b.name==='ffmpeg')?.revision;
    return !!revision&&existsSync(join(base,'ffmpeg-'+revision,process.platform==='win32'?'ffmpeg-win64.exe':'ffmpeg-linux'));
  }catch{return false;}
}
