// Local maintenance entry point, opened explicitly when updating the extension.
if(new URL(location.href).searchParams.get('showDemo')==='1'){
  void (async()=>{
    const own=await chrome.tabs.getCurrent();
    const tabs=await chrome.tabs.query({url:'https://chatgpt.com/plugins'});
    for(const tab of tabs){
      const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>[...document.querySelectorAll('[role="dialog"] input')].some(input=>input.value==='ChatGPTForge_示範_20261023')}).catch(()=>[]);
      if(!result[0]?.result)continue;
      await chrome.tabs.update(tab.id,{active:true});
      await chrome.windows.update(tab.windowId,{focused:true});
      await chrome.storage.local.set({forgeDemoVisible:true});
      if(own?.id)await chrome.tabs.remove(own.id);
      return;
    }
    document.querySelector('p').textContent='The prepared demo tab was not found.';
  })();
}else chrome.runtime.reload();
