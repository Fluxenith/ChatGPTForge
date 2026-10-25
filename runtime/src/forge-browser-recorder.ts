import {randomUUID} from 'node:crypto';
import type {BrowserContext,Frame,Page} from 'playwright-core';

type RecordedKind='goto'|'click'|'fill'|'select'|'check';
interface RecordedStep {kind:RecordedKind;url?:string;selector?:string;frames?:string[];checked?:boolean}
interface BrowserRecording {
  id:string;page:Page;createdAt:number;expiresAt:number;active:boolean;
  steps:RecordedStep[];dropped:number;navigation:(frame:Frame)=>void;timer:ReturnType<typeof setTimeout>;
}
interface BindingRegistration {name:string;ready:true}

// This function is serialized into authorized Chrome contexts, including newly
// navigated documents. It does not read input values, cookies or page text.
function installEventRecorder({bindingName}:{bindingName:string}){
  const key='__forge_code_recorder_installed_v1';
  const global=window as unknown as Record<string,unknown>;
  if(global[key])return;
  global[key]=true;
  // Page-authored attributes can contain private values (for example an
  // email address in an id). Use only short structural identifiers, falling
  // back to positional selectors for everything else.
  const structural=(value:string|null):value is string=>!!value&&
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)&&
    !/(?:password|passwd|secret|token|bearer|credential|private|session|api[_-]?key|otp|ssn)/i.test(value);
  const selector=(element:Element):string=>{
    const e=element as HTMLElement;
    if(structural(e.id))return '#'+CSS.escape(e.id);
    for(const attr of ['data-testid','name']){
      const v=e.getAttribute(attr);
      if(structural(v))return e.tagName.toLowerCase()+'['+attr+'='+JSON.stringify(v)+']';
    }
    const segments:string[]=[];let current:Element|null=element;
    while(current&&current!==document.documentElement&&segments.length<9){
      const tag=current.tagName.toLowerCase();
      if(structural(current.id)){segments.unshift('#'+CSS.escape(current.id));break;}
      let index=1;for(let prev=current.previousElementSibling;prev;prev=prev.previousElementSibling)
        if(prev.tagName===current.tagName)index++;
      segments.unshift(tag+':nth-of-type('+index+')');
      current=current.parentElement;
    }
    return segments.join(' > ');
  };
  const send=(kind:'click'|'fill'|'select'|'check',target:Element,checked?:boolean)=>{
    const css=selector(target);
    if(!css||css.length>512)return;
    const binding=global[bindingName];
    if(typeof binding==='function'){
      try{void Promise.resolve((binding as (payload:unknown)=>Promise<unknown>)({kind,selector:css,...(checked===undefined?{}:{checked})})).catch(()=>{});}
      catch{/* Recording must never affect the page action. */}
    }
  };
  document.addEventListener('click',event=>{
    if(!event.isTrusted)return;
    const target=event.composedPath()[0];
    if(!(target instanceof Element)||target.closest('[type=password],[type=file]'))return;
    const control=target.closest('a,button,summary,[role=button],[role=link],input,select,textarea,[data-testid]');
    if(!control||['INPUT','SELECT','TEXTAREA'].includes(control.tagName))return;
    send('click',control);
  },true);
  document.addEventListener('change',event=>{
    if(!event.isTrusted)return;
    const target=event.target;
    if(!(target instanceof Element))return;
    if(target instanceof HTMLInputElement){
      if(['password','file','hidden'].includes(target.type))return;
      if(['checkbox','radio'].includes(target.type))send('check',target,target.checked);
      else send('fill',target);
    }else if(target instanceof HTMLTextAreaElement)send('fill',target);
    else if(target instanceof HTMLSelectElement)send('select',target);
  },true);
}

function safeUrl(value:string,allowed:(url:string)=>boolean):string|undefined{
  try{
    const url=new URL(value);
    if(!allowed(url.href)||!['https:','http:'].includes(url.protocol))return;
    url.username='';url.password='';url.search='';url.hash='';
    return url.href.slice(0,2000);
  }catch{return;}
}

export type CodeLanguage='typescript'|'python'|'java'|'csharp';
export function recordingLanguage(path:string):CodeLanguage{
  const extension=path.toLowerCase().split('.').at(-1);
  if(extension==='ts')return 'typescript';
  if(extension==='py')return 'python';
  if(extension==='java')return 'java';
  if(extension==='cs')return 'csharp';
  throw Error('Code recording filename must end in .ts, .py, .java or .cs');
}

function renderScript(steps:RecordedStep[],dropped:number,language:CodeLanguage){
  const q=(value:string|undefined)=>JSON.stringify(value??'');
  const lines:string[]=[];
  const suffix=language==='python'?'#':'//';
  lines.push(suffix+' Generated from authorized browser interactions by ChatGPTForge.',
    suffix+' Review selectors and supply FORGE_INPUT_* environment variables before running.',
    suffix+' Input values, passwords, URL query strings and fragments were never recorded.');
  const indent=language==='python'?'    ':language==='csharp'?'    ':language==='java'?'      ':'  ';
  if(language==='typescript')lines.push(
    "import { chromium } from 'playwright-core';",
    '',
    "function required(name: string): string {",
    "  const value = process.env[name];",
    "  if (value === undefined) throw new Error('Missing recorded input: ' + name);",
    "  return value;",
    "}",
    '',
    "const browser = await chromium.launch({ channel: 'chrome', headless: false });",
    'try {',
    '  const context = await browser.newContext();',
    '  const page = await context.newPage();');
  if(language==='python')lines.push(
    'import os','from playwright.sync_api import sync_playwright','',
    'def required(name: str) -> str:',
    '    if name not in os.environ: raise RuntimeError("Missing recorded input: " + name)',
    '    return os.environ[name]','',
    'with sync_playwright() as p:',
    '    browser = p.chromium.launch(channel="chrome", headless=False)',
    '    context = browser.new_context()',
    '    page = context.new_page()');
  if(language==='java')lines.push(
    'import com.microsoft.playwright.*;','',
    'class RecordedFlow {',
    '  private static String required(String name) {',
    '    String value = System.getenv(name);',
    '    if (value == null) throw new IllegalStateException("Missing recorded input: " + name);',
    '    return value;',
    '  }',
    '  public static void main(String[] args) {',
    '    try (Playwright playwright = Playwright.create()) {',
    '      Browser browser = playwright.chromium().launch(new BrowserType.LaunchOptions().setChannel("chrome").setHeadless(false));',
    '      BrowserContext context = browser.newContext();',
    '      Page page = context.newPage();');
  if(language==='csharp')lines.push(
    'using System;',
    'using System.Threading.Tasks;',
    'using Microsoft.Playwright;',
    '',
    'public class RecordedFlow {',
    '  private static string Required(string name) => Environment.GetEnvironmentVariable(name) ??',
    '      throw new InvalidOperationException("Missing recorded input: " + name);',
    '  public static async Task Main() {',
    '    using var playwright = await Playwright.CreateAsync();',
    '    await using var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions { Channel = "chrome", Headless = false });',
    '    var context = await browser.NewContextAsync();',
    '    var page = await context.NewPageAsync();');
  let inputIndex=0;
  for(const s of steps){
    if(s.kind==='goto'){
      const invocation=language==='java'?'page.navigate('+q(s.url)+');'
        :language==='csharp'?'await page.GotoAsync('+q(s.url)+');'
        :language==='python'?'page.goto('+q(s.url)+')'
        :'await page.goto('+q(s.url)+');';
      lines.push(indent+invocation);continue;
    }
    let locator='page';
    const frameFn=language==='csharp'?'FrameLocator':language==='python'?'frame_locator':'frameLocator';
    const locatorFn=language==='csharp'?'Locator':'locator';
    for(const frame of s.frames??[])locator+='.'+frameFn+'('+q(frame)+')';
    locator+='.'+locatorFn+'('+q(s.selector)+')';
    const arg=s.kind==='fill'||s.kind==='select'
      ?(language==='python'?'required':language==='csharp'?'Required':'required')+'('+q('FORGE_INPUT_'+ ++inputIndex)+')'
      :'';
    if(s.kind==='fill'||s.kind==='select'){
      if(language==='java')lines.push(indent+locator+'.'+(s.kind==='fill'?'fill':'selectOption')+'('+arg+');');
      else if(language==='python')lines.push(indent+locator+'.'+(s.kind==='fill'?'fill':'select_option')+'('+arg+')');
      else if(language==='csharp')lines.push(indent+'await '+locator+'.'+(s.kind==='fill'?'FillAsync':'SelectOptionAsync')+'('+arg+');');
      else lines.push(indent+'await '+locator+'.'+(s.kind==='fill'?'fill':'selectOption')+'('+arg+');');
    }else if(s.kind==='click'){
      lines.push(indent+(language==='csharp'?'await ':'')+locator+'.'+
        (language==='csharp'?'ClickAsync()':'click()')+(language==='python'?'':';'));
      if(language==='typescript')lines[lines.length-1]=indent+'await '+locator+'.click();';
    }else{
      const checked=language==='python'?(s.checked?'True':'False'):String(!!s.checked);
      const method=language==='python'?'set_checked':language==='csharp'?'SetCheckedAsync':'setChecked';
      lines.push(indent+(language==='typescript'||language==='csharp'?'await ':'')+locator+'.'+method+'('+checked+')'+(language==='python'?'':';'));
    }
  }
  if(dropped>0)lines.push(indent+suffix+' WARNING: '+dropped+' actions were omitted; recording is incomplete.');
  if(language==='typescript')lines.push('} finally {','  await browser.close();','}');
  if(language==='python')lines.push('    browser.close()');
  if(language==='java')lines.push('      browser.close();','    }','  }','}');
  if(language==='csharp')lines.push('    await browser.CloseAsync();','  }','}');
  lines.push('');
  return {code:lines.join('\n'),inputCount:inputIndex};
}

export class BrowserCodeRecorder {
  private active=new WeakMap<BrowserContext,BrowserRecording>();
  private bindings=new WeakMap<BrowserContext,BindingRegistration>();
  constructor(private permitted:(url:string)=>boolean,private frameAllowed:(frame:Frame)=>boolean){}

  status(context:BrowserContext,page:Page){
    const rec=this.active.get(context);
    return rec&&rec.page===page
      ?{state:'completed',recording:rec.active&&Date.now()<rec.expiresAt,record_id:rec.id,
          actions:rec.steps.length,dropped:rec.dropped,expires_at:new Date(rec.expiresAt).toISOString(),tab_locked:true}
      :{state:'completed',recording:false,actions:0,dropped:0};
  }
  recording(context:BrowserContext){return this.active.has(context);}
  recordedPage(context:BrowserContext){return this.active.get(context)?.page;}
  private push(rec:BrowserRecording,step:RecordedStep){
    if(!rec.active||Date.now()>rec.expiresAt)return;
    if(rec.steps.length>=256){rec.dropped++;return;}
    const last=rec.steps.at(-1);
    if(step.kind==='fill'||step.kind==='select'){
      if(last?.kind===step.kind&&last.selector===step.selector&&JSON.stringify(last.frames)===JSON.stringify(step.frames)){
        rec.steps[rec.steps.length-1]=step;return;
      }
    }
    if(step.kind==='goto'&&last?.kind==='goto'&&last.url===step.url)return;
    rec.steps.push(step);
  }
  private async frameSelectors(frame:Frame):Promise<string[]>{
    const chain:string[]=[];
    let current:Frame|null=frame;
    while(current?.parentFrame()){
      const element=await current.frameElement();
      try{
        const css=await element.evaluate((node:Element)=>{
          if(node.id&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(node.id)&&
            !/(?:password|passwd|secret|token|bearer|credential|private|session|api[_-]?key|otp|ssn)/i.test(node.id))
            return '#'+CSS.escape(node.id);
          const e=node as HTMLElement,testId=e.getAttribute('data-testid');
          if(testId&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(testId)&&
            !/(?:password|passwd|secret|token|bearer|credential|private|session|api[_-]?key|otp|ssn)/i.test(testId))
            return 'iframe[data-testid='+JSON.stringify(testId)+']';
          let nth=1;for(let sibling=node.previousElementSibling;sibling;sibling=sibling.previousElementSibling)
            if(sibling.tagName===node.tagName)nth++;
          return node.tagName.toLowerCase()+':nth-of-type('+nth+')';
        });
        if(!css||css.length>256)throw Error('Invalid frame selector');
        chain.unshift(css);
      }finally{await element.dispose();}
      current=current.parentFrame();
      if(chain.length>8)throw Error('Frame depth limit exceeded');
    }
    return chain;
  }
  async start(context:BrowserContext,page:Page){
    if(this.active.has(context))throw Error('Browser code recording is already active; stop it first');
    if(page.isClosed()||!this.permitted(page.url())||page.frames().some(frame=>!this.frameAllowed(frame)))
      throw Error('Recording requires an authorized current tab and authorized frames');
    let binding=this.bindings.get(context);
    if(!binding){
      const name='__forgeRecorder_'+randomUUID().replaceAll('-','');
      await context.exposeBinding(name,async(source,payload:unknown)=>{
        const rec=this.active.get(context);
        if(!rec?.active||rec.page!==source.page||source.page.isClosed()||
          !this.permitted(source.page.url())||!this.frameAllowed(source.frame))return;
        if(!payload||typeof payload!=='object'||Array.isArray(payload))return;
        const input=payload as {kind?:unknown;selector?:unknown;checked?:unknown};
        if(!['click','fill','select','check'].includes(String(input.kind))||typeof input.selector!=='string'
          ||input.selector.length>512||!input.selector.trim())return;
        if(input.kind==='check'&&typeof input.checked!=='boolean')return;
        try{
          const frames=await this.frameSelectors(source.frame);
          if(!rec.active||!this.frameAllowed(source.frame)||!this.permitted(source.page.url()))return;
          this.push(rec,{kind:input.kind as RecordedKind,selector:input.selector,frames,
            ...(input.kind==='check'?{checked:input.checked as boolean}:{})});
        }catch{rec.dropped++;}
      });
      // tsx/esbuild may serialize nested functions with the __name helper.
      // Inject an isolated shim with the function body for both new and
      // currently loaded documents; do not require page-owned globals.
      const script='(()=>{const __name=(value)=>value;('+installEventRecorder.toString()+')('+JSON.stringify({bindingName:name})+');})()';
      await context.addInitScript({content:script});
      binding={name,ready:true};this.bindings.set(context,binding);
    }
    // addInitScript handles future documents; install into existing frames now.
    for(const frame of page.frames()){
      if(!this.frameAllowed(frame))throw Error('Recording frame grant changed');
      const script='(()=>{const __name=(value)=>value;('+installEventRecorder.toString()+')('+JSON.stringify({bindingName:binding.name})+');})()';
      await frame.evaluate(script);
    }
    if(page.isClosed()||page.frames().some(frame=>!this.frameAllowed(frame)))
      throw Error('Recording page changed during listener installation');
    const createdAt=Date.now(),expiresAt=createdAt+15*60_000;
    const rec:BrowserRecording={id:randomUUID(),page,createdAt,expiresAt,active:true,
      steps:[],dropped:0,timer:undefined!,navigation:()=>{}};
    const url=safeUrl(page.url(),this.permitted);
    if(url)this.push(rec,{kind:'goto',url});
    rec.navigation=(frame:Frame)=>{
      if(frame!==page.mainFrame()||!this.permitted(frame.url())||!this.frameAllowed(frame))return;
      const safe=safeUrl(frame.url(),this.permitted);
      if(safe)this.push(rec,{kind:'goto',url:safe});
    };
    page.on('framenavigated',rec.navigation);
    rec.timer=setTimeout(()=>{rec.active=false;},15*60_000);
    rec.timer.unref?.();
    this.active.set(context,rec);
    return {state:'completed',recording:true,record_id:rec.id,
      expires_at:new Date(expiresAt).toISOString(),tab_locked:true,inputs_redacted:true};
  }
  export(context:BrowserContext,page:Page,language:CodeLanguage,save:(buffer:Buffer)=>{path:string|undefined,size:number,sha256:string},finish:boolean){
    const rec=this.active.get(context);
    if(!rec||rec.page!==page)throw Error('No code recording on the current tab');
    if(finish){rec.active=false;clearTimeout(rec.timer);page.off('framenavigated',rec.navigation);}
    const {code,inputCount}=renderScript(rec.steps,rec.dropped,language),data=Buffer.from(code,'utf8');
    // Keep bounded code available for a retry with a different operation ID
    // if the new-file write fails; never overwrite the user's destination.
    try{
      const script=save(data);
      if(finish)this.active.delete(context);
      return {state:'completed',recording:!finish&&rec.active,record_id:rec.id,actions:rec.steps.length,
        dropped:rec.dropped,inputs_required:inputCount,script,code_preview:code.slice(0,8000),
        preview_truncated:code.length>8000,code_language:language,input_values_recorded:false};
    }catch(error){throw error;}
  }
  discard(context:BrowserContext){
    const rec=this.active.get(context);
    if(rec){rec.active=false;clearTimeout(rec.timer);rec.page.off('framenavigated',rec.navigation);this.active.delete(context);}
  }
}
