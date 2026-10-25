import {realpathSync,statSync} from 'node:fs';
import {parse,resolve} from 'node:path';
import {homedir} from 'node:os';

export function projectDirectory(input:unknown):string {
  if(typeof input!=='string'||!input.trim())throw Error('請輸入專案資料夾完整路徑');
  const path=realpathSync(resolve(input));
  if(!statSync(path).isDirectory())throw Error('請選擇資料夾');
  const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(same(path,parse(path).root)||same(path,homedir()))throw Error('請選擇單一專案，不能開放磁碟根目錄或整個使用者目錄');
  return path;
}
