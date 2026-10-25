// Standalone release bootstrap: only Node builtins before npm ci.
import {readFileSync,writeFileSync,existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import net from 'node:net';
const {values}=parseArgs({options:{help:{type:'boolean'},check:{type:'boolean'},apply:{type:'boolean'},workspace:{type:'string'},'config-dir':{type:'string'},'public-url':{type:'string'},port:{type:'string',default:'8767'},'manager-port':{type:'string',default:'8768'},'manifest-sha256':{type:'string'}}});
if(values.help){console.log('node setup.mjs [--check] [--apply --workspace EXISTING_PATH --config-dir NEW_PATH --public-url HTTPS_ORIGIN] [--port 8767 --manager-port 8768] [--manifest-sha256 EXPECTED_HASH]\nCheck is read-only. Apply runs npm ci from the included lock and creates fresh config; never starts a tunnel or optional component.');process.exit(0);}
const kit=dirname(fileURLToPath(import.meta.url)),runtime=join(kit,'runtime');
const hash=data=>createHash('sha256').update(data).digest('hex');
const manifestBytes=readFileSync(join(kit,'manifest.json'));
if(values['manifest-sha256']&&hash(manifestBytes)!==values['manifest-sha256'])throw Error('Release manifest hash mismatch');
const manifest=JSON.parse(manifestBytes);
if(manifest.version!==1||manifest.product!=='chatgptforge'||!Array.isArray(manifest.files))throw Error('Invalid release manifest');
const seen=new Set();
for(const f of manifest.files){
 if(typeof f.path!=='string'||f.path.includes('\\')||f.path.includes(':')||f.path.startsWith('/')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(f.path))throw Error('Invalid release path');
 seen.add(f.path);let current=kit;
 for(const part of f.path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Linked release files are not supported');}
 if(!lstatSync(current).isFile())throw Error('Release entry is not a file');
 const bytes=readFileSync(current);if(bytes.length!==f.bytes||hash(bytes)!==f.sha256)throw Error('Release integrity mismatch: '+f.path);
}
for(const name of ['runtime/package.json','runtime/package-lock.json','runtime/dist/forge-cli.js','runtime/bin/chatgptforge.js','setup.mjs'])if(!seen.has(name))throw Error('Missing release entry: '+name);
const [major,minor]=process.versions.node.split('.').map(Number);
if(process.platform!=='win32'||major<22||major>=27||(major===22&&minor<19))throw Error('This kit requires Windows and Node >=22.19 <27');
const candidates=[process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')];
try{for(const entry of execFileSync('where.exe',['npm'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/))candidates.push(join(dirname(entry),'node_modules/npm/bin/npm-cli.js'));}catch{}
const npm=candidates.find(p=>p&&existsSync(p));if(!npm)throw Error('npm CLI missing; install Node with npm first');
const ports=[Number(values.port),Number(values['manager-port'])];
if(ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||ports[0]===ports[1])throw Error('Use distinct MCP/Manager ports within 1024..65535');
const portFree=port=>new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});
const available=await Promise.all(ports.map(portFree));
const tools={};
for(const [name,command,args] of [['git','git',['--version']],['powershell','powershell.exe',['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()']]]){
 try{tools[name]={available:true,version:execFileSync(command,args,{encoding:'utf8',windowsHide:true,timeout:15000}).trim()};}catch{tools[name]={available:false};}
}
const preflight={ok:available.every(Boolean)&&Object.values(tools).every(t=>t.available),node:process.versions.node,npm:execFileSync(process.execPath,[npm,'--version'],{encoding:'utf8',windowsHide:true}).trim(),tools,integrity:'verified',manifest_sha256:hash(manifestBytes),ports:ports.map((port,i)=>({port,available:available[i]})),optional_components:'not installed or inferred',clean_os_verified:false};
console.log(JSON.stringify(preflight,null,2));
if(!preflight.ok){process.exitCode=1;}else if(values.apply){
 if(!values.workspace||!values['config-dir']||!values['public-url'])throw Error('Apply requires workspace, new config-dir and public-url');
 const workspace=realpathSync(values.workspace),config=resolve(values['config-dir']),url=new URL(values['public-url']);
 if(!lstatSync(workspace).isDirectory())throw Error('Workspace must be a directory');
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Use a credential-free HTTPS origin');
 const rel=relative(workspace,config);if(!rel||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)))throw Error('Config must be outside the workspace');
 if(existsSync(config)||existsSync(join(runtime,'node_modules')))throw Error('Use fresh configuration and installation directories; do not overwrite an installation');
 // Windows env keys are case insensitive, but Node spawn serializes only the
 // first spelling. Normalize PATH and give lifecycle scripts this exact Node.
 const inheritedPath=Object.entries(process.env).find(([key])=>key.toLowerCase()==='path')?.[1]??'';
 const pathEntries=[dirname(process.execPath),...inheritedPath.split(';').map(p=>p.trim().replace(/^"|"$/g,''))].filter(p=>p&&existsSync(p));
 const pathSeen=new Set();const installPath=pathEntries.filter(p=>{const key=p.toLowerCase();if(pathSeen.has(key))return false;pathSeen.add(key);return true;}).join(';');
 if(installPath.length>5000)throw Error('Existing PATH is too long for nested npm lifecycle commands; use a dedicated installation shell with a shorter PATH');
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path')),PATH:installPath,CHATGPTFORGE_CONFIG_DIR:config,CHATGPTFORGE_MANAGER_PORT:String(ports[1])};
 function run(args){const r=spawnSync(process.execPath,args,{cwd:runtime,env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw Error('Setup step failed; preserve directory and inspect its output before retrying');}
 run([npm,'ci','--omit=dev','--no-audit','--no-fund']);
 run(['dist/forge-cli.js','init','--workspace',workspace,'--public-url',url.origin,'--port',String(ports[0])]);
 const receipt={...preflight,workspace,config,public_origin:url.origin,installed_at:new Date().toISOString(),status:'installed_not_started',manager_port:ports[1]};
 writeFileSync(join(kit,'install-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 writeFileSync(join(kit,'start.mjs'),`import {spawn} from 'node:child_process';\nconst p=spawn(process.execPath,[${JSON.stringify(join(runtime,'dist/forge-cli.js'))},'serve'],{cwd:${JSON.stringify(runtime)},env:{...process.env,CHATGPTFORGE_CONFIG_DIR:${JSON.stringify(config)},CHATGPTFORGE_MANAGER_PORT:${JSON.stringify(String(ports[1]))}},stdio:'inherit',windowsHide:true});\np.on('exit',code=>{process.exitCode=code??1;});\n`);
 console.log('Installed. Run node start.mjs in this release directory. Configure your existing tunnel separately, then perform authenticated MCP/ChatGPT acceptance.');
}
