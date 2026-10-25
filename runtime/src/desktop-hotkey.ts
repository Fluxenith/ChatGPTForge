const modifiers:Record<string,number>={ctrl:0x11,alt:0x12,shift:0x10,win:0x5b};
const named:Record<string,number>={enter:13,tab:9,escape:27,space:32,backspace:8,delete:46,insert:45,home:36,end:35,pageup:33,pagedown:34,arrowleft:37,arrowup:38,arrowright:39,arrowdown:40};

export function parseDesktopHotkey(chord:string|undefined):number[]{
  if(typeof chord!=='string'||chord.length>80)throw Error('hotkey requires a chord such as Ctrl+Shift+S');
  const parts=chord.toLowerCase().split('+').map(p=>p.trim());
  if(parts.length>5||parts.some(p=>!p))throw Error('Invalid hotkey chord');
  const main=parts.pop()!;
  if(parts.some(p=>!Object.hasOwn(modifiers,p))||new Set(parts).size!==parts.length)throw Error('Use each Ctrl, Alt, Shift or Win modifier at most once');
  let key=Object.hasOwn(named,main)?named[main]:undefined;
  if(/^[a-z0-9]$/.test(main))key=main.toUpperCase().charCodeAt(0);
  if(/^f([1-9]|1[0-9]|2[0-4])$/.test(main))key=0x6f+Number(main.slice(1));
  if(key===undefined)throw Error('Unsupported hotkey key');
  return [...parts.map(p=>modifiers[p]!),key];
}
