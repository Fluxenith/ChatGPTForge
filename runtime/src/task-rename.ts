import { navigateCode } from './code-navigation.js';
import { DurableTasks, digest, snapshot } from './durable-tasks.js';
import { TaskFileBatches, type BatchChange } from './task-file-batches.js';
import { realpath } from 'node:fs/promises';
import type {CodeProject} from './code-project.js';
import {verifyCodeEnvironment} from './code-environment.js';
import {usesPythonNavigation,verifyPythonEnvironment,type PythonProject} from './python-project.js';
import {navigatePython} from './python-navigation.js';
import {usesGoNavigation,verifyGoEnvironment,type GoProject} from './go-project.js';
import {navigateGo} from './go-navigation.js';
import {usesJavaNavigation,verifyJavaEnvironment,type JavaProject} from './java-project.js';
import {navigateJava} from './java-navigation.js';
import {usesCSharpNavigation,verifyCSharpEnvironment,type CSharpProject} from './csharp-project.js';
import {navigateCSharp} from './csharp-navigation.js';
import {planSerenaRename,planSerenaSymbolEdit,type SerenaSymbolEditOperation} from './serena-workspace-edit.js';
import {assertKotlinTaskWritable} from './kotlin-generated.js';

export interface TaskRename {
  task_id: string; operation_id: string; expected_fingerprint: string; lease_token?: string;
  file: string; line: number; column: number; new_name: string; files?: string[];
}

// Generate edits from fresh bounded semantic snapshots; the model does not have
// to reconstruct UTF-16 ranges or shorthand/import prefix/suffix replacements.
export async function renameTask(engine: DurableTasks, batches: TaskFileBatches, input: TaskRename, allowedRoots: string[], signal?: AbortSignal) {
  const { task_id: id, operation_id: op, expected_fingerprint: expected, lease_token: lease, ...query } = input;
  // Keep the public schema order stable across core and MCP callers so valid
  // receipt replays do not depend on JavaScript object insertion order.
  const request = { kind: 'rename', file:query.file, line:query.line, column:query.column, new_name:query.new_name, ...(query.files?{files:query.files}:{}), expected };
  const replay = batches.replay(id, op, request, lease);
  if (replay) return replay;
  if (signal?.aborted) throw new Error('Rename cancelled before write intent');
  const task = engine.task(id); engine.assertLease(task, lease); engine.assertIdle(task);
  if (snapshot(task.root).fingerprint !== expected) throw new Error('Workspace changed before rename analysis');
  assertKotlinTaskWritable(task.root,[input.file]);
  const roots = await Promise.all(allowedRoots.map(root => realpath(root)));
  let captured:CodeProject|undefined;
  let capturedPython:PythonProject|undefined;
  let capturedGo:GoProject|undefined;
  let capturedJava:JavaProject|undefined;
  let capturedCSharp:CSharpProject|undefined;
  const csharp=await usesCSharpNavigation({path:task.root,...query},roots);
  const java=!csharp&&await usesJavaNavigation({path:task.root,...query},roots);
  const go=!csharp&&!java&&await usesGoNavigation({path:task.root,...query},roots);
  const python=!csharp&&!java&&!go&&await usesPythonNavigation({path:task.root,...query},roots);
  const preview = csharp
    ? await navigateCSharp({...query,path:task.root,action:'rename_preview'},roots,signal,project=>{capturedCSharp=project;})
    : java
    ? await navigateJava({...query,path:task.root,action:'rename_preview'},roots,signal,project=>{capturedJava=project;})
    : go
    ? await navigateGo({ ...query,path:task.root,action:'rename_preview' },roots,project=>{capturedGo=project;},signal)
    : python
    ? await navigatePython({ ...query, path:task.root,action:'rename_preview' },roots,project=>{capturedPython=project;},signal)
    : await navigateCode({ ...query, path: task.root, action: 'rename_preview' }, roots,project=>{captured=project;},signal);
  if (!preview.edits?.length) throw new Error('No rename edits available; inspect rename_preview');
  const changes:BatchChange[] = preview.edits.map(edit => {
    let content = batches.readText(task.root, edit.file);
    if (digest(content) !== edit.sha256) throw new Error('Rename source changed since semantic capture');
    let previous = content.length;
    for (const replacement of edit.replacements) {
      if (replacement.start < 0 || replacement.start + replacement.length > previous
        || content.slice(replacement.start, replacement.start + replacement.length) !== replacement.old_text) throw new Error('Invalid or stale rename edit');
      previous = replacement.start;
      content = content.slice(0, replacement.start) + replacement.new_text + content.slice(replacement.start + replacement.length);
    }
    return { path: edit.file, content, expected_hash: edit.sha256 };
  });
  if(java&&'file_moves' in preview)for(const move of preview.file_moves??[]){const change=changes.find(c=>c.path===move.from);if(!change||change.expected_hash!==move.sha256)throw Error('Invalid Java filename move');if(move.from.toLowerCase()===move.to.toLowerCase()){change.rename_to=move.to;}else{changes.push({path:move.to,content:change.content,expected_hash:null});change.content=null;}}
  if(signal?.aborted)throw new Error('Rename cancelled before write intent');
  if(csharp)await verifyCSharpEnvironment(capturedCSharp!,signal);else if(java)await verifyJavaEnvironment(capturedJava!,signal);else if(go)await verifyGoEnvironment(capturedGo!,signal);else if(python)verifyPythonEnvironment(capturedPython!);else verifyCodeEnvironment(captured!.environment);
  // Cancellation fences the write until intent is durable. Afterwards use its receipt.
  if (signal?.aborted) throw new Error('Rename cancelled before write intent');
  assertKotlinTaskWritable(task.root,changes.flatMap(c=>[c.path,...(c.rename_to?[c.rename_to]:[])]));
  return batches.write(id, op, changes, expected, lease, request);
}

export interface TaskSerenaRename {
  task_id: string; operation_id: string; expected_fingerprint: string; lease_token?: string;
  language: string; file: string; line: number; column: number; new_name: string;
}

// Shared Serena backend: the LSP plans on a private copy of exactly the expected
// fingerprint; Forge alone publishes the result through the journaled batch.
export async function serenaRenameTask(engine: DurableTasks, batches: TaskFileBatches, input: TaskSerenaRename, signal?: AbortSignal, plan = planSerenaRename) {
  const { task_id: id, operation_id: op, expected_fingerprint: expected, lease_token: lease } = input;
  const request = { kind: 'serena_rename', language: input.language, file: input.file, line: input.line, column: input.column, new_name: input.new_name, expected };
  const replay = batches.replay(id, op, request, lease);
  if (replay) return replay;
  if (signal?.aborted) throw new Error('Rename cancelled before write intent');
  const task = engine.task(id); engine.assertLease(task, lease); engine.assertIdle(task);
  if (snapshot(task.root).fingerprint !== expected) throw new Error('Workspace changed before Serena rename analysis');
  assertKotlinTaskWritable(task.root,[input.file]);
  const result = await plan({ root: task.root, language: input.language, file: input.file, line: input.line, column: input.column, new_name: input.new_name }, signal);
  if (result.fingerprint !== expected) throw new Error('Serena captured a different workspace than expected; nothing applied');
  for (const change of result.changes) if (change.expected_hash !== null && digest(batches.readText(task.root, change.path)) !== change.expected_hash) throw new Error('Rename source changed since Serena capture');
  if (signal?.aborted) throw new Error('Rename cancelled before write intent');
  // batches.write rechecks lease, idleness and the full fingerprint atomically with intent.
  assertKotlinTaskWritable(task.root,result.changes.flatMap(c=>[c.path,...(c.rename_to?[c.rename_to]:[])]));
  return batches.write(id, op, result.changes, expected, lease, request);
}

export interface TaskSerenaEdit {
  task_id: string; operation_id: string; expected_fingerprint: string; lease_token?: string;
  language: string; file: string; operation: SerenaSymbolEditOperation; name_path: string; body?: string;
}
// Serena's own symbol editor runs on a private copy; the result is one
// journaled batch with the same replay, rollback and recovery as task_edit.
export async function serenaSymbolEditTask(engine: DurableTasks, batches: TaskFileBatches, input: TaskSerenaEdit, signal?: AbortSignal, plan = planSerenaSymbolEdit) {
  const { task_id: id, operation_id: op, expected_fingerprint: expected, lease_token: lease } = input;
  const request = { kind: 'serena_symbol_edit', language: input.language, file: input.file, operation: input.operation, name_path: input.name_path, body_sha256: input.body === undefined ? null : digest(Buffer.from(input.body, 'utf8')), expected };
  const replay = batches.replay(id, op, request, lease);
  if (replay) return replay;
  if (signal?.aborted) throw new Error('Symbol edit cancelled before write intent');
  const task = engine.task(id); engine.assertLease(task, lease); engine.assertIdle(task);
  if (snapshot(task.root).fingerprint !== expected) throw new Error('Workspace changed before Serena symbol edit');
  assertKotlinTaskWritable(task.root,[input.file]);
  const result = await plan({ root: task.root, language: input.language, file: input.file, operation: input.operation, name_path: input.name_path, ...(input.body !== undefined ? { body: input.body } : {}) }, signal);
  if (result.fingerprint !== expected) throw new Error('Serena captured a different workspace than expected; nothing applied');
  for (const change of result.changes) if (change.expected_hash !== null && digest(batches.readText(task.root, change.path)) !== change.expected_hash) throw new Error('Symbol edit source changed since Serena capture');
  if (signal?.aborted) throw new Error('Symbol edit cancelled before write intent');
  assertKotlinTaskWritable(task.root,result.changes.map(c=>c.path));
  return batches.write(id, op, result.changes, expected, lease, request);
}
