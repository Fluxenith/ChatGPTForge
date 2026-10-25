const t=forgeLanguage.t;
const el=id=>document.getElementById(id);
function showStatus(value){el('status').dataset.i18nMessage=value;el('status').textContent=t(value);}
async function render(){const s=await chrome.storage.local.get(['token','origin','enabled','lastStatus','lastCheck']);el('token').value=s.token??'';el('origin').value=s.origin??'http://127.0.0.1:8768';el('enabled').checked=Boolean(s.enabled);showStatus((t(s.lastStatus??'')||(s.token?t('已保存配對碼，尚未檢查連線'):t('尚未填入並保存配對碼')))+'\n'+(s.lastCheck??''));}
el('save').onclick=async()=>{
  try{const u=new URL(el('origin').value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error(t('請使用本機 http://127.0.0.1:連接埠'));
    await chrome.storage.local.set({origin:u.origin,token:el('token').value.trim(),enabled:el('enabled').checked,lastStatus:'設定已保存，尚未檢查連線',lastCheck:''});await chrome.alarms.create('forge',{periodInMinutes:0.5});showStatus(t('設定已保存，尚未檢查連線'));
  }catch(e){showStatus(String(e));}
};
el('run').onclick=async()=>{
  try{
    const s=await chrome.storage.local.get(['token','origin','enabled']);
    if(el('token').value.trim()!==(s.token??'')||el('origin').value!==(s.origin??'http://127.0.0.1:8768')||el('enabled').checked!==Boolean(s.enabled)){showStatus(t('設定尚未保存，請先按「保存設定」'));return;}
    if(!s.enabled){showStatus(t('自動接續未啟用；請勾選啟用並保存設定後再檢查'));return;}
    showStatus(t('正在檢查…'));
    const result=await chrome.runtime.sendMessage({type:'run'});if(result?.error)throw Error(result.error);await render();
  }catch(e){showStatus(t('檢查失敗：')+String(e));}
};render();

