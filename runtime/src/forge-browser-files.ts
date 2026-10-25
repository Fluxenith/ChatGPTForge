import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {lstatSync,realpathSync,openSync,readSync,fstatSync,closeSync,mkdirSync,mkdtempSync,writeFileSync,rmSync,opendirSync,utimesSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {ElementHandle,FileChooser,Frame,Page} from 'playwright-core';
import type {DurableTasks} from './durable-tasks.js';

export const chooserNoticePrefix='_forge_chooser:';
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export function projectFilePath(root:string,path:string){
  if(!path||isAbsolute(path)||path.includes(':')||path.includes('\0')||path.split(/[\\/]/).some(p=>p==='..'||/^\.(git)$/i.test(p)||p.toLowerCase()==='node_modules'))throw Error('Use a task-relative path outside Git and dependency internals');
  const target=resolve(root,path),rel=relative(root,target);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw Error('File path is outside the current task');
  let parent=dirname(target);
  while(parent!==root){const info=lstatSync(parent);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Symbolic link or non-directory parent refused');parent=dirname(parent);}
  return target;
}
export function ownedDirectory(state:string,name:string){
  const path=join(state,name);
  try{const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Owned artifact directory was replaced');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;mkdirSync(path);}
  if(lstatSync(path).isSymbolicLink()||realpathSync.native(path)!==path)throw Error('Owned artifact directory was replaced');
  return path;
}
type UploadFile={path:string,name:string,bytes:Buffer,size:number,sha256:string,identity:string,mtimeMs:number};
const identity=(info:ReturnType<typeof fstatSync>)=>[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
function capture(root:string,path:string,name:string):UploadFile{
  const target=projectFilePath(root,path),before=lstatSync(target);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error('Upload requires an unlinked regular file');
  if(before.size>32*1024*1024)throw Error('Upload exceeds 32 MiB');
  const fd=openSync(target,'r');
  try{
    if(identity(fstatSync(fd))!==identity(before))throw Error('Upload file changed before capture');
    const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)throw Error('Upload file truncated');offset+=n;}
    const after=fstatSync(fd);
    if(identity(after)!==identity(before)||identity(lstatSync(target))!==identity(before)||bytes.length!==before.size)throw Error('Upload file changed during capture');
    return {path,name,bytes,size:bytes.length,sha256:hash(bytes),identity:identity(before),mtimeMs:before.mtimeMs};
  }finally{closeSync(fd);}
}
export class PreparedUpload {
  readonly files:UploadFile[]=[];
  readonly directory?:string;
  private sourcePaths:string[];
  private folderInput:boolean;
  constructor(private root:string,paths:string[],directory:boolean){
    this.sourcePaths=[...paths];this.folderInput=directory;
    if(paths.length>16)throw Error('Upload supports at most 16 file paths');
    if(directory&&paths.length){
      if(paths.length!==1)throw Error('Directory input requires one directory path');
      const target=projectFilePath(root,paths[0]),info=lstatSync(target);
      if(!info.isDirectory()||info.isSymbolicLink())throw Error('Directory input requires a regular directory');
      this.directory=basename(target);
      let visited=0;
      const walk=(path:string,name:string,depth:number)=>{
        if(depth>16)throw Error('Upload directory exceeds 16 levels');
        const handle=opendirSync(path);
        try{for(let child=handle.readSync();child;child=handle.readSync()){
          if(++visited>4096)throw Error('Upload directory exceeds 4096 entries');
          const absolute=join(path,child.name),rel=relative(root,absolute),entry=lstatSync(absolute);
          projectFilePath(root,rel);
          if(entry.isSymbolicLink())throw Error('Symbolic links in upload directory are refused');
          if(entry.isDirectory())walk(absolute,join(name,child.name),depth+1);
          else this.files.push(capture(root,rel,join(name,child.name)));
          this.limit();
        }}finally{handle.closeSync();}
      };walk(target,'',0);
      this.files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    }else for(const path of paths){this.files.push(capture(root,path,basename(path)));this.limit();}
  }
  private limit(){if(this.files.length>512||this.files.reduce((sum,f)=>sum+f.size,0)>32*1024*1024)throw Error('Upload exceeds 512 files or 32 MiB total');}
  get metadata(){return this.files.map(f=>({name:f.name.replaceAll('\\','/'),size:f.size,sha256:f.sha256}));}
  revalidate(){const current=new PreparedUpload(this.root,this.sourcePaths,this.folderInput);if(current.files.length!==this.files.length||current.files.some((f,i)=>f.name!==this.files[i].name||f.identity!==this.files[i].identity||f.sha256!==this.files[i].sha256))throw Error('Upload file or directory changed before dispatch');}
  stage(state:string){
    if(!this.files.length&&!this.directory)return {paths:[] as string[],close:()=>{}};
    const parent=ownedDirectory(state,'browser-uploads'),root=mkdtempSync(join(parent,'upload-'));
    const close=()=>{if(realpathSync.native(root)!==root||!root.startsWith(parent+sep))throw Error('Upload staging directory was replaced; refusing cleanup');rmSync(root,{recursive:true,force:true,maxRetries:10});};
    try{
      const paths=this.files.map((file,index)=>{
        const path=this.directory?join(root,this.directory,file.name):join(root,String(index),file.name);
        mkdirSync(dirname(path),{recursive:true});writeFileSync(path,file.bytes,{flag:'wx'});utimesSync(path,file.mtimeMs/1000,file.mtimeMs/1000);return path;
      });
      if(this.directory)mkdirSync(join(root,this.directory),{recursive:true});
      return {paths:this.directory?join(root,this.directory):paths,close};
    }catch(error){close();throw error;}
  }
}
type ChooserPin={id:string,notice:string,page:Page,chooser:FileChooser,node:ElementHandle<HTMLElement>,frame?:Frame,url?:string,version?:string,ready:Promise<void>};
export class BrowserFileChoosers {
  readonly pending=new Map<string,ChooserPin>();
  private stopping=false;
  constructor(private engine:DurableTasks,private task:string,private version:(frame:Frame)=>string|undefined,private allowed:(frame:Frame)=>boolean,private tab:(page:Page)=>string|undefined){}
  get notices(){return [...this.pending.values()].map(c=>c.notice);}
  attach(page:Page){
    page.on('filechooser',chooser=>{
      if(this.stopping)return;
      const id=randomUUID(),notice=chooserNoticePrefix+id,node=chooser.element() as ElementHandle<HTMLElement>;
      if(this.pending.size>=8){
        this.engine.db.prepare('INSERT OR IGNORE INTO browser_operations VALUES(?,?,?,?,?)').run(this.task,chooserNoticePrefix+'overflow',JSON.stringify({action:'file_chooser_overflow'}),'unknown',JSON.stringify({state:'unknown',message:'File chooser capacity exceeded; close the owned session and inspect receipts'}));
        void node.dispose().catch(()=>{});return;
      }
      const pin:ChooserPin={id,notice,page,chooser,node,ready:Promise.resolve()};this.pending.set(id,pin);
      this.engine.db.prepare('INSERT INTO browser_operations VALUES(?,?,?,?,?)').run(this.task,notice,JSON.stringify({action:'file_chooser',chooser_id:id}),'waiting_upload',JSON.stringify({state:'file_chooser_pending',chooser_id:id}));
      pin.ready=(async()=>{const frame=await node.ownerFrame();if(frame){pin.frame=frame;pin.url=frame.url();pin.version=this.version(frame);}})();void pin.ready.catch(()=>{});
    });
    page.on('close',()=>{for(const [id,pin] of this.pending)if(pin.page===page){this.unknown(pin);this.pending.delete(id);}});
  }
  private unknown(pin:ChooserPin){this.engine.db.prepare("UPDATE browser_operations SET state='unknown' WHERE task_id=? AND id=? AND state='waiting_upload'").run(this.task,pin.notice);}
  async ready(){await Promise.all([...this.pending.values()].map(c=>c.ready));}
  authorized(pin:ChooserPin){return !!pin.frame&&!pin.frame.isDetached()&&!pin.page.isClosed()&&pin.frame.url()===pin.url&&this.version(pin.frame)===pin.version&&this.allowed(pin.frame);}
  async get(id:string){const pin=this.pending.get(id);if(!pin)throw Error('Unknown or already handled file chooser');await pin.ready;if(!this.authorized(pin))throw Error('File chooser origin or document is not authorized');const valid=await pin.node.evaluate(e=>e.isConnected&&e.tagName==='INPUT'&&e.getAttribute('type')?.toLowerCase()==='file');if(!valid||!this.authorized(pin))throw Error('File chooser input or document changed');return pin;}
  view(){return [...this.pending.values()].map(c=>({chooser_id:c.id,tab_id:this.tab(c.page),multiple:c.chooser.isMultiple(),authorized:this.authorized(c),source_url:this.authorized(c)?(c.url!.startsWith('data:')?'[inline-frame]':c.url!.slice(0,1600)):'[unavailable-origin]'}));}
  complete(pin:ChooserPin,cancelled:boolean){this.pending.delete(pin.id);this.engine.db.prepare('UPDATE browser_operations SET state=?,result=? WHERE task_id=? AND id=?').run('completed',JSON.stringify({state:'file_chooser_handled',chooser_id:pin.id,cancelled}),this.task,pin.notice);}
  close(){this.stopping=true;for(const pin of this.pending.values())this.unknown(pin);this.pending.clear();}
}
