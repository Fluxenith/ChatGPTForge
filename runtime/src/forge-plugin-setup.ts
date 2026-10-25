import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {realpath,stat} from 'node:fs/promises';
import type {DurableTasks} from './durable-tasks.js';
import type {ForgeProjectBindings} from './project-bindings.js';
import {resolveCanonicalAllowedPath} from './roots.js';

type Entry={id:string,name:string,root:string,client_id:string|null};
export class ForgePluginSetup {
 constructor(private engine:DurableTasks,private bindings:ForgeProjectBindings,private roots:string[],private tunnelId:string){
  engine.db.exec('CREATE TABLE IF NOT EXISTS plugin_setup_jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,note TEXT NOT NULL);');
  engine.db.exec('CREATE TABLE IF NOT EXISTS plugin_setups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,root TEXT NOT NULL,client_id TEXT UNIQUE)');
 }
 list():Entry[]{return this.engine.db.prepare('SELECT * FROM plugin_setups ORDER BY rowid DESC').all() as Entry[];}
 async prepare(name:unknown,path:unknown){
  if(typeof name!=='string'||!name.trim()||name.trim().length>80)throw Error('請填寫外掛名稱（最多 80 字）');
  if(typeof path!=='string'||!path.trim())throw Error('請填寫資料夾完整路徑');
  if(!/^tunnel_[a-z0-9]{32}$/.test(this.tunnelId))throw Error('找不到共用 Tunnel，請先啟動 Forge Tunnel');
  const root=await realpath(path.trim());if(!(await stat(root)).isDirectory())throw Error('請選擇資料夾');await resolveCanonicalAllowedPath(root,root,this.roots);
  name=name.trim();const old=this.list().find(r=>r.name===name);
  if(old){if(old.root!==root)throw Error('此外掛名稱已用於另一資料夾，請換個名稱');return old;}
  if(this.bindings.list().some(r=>(r.name||r.client_name)===name))throw Error('此外掛名稱已存在');
  const entry={id:randomUUID(),name:name as string,root,client_id:null};
  this.engine.db.prepare('INSERT INTO plugin_setups VALUES(?,?,?,NULL)').run(entry.id,entry.name,root);return entry;
 }
 pending(clientId:string){if(this.bindings.list().some(r=>r.client_id===clientId))return [];return this.list().filter(r=>!r.client_id);}
 async activate(clientId:string,id:string){
  const row=this.list().find(r=>r.id===id);if(!row)throw Error('找不到待連接的專案外掛');
  if(row.client_id===clientId)return;
  if(row.client_id||this.bindings.list().some(r=>r.client_id===clientId))throw Error('此連接已使用，請勿覆蓋既有外掛');
  await resolveCanonicalAllowedPath(row.root,row.root,this.roots);
  // Serialize after filesystem validation: only one OAuth client may claim a setup.
  const claim=this.engine.db.prepare('UPDATE plugin_setups SET client_id=? WHERE id=? AND client_id IS NULL').run(clientId,id);
  if(!claim.changes)throw Error('此外掛已完成連接');
  try{this.bindings.seen(clientId,row.name);await this.bindings.set(clientId,row.name,row.root);}
  catch(error){this.engine.db.prepare('UPDATE plugin_setups SET client_id=NULL WHERE id=? AND client_id=?').run(id,clientId);throw error;}
 }
 queue(id:string){const entry=this.list().find(r=>r.id===id);if(!entry||entry.client_id)throw Error('此外掛已連接或不存在');this.engine.db.prepare("INSERT INTO plugin_setup_jobs VALUES(?,'queued','等待 Chrome 填入表單') ON CONFLICT(id) DO UPDATE SET state='queued',note='等待 Chrome 填入表單' WHERE plugin_setup_jobs.state='blocked'").run(id);return this.status(id);}
 status(id:string){const entry=this.list().find(r=>r.id===id);if(!entry)throw Error('找不到外掛');return {...entry,...this.engine.db.prepare('SELECT state,note FROM plugin_setup_jobs WHERE id=?').get(id) as object,connected:!!entry.client_id};}
 take(){return this.engine.db.transaction(()=>{const job=this.engine.db.prepare("SELECT id FROM plugin_setup_jobs WHERE state='queued' ORDER BY rowid LIMIT 1").get() as {id:string}|undefined;if(!job)return null;this.engine.db.prepare("UPDATE plugin_setup_jobs SET state='opening',note='正在開啟 ChatGPT' WHERE id=?").run(job.id);return {...this.list().find(e=>e.id===job.id)!,tunnelId:this.tunnelId};}) ();}
 report(id:string,state:unknown,note:unknown){if(!['ready','blocked'].includes(String(state)))throw Error('Invalid setup state');const result=this.engine.db.prepare("UPDATE plugin_setup_jobs SET state=?,note=? WHERE id=? AND state='opening'").run(state,String(note).slice(0,500),id);if(!result.changes)throw Error('Setup already resolved');return this.status(id);}
 archive(id:string){
  const e=this.list().find(r=>r.id===id);if(!e)throw Error('找不到外掛包');const slug='forge-project-'+e.id;
  const manifest={$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:slug,version:'0.1.0',description:'Use the configured local Forge project.',author:{name:'Forge'},extensions:{'com.openai':{interface:{displayName:e.name,shortDescription:'本機專案工具',longDescription:'連接時請確認專案名稱：'+e.name+'。預設資料夾由本機 Forge 管理，仍可指定其他目錄。',developerName:'Forge',category:'Developer Tools',defaultPrompt:'查看目前專案，回報預設資料夾。'}}}};
  const mcp={$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{[slug]:{type:'streamable-http',extensions:{'com.openai':{tunnelId:this.tunnelId,auth:{type:'oauth',client:{mode:'dcr'}}}}}}};
  return {filename:slug+'.tar.gz',bytes:tarGz({[slug+'/plugin.json']:JSON.stringify(manifest,null,2),[slug+'/mcp.json']:JSON.stringify(mcp,null,2)})};
 }
}
function tarGz(files:Record<string,string>){const blocks:Buffer[]=[];for(const [name,text] of Object.entries(files)){const body=Buffer.from(text),h=Buffer.alloc(512);h.write(name,0,100);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(body.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);blocks.push(h,body,Buffer.alloc((512-body.length%512)%512));}return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));}
