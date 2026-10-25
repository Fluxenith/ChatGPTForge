import {createHash,randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,openSync,writeFileSync,readFileSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BrowserContext,ElementHandle,Frame,Page,Route} from 'playwright-core';
import {z} from 'zod';
import {projectFilePath} from './forge-browser-files.js';
import {BrowserCodeRecorder,recordingLanguage} from './forge-browser-recorder.js';
import {auditAccessibility} from './forge-browser-accessibility.js';

// Additional isolated-browser capabilities (cookies, Web Storage, request
// mocking, tracing, PDF, page evaluation and assertions). Everything is scoped
// to the owned context and to origins granted in the local manager; outputs
// are written only as new task-relative files.
export const EXTRA_ACTIONS=['annotate','clear_annotations','highlight','hide_highlight','storage_state','set_storage_state','resize','network_state_set','cookies','cookie_set','cookie_clear','storage','storage_set','storage_clear','route','unroute','routes','trace_start','trace_stop','record_start','record_status','record_export','record_stop','pdf','evaluate','assert','find','wait_for','accessibility_audit','mouse_click','mouse_move','mouse_down','mouse_up','mouse_cancel','mouse_state','mouse_path','mouse_drag','mouse_stroke','mouse_wheel','locator','webmcp_list','webmcp_call'] as const;
export type ExtraAction=(typeof EXTRA_ACTIONS)[number];
export const EXTRA_READ_ONLY:readonly string[]=['cookies','storage','routes','assert','find','wait_for','accessibility_audit','locator','webmcp_list','mouse_state','record_status'];
export const EXTRA_FRAME_ACTIONS:readonly string[]=['storage','storage_set','storage_clear','evaluate','assert','find','wait_for','accessibility_audit','webmcp_list','webmcp_call'];
export const isExtraAction=(action:string):action is ExtraAction=>(EXTRA_ACTIONS as readonly string[]).includes(action);

export interface ExtraInput {
  width?:number;height?:number;offline?:boolean;max_issues?:number;
  action:string;url?:string;name?:string;value?:string;kind?:string;storage_key?:string;path?:string;expression?:string;revision?:string;ref?:string;text?:string;regex?:string;time?:number;text_gone?:string;
  x?:number;y?:number;to_x?:number;to_y?:number;points?:{x:number;y:number}[];button?:string;hold_id?:string;click_count?:number;delta_y?:number;tool_name?:string;input_json?:string;
  url_pattern?:string;status?:number;body?:string;content_type?:string;times?:number;route_id?:string;http_only?:boolean;secure?:boolean;same_site?:string;expires?:number;assertion?:string;items?:string[];
}
export interface ExtraSession {context:BrowserContext;page:Page;revision:string;refs:Map<string,string>;nodes:Map<string,ElementHandle<HTMLElement|SVGElement>>;frameVersions?:WeakMap<Frame,string>}
interface Prepared {action:ExtraAction;input:ExtraInput;root:string;target?:string;frame?:Frame;storageState?:Awaited<ReturnType<BrowserContext['storageState']>>}
interface MockRoute {route_id:string;url_pattern:string;status:number;content_type:string;body_sha256:string;bytes:number;times:number|null;hits:number;handler:(route:Route)=>Promise<void>}
interface PointerHold {id:string;button:'left'|'right'|'middle';expiresAt:number;timer:ReturnType<typeof setTimeout>;changed:()=>void}
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const cookieName=/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

function safeFindRegex(source:string){
  const literal=/^\/(.*)\/([imsu]*)$/.exec(source);
  const expression=literal?literal[1]:source,flags=literal?literal[2]:'';
  // Keep regex search bounded when inspecting untrusted page text; reject
  // patterns with nested repetition and expensive backreferences.
  if(/\\[1-9]|\([^)]*[+*{][^)]*\)[+*{]/.test(expression))throw Error('Find regular expression has unsafe nested repetition or backreferences');
  return new RegExp(expression,flags);
}

function searchSnapshot(snapshot:string,text?:string,regex?:string){
  const test=regex?safeFindRegex(regex):null;
  const lines=snapshot.slice(0,65536).split('\n'),matches:number[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i].slice(0,2000);
    if(test?(test.lastIndex=0,test.test(line)):line.toLocaleLowerCase().includes(text!.toLocaleLowerCase()))matches.push(i);
  }
  const snippets:string[]=[];let end=-1;
  for(const index of matches.slice(0,40)){
    const start=Math.max(end+1,index-3),last=Math.min(lines.length-1,index+3);
    if(start>last)continue;
    snippets.push(lines.slice(start,last+1).join('\n'));end=last;
  }
  return {state:'completed',query:regex?{regex}:{text},match_count:matches.length,matches_truncated:matches.length>40,snippets:snippets.join('\n…\n').slice(0,16000)};
}

export class BrowserExtras {
  private routes=new WeakMap<BrowserContext,Map<string,MockRoute>>();
  private tracing=new WeakSet<BrowserContext>();
  private annotation=new WeakMap<Page,ElementHandle<HTMLElement>>();
  private highlights=new WeakMap<Page,Map<ElementHandle<HTMLElement|SVGElement>,{value:string;priority:string}>>();
  private heldPointers=new WeakMap<Page,PointerHold>();
  private readonly recorder:BrowserCodeRecorder;
  constructor(private permitted:(url:string)=>boolean,private origins:()=>string[],private frameAllowed:(frame:Frame)=>boolean){
    this.recorder=new BrowserCodeRecorder(permitted,frameAllowed);
  }

  pointerHeld(page:Page){return this.heldPointers.has(page);}
  recording(context:BrowserContext){return this.recorder.recording(context);}
  recordedPage(context:BrowserContext){return this.recorder.recordedPage(context);}
  discardRecording(context:BrowserContext){this.recorder.discard(context);}
  async releasePointer(page:Page,cancel=true){
    const held=this.heldPointers.get(page);
    if(!held)return;
    this.heldPointers.delete(page);clearTimeout(held.timer);
    page.off('framenavigated',held.changed);page.off('framedetached',held.changed);page.off('close',held.changed);
    if(page.isClosed())return;
    if(cancel){await page.keyboard.press('Escape').catch(()=>{});await page.mouse.move(-1,-1).catch(()=>{});}
    if(cancel)await page.mouse.up({button:held.button}).catch(()=>{});
    else await page.mouse.up({button:held.button});
  }

  // Every check that can fail without touching the browser runs before intent.
  validate(input:ExtraInput,root:string,session:ExtraSession|undefined,frame:Frame|undefined):Prepared{
    const action=input.action as ExtraAction;
    if(!session)throw Error('Open a browser session first');
    if(!this.permitted(session.page.url()))throw Error('Current page origin is not authorized');
    const prepared:Prepared={action,input,root,...(frame?{frame}:{})};
    const newFile=(path:string|undefined)=>{
      if(!path)throw Error(`${action} requires a new task-relative path`);
      const target=projectFilePath(root,path);
      try{lstatSync(target);throw Error('Destination already exists; overwrite is refused');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return target;
    };
    switch(action){
      case 'accessibility_audit':
        if(input.max_issues!==undefined&&(!Number.isInteger(input.max_issues)||input.max_issues<1||input.max_issues>100))
          throw Error('accessibility_audit max_issues must be an integer from 1 to 100');
        if(input.revision!==undefined||input.path!==undefined)throw Error('accessibility_audit is read-only and needs no revision or path');
        break;
      case 'record_start':
        if(input.path!==undefined)throw Error('record_start does not accept an artifact path');
        if(this.recorder.recording(session.context))throw Error('Recording is already active');
        if(session.page.frames().some(f=>!this.frameAllowed(f)))throw Error('Code recording contains a frame without an origin grant');
        break;
      case 'record_status':
        if(input.path!==undefined)throw Error('record_status does not accept a path');
        break;
      case 'record_export':case 'record_stop':
        if(!this.recorder.recording(session.context))throw Error('Start code recording before exporting');
        recordingLanguage(input.path??'');
        prepared.target=newFile(input.path);
        break;
      case 'mouse_state':
        if(input.hold_id!==undefined||input.x!==undefined||input.y!==undefined||input.button!==undefined||input.revision!==undefined)
          throw Error('mouse_state does not accept pointer control arguments');
        break;
      case 'annotate':case 'clear_annotations':
        if(!input.revision||input.revision!==session.revision)throw Error('Stale page reference; inspect again');
        if(action==='annotate'&&(!input.text||input.text.length>1000))throw Error('annotate requires text of at most 1000 characters');
        break;
      case 'highlight':case 'hide_highlight':
        if(!input.ref||!input.revision||input.revision!==session.revision||!session.nodes.has(input.ref))throw Error('Stale page reference; inspect again');
        if(action==='highlight'&&(this.highlights.get(session.page)?.size??0)>=100)throw Error('At most 100 highlighted elements per page');
        break;
      case 'find':{
        if(!!input.text===!!input.regex)throw Error('find requires exactly one of text or regex');
        if(input.text!==undefined&&(!input.text.trim()||input.text.length>500))throw Error('Find text must be 1..500 characters');
        if(input.regex!==undefined){if(input.regex.length>200||!input.regex.trim())throw Error('Find regex must be 1..200 characters');safeFindRegex(input.regex);}
        break;
      }
      case 'wait_for':
        if(input.time===undefined&&!input.text&&!input.text_gone)throw Error('wait_for requires time, text or text_gone');
        if(input.time!==undefined&&(!Number.isFinite(input.time)||input.time<=0||input.time>30))throw Error('wait_for time must be 0..30 seconds');
        for(const value of [input.text,input.text_gone])if(value!==undefined&&(!value.trim()||value.length>500))throw Error('wait_for text must be 1..500 characters');
        break;
      case 'storage_state':prepared.target=newFile(input.path);break;
      case 'set_storage_state':{
        if(!input.revision||input.revision!==session.revision)throw Error('Stale page reference; inspect again');
        if(!input.path)throw Error('set_storage_state requires a task-relative path');
        const target=projectFilePath(root,input.path),info=lstatSync(target);
        if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('Storage state requires a regular file at most 1 MiB');
        const item=z.object({name:z.string().max(4096),value:z.string().max(262144)}).strict();
        const schema=z.object({cookies:z.array(z.object({name:z.string().max(256),value:z.string().max(4096),domain:z.string().max(253),path:z.string().startsWith('/'),expires:z.number().finite(),httpOnly:z.boolean(),secure:z.boolean(),sameSite:z.enum(['Strict','Lax','None'])}).strict()).max(500),origins:z.array(z.object({origin:z.string().url(),localStorage:z.array(item).max(1000)}).strict()).max(100)}).strict();
        const bytes=readFileSync(target);if(bytes.length>1024*1024)throw Error('Storage state exceeds 1 MiB');
        const state=schema.parse(JSON.parse(bytes.toString('utf8')));
        for(const o of state.origins)if(new URL(o.origin).origin!==o.origin||!this.permitted(o.origin+'/'))throw Error('Storage state origin is not authorized');
        for(const c of state.cookies)if(c.domain.startsWith('.')||!this.origins().some(o=>new URL(o).hostname===c.domain))throw Error('Storage state cookie domain is not an authorized exact host');
        prepared.storageState=state;break;
      }
      case 'resize':
        if(!Number.isInteger(input.width)||!Number.isInteger(input.height)||input.width!<320||input.width!>3840||input.height!<200||input.height!>2160)throw Error('resize requires width 320..3840 and height 200..2160');
        if(!input.revision||input.revision!==session.revision)throw Error('Stale page reference; inspect again');
        break;
      case 'network_state_set':
        if(typeof input.offline!=='boolean')throw Error('network_state_set requires offline boolean');
        if(!input.revision||input.revision!==session.revision)throw Error('Stale page reference; inspect again');
        break;
      case 'cookies':case 'routes':break;
      case 'cookie_set':
        if(!input.url||!this.permitted(input.url))throw Error('Cookie URL origin is not authorized');
        if(!input.name||!cookieName.test(input.name))throw Error('Cookie name must be a valid token');
        if(typeof input.value!=='string'||input.value.length>4096||/[;\r\n\0]/.test(input.value))throw Error('Cookie value must be at most 4096 characters without ; or line breaks');
        if(input.same_site!==undefined&&!['Strict','Lax','None'].includes(input.same_site))throw Error('same_site must be Strict, Lax or None');
        if(input.expires!==undefined&&(!Number.isFinite(input.expires)||input.expires<0))throw Error('expires must be a Unix time in seconds');
        break;
      case 'cookie_clear':if(input.name!==undefined&&!cookieName.test(input.name))throw Error('Cookie name must be a valid token');break;
      case 'storage':case 'storage_set':case 'storage_clear':
        if(!['local','session'].includes(input.kind??''))throw Error('Storage kind must be local or session');
        if(action==='storage_set'&&(!input.storage_key||input.storage_key.length>1024||typeof input.value!=='string'||input.value.length>256*1024))throw Error('storage_set requires a storage_key (1024 chars) and a string value (256 KiB)');
        if(action==='storage_clear'&&input.storage_key!==undefined&&(!input.storage_key||input.storage_key.length>1024))throw Error('storage_clear storage_key must be 1..1024 characters');
        if(action!=='storage'&&input.revision!==session.revision)throw Error('Stale page reference; inspect again');
        break;
      case 'route':{
        const pattern=input.url_pattern??'';
        const origin=this.origins().find(o=>pattern.startsWith(o+'/'));
        if(!origin||pattern.length>2048)throw Error('url_pattern must start with an authorized origin followed by /');
        if(!Number.isInteger(input.status)||input.status!<100||input.status!>599)throw Error('status must be an HTTP status code');
        if(typeof input.body!=='string'||Buffer.byteLength(input.body)>1024*1024)throw Error('body must be a string of at most 1 MiB');
        if(input.content_type!==undefined&&(input.content_type.length>200||/[\r\n]/.test(input.content_type)))throw Error('content_type is invalid');
        if(input.times!==undefined&&(!Number.isInteger(input.times)||input.times<1||input.times>1000))throw Error('times must be 1..1000');
        if((this.routes.get(session.context)?.size??0)>=32)throw Error('At most 32 mocked routes per session');
        break;
      }
      case 'unroute':if(!input.route_id||!this.routes.get(session.context)?.has(input.route_id))throw Error('Unknown route_id');break;
      case 'trace_start':if(this.tracing.has(session.context))throw Error('Tracing is already active');break;
      case 'trace_stop':if(!this.tracing.has(session.context))throw Error('Tracing is not active');prepared.target=newFile(input.path);break;
      case 'pdf':
        if(session.page.frames().some(f=>!this.frameAllowed(f)))throw Error('PDF would contain a frame without an origin grant');
        prepared.target=newFile(input.path);break;
      case 'evaluate':
        if(typeof input.expression!=='string'||!input.expression.trim()||input.expression.length>16384)throw Error('expression must be 1..16384 characters');
        if(input.revision!==session.revision||!session.revision)throw Error('Stale page reference; inspect again');
        break;
      case 'mouse_click':case 'mouse_move':case 'mouse_down':case 'mouse_up':case 'mouse_cancel':case 'mouse_path':case 'mouse_drag':case 'mouse_stroke':case 'mouse_wheel':{
        const viewport=session.page.viewportSize()??{width:1280,height:800};
        const inside=(x:unknown,y:unknown)=>typeof x==='number'&&typeof y==='number'&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<viewport.width&&y<viewport.height;
        const held=this.heldPointers.get(session.page);
        if(['mouse_down','mouse_move','mouse_path','mouse_up'].includes(action)&&session.page.frames().some(frame=>!this.frameAllowed(frame)))
          throw Error('Held pointer action includes a frame without an origin grant');
        if(action==='mouse_up'||action==='mouse_cancel'){
          if(!held||held.id!==input.hold_id||Date.now()>=held.expiresAt)throw Error('No matching active pointer hold; inspect or close the session');
          if(input.button!==undefined&&input.button!==held.button)throw Error('Pointer button must match the held button');
          if(input.x!==undefined||input.y!==undefined||input.to_x!==undefined||input.to_y!==undefined||input.points!==undefined||input.revision!==undefined)
            throw Error('mouse_up and mouse_cancel accept only hold_id and optional button');
        }else if(action==='mouse_stroke'||action==='mouse_path'){
          if(input.x!==undefined||input.y!==undefined||input.to_x!==undefined||input.to_y!==undefined)throw Error(`${action} accepts points, not individual coordinates`);
          if(!Array.isArray(input.points)||input.points.length<2||input.points.length>64||input.points.some(point=>!point||!inside(point.x,point.y)))
            throw Error(`${action} requires 2..64 points inside the page viewport`);
          if(input.points.some((point,index)=>index>0&&Math.hypot(point.x-input.points![index-1]!.x,point.y-input.points![index-1]!.y)>250))
            throw Error(`${action} points must be at most 250 CSS pixels apart`);
          if(action==='mouse_path'){
            if(!held||held.id!==input.hold_id||Date.now()>=held.expiresAt)throw Error('mouse_path requires the current active hold_id');
            if(input.button!==undefined)throw Error('mouse_path uses the button already held');
            if(input.revision!==undefined&&input.revision!==session.revision)throw Error('Stale page revision during pointer hold');
          }else{
            if(input.hold_id!==undefined)throw Error('mouse_stroke creates and releases its own button; omit hold_id');
            if(input.button!==undefined&&!['left','right','middle'].includes(input.button))throw Error('mouse_stroke button must be left/right/middle');
          }
        }else if(!inside(input.x,input.y))throw Error('x and y must be inside the page viewport');
        if(action==='mouse_down'&&held)throw Error('A pointer is already held; release or cancel it first');
        if(action==='mouse_move'&&held&&(held.id!==input.hold_id||Date.now()>=held.expiresAt))throw Error('Mouse move requires the current active hold_id');
        if(action==='mouse_move'&&held&&input.revision!==undefined&&input.revision!==session.revision)throw Error('Stale page revision during pointer hold');
        if(!held&&input.hold_id!==undefined&&action!=='mouse_up'&&action!=='mouse_cancel')throw Error('hold_id requires an active pointer hold');
        if(action==='mouse_down'&&input.hold_id!==undefined)throw Error('mouse_down creates a hold_id; do not supply one');
        if(['mouse_down','mouse_up','mouse_cancel'].includes(action)&&input.button!==undefined&&!['left','right','middle'].includes(input.button))throw Error('Pointer button must be left/right/middle');
        if(action==='mouse_drag'&&!inside(input.to_x,input.to_y))throw Error('to_x and to_y must be inside the page viewport');
        if(action==='mouse_click'&&((input.button!==undefined&&!['left','right','middle'].includes(input.button))||(input.click_count!==undefined&&(!Number.isInteger(input.click_count)||input.click_count<1||input.click_count>3))))throw Error('button must be left/right/middle and click_count 1..3');
        if(action==='mouse_wheel'&&(!Number.isInteger(input.delta_y)||input.delta_y===0||Math.abs(input.delta_y!)>2000))throw Error('delta_y must be a nonzero integer within 2000');
        if(!['mouse_up','mouse_cancel'].includes(action)&&!(['mouse_move','mouse_path'].includes(action)&&held)&&(input.revision!==session.revision||!session.revision))throw Error('Stale page reference; inspect or screenshot again');
        break;
      }
      case 'locator':if(!input.ref||input.revision!==session.revision||!session.refs.has(input.ref))throw Error('Stale page reference; inspect again');break;
      case 'webmcp_list':break;
      case 'webmcp_call':
        if(!input.tool_name||input.tool_name.length>200)throw Error('webmcp_call requires tool_name');
        if(input.input_json!==undefined){if(input.input_json.length>65536)throw Error('input_json exceeds 64 KiB');try{JSON.parse(input.input_json);}catch{throw Error('input_json must be valid JSON');}}
        break;
      case 'assert':
        if(input.assertion==='text_visible'){if(!input.text||input.text.length>500)throw Error('text_visible requires text of at most 500 characters');}
        else if(input.assertion==='element_visible'||input.assertion==='value'||input.assertion==='list_visible'){
          if(!input.ref||input.revision!==session.revision||!session.refs.has(input.ref))throw Error('Stale page reference; inspect again');
          if(input.assertion==='value'&&typeof input.value!=='string')throw Error('value assertion requires the expected value');
          if(input.assertion==='list_visible'){
            if(!Array.isArray(input.items)||input.items.length<1||input.items.length>100||input.items.some(i=>typeof i!=='string'||!i.trim()||i.length>500))throw Error('list_visible requires 1..100 non-empty item strings of at most 500 characters');
            const captured=JSON.parse(session.refs.get(input.ref)!) as {tag:string;role:string};
            if(!['UL','OL'].includes(captured.tag)&&captured.role!=='list')throw Error('list_visible requires a captured ul/ol or role=list element');
          }
        }else throw Error('assertion must be text_visible, element_visible, list_visible or value');
        break;
    }
    if(frame&&!this.frameAllowed(frame))throw Error('Frame origin is not authorized');
    return prepared;
  }

  async execute(p:Prepared,session:ExtraSession,signal?:AbortSignal):Promise<Record<string,unknown>>{
    const {input}=p,context=session.context,frame=p.frame??session.page.mainFrame();
    const write=(target:string,data:Buffer)=>{if(projectFilePath(p.root,input.path!)!==target)throw Error('Destination changed');const fd=openSync(target,'wx');try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}return {path:input.path,size:data.length,sha256:sha(data)};};
    switch(p.action){
      case 'accessibility_audit':
        return auditAccessibility(session.page,this.frameAllowed,input.max_issues??30,p.frame,session.frameVersions,signal);
      case 'record_start':return this.recorder.start(context,session.page);
      case 'record_status':return this.recorder.status(context,session.page);
      case 'record_export':case 'record_stop':
        return this.recorder.export(context,session.page,recordingLanguage(input.path!),
          data=>write(p.target!,data),p.action==='record_stop');
      case 'mouse_state':{
        const held=this.heldPointers.get(session.page);
        return {state:'completed',held:!!held&&Date.now()<held.expiresAt,
          ...(held?{hold_id:held.id,button:held.button,expires_at:new Date(held.expiresAt).toISOString(),expired:Date.now()>=held.expiresAt}:{})};
      }
      case 'find':{
        if(!this.frameAllowed(frame))throw Error('Find frame origin is not authorized');
        const snapshot=await frame.locator('body').ariaSnapshot({timeout:5000});
        if(!this.frameAllowed(frame))throw Error('Find frame origin changed');
        return searchSnapshot(snapshot,input.text,input.regex);
      }
      case 'wait_for':{
        if(input.time)await new Promise(resolve=>setTimeout(resolve,1000*input.time!));
        if(!this.frameAllowed(frame))throw Error('Wait frame origin is not authorized');
        if(input.text_gone)await frame.getByText(input.text_gone).first().waitFor({state:'hidden',timeout:30000});
        if(input.text)await frame.getByText(input.text).first().waitFor({state:'visible',timeout:30000});
        if(!this.frameAllowed(frame))throw Error('Wait frame origin changed');
        return {state:'completed',waited_for:{time:input.time??null,text:input.text??null,text_gone:input.text_gone??null}};
      }
      case 'annotate':case 'clear_annotations':{
        const old=this.annotation.get(session.page);
        if(old){await old.evaluate(el=>el.remove()).catch(()=>{});await old.dispose().catch(()=>{});this.annotation.delete(session.page);}
        if(p.action==='annotate'){
          const node=(await session.page.evaluateHandle(text=>{const el=document.createElement('div');el.textContent=text;el.style.cssText='position:fixed;top:12px;left:12px;max-width:80vw;padding:10px 16px;background:#111;color:#fff;font:18px system-ui;z-index:2147483647;pointer-events:none;border-radius:6px;white-space:pre-wrap';document.documentElement.append(el);return el;},input.text!)).asElement()!;
          this.annotation.set(session.page,node);
        }
        return {state:'completed',annotated:p.action==='annotate'};
      }

      case 'highlight':case 'hide_highlight':{
        const node=session.nodes.get(input.ref!)!;
        const owner=await node.ownerFrame();
        if(!owner||!this.frameAllowed(owner))throw Error('Highlight frame origin is not authorized');
        let entries=this.highlights.get(session.page);if(!entries){entries=new Map();this.highlights.set(session.page,entries);}
        let existing:ElementHandle<HTMLElement|SVGElement>|undefined;
        for(const old of entries.keys()){
          if(!await old.evaluate(el=>el.isConnected).catch(()=>false)){entries.delete(old);await old.dispose().catch(()=>{});continue;}
          if(await node.evaluate((el,other)=>el===other,old).catch(()=>false)){existing=old;break;}
        }
        if(p.action==='highlight'){
          const prior=await node.evaluate(el=>{const old={value:el.style.getPropertyValue('outline'),priority:el.style.getPropertyPriority('outline')};el.style.setProperty('outline','3px solid #ff3b30','important');return old;});
          if(!existing){const retained=(await node.evaluateHandle(el=>el)).asElement()!;entries.set(retained,prior);}
        }else if(existing){
          await node.evaluate((el,old)=>{if(old.value)el.style.setProperty('outline',old.value,old.priority);else el.style.removeProperty('outline');},entries.get(existing)!);
          entries.delete(existing);await existing.dispose();
        }
        return {state:'completed',highlighted:p.action==='highlight',ref:input.ref};
      }

      case 'storage_state':{
        const state=await context.storageState();
        state.origins=state.origins.filter(o=>this.permitted(o.origin+'/'));
        state.cookies=state.cookies.filter(c=>!c.domain.startsWith('.')&&this.origins().some(o=>new URL(o).hostname===c.domain));
        const bytes=Buffer.from(JSON.stringify(state));if(bytes.length>1024*1024)throw Error('Storage state exceeds 1 MiB');
        return {state:'completed',artifact:write(p.target!,bytes),contains_credentials:true};
      }
      case 'set_storage_state':
        await context.setStorageState(p.storageState!);
        session.revision='';session.refs.clear();session.nodes.clear();
        return {state:'completed',restored:true,revision_invalidated:true,scope:'browser_context'};

      case 'resize':
        await session.page.setViewportSize({width:input.width!,height:input.height!});
        session.revision='';session.refs.clear();session.nodes.clear();
        return {state:'completed',viewport:{width:input.width,height:input.height},revision_invalidated:true};
      case 'network_state_set':
        await context.setOffline(input.offline!);
        session.revision='';session.refs.clear();session.nodes.clear();
        return {state:'completed',offline:input.offline,scope:'browser_context',revision_invalidated:true};
      case 'cookies':{
        const cookies=await context.cookies(this.origins());
        return {state:'completed',cookies:cookies.slice(0,200).map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,expires:c.expires,http_only:c.httpOnly,secure:c.secure,same_site:c.sameSite})),truncated:cookies.length>200};
      }
      case 'cookie_set':
        await context.addCookies([{name:input.name!,value:input.value!,url:input.url!,...(input.http_only!==undefined?{httpOnly:input.http_only}:{}),...(input.secure!==undefined?{secure:input.secure}:{}),...(input.same_site?{sameSite:input.same_site as 'Strict'|'Lax'|'None'}:{}),...(input.expires!==undefined?{expires:input.expires}:{})}]);
        return {state:'completed',cookie:{name:input.name,url:input.url}};
      case 'cookie_clear':
        await context.clearCookies(input.name?{name:input.name}:undefined);
        return {state:'completed',cleared:input.name??'all'};
      case 'storage':case 'storage_set':case 'storage_clear':{
        const result=await frame.evaluate(({action,kind,key,value})=>{
          const store=kind==='local'?window.localStorage:window.sessionStorage;
          if(action==='storage_set')store.setItem(key!,value!);
          else if(action==='storage_clear'){if(key===undefined)store.clear();else store.removeItem(key);}
          const entries:[string,string][]=[];for(let i=0;i<store.length&&i<200;i++){const k=store.key(i)!;entries.push([k,store.getItem(k)??'']);}
          return {origin:location.origin,length:store.length,entries};
        },{action:p.action,kind:input.kind!,key:input.storage_key,value:input.value});
        if(!this.permitted(result.origin+'/'))throw Error('Storage frame origin is not authorized');
        if(p.action!=='storage'){session.revision='';session.refs.clear();}
        return {state:'completed',kind:input.kind,origin:result.origin,length:result.length,entries:result.entries.map(([key,value])=>({key,value:value.length>4096?value.slice(0,4096):value,value_truncated:value.length>4096})),truncated:result.length>200,...(p.action!=='storage'?{revision_invalidated:true}:{})};
      }
      case 'route':{
        const routes=this.routes.get(context)??new Map<string,MockRoute>();this.routes.set(context,routes);
        const body=Buffer.from(input.body!,'utf8'),route_id=randomUUID();
        const entry:MockRoute={route_id,url_pattern:input.url_pattern!,status:input.status!,content_type:input.content_type??'text/plain; charset=utf-8',body_sha256:sha(body),bytes:body.length,times:input.times??null,hits:0,
          handler:async route=>{
            // The guard route still rejects anything outside authorized origins.
            if(!this.permitted(route.request().url()))return route.abort('blockedbyclient');
            entry.hits++;if(entry.times!==null&&entry.hits>=entry.times)routes.delete(route_id);
            await route.fulfill({status:entry.status,contentType:entry.content_type,body});
          }};
        await context.route(entry.url_pattern,entry.handler,input.times!==undefined?{times:input.times}:undefined);
        routes.set(route_id,entry);
        return {state:'completed',route:this.describe(entry)};
      }
      case 'unroute':{
        const routes=this.routes.get(context)!,entry=routes.get(input.route_id!)!;
        await context.unroute(entry.url_pattern,entry.handler);routes.delete(entry.route_id);
        return {state:'completed',removed:this.describe(entry)};
      }
      case 'routes':return {state:'completed',routes:[...(this.routes.get(context)?.values()??[])].map(r=>this.describe(r))};
      case 'trace_start':
        await context.tracing.start({screenshots:true,snapshots:true,sources:false});this.tracing.add(context);
        return {state:'completed',tracing:true};
      case 'trace_stop':{
        const dir=await mkdtemp(join(tmpdir(),'forge-trace-'));
        try{
          const staged=join(dir,'trace.zip');await context.tracing.stop({path:staged});this.tracing.delete(context);
          const data=await readFile(staged);if(data.length>64*1024*1024)throw Error('Trace exceeds 64 MiB');
          return {state:'completed',trace:write(p.target!,data)};
        }finally{await rm(dir,{recursive:true,force:true});}
      }
      case 'pdf':{
        const data=await session.page.pdf({printBackground:true});
        if(data.length>32*1024*1024)throw Error('PDF exceeds 32 MiB');
        if(session.page.frames().some(f=>!this.frameAllowed(f)))throw Error('PDF would contain a frame without an origin grant');
        return {state:'completed',pdf:write(p.target!,data)};
      }
      case 'evaluate':{
        const value=await frame.evaluate(input.expression!);
        session.revision='';session.refs.clear();
        let text:string;try{text=JSON.stringify(value)??'undefined';}catch{text='"[unserializable result]"';}
        return {state:'completed',result:text.length>65536?text.slice(0,65536):text,result_truncated:text.length>65536,revision_invalidated:true};
      }
      case 'mouse_click':case 'mouse_move':case 'mouse_down':case 'mouse_up':case 'mouse_cancel':case 'mouse_path':case 'mouse_drag':case 'mouse_stroke':case 'mouse_wheel':{
        if(['mouse_down','mouse_up','mouse_cancel','mouse_path'].includes(p.action)||this.heldPointers.has(session.page)){
          const page=session.page,held=this.heldPointers.get(page);
          const check=()=>{
            if(signal?.aborted||page.isClosed()||!this.permitted(page.url())||page.frames().some(frame=>!this.frameAllowed(frame)))
              throw Error('Pointer hold cancelled or document origin is no longer authorized');
          };
          if(p.action==='mouse_down'){
            if(held)throw Error('Pointer is already held');
            const button=(input.button??'left') as 'left'|'right'|'middle';
            check();await page.mouse.move(input.x!,input.y!);check();
            const active:PointerHold={id:randomUUID(),button,expiresAt:Date.now()+30_000,timer:undefined!,changed:()=>{void this.releasePointer(page).catch(()=>{});}};
            active.timer=setTimeout(active.changed,30_000);active.timer.unref?.();
            this.heldPointers.set(page,active);
            page.on('framenavigated',active.changed);page.on('framedetached',active.changed);page.on('close',active.changed);
            session.revision='';session.refs.clear();
            try{await page.mouse.down({button});check();if(this.heldPointers.get(page)!==active)throw Error('Pointer hold was released while pressing');}
            catch(error){await this.releasePointer(page);throw error;}
            return {state:'completed',action:p.action,hold_id:active.id,button,expires_at:new Date(active.expiresAt).toISOString(),revision_invalidated:true};
          }
          if(!held||held.id!==input.hold_id||Date.now()>=held.expiresAt)throw Error('Active pointer hold expired or changed');
          if(p.action==='mouse_cancel'){
            await this.releasePointer(page);
            session.revision='';session.refs.clear();
            return {state:'completed',action:p.action,hold_id:held.id,cancelled:true,revision_invalidated:true};
          }
          try{
            check();
            if(p.action==='mouse_path'){
              for(const point of input.points!){await page.mouse.move(point.x,point.y,{steps:2});check();}
              session.revision='';session.refs.clear();
              return {state:'completed',action:p.action,hold_id:held.id,points:input.points!.length,revision_invalidated:true};
            }
            if(p.action==='mouse_move'){
              await page.mouse.move(input.x!,input.y!,{steps:3});check();
              session.revision='';session.refs.clear();
              return {state:'completed',action:p.action,hold_id:held.id,revision_invalidated:true};
            }
            await this.releasePointer(page,false);check();
            session.revision='';session.refs.clear();
            return {state:'completed',action:p.action,hold_id:held.id,released:true,revision_invalidated:true};
          }catch(error){await this.releasePointer(page);throw error;}
        }
        if(p.action==='mouse_stroke'){
          const page=session.page,points=input.points!,button=(input.button??'left') as 'left'|'right'|'middle';
          // Reject unauthorized embedded documents, even when the gesture
          // crosses their surface between explicit waypoints.
          let documentChanged=false,pressed=false;
          const changed=()=>{documentChanged=true;};
          page.on('framenavigated',changed);page.on('framedetached',changed);page.on('close',changed);
          const check=()=>{
            if(signal?.aborted)throw Error('Browser mouse stroke cancelled');
            if(documentChanged||session.page!==page||page.isClosed()||!this.permitted(page.url())||page.frames().some(frame=>!this.frameAllowed(frame)))
              throw Error('Mouse stroke document changed or includes a frame without an origin grant');
          };
          session.revision='';session.refs.clear();
          try{
            check();
            await page.mouse.move(points[0]!.x,points[0]!.y);check();
            // Set pressed before invoking the protocol so a partial dispatch
            // is still released if the native call throws.
            pressed=true;await page.mouse.down({button});check();
            for(const point of points.slice(1)){await page.mouse.move(point.x,point.y,{steps:2});check();}
            await page.mouse.up({button});pressed=false;check();
            return {state:'completed',action:p.action,points:points.length,revision_invalidated:true};
          }finally{
            if(pressed){
              await page.keyboard.press('Escape').catch(()=>{});
              await page.mouse.move(-1,-1).catch(()=>{});
              await page.mouse.up({button}).catch(()=>{});
            }
            page.off('framenavigated',changed);page.off('framedetached',changed);page.off('close',changed);
          }
        }
        // Points must land on a document whose frame is authorized.
        const points:[number,number][]=p.action==='mouse_drag'?[[input.x!,input.y!],[input.to_x!,input.to_y!]]:[[input.x!,input.y!]];
        for(const point of points){
          const handle=await session.page.evaluateHandle(([px,py])=>document.elementFromPoint(px,py),point);
          const element=handle.asElement();
          if(element&&await element.evaluate(e=>e.tagName==='IFRAME'||e.tagName==='FRAME')){const child=await element.contentFrame();if(child&&!this.frameAllowed(child))throw Error('Point lands on a frame without an origin grant');}
          await handle.dispose();
        }
        const mouse=session.page.mouse;
        if(p.action==='mouse_click')await mouse.click(input.x!,input.y!,{button:(input.button??'left') as 'left'|'right'|'middle',clickCount:input.click_count??1});
        else if(p.action==='mouse_move')await mouse.move(input.x!,input.y!);
        else if(p.action==='mouse_drag'){await mouse.move(input.x!,input.y!);await mouse.down();try{await mouse.move(input.to_x!,input.to_y!,{steps:12});}finally{await mouse.up();}}
        else{await mouse.move(input.x!,input.y!);await mouse.wheel(0,input.delta_y!);}
        session.revision='';session.refs.clear();
        return {state:'completed',action:p.action,revision_invalidated:true};
      }
      case 'locator':{
        const node=session.nodes.get(input.ref!);if(!node)throw Error('Stale page reference; inspect again');
        const info=await node.evaluate(e=>{
          const el=e as HTMLElement;
          const forLabel=el.id?document.querySelector('label[for="'+CSS.escape(el.id)+'"]')?.textContent??'':'';
          const label=(el.getAttribute('aria-label')||forLabel||'').trim();
          const text=(el.innerText||'').trim().slice(0,80);
          const path:string[]=[];let n:Element|null=el;
          while(n&&n!==document.documentElement&&path.length<6){
            const current:Element=n,parent:Element|null=current.parentElement;
            const same:Element[]=[];if(parent)for(const c of Array.from(parent.children))if(c.tagName===current.tagName)same.push(c);
            path.unshift(current.tagName.toLowerCase()+(same.length>1?':nth-of-type('+(same.indexOf(current)+1)+')':''));
            n=parent;
          }
          return {tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),test_id:el.getAttribute('data-testid'),id:el.id||null,label:label.slice(0,120),text,placeholder:el.getAttribute('placeholder'),css:path.join(' > ')};
        });
        const q=(v:string)=>JSON.stringify(v);
        const implicitRole:Record<string,string>={button:'button',a:'link',select:'combobox',textarea:'textbox',h1:'heading',h2:'heading',h3:'heading'};
        const role=info.role??implicitRole[info.tag]??(info.tag==='input'?'textbox':null);
        const locators:string[]=[];
        if(info.test_id)locators.push('getByTestId('+q(info.test_id)+')');
        if(role&&(info.label||info.text))locators.push('getByRole('+q(role)+', { name: '+q(info.label||info.text)+' })');
        if(info.label)locators.push('getByLabel('+q(info.label)+')');
        if(info.placeholder)locators.push('getByPlaceholder('+q(info.placeholder)+')');
        if(info.text&&!['input','textarea','select'].includes(info.tag))locators.push('getByText('+q(info.text)+')');
        if(info.id)locators.push('locator('+q('#'+info.id)+')');
        locators.push('locator('+q(info.css)+')');
        const cssMatches=await frame.evaluate(css=>document.querySelectorAll(css).length,info.css).catch(()=>-1);
        return {state:'completed',element:{tag:info.tag,role,test_id:info.test_id,label:info.label||null},locators,css_matches:cssMatches};
      }
      case 'webmcp_list':case 'webmcp_call':{
        // WebMCP tools are registered by the page on document/navigator.modelContext.
        const result=await frame.evaluate(async({action,name,inputJson})=>{
          const ctx=(document as any).modelContext??(navigator as any).modelContext;
          if(!ctx||typeof ctx.getTools!=='function')return {available:false} as any;
          const tools=(await ctx.getTools()) as any[];
          const own:any[]=[];for(const t of tools)if(!('window' in t)||t.window===window)own.push(t);
          if(action==='webmcp_list'){
            const listed:any[]=[];
            for(const t of own){let input_schema=t.inputSchema??null;if(typeof input_schema==='string'){try{input_schema=JSON.parse(input_schema);}catch{input_schema=null;}}listed.push({name:String(t.name),title:t.title??null,description:String(t.description??''),input_schema,annotations:t.annotations??null});}
            return {available:true,tools:listed};
          }
          let tool:any;for(const t of own)if(t.name===name){tool=t;break;}
          if(!tool)return {available:true,error:'Unknown WebMCP tool'};
          const raw=typeof ctx.executeTool==='function'?await ctx.executeTool(tool,inputJson):await ctx.invokeTool(name,JSON.parse(inputJson));
          return {available:true,result:typeof raw==='string'?raw:JSON.stringify(raw??null)};
        },{action:p.action,name:input.tool_name??'',inputJson:input.input_json??'{}'});
        if(!result.available)return {state:'completed',webmcp_available:false,message:'This page does not expose WebMCP (document.modelContext / navigator.modelContext)'};
        // Nothing ran when the page has no such tool: a definite, completed outcome.
        if(result.error)return {state:'completed',webmcp_available:true,called:false,error:String(result.error)};
        if(p.action==='webmcp_list')return {state:'completed',webmcp_available:true,tools:result.tools};
        session.revision='';session.refs.clear();
        const text=result.result as string|undefined;
        return {state:'completed',webmcp_available:true,result:text&&text.length>65536?text.slice(0,65536):text,result_truncated:!!text&&text.length>65536,revision_invalidated:true};
      }
      case 'assert':{
        if(input.assertion==='text_visible'){
          for(const f of session.page.frames()){
            if(!this.frameAllowed(f))continue;
            if(await f.getByText(input.text!).first().isVisible().catch(()=>false))return {state:'completed',assertion:'text_visible',passed:true};
          }
          return {state:'completed',assertion:'text_visible',passed:false};
        }
        const node=session.nodes.get(input.ref!);if(!node)throw Error('Stale page reference; inspect again');
        if(input.assertion==='element_visible'){const visible=await node.isVisible();return {state:'completed',assertion:'element_visible',passed:visible};}
        if(input.assertion==='list_visible'){
          if(!await node.isVisible())return {state:'completed',assertion:'list_visible',passed:false,reason:'list_hidden'};
          const children=await node.$$('li,[role="listitem"]');
          try{
            if(children.length>500)throw Error('List exceeds 500 items');
            const actual:string[]=[];
            for(const child of children)if(await child.isVisible())actual.push((await child.innerText()).replace(/\s+/g,' ').trim().slice(0,2000));
            // Accept a partial ordered list; it must be a sequence of
            // genuinely visible list items within the captured list, not a
            // substring somewhere in the page body.
            let position=0;
            for(const item of input.items!){
              const target=item.replace(/\s+/g,' ').trim();
              while(position<actual.length&&!actual[position]!.includes(target))position++;
              if(position===actual.length)return {state:'completed',assertion:'list_visible',passed:false,missing:item,visible_items:actual.length};
              position++;
            }
            return {state:'completed',assertion:'list_visible',passed:true,matched:input.items!.length,visible_items:actual.length};
          }finally{await Promise.all(children.map(c=>c.dispose().catch(()=>{})));}
        }
        const actual=await node.evaluate(e=>'value' in e?String((e as HTMLInputElement).value):(e.textContent??''));
        return {state:'completed',assertion:'value',passed:actual===input.value,actual:actual.length>4096?actual.slice(0,4096):actual};
      }
    }
  }
  private describe(r:MockRoute){return {route_id:r.route_id,url_pattern:r.url_pattern,status:r.status,content_type:r.content_type,body_sha256:r.body_sha256,bytes:r.bytes,times:r.times,hits:r.hits};}
}
