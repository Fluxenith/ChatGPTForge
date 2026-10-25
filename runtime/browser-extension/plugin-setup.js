// Prepare only a new, extension-owned ChatGPT tab. The user confirms creation.
export async function runPluginSetup(api){
 const job=await api('plugin-setup-take');if(!job)return false;
 try{
  const tab=await chrome.tabs.create({url:'https://chatgpt.com/plugins',active:true});
  let results;
  for(let attempt=0;attempt<3;attempt++){
   await waitForPluginPage(tab.id);
   try{results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:fillPluginForm,args:[job.name,job.tunnelId]});break;}
   catch(error){if(attempt===2||!/frame.*removed|frame.*not found|document.*unload|frame.*navigat/i.test(String(error)))throw error;}
  }
  if(!results[0]?.result?.ok)throw Error(results[0]?.result?.error||'表單未就緒');
  await api('plugin-setup-report',{id:job.id,state:'ready',note:'ChatGPT 表單已填好。請在新分頁確認建立，再按 Connect。'});
 }catch(e){await api('plugin-setup-report',{id:job.id,state:'blocked',note:'無法自動填表：'+String(e)+'。未自動建立或重送外掛。'});}
 return true;
}
export async function waitForPluginPage(tabId){
 let stable=0,previous='';
 for(let i=0;i<90;i++){
  const state=await chrome.tabs.get(tabId);
  const url=new URL(state.url||'about:blank');
  if(url.origin==='https://chatgpt.com'&&url.pathname==='/plugins'&&state.status==='complete'){
   stable=state.url===previous?stable+1:1;if(stable>=4)return;
  }else stable=0;
  previous=state.url;await new Promise(r=>setTimeout(r,500));
 }
 throw Error('ChatGPT plugin page did not finish loading');
}
export async function fillPluginForm(name,tunnelId){
 try{
  if(location.origin!=='https://chatgpt.com'||location.pathname!=='/plugins')throw Error('Unexpected page');
  const visible=e=>e.getClientRects().length>0;
  let step='新增選單';
  const find=async(fn)=>{for(let i=0;i<100;i++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,300));}throw Error('等待「'+step+'」逾時');};
  const button=label=>[...document.querySelectorAll('button,[role="menuitem"],[role="tab"]')].find(e=>visible(e)&&(e.getAttribute('aria-label')||e.textContent).trim()===label);
  if(!document.querySelector('[role="dialog"]')){
  const add=await find(()=>button('Add'));
  // Radix dropdown triggers open on pointerdown, not HTMLElement.click().
  add.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,pointerType:'mouse',isPrimary:true}));
  add.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerType:'mouse',isPrimary:true}));
  step='Add custom MCP server';
  (await find(()=>button('Add custom MCP server'))).click();
  }
  const input=label=>{const dialog=document.querySelector('[role="dialog"]');if(!dialog)return null;const aria=[...dialog.querySelectorAll('input')].find(e=>visible(e)&&e.getAttribute('aria-label')===label);if(aria)return aria;const l=[...dialog.querySelectorAll('label')].find(e=>visible(e)&&e.textContent.trim()===label);return l&&(l.control||document.getElementById(l.htmlFor)||l.querySelector('input'));};
  const fill=(e,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
  step='Name';fill(await find(()=>input('Name')),name);
  step='Tunnel';
  if(!input('Tunnel ID'))(await find(()=>button('Tunnel'))).click();
  step='Tunnel ID';fill(await find(()=>input('Tunnel ID')),tunnelId);
  return {ok:true};
 }catch(e){return {ok:false,error:String(e)};}
}
