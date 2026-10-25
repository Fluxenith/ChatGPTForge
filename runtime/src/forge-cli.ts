import { existsSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import {randomUUID} from 'node:crypto';
import { homedir } from "node:os";
import {fileURLToPath} from 'node:url';
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import type { startForgeListeners } from "./forge-listeners.js";
import { generateOwnerToken, loadDevspaceFiles, writeDevspaceAuth, writeDevspaceConfig,setDevspaceConfigValue } from "./user-config.js";
import { requireChatGPTOnly } from "./forge-policy.js";
import { diagnoseConnection } from "./forge-doctor.js";

// Never inherit another product's configuration or owner token.
process.env.DEVSPACE_CONFIG_DIR = resolve(process.env.CHATGPTFORGE_CONFIG_DIR ?? join(homedir(), ".chatgptforge"));
delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string" },
    goal: {type:'string'},kind:{type:'string'},'max-results':{type:'string'},
    endpoint: { type: "string" },
    "bearer-env": { type: "string" },
    "oauth-port": { type: "string" },
    "oauth-origins": { type: "string" },
    "public-url": { type: "string" },
    port: { type: "string", default: "8767" },
    from: { type: "string" },
    tool:{type:'string'},'probe-file':{type:'string'},manifest:{type:'string'},'ttl-seconds':{type:'string'},'allow-build':{type:'boolean'},online:{type:'boolean'},
    file: {type:"string"},
    line:{type:"string"},column:{type:"string"},"new-name":{type:"string"},
    "auto-repair": { type: "boolean" },
    "allow-upgrade": { type: "boolean" },
    version: { type: "string" },
    read: { type: "string" },
    "tunnel-id": { type: "string" },
    set: { type: "string" },
    "api-key-ref": { type: "string" },
    write: { type: "string" },
    apply: {type:'boolean'},
  },
});
const action = positionals[0];
if (positionals.length > (action === "components" || action === "gateway" ? 3 : (action === "signed-in-browser" || action === "rescue" || action === 'deployment') ? 2 : 1)) throw new Error("Unexpected arguments");

if (action === "init") {
  if (!values.workspace || !values["public-url"]) throw new Error("Usage: chatgptforge init --workspace PATH --public-url https://HOST:8443");
  const root = realpathSync(values.workspace);
  const url = new URL(values["public-url"]);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("public-url must be a credential-free HTTPS origin");
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("port must be 1024..65535");
  const files = loadDevspaceFiles();
  if (files.configExists) throw new Error("Configuration already exists; inspect and edit it explicitly instead of overwriting it");
  mkdirSync(files.dir, { recursive: true });
  if (!files.auth.ownerToken) writeDevspaceAuth({ ownerToken: generateOwnerToken() });
  writeDevspaceConfig({
    configVersion: 1,
    server: { host: "127.0.0.1", port, publicBaseUrl: url.origin },
    workspaces: { allowedRoots: [root], worktreeRoot: join(files.dir, "worktrees") },
    storage: { stateDir: join(files.dir, "state") },
    skills: { enabled: false, paths: [], agentDir: join(files.dir, "skills") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
    oauth: { scopes: ["chatgptforge"] },
  });
  console.log(`ChatGPTForge configured. MCP: ${url.origin}/mcp`);
  console.log(`Owner password is stored locally in ${files.authPath}; enter it only on the OAuth approval page.`);
  console.log("No tunnel settings were changed. Run chatgptforge serve next.");
} else if(action==='deployment'){
  const {exportDeployment,deploymentPlan,deploymentInventory,exportOperationGuide}=await import('./forge-deployment.js');
  const sub=positionals[1]??'inventory';
  if(sub==='export'&&values.file)console.log(JSON.stringify(exportDeployment(values.file),null,2));
  else if(sub==='guide'&&values.file)console.log(JSON.stringify(exportOperationGuide(values.file),null,2));
  else if(sub==='plan'&&values.manifest)console.log(JSON.stringify(deploymentPlan(JSON.parse(readFileSync(values.manifest,'utf8'))),null,2));
  else if(sub==='inventory')console.log(JSON.stringify(deploymentInventory(),null,2));
  else if(['check','repair','apply'].includes(sub)&&values.manifest){
    const {deploymentCheck,deploymentRun}=await import('./deployment-runner.js');
    const input=JSON.parse(readFileSync(values.manifest,'utf8'));
    const report=sub==='check'?await deploymentCheck(input):await deploymentRun(input,sub as 'repair'|'apply',{apply:values.apply,online:values.online,from:values.from,probes:values['probe-file']?JSON.parse(readFileSync(values['probe-file'],'utf8')):undefined});
    console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
  }
  else throw Error('Usage: deployment export --file NEW_DIRECTORY | guide --file NEW_DIRECTORY | plan|check --manifest PROFILE.json | repair|apply --manifest PROFILE.json [--apply] [--online] [--from ABSOLUTE_UV_EXE] [--probe-file PROBES.json] | inventory');
} else if (action === "serve") {
  const config = loadConfig();
  requireChatGPTOnly(config);
  const managerPort=Number(process.env.CHATGPTFORGE_MANAGER_PORT??8768);
  if(!Number.isInteger(managerPort) || managerPort<1024 || managerPort>65535 || managerPort===config.port) throw new Error('Invalid manager port');
  // The server modules are loaded only for serve, so other commands start fast.
  const [{ createServer }, { createForgeManager }, { startForgeListeners }] = await Promise.all([import("./server.js"), import("./forge-manager.js"), import("./forge-listeners.js")]);
  const server = createServer(config);
  let listeners: Awaited<ReturnType<typeof startForgeListeners>> | undefined;
  try {
    const browserTokenPath=join(process.env.DEVSPACE_CONFIG_DIR!,'browser-bridge-token');
    if(!existsSync(browserTokenPath))writeFileSync(browserTokenPath,randomUUID(),{flag:'wx',mode:0o600});
    const manager=createForgeManager(server.durableTasks,config.allowedRoots,readFileSync(browserTokenPath,'utf8').trim(),{gateway:server.mcpGateway,browser:server.forgeBrowser,desktop:server.forgeDesktop,skillsManager:server.skillsManager,projectBindings:server.projectBindings,pluginSetup:server.pluginSetup,saveRoots:roots=>setDevspaceConfigValue(['workspaces','allowedRoots'],roots)});
    listeners = await startForgeListeners(server.app, manager.app, config.port, managerPort);
    writeFileSync(join(process.env.DEVSPACE_CONFIG_DIR!,'manager.json'),JSON.stringify({url:`http://127.0.0.1:${managerPort}/#${manager.token}`,pid:process.pid}),{mode:0o600});
    console.log(`Local manager ready on port ${managerPort}. Open with scripts/Open-ForgeManager.ps1.`);
    console.log(`ChatGPTForge: http://${config.host}:${config.port}/mcp (OAuth required)`);
    console.log("Reasoning: ChatGPT only; model providers disabled. Shell: PowerShell on Windows.");
    const ownedListeners = listeners;
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await Promise.all([ownedListeners.close(), server.close()]);
    };
    const failed = (error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
      void stop().catch(error => console.error(error));
    };
    listeners.manager.on('error', failed);
    listeners.mcp.on('error', failed);
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    console.error('Forge startup failed: ' + (error instanceof Error ? error.message : String(error)));
    await Promise.all([listeners?.close(), server.close()]);
    throw error;
  }
} else if (action === "doctor") {
  const config = loadConfig();
  requireChatGPTOnly(config);
  console.log(JSON.stringify({
    product: "ChatGPTForge", phase: "connection", modelProviders: "disabled",
    rootsExist: config.allowedRoots.every(root => existsSync(root)),
    localEndpoint: `http://${config.host}:${config.port}/mcp`, publicEndpoint: `${config.publicBaseUrl}/mcp`,
  }, null, 2));
  const report = await diagnoseConnection(`http://${config.host}:${config.port}`, config.publicBaseUrl);
  console.log(JSON.stringify(report, null, 2));
  console.log("These checks do not prove ChatGPT can invoke tools; actual host acceptance is separate.");
  if (!report.ok) process.exitCode = 1;
} else if (action === "components") {
  const { verifyComponents, installComponent } = await import("./forge-components.js");
  const sub = positionals[1] ?? "verify";
  if(sub.startsWith('external-')){
    const managed=await import('./managed-components.js');
    const {readManagedState}=await import('./managed-component-state.js');
    const id=positionals[2];let result:unknown;
    if(sub==='external-list')result=await managed.verifyManaged();
    else if(sub==='external-check-updates')result=await managed.managedUpdates();
    else if(sub==='external-bind'){
      if(!id)throw Error('Component ID required');result=managed.bindManaged(id);
    }
    else if(sub==='external-install'){
      if(!id||!values.version)throw Error('Usage: components external-install ID --version VERSION');
      result=await managed.installManaged(id,values.version);
    }else if(sub==='external-repair'){
      const entry=id?readManagedState().active[id]:undefined;if(!entry)throw Error('Component is not managed');
      result=await managed.installManaged(id!,entry.version,true);
    }else if(sub==='external-rollback'){
      if(!id)throw Error('Component ID required');result=await managed.rollbackManaged(id);
    }else throw Error('Unknown external component command');
    console.log(JSON.stringify(result,null,2));process.exit(0);
  }
  if(sub==='language-cache'){
    const {cacheLanguageTrees}=await import('./language-tree-cache.js');
    const {productionUpgradeHooks}=await import('./forge-upgrades.js');
    const {serenaLanguagesHome}=await import('./serena-workspace-edit.js');
    console.log(JSON.stringify(await cacheLanguageTrees({lockPath:fileURLToPath(new URL('../scripts/serena-analysis/languages-lock.json',import.meta.url)),home:serenaLanguagesHome(),cache:join(homedir(),'.chatgptforge','components','language-cache'),digest:productionUpgradeHooks().treeDigest,language:positionals[2]}),null,2));process.exit(0);
  }
  if(sub==='kotlin-build-import'){
    if(!values.from||!values.tool||!['gradle','maven'].includes(positionals[2]??'gradle'))throw Error('Usage: components kotlin-build-import [gradle|maven] --from PROJECT --tool BUILD_TOOL --allow-build [--online]');
    const {importDynamicGradle}=await import('./kotlin-dynamic-build.js');
    console.log(JSON.stringify(await importDynamicGradle(resolve(values.from),values.tool,!!values['allow-build'],!!values.online,(positionals[2]??'gradle') as 'gradle'|'maven'),null,2));process.exit(0);
  }
  if(sub==='language-list'){
    const {serenaLanguageCapabilities}=await import('./serena-workspace-edit.js');
    console.log(JSON.stringify({languages:serenaLanguageCapabilities(),note:'Registered capabilities; run components verify for installed tree integrity.'},null,2));process.exit(0);
  }
  if(sub==='language-verify-rename'){
    if(!positionals[2]||!values.from||!values.file||!values['new-name'])throw Error('Usage: components language-verify-rename LANGUAGE --from PROJECT --file SOURCE --line N --column N --new-name IDENTIFIER');
    const {registerProjectRename}=await import('./serena-language-install.js');
    console.log(JSON.stringify(await registerProjectRename({language:positionals[2],root:resolve(values.from),file:values.file,line:Number(values.line),column:Number(values.column),new_name:values['new-name']}),null,2));process.exit(0);
  }
  if(sub==='language-install'){
    if(!positionals[2]||!values.from||!values.file)throw Error('Usage: components language-install LANGUAGE --from PROJECT --file SOURCE');
    const {installProjectLanguage}=await import('./serena-language-install.js');
    console.log(JSON.stringify(await installProjectLanguage(positionals[2],resolve(values.from),values.file,values.version),null,2));process.exit(0);
  }
  if (!["verify", "install", "check-updates", "repair", "updates", "upgrade"].includes(sub)) throw new Error("Usage: components [verify | install ID --from LOCAL_SOURCE | check-updates | repair [ID] | updates on|off [--auto-repair]]");
  if (sub === "check-updates") {
    const { checkUpdates } = await import("./forge-updates.js");
    console.log(JSON.stringify(await checkUpdates(), null, 2));
    process.exit(0);
  }
  if (sub === "updates") {
    const { loadUpdateConfig, saveUpdateConfig } = await import("./forge-updates.js");
    const mode = positionals[2];
    if (mode !== "on" && mode !== "off") throw new Error("Usage: components updates on|off [--auto-repair]");
    saveUpdateConfig({ ...loadUpdateConfig(), enabled: mode === "on", autoRepair: mode === "on" && !!values["auto-repair"], allowUpgrade: mode === "on" && !!values["allow-upgrade"] });
    console.log(JSON.stringify(loadUpdateConfig(), null, 2));
    process.exit(0);
  }
  if (sub === "upgrade") {
    const id = positionals[2];
    if (!id || !values.version) throw new Error("Usage: components upgrade ID --version X");
    const { upgradeComponent } = await import("./forge-upgrades.js");
    try { console.log(JSON.stringify(await upgradeComponent(id, values.version), null, 2)); process.exit(0); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
  }
  if (sub === "repair") {
    const { loadUpdateConfig, repairComponents, productionRepairHooks } = await import("./forge-updates.js");
    console.log(JSON.stringify(await repairComponents(loadUpdateConfig(), productionRepairHooks(), undefined, positionals[2]), null, 2));
  }
  if (sub === "install") {
    const id = positionals[2];
    if (!id || !values.from) throw new Error("Usage: components install ID --from LOCAL_SOURCE");
    console.log(JSON.stringify(await installComponent(id, values.from), null, 2));
  }
  const report = await verifyComponents();
  console.log(JSON.stringify(report, null, 2));
  console.log(sub === "repair" ? "Repairs restore pinned versions from verified language caches or official package sources when updates are on; a repair counts only if verification passes." : "Verification reads pinned components only; nothing is downloaded. New releases need an approved lock change.");
  if (!report.ok) process.exitCode = 1;
} else if (action === "rescue") {
  const config = loadConfig();
  const stateDir = process.env.DEVSPACE_CONFIG_DIR!;
  const sub = positionals[1] ?? "status";
  if (sub === "run") {
    const { runRescue } = await import("./forge-rescue.js");
    await runRescue(stateDir, config.port, config.skillsManagerEndpoint ?? null);
  } else if (sub === "status") {
    try { console.log(JSON.stringify(await (await fetch("http://127.0.0.1:8770/status", { signal: AbortSignal.timeout(5000) })).json(), null, 2)); }
    catch { console.log(JSON.stringify({ running: false, note: "Rescue supervisor is not running; start it with: forge-cli rescue run" })); process.exitCode = 1; }
  } else if (sub === "remote-setup") {
    // Opt-in: writes the remote rescue config and an owner password. It does
    // not publish anything; the owner publishes the route and adds the connector.
    if (!values["public-url"]) throw new Error("Usage: rescue remote-setup --public-url https://HOST:10000");
    const { setupRemoteRescue } = await import("./forge-rescue-mcp.js");
    const result = setupRemoteRescue(stateDir, values["public-url"]);
    console.log(JSON.stringify({ ...result, next: ["Restart the rescue supervisor (scripts/Start-ForgeRescue.ps1) so it listens on 127.0.0.1:" + result.config.port, "Publish that port on the public rescue route", "Add a second ChatGPT connector with " + result.mcp_url + " and enter the owner password from the file when ChatGPT asks"] }, null, 2));
  } else if (sub === "tunnel-setup") {
    // Outbound-only rescue route through a second OpenAI tunnel owned by the owner.
    if (!values["tunnel-id"] || !values["api-key-ref"]) throw new Error("Usage: rescue tunnel-setup --tunnel-id tunnel_... --api-key-ref file:PATH");
    const { setupRescueTunnel } = await import("./forge-rescue-mcp.js");
    const result = setupRescueTunnel(stateDir, values["tunnel-id"], values["api-key-ref"]);
    console.log(JSON.stringify({ ...result, next: ["Restart the rescue supervisor (scripts/Start-ForgeRescue.ps1)", "In ChatGPT add a connector for this second tunnel and enter the owner password from the file when asked"] }, null, 2));
  } else throw new Error("Usage: rescue [run | status | remote-setup --public-url URL | tunnel-setup --tunnel-id ID --api-key-ref file:PATH]");
} else if (action === "gateway") {
  // Owner-managed MCP gateway servers in the Forge config. Nothing here
  // contacts or launches a server; ChatGPT can reach only approved servers,
  // and only their listed tools, after Forge restarts.
  const { readFileSync: read, writeFileSync: write, copyFileSync, lstatSync } = await import("node:fs");
  const { discoverConfiguredServers, gatewayServersSchema, gatewayProbesSchema, downloadsOnLaunch } = await import("./forge-mcp-gateway.js");
  const configPath = join(process.env.DEVSPACE_CONFIG_DIR!, "config.jsonc");
  const stored = JSON.parse(read(configPath, "utf8")) as Record<string, unknown> & { mcpGateway?: { servers?: unknown[] } };
  const servers = gatewayServersSchema.parse(stored.mcpGateway?.servers ?? []);
  const save = (next: unknown[]) => {
    copyFileSync(configPath, configPath + ".before-gateway-" + Date.now());
    write(configPath, JSON.stringify({ ...stored, mcpGateway: { ...(stored.mcpGateway ?? {}), servers: gatewayServersSchema.parse(next) } }, null, 2) + "\n");
  };
  const view = (list: import("./forge-mcp-gateway.js").GatewayServer[]) => list.map(x => ({ id: x.id, approved: x.approved, source: x.source ?? "forge", kind: x.endpoint ? "http" : "stdio", target: x.endpoint ?? [x.command, ...(x.args ?? [])].join(" "), env_keys: x.env_keys ?? [], downloads_on_launch: downloadsOnLaunch(x), read_tools: x.read_tools, write_tools: x.write_tools, write_gate:x.write_gate??'off',...(x.write_gate?{write_gate_max_age_seconds:x.write_gate_max_age_seconds??900}:{}) }));
  const sub = positionals[1] ?? "list";
  if (sub === "list") console.log(JSON.stringify(view(servers), null, 2));
  else if(sub==='onboard'){
    let probes:import('./forge-mcp-gateway.js').GatewayReadProbe[]=[];
    if(values['probe-file']){
      const file=values['probe-file'],stat=lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Probe manifest must be a regular JSON file of at most 64 KiB');
      probes=gatewayProbesSchema.parse(JSON.parse(read(file,'utf8')));
    }
    const {DurableTasks}=await import('./durable-tasks.js');const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const engine=new DurableTasks(loadConfig().stateDir),gateway=new ForgeMcpGateway(engine,servers);
    try{console.log(JSON.stringify(await gateway.onboard(positionals[2]??'',!!values.apply,probes),null,2));}finally{await gateway.close();engine.close();}
  }
  else if(sub==='manifest'){
    if(!values.manifest)throw Error('Usage: gateway manifest --manifest FILE [--probe-file FILE] [--apply]');
    const readRegularJson=(path:string)=>{
      const stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Gateway manifest/probe file must be a regular JSON file of at most 64 KiB');
      return JSON.parse(read(path,'utf8')) as unknown;
    };
    const {gatewayManifestCandidate,GatewayOnboarding}=await import('./forge-gateway-onboarding.js');
    const {manifest,server,needs_registration}=gatewayManifestCandidate(readRegularJson(values.manifest),servers);
    const probes=values['probe-file']?gatewayProbesSchema.parse(readRegularJson(values['probe-file'])):[];
    if(needs_registration&&probes.length)throw Error('New servers are unapproved; approve read tools before running probes');
    if(needs_registration&&values.apply)save([...servers,server]);
    const {DurableTasks}=await import('./durable-tasks.js');const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const engine=new DurableTasks(loadConfig().stateDir);
    const gateway=new ForgeMcpGateway(engine,needs_registration?[...servers,server]:servers);
    try{
      const service=new GatewayOnboarding(gateway,engine.stateDir);
      console.log(JSON.stringify({...await service.run(manifest,!!values.apply,probes),
        registration:needs_registration?(values.apply?'registered_unapproved':'planned_unapproved'):'already_registered',
        ...(needs_registration&&values.apply?{restart_required:true}:{})},null,2));
    }finally{await gateway.close();engine.close();}
  }
  else if(sub==='inventory'){
    const {DurableTasks}=await import('./durable-tasks.js');const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const {GatewayOnboarding}=await import('./forge-gateway-onboarding.js');
    const engine=new DurableTasks(loadConfig().stateDir),gateway=new ForgeMcpGateway(engine,servers);
    try{console.log(JSON.stringify(await new GatewayOnboarding(gateway,engine.stateDir).inventory(),null,2));}
    finally{await gateway.close();engine.close();}
  }
  else if(sub==='recommend'){
    if(!values.goal)throw Error('Usage: gateway recommend --goal "Find documents" [--kind read|write|any] [--max-results 5]');
    const {DurableTasks}=await import('./durable-tasks.js');const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const {GatewayOnboarding}=await import('./forge-gateway-onboarding.js');
    const engine=new DurableTasks(loadConfig().stateDir),gateway=new ForgeMcpGateway(engine,servers);
    try{
      console.log(JSON.stringify(await new GatewayOnboarding(gateway,engine.stateDir).recommend(
        values.goal,(values.kind??'read') as 'read'|'write'|'any',Number(values['max-results']??5)),null,2));
    }finally{await gateway.close();engine.close();}
  }
  else if(sub==='parallel-read'){
    if(!values.file)throw Error('Usage: gateway parallel-read --file approved-reads.json');
    const stat=lstatSync(values.file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Gateway parallel read file must be a regular JSON file of at most 64 KiB');
    const {DurableTasks}=await import('./durable-tasks.js');
    const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const engine=new DurableTasks(loadConfig().stateDir),gateway=new ForgeMcpGateway(engine,servers);
    try{console.log(JSON.stringify(await gateway.parallelRead(JSON.parse(read(values.file,'utf8'))),null,2));}
    finally{await gateway.close();engine.close();}
  }
  else if(sub==='compare-read'){
    if(!values.file)throw Error('Usage: gateway compare-read --file approved-comparison.json');
    const stat=lstatSync(values.file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Gateway comparison file must be a regular JSON file of at most 64 KiB');
    const {DurableTasks}=await import('./durable-tasks.js');
    const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const engine=new DurableTasks(loadConfig().stateDir),gateway=new ForgeMcpGateway(engine,servers);
    try{
      const comparison=await gateway.compareRead(JSON.parse(read(values.file,'utf8')));
      console.log(JSON.stringify(comparison,null,2));
      if(comparison.status!=='matched')process.exitCode=1;
    }finally{await gateway.close();engine.close();}
  }
  else if(sub==='doctor'){
    const {DurableTasks}=await import('./durable-tasks.js');const {ForgeMcpGateway}=await import('./forge-mcp-gateway.js');
    const engine=new DurableTasks(loadConfig().stateDir),gateway=new ForgeMcpGateway(engine,servers);
    try{console.log(JSON.stringify(await gateway.doctor(),null,2));}finally{await gateway.close();engine.close();}
  }
  else if(sub==='write-gate'){
    const id=positionals[2],target=servers.find(s=>s.id===id),mode=values.set;
    if(!target)throw Error('Unknown gateway server');
    if(mode!=='off'&&mode!=='verified')throw Error('Usage: gateway write-gate ID --set off|verified [--ttl-seconds 900]');
    const age=values['ttl-seconds']===undefined?undefined:Number(values['ttl-seconds']);
    if(mode==='verified'&&!target.read_tools.length)throw Error('Verified write gate requires at least one approved read tool');
    if(age!==undefined&&(mode!=='verified'||!Number.isInteger(age)||age<60||age>86400))throw Error('ttl-seconds must be 60..86400 and requires verified mode');
    const next={...target};delete next.write_gate;delete next.write_gate_max_age_seconds;
    if(mode==='verified'){next.write_gate='verified';if(age!==undefined)next.write_gate_max_age_seconds=age;}
    save(servers.map(s=>s.id===id?next:s));
    console.log(JSON.stringify({server:id,write_gate:mode,max_age_seconds:mode==='verified'?(age??900):null,
      next:mode==='verified'?'Restart Forge; run gateway onboard '+id+' --probe-file FILE --apply to establish fresh read-tool proof before writes.':'Restart Forge to apply the change.'}));
  }
  else if(sub==='capabilities'){
    const id=positionals[2],target=servers.find(s=>s.id===id);
    if(!target||target.source!=='forge-managed:playwright')throw Error('Capabilities require a Forge-managed Playwright entry');
    const caps=[...new Set((values.set??'').split(',').filter(Boolean))];if(caps.some(c=>!['vision','pdf','devtools'].includes(c)))throw Error('Supported capabilities: vision,pdf,devtools');
    const args=(target.args??[]).filter((v,i,all)=>v!=='--caps'&&all[i-1]!=='--caps');
    save(servers.map(s=>s.id===id?{...s,args:[...args,...(caps.length?['--caps',caps.join(',')]:[])]}:s));
    console.log(JSON.stringify({server:id,capabilities:caps,approval_changed:false,next:'Discover and explicitly classify required tools; restart Forge after configuration changes'}));
  }
  else if(sub==='oauth'){
    const id=positionals[2],server=servers.find(s=>s.id===id);if(!server)throw Error('Unknown gateway server');
    const oauth={port:Number(values['oauth-port']??8773),origins:(values['oauth-origins']??'').split(';').filter(Boolean)};
    save(servers.map(s=>s.id===id?{...s,bearer_env:undefined,oauth}:s));console.log(JSON.stringify({server:id,next:'Run gateway login '+id+' locally, then restart Forge.'}));
  }else if(sub==='login'){
    const server=servers.find(s=>s.id===positionals[2]);if(!server?.approved||!server.endpoint||!server.oauth)throw Error('Login needs an approved HTTPS server with OAuth configured');
    const {loginGateway}=await import('./gateway-oauth.js');
    console.log(JSON.stringify(await loginGateway(server.id,server.endpoint,server.oauth,url=>console.log('Open this authorization URL in your browser: '+url))));
  }else if (sub === "add-http") {
    const id=positionals[2];if(!id||!values.endpoint)throw Error('Usage: gateway add-http ID --endpoint HTTPS_URL [--bearer-env ENV_NAME]');
    if(servers.some(x=>x.id===id))throw Error('Gateway server already exists');
    const entry=gatewayServersSchema.parse([{id,endpoint:values.endpoint,allow_remote:true,...(values['bearer-env']?{bearer_env:values['bearer-env']}:{})}])[0]!;
    save([...servers,entry]);console.log(JSON.stringify({id,approved:false,next:'Approve tool names with gateway approve, then restart Forge.'}));
  } else if (sub === "import") {
    const { found, skipped } = discoverConfiguredServers();
    const added = found.filter(f => !servers.some(x => x.id === f.id));
    save([...servers, ...added]);
    console.log(JSON.stringify({ imported_unapproved: view(added), skipped, note: "Imported servers stay unapproved: they are listed but never launched. Approve one with: gateway approve ID --read a,b --write c,d" }, null, 2));
  } else if (sub === "approve") {
    const id = positionals[2]; const target = servers.find(x => x.id === id);
    if (!target) throw new Error("Unknown gateway server: " + id);
    const list = (v?: string) => (v ?? "").split(",").map(x => x.trim()).filter(Boolean);
    const read_tools = list(values.read), write_tools = list(values.write);
    if (!read_tools.length && !write_tools.length) throw new Error("Usage: gateway approve ID --read tool,tool --write tool,tool");
    save(servers.map(x => x.id === id ? { ...x, approved: true, read_tools, write_tools } : x));
    console.log(JSON.stringify({ approved: id, read_tools, write_tools, downloads_on_launch: downloadsOnLaunch(target), next: "Restart Forge so the gateway loads the change" }, null, 2));
  } else if (sub === "revoke") {
    const id = positionals[2]; if (!servers.some(x => x.id === id)) throw new Error("Unknown gateway server: " + id);
    save(servers.map(x => x.id === id ? { ...x, approved: false } : x));
    console.log(JSON.stringify({ revoked: id, next: "Restart Forge" }, null, 2));
  } else if (sub === "origins") {
    // Owner-chosen origins a server may be sent to (url arguments). For
    // Playwright, exact origins are also passed to its own --allowed-origins.
    const id = positionals[2]; const target = servers.find(x => x.id === id);
    if (!target) throw new Error("Unknown gateway server: " + id);
    const origins = (values.set ?? "").split(";").map(x => x.trim()).filter(Boolean);
    if (!origins.length) throw new Error("Usage: gateway origins ID --set \"http://127.0.0.1:*;https://example.com\"");
    const exact = origins.filter(o => o !== "http://127.0.0.1:*");
    const args = (target.args ?? []).filter((a, i, all) => a !== "--allowed-origins" && all[i - 1] !== "--allowed-origins");
    const next = { ...target, allowed_origins: origins, ...(["playwright","playwright-browser"].includes(id!) ? { args: exact.length ? [...args, "--allowed-origins", exact.join(";")] : args } : {}) };
    save(servers.map(x => x.id === id ? next : x));
    console.log(JSON.stringify({ server: id, allowed_origins: origins, next: "Restart Forge so the gateway loads the change" }, null, 2));
  } else if ((sub === "add-playwright" || sub === "add-playwright-browser")) {
    // Microsoft Playwright MCP from the copy already installed on this PC
    // (pinned to that version; no npx @latest download at launch).
    const { execFileSync } = await import("node:child_process");
    const root = execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
    const cli = join(root, "@playwright", "mcp", "cli.js");
    const version = (JSON.parse(read(join(root, "@playwright", "mcp", "package.json"), "utf8")) as { version: string }).version;
    const browserRelay=sub === "add-playwright-browser",id=browserRelay?"playwright-browser":"playwright";
    const entry = { id, command: process.execPath, args: browserRelay?[cli,"--extension"]:[cli, "--headless", "--isolated"], env_keys: [], source: "forge:@playwright/mcp@" + version, allowed_origins: ["http://127.0.0.1:*"], approved: false, read_tools: [], write_tools: [] };
    if (servers.some(x => x.id === id)) throw new Error("A gateway server named playwright already exists");
    save([...servers, entry]);
    console.log(JSON.stringify({ added: view([gatewayServersSchema.parse([entry])[0]!]), note: `Added unapproved; approve with gateway approve ${id} --read ... --write ...` }, null, 2));
  } else throw new Error("Usage: gateway [list | doctor | import | recommend --goal TEXT | parallel-read --file FILE | compare-read --file FILE | onboard ID [--apply] [--probe-file safe-reads.json] | manifest --manifest FILE [--probe-file FILE] [--apply] | inventory | write-gate ID --set off|verified [--ttl-seconds 900] | capabilities ID --set vision,pdf,devtools | approve ID --read a,b --write c,d | revoke ID | origins ID --set 'a;b' | add-playwright]");
} else if (action === "signed-in-browser") {
  // Opens ordinary Chrome (no automation) on the dedicated signed-in profile so
  // the owner can sign in by hand. Forge never types credentials.
  const config = loadConfig();
  const dir = config.signedInBrowser?.userDataDir;
  if (!dir) throw new Error("signedInBrowser is not configured");
  const { existsSync: exists } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean).map(base => join(base!, "Google", "Chrome", "Application", "chrome.exe"));
  const chrome = candidates.find(path => exists(path));
  if (!chrome) throw new Error("Google Chrome was not found");
  const child = spawn(chrome, [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", ...(positionals[1] ? [positionals[1]] : [])], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(JSON.stringify({ opened: true, user_data_dir: dir, enabled: config.signedInBrowser?.enabled ?? false, note: "Sign in by hand, then close this Chrome window before Forge uses the profile (one process can own a profile at a time)." }, null, 2));
} else {
  console.log("ChatGPTForge: init --workspace PATH --public-url HTTPS_ORIGIN | serve | doctor | components [verify | install ID --from PATH | check-updates | repair [ID] | updates on|off] | gateway [list | import | approve ID | revoke ID | add-playwright] | signed-in-browser [URL] | rescue [run | status | remote-setup --public-url URL]");
  if (action) throw new Error(`Unsupported command: ${action}. Model-agent commands are not provided.`);
}
