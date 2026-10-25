import {AsyncLocalStorage} from 'node:async_hooks';
import {realpath} from 'node:fs/promises';
import type {DurableTasks} from './durable-tasks.js';
import type {WorkspaceRegistry} from './workspaces.js';
import type {McpRegistrationTarget} from './mcp-modern-server.js';
import {projectDirectory} from './project-access.js';
import {AccessDeniedError,resolveCanonicalAllowedPath,isPathInsideRoot} from './roots.js';

type Connection={client_id:string,client_name:string,name:string|null,root:string|null,last_seen:number,updated:number};
export type ProjectBinding={name:string,root:string};
const projectPathTools=new Set(['open_workspace','task_create','code_navigate']);
const isProjectPathTool=(name:string)=>projectPathTools.has(name)||name.startsWith('serena_');
const failure=(error:unknown)=>({isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]});

// A display name is not an authenticated identity. Bind the verified OAuth
// client instead, so renames, token refreshes and concurrent plugins are safe.
export class ForgeProjectBindings {
  private clients=new AsyncLocalStorage<string>();
  constructor(private engine:DurableTasks,private allowedRoots:string[]) {
    engine.db.exec(`CREATE TABLE IF NOT EXISTS project_connections (
      client_id TEXT PRIMARY KEY,client_name TEXT NOT NULL,name TEXT,root TEXT,
      last_seen INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_binding_events (
      client_id TEXT NOT NULL,time INTEGER NOT NULL,previous TEXT NOT NULL,current TEXT NOT NULL);`);
  }
  seen(clientId:string,clientName:string) {
    const now=Date.now();
    this.engine.db.prepare(`INSERT INTO project_connections VALUES(?,?,NULL,NULL,?,?)
      ON CONFLICT(client_id) DO UPDATE SET client_name=excluded.client_name,last_seen=excluded.last_seen
      WHERE project_connections.last_seen < ? OR project_connections.client_name != excluded.client_name`)
      .run(clientId,clientName.slice(0,200),now,now,now-15000);
  }
  withClient<T>(clientId:string,run:()=>T):T {return this.clients.run(clientId,run);}
  list():Connection[] {return this.engine.db.prepare('SELECT * FROM project_connections ORDER BY last_seen DESC').all() as Connection[];}
  async set(clientId:unknown,name:unknown,path:unknown,approveProject?:(root:string)=>void):Promise<Connection> {
    if(typeof clientId!=='string')throw Error('請選擇已連線的外掛');
    const previous=this.connection(clientId);
    if(!previous)throw Error('連接尚未出現；請先在該外掛呼叫 project_context，再重新讀取');
    if(typeof name!=='string'||!name.trim()||name.trim().length>120)throw Error('請填寫外掛名稱（最多 120 字）');
    const directory=projectDirectory(path);
    const root=await realpath(directory);
    try{await resolveCanonicalAllowedPath(directory,directory,this.allowedRoots);}
    catch(error){
      if(!(error instanceof AccessDeniedError)||!approveProject)throw error;
      // Only the authenticated local manager supplies this callback after an
      // explicit project grant. The live allowed roots remain unchanged until restart.
      approveProject(root);
    }
    this.save(previous,name.trim(),root);
    return this.connection(clientId)!;
  }
  unbind(clientId:unknown):Connection {
    if(typeof clientId!=='string')throw Error('請選擇已連線的外掛');
    const previous=this.connection(clientId);if(!previous)throw Error('找不到此連接');
    this.save(previous,null,null);return this.connection(clientId)!;
  }
  private connection(id:string):Connection|undefined {return this.engine.db.prepare('SELECT * FROM project_connections WHERE client_id=?').get(id) as Connection|undefined;}
  private save(previous:Connection,name:string|null,root:string|null) {
    if(previous.name===name&&previous.root===root)return;
    this.engine.db.transaction(()=>{
      this.engine.db.prepare('UPDATE project_connections SET name=?,root=?,updated=? WHERE client_id=?').run(name,root,Date.now(),previous.client_id);
      this.engine.db.prepare('INSERT INTO project_binding_events VALUES(?,?,?,?)').run(previous.client_id,Date.now(),JSON.stringify({name:previous.name,root:previous.root}),JSON.stringify({name,root}));
    })();
  }
  async context() {
    const clientId=this.clients.getStore();
    if(!clientId)throw Error('Project context requires an authenticated OAuth connection');
    const connection=this.connection(clientId);if(!connection)throw Error('Unknown OAuth connection');
    if(!connection.root)return {bound:false as const,connection_name:connection.client_name,connection_code:clientId.slice(-8)};
    const canonical=await realpath(connection.root);
    if(!isPathInsideRoot(canonical,connection.root)||!isPathInsideRoot(connection.root,canonical))throw Error('Bound project location changed; review the binding in the local manager');
    await resolveCanonicalAllowedPath(connection.root,connection.root,this.allowedRoots);
    return {bound:true as const,connection_name:connection.name!,connection_code:clientId.slice(-8),project_path:connection.root,binding_mode:'default' as const,allows_other_projects:true};
  }
  // Compile once, but resolve binding on every call. Neither cached tool lists
  // nor model-provided names/metadata can override the verified connection.
  wrap(target:McpRegistrationTarget,_workspaces:WorkspaceRegistry):McpRegistrationTarget {
    return {
      registerResource:target.registerResource.bind(target),
      registerTool:((name:string,definition:Record<string,any>,handler:(...args:any[])=>any)=>{
        const schema=definition.inputSchema;
        // Multi-project Serena tools carry paths/queries, not one default path.
        const defaultsPath=isProjectPathTool(name)&&(!name.startsWith('serena_')||schema?.path!==undefined);
        const descriptor=defaultsPath&&schema?.path?{...definition,
          description:definition.description+' Omit path to use this connection’s default project. Explicit paths may select any other allowed directory; relative paths resolve from the default project. Connections without a default must supply path.',
          inputSchema:{...schema,path:schema.path.optional()}}:definition;
        return (target.registerTool as Function)(name,descriptor,async (raw:Record<string,unknown>,...extra:unknown[])=>{
          try {
            const input={...raw};
            if(defaultsPath){
              const clientId=this.clients.getStore();
              const connection=clientId?this.connection(clientId):undefined;
              if(input.path===undefined){
                if(!connection?.root)throw Error('No default project is configured. Set one in the local manager, or provide path.');
                const context=await this.context();
                input.path=context.project_path;
              }else if(typeof input.path==='string'&&connection?.root){
                // The default supplies a base for relative paths, never an
                // access boundary. Global roots and tool/task checks still apply.
                input.path=await resolveCanonicalAllowedPath(input.path,connection.root,this.allowedRoots);
              }
            }
            return await handler(input,...extra);
          }catch(error){return failure(error);}
        });
      }) as McpRegistrationTarget['registerTool'],
    };
  }
  register(target:McpRegistrationTarget) {
    target.registerTool('project_context',{
      description:'Identify this authenticated connection’s default project. Omit path from open_workspace, task_create, code_navigate and serena_* tools to use that default. Explicit paths can select other allowed directories. Existing workspace/task IDs retain their own project; task_list includes all allowed projects. The default is a convenience, not an access restriction. Configure it in the local manager; display names alone do not select a project.',
      inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    },async()=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await this.context())}]};}catch(error){return failure(error);}});
  }
}
