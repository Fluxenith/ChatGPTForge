import {parseDesktopHotkey} from './desktop-hotkey.js';
import {observeDesktop} from './desktop-observation.js';
import {DesktopInputMonitor,type InputMonitor,type InputStamp} from './desktop-input-monitor.js';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as z from 'zod/v4';
import {desktopScript,desktopNativeSources} from './desktop-helper.js';
import {DurableTasks} from './durable-tasks.js';
import {resolveCanonicalAllowedPath} from './roots.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';
type Window={pid:number,creation:string,title:string,app:string,hwnd?:string};
type Control={index:number,name:string,type:string,runtime_id:string,password:boolean,enabled?:boolean,pointer_bounds?:number[],checked?:boolean|null,selected?:boolean,scroll?:{horizontal_scrollable:boolean,vertical_scrollable:boolean,horizontal_percent:number,vertical_percent:number}};
type CaptureGeometry={window_x:number,window_y:number,width:number,height:number,image_width:number,image_height:number};
type Snapshot={pid:number,grant_id:string,controls:Control[],key:string,capture?:CaptureGeometry,inputStamp?:InputStamp};
const inputWorkers=new Map<string,Set<()=>void>>();
function interruptDesktopWorkers(name:string){for(const stop of inputWorkers.get(name)??[])stop();}
const nativeCaptureExecutable=fileURLToPath(new URL('../bin/forge-window-capture.exe',import.meta.url));
const nativeDirectory=fileURLToPath(new URL('../bin/',import.meta.url));
function verifiedNativeDirectory():string|undefined {
  try{
    const manifest=JSON.parse(readFileSync(nativeDirectory+'forge-desktop-manifest.json','utf8'));
    for(const [name,source] of Object.entries(desktopNativeSources)){
      const pin=manifest[name];
      if(pin?.source_sha256!==createHash('sha256').update(source).digest('hex')||pin.binary_sha256!==createHash('sha256').update(readFileSync(nativeDirectory+'forge-desktop-'+name+'.dll')).digest('hex'))return undefined;
    }
    return nativeDirectory;
  }catch{return undefined;}
}
export function desktopCall(input:unknown):Promise<any>{
  const record=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
  if(record.action==='observe')return observeDesktop(record,desktopWorker);
  return desktopWorker(record,record.action==='inspect'?5000:20000);
}
function desktopWorker(input:Record<string,unknown>,timeoutMs:number):Promise<any>{
  if(process.platform!=='win32')return Promise.reject(Error('Desktop tools require Windows'));
  return new Promise((resolve,reject)=>{
    // Keep the Windows command line bounded. The first stdin line contains only
    // our bundled helper; the remainder is JSON data, never executable input.
    const bootstrap="[Console]::InputEncoding=New-Object System.Text.UTF8Encoding; $taskDesktopSource=[Console]::In.ReadLine(); & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($taskDesktopSource))))";
    const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',error='',settled=false;
    const outputLimit=['screenshot','observe','screen'].includes((input as {action?:string})?.action??'')?5*1024*1024:1024*1024;
    const fail=(e:Error)=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}};
    const guard=(input.input_guard as InputStamp|undefined)?.name;
    const mutation=!['list','inspect','screenshot','observe','screen'].includes(String(input.action));
    const stop=()=>{p.kill();fail(Error('Desktop input interrupted; outcome unknown, do not replay input'));};
    // Surface drag checks the monitor during every step and releases its own
    // pressed button in finally; killing it on human input could strand a drag.
    if(guard&&mutation&&input.action!=='surface_input'){let workers=inputWorkers.get(guard);if(!workers){workers=new Set;inputWorkers.set(guard,workers);}workers.add(stop);}
    p.once('close',()=>{if(guard){const workers=inputWorkers.get(guard);workers?.delete(stop);if(workers?.size===0)inputWorkers.delete(guard);}});
    const timer=setTimeout(()=>{p.kill();fail(Object.assign(Error('Desktop result unknown after timeout; do not replay input'),{code:'DESKTOP_TIMEOUT'}));},timeoutMs);
    p.on('error',fail);p.stdin.on('error',()=>{});
    p.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>outputLimit){p.kill();fail(Error('Desktop output limit'));}});
    p.stderr.on('data',b=>{error=(error+b.toString('utf8')).slice(-3000);});
    p.on('close',code=>{if(settled)return;clearTimeout(timer);settled=true;if(code!==0){reject(Error(error||'Desktop helper failed'));return;}try{resolve(JSON.parse(output));}catch(e){reject(e);}});
    // The optional native capture program is selected only from this installed
    // package. No caller-provided executable path is ever forwarded to PowerShell.
    const record=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
    const {wgc_executable:_ignored,native_directory:_ignoredDirectory,...safeInput}=record;
    const action=safeInput.action;
    const payload={...safeInput,native_directory:verifiedNativeDirectory(),...(['screenshot','observe'].includes(String(action))&&existsSync(nativeCaptureExecutable)?{wgc_executable:nativeCaptureExecutable}:{})};
    p.stdin.end(Buffer.from(desktopScript,'utf8').toString('base64')+'\n'+JSON.stringify(payload));
  });
}
export class ForgeDesktop {
  private grants=new Map<string,{id:string,window:Window,expires:number}>();
  private snapshots=new Map<string,Snapshot>();
  private busy=false;
  private screenGrantExpires=0;
  private screenGrantId=0;
  private sessionExpires=0;
  private sessionGeneration=0;
  private surfaces=new Map<string,{revision:string;generation:number;time:number;geometry:any;targets:any[];stamp?:InputStamp}>();
  private grantExpiry?:ReturnType<typeof setTimeout>;
  constructor(private engine:DurableTasks,private roots:string[],private call=desktopCall,
    private monitor:InputMonitor|null=call===desktopCall?new DesktopInputMonitor(interruptDesktopWorkers):null){
    engine.db.exec('CREATE TABLE IF NOT EXISTS desktop_operations(task_id TEXT,id TEXT,request TEXT,state TEXT,result TEXT,PRIMARY KEY(task_id,id))');
  }
  async windows(pid?:number):Promise<Window[]>{return this.call({action:'list',...(pid===undefined?{}:{pid})});}
  async grant(pid:number,hwnd?:string){
    const windows=(await this.windows(pid)).filter(w=>w.pid===pid);
    if(!hwnd&&windows.length>1)throw Error('Select an exact window handle; this process has multiple windows');
    const w=hwnd?windows.find(w=>w.hwnd===hwnd):windows[0];
    if(!w)throw Error('Window no longer available');
    if(this.monitor){try{this.monitor.stamp();}catch{this.revoke();}await this.monitor.authorize(w.hwnd);}
    this.grants.set(`${pid}:${w.hwnd??''}`,{id:randomUUID(),window:w,expires:Date.now()+15*60*1000});
    this.armGrantExpiry();
    for(const [task,snapshot] of this.snapshots)if(snapshot.pid===pid)this.snapshots.delete(task);
    return {window:w,expires_in_minutes:15};
  }
  async grantSession(){
    this.revoke();
    const generation=this.sessionGeneration;
    await this.monitor?.authorize('0'); // Zero means physical input anywhere on the desktop.
    if(generation!==this.sessionGeneration)throw Error('Desktop session grant superseded');
    this.sessionExpires=Date.now()+15*60*1000;
    this.sessionGeneration++;
    this.grantScreen();this.armGrantExpiry();
    return {scope:'desktop_session',expires_in_minutes:15};
  }
  private async resolveGrant(pid:number,hwnd?:string){
    if(hwnd!==undefined&&!/^\d+$/.test(hwnd))throw Error('Invalid window handle');
    const session=this.sessionExpires>Date.now(),generation=this.sessionGeneration;
    if(session){
      this.monitor?.stamp(); // Never clear a physical Escape latch through remote calls.
      const windows=(await this.windows(pid)).filter(w=>w.pid===pid&&(!hwnd||w.hwnd===hwnd));
      if(windows.length!==1)throw Error('Select an exact available window handle from desktop_screen');
      if(this.sessionExpires<=Date.now()||generation!==this.sessionGeneration)throw Error('Desktop session revoked or expired');
      this.monitor?.stamp();
      const w=windows[0]!,key=`${pid}:${w.hwnd??''}`,prior=this.grants.get(key);
      if(!prior||prior.window.creation!==w.creation||prior.expires<=Date.now()){
        this.grants.set(key,{id:randomUUID(),window:w,expires:this.sessionExpires});
      }
      return this.grants.get(key)!;
    }
    const choices=[...this.grants.values()].filter(g=>g.window.pid===pid&&g.expires>Date.now()&&(!hwnd||g.window.hwnd===hwnd));
    if(choices.length!==1)throw Error('請在本機管理頁選擇並授權視窗（15 分鐘）；多視窗請指定 hwnd');
    return choices[0]!;
  }
  grantScreen(){this.screenGrantId++;this.screenGrantExpires=Date.now()+15*60*1000;return {scope:'all_screens',expires_in_minutes:15};}
  private armGrantExpiry(){
    clearTimeout(this.grantExpiry);
    if(this.sessionExpires<=Date.now())this.sessionExpires=0;
    if(!this.grants.size&&!this.sessionExpires){this.monitor?.close();return;}
    this.grantExpiry=setTimeout(()=>{
      for(const [pid,grant] of this.grants)if(grant.expires<=Date.now())this.grants.delete(pid);
      for(const [task,snapshot] of this.snapshots)if(![...this.grants.values()].some(g=>g.id===snapshot.grant_id))this.snapshots.delete(task);
      this.armGrantExpiry();
    },Math.max(1,Math.min(...[...this.grants.values()].map(g=>g.expires),this.sessionExpires||Infinity)-Date.now()));
    this.grantExpiry.unref();
  }
  revoke(){this.sessionExpires=0;this.sessionGeneration++;clearTimeout(this.grantExpiry);this.grants.clear();this.snapshots.clear();this.surfaces.clear();this.screenGrantExpires=0;this.screenGrantId++;this.monitor?.close();}
  async surface(task:string,id:string,lease:string,input:{action:'observe'|'click'|'drag';revision?:string;source_hwnd?:string;destination_hwnd?:string;x?:number;y?:number;end_x?:number;end_y?:number}){
    const row=this.engine.task(task);await resolveCanonicalAllowedPath(row.root,row.root,await Promise.all(this.roots.map(r=>realpath(r))));this.engine.assertLease(row,lease);
    if(row.status!=='active')throw Error('Task not active');
    if(this.sessionExpires<=Date.now())throw Error('Desktop surface input requires a local desktop-session grant; screenshot consent alone is insufficient');
    const generation=this.sessionGeneration,stamp=this.monitor?.stamp(),request=JSON.stringify({surface:input});
    const prior=this.engine.db.prepare('SELECT request,state,result FROM desktop_operations WHERE task_id=? AND id=?').get(task,id) as any;
    if(prior){if(prior.request!==request)throw Error('Operation ID reused');return prior.state==='completed'?JSON.parse(prior.result):{state:'unknown',message:'Observe and inspect receipt; never replay unknown input'};}
    this.engine.assertIdle(row,input.action==='observe',[],true);if(this.busy)throw Error('Desktop input already in progress');
    const check=()=>{if(this.sessionExpires<=Date.now()||this.sessionGeneration!==generation)throw Error('Desktop session expired or revoked');if(stamp)this.monitor!.check(stamp);};
    const observe=async()=>{
      const screen=await this.call({action:'screen'}),windows=await this.windows(),shell=await this.call({action:'surface_catalog'});
      check();const png=Buffer.from(screen.image??'','base64');if(png.length>3*1024*1024||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid surface PNG');
      const {image,...geometry}=screen;
      if(!['x','y','width','height','image_width','image_height'].every(k=>Number.isInteger(geometry[k]))||geometry.width<2||geometry.height<2||geometry.image_width<1||geometry.image_height<1)throw Error('Invalid surface geometry');
      const targets=[...windows.filter((w:any)=>!w.window?.minimized).map((w:any)=>({...w.window,pid:w.pid,creation:w.creation,hwnd:w.hwnd,title:w.title,kind:'window'})),...shell];
      const revision=randomUUID();this.surfaces.set(task,{revision,generation,time:Date.now(),geometry,targets,stamp});
      return {state:'observed',coordinate_space:'desktop_image',...geometry,targets,revision,image};
    };
    this.busy=true;
    try {
      if(input.action==='observe'){this.surfaces.delete(task);return await observe();}
      if(!['click','drag'].includes(input.action))throw Error('Unsupported surface action');
      const snap=this.surfaces.get(task);if(!snap||snap.revision!==input.revision||snap.generation!==generation||Date.now()-snap.time>120000)throw Error('Stale desktop surface revision; observe again');
      if(snap.stamp)this.monitor!.check(snap.stamp);
      const source=snap.targets.find(t=>t.hwnd===input.source_hwnd),destination=input.action==='drag'?snap.targets.find(t=>t.hwnd===input.destination_hwnd):source;
      if(!source||!destination)throw Error('Select exact source and destination handles from surface observation');
      if(input.action==='drag'&&(source.kind!=='window'||destination.kind!=='window'||source.hwnd===destination.hwnd))throw Error('Cross-window drag requires two distinct supported application windows');
      const g=snap.geometry,ex=input.action==='drag'?input.end_x:input.x,ey=input.action==='drag'?input.end_y:input.y;
      const point=(x:number|undefined,y:number|undefined,t:any)=>{if(!Number.isInteger(x)||!Number.isInteger(y)||x!<0||y!<0||x!>=g.image_width||y!>=g.image_height)throw Error('Pointer outside desktop image');const sx=g.x+Math.floor((x!+.5)*g.width/g.image_width),sy=g.y+Math.floor((y!+.5)*g.height/g.image_height);if(sx<t.x||sy<t.y||sx>=t.x+t.width||sy>=t.y+t.height)throw Error('Pointer outside selected target');};
      point(input.x,input.y,source);point(ex,ey,destination);
      for(const t of [...new Map([source,destination].map(t=>[t.hwnd,t])).values()])if(t.kind==='window'){
        const grant=await this.resolveGrant(t.pid,t.hwnd);if(grant.window.creation!==t.creation)throw Error('Target identity changed');
        const inspected=await this.call({action:'inspect',pid:t.pid,hwnd:t.hwnd,creation:t.creation});
        if(!Array.isArray(inspected.controls)||inspected.controls.some((c:any)=>c.password))throw Error('Password controls or unavailable accessibility; surface input refused');
      }
      check();this.engine.assertIdle(row,false,[],true);this.surfaces.delete(task);this.snapshots.delete(task);this.engine.interactionBusy.add(task);
      this.engine.db.prepare('INSERT INTO desktop_operations VALUES(?,?,?,?,NULL)').run(task,id,request,'unknown');
      const result=await this.call({action:'surface_input',operation:input.action,source,destination,geometry:g,x:input.x,y:input.y,end_x:ex,end_y:ey,input_guard:stamp});
      check();let image:string|undefined;
      try{const post=await observe();image=post.image;const {image:_,...metadata}=post;result.post_observation=metadata;result.verification='post_state_observed';}catch(e){result.post_observation_error=String(e);}
      this.engine.db.prepare('UPDATE desktop_operations SET state=?,result=? WHERE task_id=? AND id=?').run('completed',JSON.stringify(result),task,id);
      this.engine.event(task,'desktop_surface_completed',{operation_id:id,action:input.action});
      return image?{...result,image}:result;
    }finally{this.busy=false;this.engine.interactionBusy.delete(task);}
  }
  close(){this.revoke();}
  async screen(task:string,lease:string){
    const row=this.engine.task(task);await resolveCanonicalAllowedPath(row.root,row.root,await Promise.all(this.roots.map(r=>realpath(r))));this.engine.assertLease(row,lease);
    if(row.status!=='active')throw Error('Task not active');
    const grant=this.screenGrantExpires;
    const grantId=this.screenGrantId;
    if(grant<=Date.now())throw Error('請在本機管理頁獨立授權整個桌面截圖（15 分鐘）');
    this.engine.assertIdle(row,true,[],true);
    if(this.busy)throw Error('Desktop input already in progress');
    this.busy=true;
    try{
      const result=await this.call({action:'screen'});
      const windows=await this.windows();
      if(this.screenGrantId!==grantId||grant<=Date.now())throw Error('Desktop capture grant revoked or expired');
      const data=typeof result?.image==='string'?Buffer.from(result.image,'base64'):Buffer.alloc(0);
      if(data.length<8||data.length>3*1024*1024||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid or oversized PNG from desktop capture');
      this.engine.event(task,'desktop_screen_captured',{});
      return {...result,state:'captured',windows,desktop_session_active:this.sessionExpires>Date.now()};
    }finally{this.busy=false;}
  }
  async run(task:string,id:string,lease:string,input:{pid:number,hwnd?:string,action:'inspect'|'observe'|'invoke'|'fill'|'check'|'screenshot'|'select'|'scroll'|'press'|'window'|'click'|'double_click'|'drag'|'hotkey'|'type_text'|'focus',input_mode?:'messages'|'physical',coordinate_space?:'window',observe_after?:boolean,chord?:string,button?:'left'|'right',end_x?:number,end_y?:number,revision?:string,ref?:number,text?:string,checked?:boolean,horizontal_percent?:number,vertical_percent?:number,key?:string,window_state?:'minimize'|'restore'|'maximize',x?:number,y?:number,width?:number,height?:number}){
    const row=this.engine.task(task);await resolveCanonicalAllowedPath(row.root,row.root,await Promise.all(this.roots.map(r=>realpath(r))));this.engine.assertLease(row,lease);
    if(row.status!=='active')throw Error('Task not active');
    const grant=await this.resolveGrant(input.pid,input.hwnd);
    const grantKey=`${input.pid}:${grant.window.hwnd??''}`;
    const request=JSON.stringify(input),prior=this.engine.db.prepare('SELECT * FROM desktop_operations WHERE task_id=? AND id=?').get(task,id) as {request:string,state:string,result:string}|undefined;
    if(prior){if(prior.request!==request)throw Error('Operation ID reused');return prior.state==='completed'?JSON.parse(prior.result):{state:'unknown',message:'Inspect before proceeding; do not replay input'};}
    const inputStamp=this.monitor?.stamp();
    if(!['inspect','observe','invoke','fill','check','screenshot','select','scroll','press','window','click','double_click','drag','hotkey','type_text','focus'].includes(input.action))throw Error('Unsupported desktop action');
    if(input.observe_after!==undefined&&typeof input.observe_after!=='boolean')throw Error('observe_after must be boolean');
    if(input.action==='type_text'&&(typeof input.text!=='string'||input.text.length<1||input.text.length>10000))throw Error('type_text requires 1..10000 UTF-16 units');
    const hotkey=input.action==='hotkey'?parseDesktopHotkey(input.chord):undefined;
    const pointer=['click','double_click','drag'].includes(input.action);
    const windowPointer=pointer&&input.coordinate_space==='window';
    if(input.coordinate_space!==undefined&&!windowPointer)throw Error('coordinate_space is only supported for window screenshot pointer input');
    if(input.input_mode!==undefined&&(!pointer||!['messages','physical'].includes(input.input_mode)))throw Error('input_mode requires a pointer action and messages or physical');
    if(windowPointer&&(input.input_mode!=='physical'||input.ref!==undefined))throw Error('Screenshot coordinates require input_mode physical and no UIA ref');
    if(pointer){
      const coords=[input.x,input.y,...(input.action==='drag'?[input.end_x,input.end_y]:[])];
      if(coords.some(v=>!Number.isInteger(v)||v!<0||v!>32767))throw Error('Pointer requires integer client coordinates within 0..32767');
      if(input.button!==undefined&&!['left','right'].includes(input.button))throw Error('Unsupported pointer button');
      if(input.action!=='drag'&&(input.end_x!==undefined||input.end_y!==undefined))throw Error('Only drag accepts end coordinates');
    }
    if(input.action==='press'&&!DESKTOP_KEYS.includes(input.key as typeof DESKTOP_KEYS[number]))throw Error('press requires a supported key');
    if(input.action==='window'){
      if(input.window_state!==undefined&&!['minimize','restore','maximize'].includes(input.window_state))throw Error('Unsupported window state');
      const bounds=[input.x,input.y,input.width,input.height];
      if(input.window_state?bounds.some(v=>v!==undefined):!(bounds.every(Number.isInteger)&&Math.abs(input.x!)<=32000&&Math.abs(input.y!)<=32000&&input.width!>=100&&input.width!<=8000&&input.height!>=100&&input.height!<=8000))throw Error('window requires window_state, or integer x/y (|v|<=32000) with width/height 100..8000');
    }
    if(input.action==='check'&&typeof input.checked!=='boolean')throw Error('Check requires an explicit boolean state');
    if(input.action==='scroll'){
      const axes=[input.horizontal_percent,input.vertical_percent];
      if(axes.every(v=>v===undefined)||axes.some(v=>v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100)))throw Error('Scroll requires at least one finite percent within 0..100');
    }
    this.engine.assertIdle(row,['inspect','screenshot','observe'].includes(input.action),[],true);
    if(this.busy)throw Error('Desktop input already in progress');
    if(input.action==='screenshot'||input.action==='observe'){
      // Read-only images never enter SQLite. A new capture invalidates older
      // element/image coordinates and returns a fresh revision for its pixels.
      this.busy=true;
      this.snapshots.delete(task);
      try{
        const result=await this.call({action:input.action,pid:input.pid,creation:grant.window.creation,hwnd:grant.window.hwnd});
        if(this.grants.get(grantKey)?.id!==grant.id||grant.expires<=Date.now())throw Error('Window capture grant revoked or expired');
        const data=typeof result?.image==='string'?Buffer.from(result.image,'base64'):Buffer.alloc(0);
        if(data.length<8||data.length>3*1024*1024||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid or oversized PNG from desktop capture');
        const capture=captureGeometry(result);
        const snapshot:Snapshot={pid:input.pid,grant_id:grant.id,key:randomUUID(),controls:input.action==='observe'&&Array.isArray(result.controls)?result.controls:[],capture,inputStamp};
        if(inputStamp){try{this.monitor!.check(inputStamp);}catch(error){return {...result,state:'captured',pid:input.pid,actionable:false,input_interruption:String(error)};}}
        this.snapshots.set(task,snapshot);
        this.engine.event(task,input.action==='observe'?'desktop_observed':'desktop_screenshot',{pid:input.pid});
        return {...result,state:'captured',pid:input.pid,revision:snapshot.key};
      }finally{this.busy=false;}
    }
    let element:Control|undefined;
    let capture:CaptureGeometry|undefined;
    if(input.action!=='inspect'&&input.action!=='window'&&input.action!=='focus'){
      const snapshot=this.snapshots.get(task);
      if(!snapshot||input.revision!==snapshotKey(snapshot)||snapshot.pid!==input.pid||snapshot.grant_id!==grant.id)throw Error('Stale desktop snapshot');
      if(this.monitor){if(!snapshot.inputStamp)throw Error('Observation has no input monitor stamp');this.monitor.check(snapshot.inputStamp);}
      if(windowPointer){
        capture=snapshot.capture;
        if(!capture)throw Error('Screenshot geometry unavailable; capture the authorized window again');
        if(snapshot.controls.some(c=>c.password))throw Error('Screenshot pointer is unavailable when password controls are present');
        if(input.x!>=capture.image_width||input.y!>=capture.image_height||(input.action==='drag'&&(input.end_x!>=capture.image_width||input.end_y!>=capture.image_height)))throw Error('Pointer coordinates outside captured screenshot');
      }else{
        element=snapshot.controls.find(c=>c.index===input.ref);if(!element||element.password)throw Error('Invalid or password control');
      }
      if(pointer&&!windowPointer){
        const b=element?.pointer_bounds;
        if(!b||b.length!==2||input.x!>=b[0]||input.y!>=b[1]||(input.action==='drag'&&(input.end_x!>=b[0]||input.end_y!>=b[1])))throw Error('Pointer coordinates outside captured control client bounds');
      }
      if(element?.enabled===false)throw Error('Control is disabled');
      if(input.action==='select'&&typeof element?.selected!=='boolean')throw Error('Control does not support selection');
      if(input.action==='scroll'&&((input.horizontal_percent!==undefined&&!element?.scroll?.horizontal_scrollable)||(input.vertical_percent!==undefined&&!element?.scroll?.vertical_scrollable)))throw Error('Requested axis is not scrollable');
      if(input.action==='check'&&element?.type!=='ControlType.CheckBox')throw Error('Check requires a checkbox');
      if(input.action==='check'&&element?.checked!==true&&element?.checked!==false)throw Error('Checkbox state unavailable or indeterminate');
      if(input.action==='invoke'&&element?.type!=='ControlType.Button')throw Error('Invoke requires a button');
      if(input.action==='fill'&&element?.type!=='ControlType.Edit')throw Error('Fill requires an editable text field');
    }
    this.busy=true;this.snapshots.delete(task);this.surfaces.delete(task);
    this.engine.interactionBusy.add(task);
    this.engine.db.prepare('INSERT INTO desktop_operations VALUES(?,?,?,?,NULL)').run(task,id,request,'unknown');
    this.engine.event(task,'desktop_started',{operation_id:id,pid:input.pid,action:input.action});
    try{
      const result=await this.call({action:input.action,pid:input.pid,creation:grant.window.creation,hwnd:grant.window.hwnd,element,capture,input_guard:inputStamp,coordinate_space:input.coordinate_space,keys:hotkey,input_mode:input.input_mode??'messages',button:input.button??'left',end_x:input.end_x,end_y:input.end_y,text:input.text,checked:input.checked,horizontal_percent:input.horizontal_percent,vertical_percent:input.vertical_percent,key:input.key,window_state:input.window_state,x:input.x,y:input.y,width:input.width,height:input.height});
      if(input.action!=='inspect'&&(this.grants.get(grantKey)?.id!==grant.id||grant.expires<=Date.now()))throw Error('Desktop grant revoked or expired while input was in flight');
      if(input.action==='inspect'){
        const snapshot={pid:input.pid,grant_id:grant.id,controls:result.controls,key:randomUUID(),inputStamp};
        try {if(inputStamp)this.monitor!.check(inputStamp);if(this.grants.get(grantKey)?.id!==grant.id||grant.expires<=Date.now())throw Error('Window grant changed during inspection');this.snapshots.set(task,snapshot);result.revision=snapshot.key;}
        catch(error){result.stale=true;result.actionable=false;result.input_interruption=String(error);}
      }
      let postImage:string|undefined;
      if(input.action!=='inspect'&&(windowPointer||input.observe_after===true)){
        try{
          if(this.grants.get(grantKey)?.id!==grant.id||grant.expires<=Date.now())throw Error('Window grant expired before post-observation');
          if(inputStamp)this.monitor!.check(inputStamp);
          const observed=await this.call({action:'observe',pid:input.pid,creation:grant.window.creation,hwnd:grant.window.hwnd});
          if(inputStamp)this.monitor!.check(inputStamp);
          if(this.grants.get(grantKey)?.id!==grant.id||grant.expires<=Date.now())throw Error('Window grant expired during post-observation');
          const png=typeof observed?.image==='string'?Buffer.from(observed.image,'base64'):Buffer.alloc(0);
          if(png.length<8||png.length>3*1024*1024||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid post-observation PNG');
          const newCapture=captureGeometry(observed);
          const next:Snapshot={pid:input.pid,grant_id:grant.id,key:randomUUID(),controls:Array.isArray(observed.controls)?observed.controls:[],capture:newCapture,inputStamp};
          this.snapshots.set(task,next);
          const {image,...metadata}=observed;
          result.post_observation={...metadata,revision:next.key};
          postImage=image;
          if(result.verification==='needs_observation')result.verification='post_state_observed';
        }catch(error){
          result.post_observation_error=String(error);
        }
      }
      this.engine.db.prepare('UPDATE desktop_operations SET state=?,result=? WHERE task_id=? AND id=?').run('completed',JSON.stringify(result),task,id);
      this.engine.event(task,'desktop_completed',{operation_id:id,pid:input.pid,action:input.action});
      return postImage?{...result,image:postImage}:result;
    }catch(e){
      if(input.action==='inspect'){
        // Failed read-only UIA must not manufacture an unknown input receipt.
        this.engine.db.prepare('DELETE FROM desktop_operations WHERE task_id=? AND id=?').run(task,id);
        this.engine.event(task,'desktop_inspection_failed',{operation_id:id,error:String(e)});
      }else this.engine.event(task,'desktop_unknown',{operation_id:id,error:String(e)});
      throw e;
    }finally{this.busy=false;this.engine.interactionBusy.delete(task);}
  }
}
function snapshotKey(s:object){return (s as {key:string}).key;}
function captureGeometry(result:any):CaptureGeometry|undefined {
  const fields=['window_x','window_y','width','height','image_width','image_height'] as const;
  if(fields.every(field=>result?.[field]===undefined))return undefined;
  if(!fields.every(field=>Number.isInteger(result?.[field])))throw Error('Invalid window screenshot geometry');
  const capture=Object.fromEntries(fields.map(field=>[field,result[field]])) as CaptureGeometry;
  if(![capture.width,capture.height,capture.image_width,capture.image_height].every(value=>value>0)||capture.width>4096||capture.height>2400||capture.image_width>capture.width||capture.image_height>capture.height)throw Error('Invalid window screenshot geometry');
  return capture;
}
export const DESKTOP_KEYS=['Tab','Enter','Escape','Space','PageUp','PageDown','End','Home','ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Backspace','Delete'] as const;
export function registerForgeDesktop(target:McpRegistrationTarget,desktop:ForgeDesktop){
  target.registerTool('desktop_surface',{description:'Observe the whole desktop and locate supported application windows, desktop and taskbar surfaces. Requires local 15-minute desktop-session consent, not screenshot-only permission. observe returns PNG, exact hwnd targets, physical bounds and a fresh revision. click uses image-relative x/y and source_hwnd. drag requires distinct supported source_hwnd/destination_hwnd and end_x/end_y; it moves the real cursor while holding the left button. Covered endpoints, changed identities/bounds, password windows and paths crossing unselected applications are refused. Physical human input/Escape stops input; button release is attempted on interruption. Input always attempts a fresh whole-desktop post-observation; observed state is not proof the app accepted the action. Stable operation IDs replay receipts only; unknown actions must not be retried blindly. Browser/terminal/security windows remain excluded. Do not target excluded applications through shell shortcuts. No automatic focus or rearrangement: make both endpoints visible, then observe again.',inputSchema:{task_id:z.string(),lease_token:z.string().uuid(),operation_id:z.string().min(1).max(160),action:z.enum(['observe','click','drag']),revision:z.string().optional(),source_hwnd:z.string().regex(/^\d+$/).optional(),destination_hwnd:z.string().regex(/^\d+$/).optional(),x:z.number().int().nonnegative().optional(),y:z.number().int().nonnegative().optional(),end_x:z.number().int().nonnegative().optional(),end_y:z.number().int().nonnegative().optional()},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},async i=>{try{const {task_id,lease_token,operation_id,...input}=i;const {image,...metadata}=await desktop.surface(task_id,operation_id,lease_token,input);return {content:[{type:'text' as const,text:JSON.stringify(metadata)},...(image?[{type:'image' as const,mimeType:'image/png',data:image}]:[])]};}catch(e){return {isError:true,content:[{type:'text' as const,text:String(e)}]};}});
  target.registerTool('desktop_screen',{description:'Capture all monitors only after separate 15-minute whole-desktop consent in the local manager. May include every visible app; window authorization alone is insufficient. Returns PNG and original virtual-desktop bounds plus scaled image dimensions. Includes eligible windows with exact pid/hwnd, bounds and foreground state for cross-app targeting. A screenshot-only grant does not authorize input. Images are not stored in task receipts. Repeated calls capture the current screen.',inputSchema:{task_id:z.string(),lease_token:z.string().uuid()},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}},async i=>{try{const {image,...metadata}=await desktop.screen(i.task_id,i.lease_token);return {content:[{type:'text' as const,text:JSON.stringify(metadata)},{type:'image' as const,mimeType:'image/png',data:image}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:String(e)}]};}});
  target.registerTool('desktop_action',{description:'Operate a Windows window under a 15-minute individual grant or cross-application desktop session from the local manager. Supply hwnd from desktop_screen when a process has multiple windows. focus restores a minimized target and verifies it became foreground; if Windows foreground locking blocks activation, it may move the real cursor and click only a verified native title bar of that authorized window; use observe_after=true for its fresh post-state. A desktop session covers eligible applications including newly opened windows, with the same excluded apps and password restrictions. inspect returns accessible controls and a revision; observe returns a fresh image and controls (or only image if UIA is unavailable); invoke clicks an accessible button; fill replaces an editable non-password field; check sets an accessible checkbox to a desired boolean state. select chooses a selectable list/tree/radio/tab item and verifies selection. scroll sets horizontal_percent and/or vertical_percent (0..100) on a captured scrollable container, returning its actual position; omitted axes stay unchanged. inspect reports selected and scroll capabilities. screenshot captures only the authorized window and returns a PNG image, dimensions and a fresh revision without saving pixels to SQLite; it does not require DOM refs or journal bytes. press sends one key from a fixed list to a captured control as window messages to the native window of that control (no global keystrokes, no focus stealing); verify the effect with inspect. window minimizes, maximizes or restores the authorized window and reports minimized/maximized state. Maximizing or restoring a maximized window can activate it. Moving/resizing (x,y,width,height) does not change z-order and requires a normal window. observe isolates UIA in a separate five-second worker and preserves the screenshot on accessibility timeout; accessibility_status reports available, unavailable or timeout. Physical user input in authorized windows invalidates old revisions. Physical Escape latches a stop until local window reauthorization; simulated Escape does not. If actionable=false, no input revision is issued: wait for the user and observe again. Input actions require fresh revision/ref and stable operation_id. Unknown input results must not be replayed. Browser, terminal and security windows remain excluded. click, double_click and drag send mouse messages to a captured native control using client-relative x/y and (for drag) end_x/end_y, within inspect pointer_bounds [width,height]; button is left or right. Default input_mode=messages does not move the global cursor or activate the window; applications requiring physical input may ignore messages, so verify the result. input_mode=physical instead moves the real cursor and activates the authorized window; it rejects held mouse buttons/modifiers and covered control paths before sending native input. Concurrent human input can still change the target, so verify afterward. Coordinates remain captured-control-relative. type_text(text) inserts Unicode text at the focused captured control caret, replacing any selection, using native keyboard input; it preserves surrounding text and does not use the clipboard. It shares hotkey foreground and held-modifier checks. hotkey(chord), e.g. Ctrl+Shift+S, activates the authorized window, focuses the captured non-password control and sends a real keyboard chord. It refuses held modifier keys and a mismatched foreground; verify the visible effect afterward. Supported modifiers are Ctrl/Alt/Shift/Win with a letter, digit, F1..F24 or navigation key. Screenshot-relative pointer coordinates require a fresh screenshot/observe revision, coordinate_space=window, input_mode=physical, and no UIA ref. They are validated against the authorized window and covered-window checks, then automatically return a fresh post-observation PNG and revision. Set observe_after=true on other input actions to capture a fresh post-state. No arbitrary desktop coordinates or credential fields. Obtain user authorization before consequential actions.',inputSchema:{task_id:z.string(),operation_id:z.string().min(1).max(160),lease_token:z.string().uuid(),pid:z.number().int().positive(),hwnd:z.string().regex(/^\d+$/).optional(),action:z.enum(['inspect','observe','invoke','fill','check','screenshot','select','scroll','press','window','click','double_click','drag','hotkey','type_text','focus']),input_mode:z.enum(['messages','physical']).optional(),coordinate_space:z.literal('window').optional(),observe_after:z.boolean().optional(),chord:z.string().min(1).max(80).optional(),button:z.enum(['left','right']).optional(),end_x:z.number().int().min(0).max(32767).optional(),end_y:z.number().int().min(0).max(32767).optional(),key:z.enum(DESKTOP_KEYS).optional(),window_state:z.enum(['minimize','restore','maximize']).optional(),x:z.number().int().optional(),y:z.number().int().optional(),width:z.number().int().optional(),height:z.number().int().optional(),revision:z.string().optional(),ref:z.number().int().min(0).optional(),text:z.string().max(10000).optional(),checked:z.boolean().optional(),horizontal_percent:z.number().min(0).max(100).optional(),vertical_percent:z.number().min(0).max(100).optional()},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true}},async i=>{try{const {task_id,operation_id,lease_token,...input}=i;const result=await desktop.run(task_id,operation_id,lease_token,input);if(result.image){const {image,...metadata}=result;return {content:[{type:'text' as const,text:JSON.stringify(metadata)},{type:'image' as const,mimeType:'image/png',data:image}]};}return {content:[{type:'text' as const,text:JSON.stringify(result)}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:String(e)}]};}});
}
