import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { requireChatGPTOnly } from "./forge-policy.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { TaskFileBatches } from './task-file-batches.js';
import { digest } from './durable-tasks.js';

test("ChatGPTForge refuses all enabled providers and unsafe bind configurations", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-policy-"));
  try {
    const config = loadConfig(writeTestDevspaceConfig(root));
    assert.doesNotThrow(() => requireChatGPTOnly(config));
    assert.throws(() => requireChatGPTOnly({ ...config, subagents: { enabled: true, instructions: "on-demand", providers: [] } }), /does not support/);
    assert.throws(() => requireChatGPTOnly({ ...config, subagents: { enabled: false, instructions: "on-demand", providers: [{ id: "codex", enabled: true }] } }), /does not support/);
    assert.throws(() => requireChatGPTOnly({ ...config, host: "0.0.0.0" }), /127.0.0.1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated HTTP tools discover, edit, read and test a Chinese-path Windows workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forge-http-"));
  const project = join(root, "中文 專案");
  await mkdir(project);
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://forge.example.com" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, "worktrees") },
    ui: { enabled: false }, skills: { enabled: false }, logging: { level: "silent" },
  }));
  const token = randomBytes(32).toString("base64url");
  const store = new SqliteOAuthStore(config.stateDir);
  const registration = store.registerClient({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }, config.oauth.allowedRedirectHosts);
  store.saveAccessToken(createHash("sha256").update(token).digest("base64url"), {
    clientId: registration.client_id, scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) + 60, resource: "https://forge.example.com/mcp",
  });
  store.close();
  const runtime = createServer(config);
  const listener = runtime.app.listen(0, "127.0.0.1");
  const client = new Client({ name: "forge-acceptance", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await runtime.close();
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal((await fetch(endpoint)).status, 401);
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal(client.getServerVersion()?.name, "chatgptforge");
  const catalog = await client.listTools();
  assert.ok(catalog.tools.find(tool=>tool.name==='task_exec')?.inputSchema.properties?.desktop_app,'GUI lifetime is advertised on task_exec');
  assert.equal(catalog.tools.find(tool=>tool.name==='task_verify')?.inputSchema.properties?.desktop_app,undefined,'verification cannot be reclassified as a GUI session');
  const browserTool=catalog.tools.find(tool=>tool.name==='browser_action');
  assert.ok(browserTool?.inputSchema.properties?.hold_id,'held pointer IDs are advertised by MCP');
  const browserActions=browserTool?.inputSchema.properties?.action as {enum?:string[]}|undefined;
  assert.ok(browserActions?.enum?.includes('mouse_path'),'multi-call pointer paths are advertised by MCP');
  assert.ok(browserActions?.enum?.includes('accessibility_audit'),'automated browser accessibility diagnostics are advertised by MCP');
  assert.ok(browserTool?.inputSchema.properties?.max_issues,'accessibility finding bounds are exposed in the Host tool schema');
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), ["apply_patch", "browser_action", "browser_get_config", "code_navigate", "desktop_action", "desktop_screen", "exec_command", "handoff_claim", "handoff_context", "handoff_prepare", "handoff_submit", "handoff_withdraw", "open_workspace", "plan_closure", "plan_define", "plan_lesson", "plan_lessons", "plan_status", "plan_update", "project_context", "read", "serena_compare_diagnostics", "serena_compare_memories", "serena_compare_symbols", "serena_file_diagnostics", "serena_find_declaration", "serena_find_file", "serena_find_implementations", "serena_find_references", "serena_find_symbol", "serena_list_dir", "serena_list_memories", "serena_memory_graph", "serena_memory_link_preview", "serena_query_projects", "serena_read_memory", "serena_rename_preview", "serena_search_pattern", "serena_symbol_diagnostics", "serena_symbols_overview", "show_changes", "task_cancel", "task_changes", "task_checkpoint", "task_complete", "task_create", "task_diagnostics", "task_edit", "task_edit_recover", "task_exec", "task_input", "task_list", "task_memory_autolink", "task_memory_edit", "task_memory_rename", "task_memory_write", "task_operation", "task_rename", "task_resume", "task_rollback", "task_serena_edit", "task_serena_rename", "task_skill_read", "task_skills", "task_stage_complete", "task_status", "task_verify", "task_workflow", "task_workflow_define", "task_write", "view_image", "write_stdin"]);
  const open = await client.callTool({ name: "open_workspace", arguments: { path: project } });
  assert.ok(!open.isError, JSON.stringify(open));
  const workspaceId = (open.structuredContent as { workspace_id: string }).workspace_id;
  assert.ok(workspaceId);
  const patch = await client.callTool({ name: "apply_patch", arguments: {
    workspace_id: workspaceId,
    patch: "*** Begin Patch\n*** Add File: check.cjs\n+const assert = require('node:assert/strict');\n+assert.equal(2 + 3, 5);\n+console.log('verified');\n*** End Patch",
  } });
  assert.ok(!patch.isError, JSON.stringify(patch));
  const read = await client.callTool({ name: "read", arguments: { workspace_id: workspaceId, path: "check.cjs" } });
  assert.ok(!read.isError, JSON.stringify(read));
  const navigation = await client.callTool({ name: "code_navigate", arguments: {
    path: project, files: ["check.cjs"], file: "check.cjs", action: "outline",
  } });
  assert.ok(!navigation.isError, JSON.stringify(navigation));
  assert.match(JSON.stringify(navigation), /selected_files_only/);
  const projectSymbols = await client.callTool({ name: 'code_navigate', arguments: {
    path: project, action: 'symbols', query: 'assert',
  } });
  assert.ok(!projectSymbols.isError, JSON.stringify(projectSymbols));
  assert.match(JSON.stringify(projectSymbols), /project_files/);
  const projectDiagnostics = await client.callTool({ name: 'code_navigate', arguments: {
    path: project, action: 'diagnostics',
  } });
  assert.ok(!projectDiagnostics.isError, JSON.stringify(projectDiagnostics));
  const renamePreview = await client.callTool({ name: 'code_navigate', arguments: {
    path: project, file: 'check.cjs', action: 'rename_preview', line: 1, column: 8, new_name: 'verify',
  } });
  assert.ok(!renamePreview.isError, JSON.stringify(renamePreview));
  assert.match(JSON.stringify(renamePreview), /can_rename/);
  assert.match(await readFile(join(project, 'check.cjs'), 'utf8'), /const assert/);
  const deniedNavigation = await client.callTool({ name: 'code_navigate', arguments: {
    path: root, action: 'symbols', query: 'assert',
  } });
  assert.equal(deniedNavigation.isError, true);
  assert.match(await readFile(join(project, "check.cjs"), "utf8"), /assert.equal/);
  const command = process.platform === "win32" ? `& '${process.execPath.replaceAll("'", "''")}' check.cjs` : `'${process.execPath}' check.cjs`;
  let execution = await client.callTool({ name: "exec_command", arguments: { workspace_id: workspaceId, cmd: command, yield_time_ms: 1000 } });
  assert.ok(!execution.isError, JSON.stringify(execution));
  for (let i = 0; (execution.structuredContent as { running: boolean }).running && i < 20; i++) {
    execution = await client.callTool({ name: "write_stdin", arguments: {
      workspace_id: workspaceId, session_id: (execution.structuredContent as { session_id: number }).session_id, yield_time_ms: 1000,
    } });
  }
  assert.ok(!execution.isError, JSON.stringify(execution));
  assert.equal((execution.structuredContent as { exit_code: number }).exit_code, 0, JSON.stringify(execution));
  let failure = await client.callTool({ name: "exec_command", arguments: { workspace_id: workspaceId, cmd: "exit 7", yield_time_ms: 12000 } });
  assert.ok(!failure.isError, JSON.stringify(failure));
  const failureSession = (failure.structuredContent as {session_id?:number}).session_id;
  for(let i=0;(failure.structuredContent as {running:boolean}).running&&i<20;i++){
    assert.ok(Number.isInteger(failureSession),'A running command must supply its live session');
    failure=await client.callTool({name:'write_stdin',arguments:{workspace_id:workspaceId,session_id:failureSession,yield_time_ms:1000}});
    assert.ok(!failure.isError,JSON.stringify(failure));
  }
  assert.equal((failure.structuredContent as { exit_code: number }).exit_code, 7, JSON.stringify(failure));
  const invokeTask = async (name:string, args:Record<string,unknown>) => {
    const response = await client.callTool({name,arguments:args});
    assert.ok(!response.isError,JSON.stringify(response));
    const content = response.content as {type:string;text:string}[];
    return JSON.parse(content[0]!.text);
  };
  const task = await invokeTask("task_create",{path:project,idempotency_key:"http-test",goal:"verify persisted execution",acceptance_commands:[command]});
  const batchArgs={task_id:task.task_id,operation_id:'batch',expected_fingerprint:task.fingerprint,lease_token:task.lease_token,changes:[
    {path:'one.txt',content:'一',expected_hash:null},{path:'two.txt',content:'二',expected_hash:null},
  ]};
  const wrongLease=await client.callTool({name:'task_edit',arguments:{...batchArgs,lease_token:'00000000-0000-4000-8000-000000000000'}});
  assert.equal(wrongLease.isError,true);
  assert.equal((await invokeTask('task_edit',batchArgs)).batch.outcome,'applied');
  assert.equal((await invokeTask('task_operation',{task_id:task.task_id,operation_id:'batch'})).batch.files.length,2);
  assert.equal((await invokeTask('task_changes',{task_id:task.task_id})).length,2);
  await invokeTask('task_rollback',{task_id:task.task_id,change_id:'batch',operation_id:'undo-batch',lease_token:task.lease_token});
  const renameArgs={task_id:task.task_id,operation_id:'rename',expected_fingerprint:task.fingerprint,lease_token:task.lease_token,file:'check.cjs',line:1,column:8,new_name:'verify'};
  assert.equal((await invokeTask('task_rename',renameArgs)).batch.outcome,'applied');
  assert.match(await readFile(join(project,'check.cjs'),'utf8'),/const verify/);
  assert.equal((await invokeTask('task_rename',renameArgs)).state,'completed');
  await invokeTask('task_rollback',{task_id:task.task_id,change_id:'rename',operation_id:'undo-rename',lease_token:task.lease_token});
  const beforePartial=await readFile(join(project,'check.cjs'),'utf8');
  const interrupted=new TaskFileBatches(runtime.durableTasks,(phase)=>{if(phase==='replaced')throw new Error('Fixture interrupted between file replacements');});
  assert.equal(interrupted.write(task.task_id,'partial',[
    {path:'check.cjs',content:beforePartial+'// partial\n',expected_hash:digest(beforePartial)},
    {path:'partial.txt',content:'pending',expected_hash:null},
  ],task.fingerprint,task.lease_token).state,'unknown');
  const partialState=await invokeTask('task_status',{task_id:task.task_id});
  const restored=await invokeTask('task_edit_recover',{task_id:task.task_id,operation_id:'partial',recovery_id:'restore',mode:'rollback',expected_fingerprint:partialState.fingerprint,lease_token:task.lease_token});
  assert.equal(restored.operation.batch.outcome,'rolled_back');
  assert.equal((await invokeTask('task_status',{task_id:task.task_id})).fingerprint,task.fingerprint);
  const blocked = await client.callTool({name:"exec_command",arguments:{workspace_id:workspaceId,cmd:"echo bypass"}});
  assert.equal(blocked.isError,true,JSON.stringify(blocked));
  assert.match(JSON.stringify(blocked),/owned by a durable task/);
  const diagnostics=await invokeTask('task_diagnostics',{task_id:task.task_id});
  assert.equal(diagnostics.verification,'not_performed');
  assert.equal(diagnostics.lease_token,undefined);
  const tasks = await invokeTask("task_list",{});
  assert.ok(tasks.some((item:{id:string})=>item.id===task.task_id));
  await invokeTask("task_verify",{task_id:task.task_id,operation_id:"verify",cmd:command,expected_fingerprint:task.fingerprint,lease_token:task.lease_token});
  let operation;
  for(let n=0;n<100;n++) {
    operation=await invokeTask("task_operation",{task_id:task.task_id,operation_id:"verify"});
    if (!["prepared","running"].includes(operation.state)) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(operation.exit_code,0,JSON.stringify(operation));
  assert.equal((await invokeTask("task_resume",{task_id:task.task_id})).checkpoint_matches,true);
  const handoff=await invokeTask("handoff_prepare",{task_id:task.task_id,handoff_id:"next",expected_fingerprint:task.fingerprint,note:"Acceptance passed; confirm and complete",lease_token:task.lease_token});
  const claimed=await invokeTask("handoff_claim",{task_id:task.task_id,handoff_id:"next",claim_token:handoff.claim_token,recipient_key:"receiver",expected_fingerprint:task.fingerprint});
  const stale=await client.callTool({name:"task_complete",arguments:{task_id:task.task_id,lease_token:task.lease_token}});
  assert.equal(stale.isError,true);
  assert.equal((await invokeTask("task_complete",{task_id:task.task_id,lease_token:claimed.lease_token})).status,"complete");
});
