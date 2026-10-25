import { relative, basename } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { resolveCanonicalAllowedPath } from './roots.js';
import { loadCodeProject, sourceHash, sourceKey, type CodeProject } from './code-project.js';
import type { McpRegistrationTarget } from './mcp-modern-server.js';
import {runCodeAnalysis} from './code-analysis-runtime.js';
import {openCodeServices} from './code-project-services.js';
import {usesPythonNavigation} from './python-project.js';
import {navigatePython} from './python-navigation.js';
import {usesGoNavigation} from './go-project.js';
import {navigateGo} from './go-navigation.js';
import {usesJavaNavigation} from './java-project.js';
import {navigateJava} from './java-navigation.js';
import {usesCSharpNavigation} from './csharp-project.js';
import {navigateCSharp} from './csharp-navigation.js';

const schema = z.object({
  path: z.string().describe('Absolute project directory within approved roots'),
  files: z.array(z.string()).min(1).max(64).optional().describe('Optional explicit files of one language (TS/JS, Python, Go, Java or C#); Go retains bounded module context and rename can touch other project files; omit for project discovery'),
  file: z.string().optional().describe('Relative target file; required for outline, definition, references and rename_preview'),
  action: z.enum(['outline', 'definition', 'references', 'symbols', 'diagnostics', 'rename_preview']),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  query: z.string().min(1).max(200).optional().describe('Symbol search text for symbols'),
  new_name: z.string().min(1).max(200).optional().describe('New identifier for read-only rename_preview'),
});
export type CodeNavigationInput=z.infer<typeof schema>;

interface RenameEdit {
  file: string;
  sha256: string;
  replacements: { start: number; length: number; old_text: string; new_text: string; line: number; column: number; end_line: number; end_column: number }[];
}

// All compiler reads use bounded snapshots. Project configuration never grants
// module resolution an unrestricted ts.sys filesystem.
export async function navigateCode(input:CodeNavigationInput,roots:string[],onCapture?:(project:CodeProject)=>void,signal?:AbortSignal) {
  schema.parse(input);
  const reply=await runCodeAnalysis(input,roots,!!onCapture,{signal});
  if(onCapture)onCapture(reply.project!);
  return reply.result;
}

export async function analyzeCode(input:CodeNavigationInput, roots: string[], onCapture?: (project:CodeProject)=>void) {
  schema.parse(input);
  if (!['symbols', 'diagnostics'].includes(input.action) && !input.file) throw new Error('file is required for this action');
  if (input.action === 'symbols' && !input.query) throw new Error('query is required for symbols');
  if (input.action === 'rename_preview') {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, input.new_name ?? '');
    if (scanner.scan() !== ts.SyntaxKind.Identifier || scanner.getTokenText() !== input.new_name || scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
      throw new Error('new_name must be a valid, non-keyword identifier');
    }
  }
  const project = await loadCodeProject(input, roots);
  onCapture?.(project);
  const { root, texts, names, metadata, environment } = project;
  const selected = input.file ? sourceKey(await resolveCanonicalAllowedPath(input.file, root, [root])) : undefined;
  if (selected && !texts.has(selected)) throw new Error('Target file must be included in files or project config');
  const services=openCodeServices(project,selected);
  const capturedText=services.capturedText;
  try {
    const {program,service}=services.primary();
    const location = (file: string, span: ts.TextSpan) => {
      const source = program.getSourceFile(file)??(capturedText(file)===undefined?undefined:ts.createSourceFile(file,capturedText(file)!,ts.ScriptTarget.Latest));
      const extra=environment.captures.get(sourceKey(file));
      const name = names.get(sourceKey(file)) ?? extra?.path;
      if (!source || !name) throw new Error('Language service returned a file outside the captured project');
      const start = source.getLineAndCharacterOfPosition(span.start);
      const end = source.getLineAndCharacterOfPosition(span.start + span.length);
      return { file: extra?.kind==='library'?`typescript:${basename(name)}`:relative(root, name), line: start.line + 1, column: start.character + 1, end_line: end.line + 1, end_column: end.character + 1,
        ...(extra?{read_only:true,origin:extra.kind}:{}) };
    };
    const results: unknown[] = [];
    let total = 0;
    const add = (value: unknown) => { total++; if (results.length < 300) results.push(value); };
    let rename: { can_rename: boolean; reason?: string; display_name?: string } | undefined;
    let edits: RenameEdit[] | undefined;
    if (input.action === 'symbols') {
      const seen=new Set<string>();
      for(const context of services.all())for (const item of context.service.getNavigateToItems(input.query!)) {
        const key=`${sourceKey(item.fileName)}:${item.textSpan.start}:${item.textSpan.length}:${item.name}`;
        if (texts.has(sourceKey(item.fileName))&&!seen.has(key)){seen.add(key);add({ name: item.name, kind: item.kind, parent: item.containerName, match_kind: item.matchKind, ...location(item.fileName, item.textSpan) });}
      }
    } else if (input.action === 'diagnostics') {
      for(const context of selected?[services.primary()]:services.all()) {
      const config=context.node.config?relative(root,context.node.config):null;
      const referenced=new Set<string>();
      const includeReferences=(node:CodeProject['projects'][number])=>{for(const ref of node.references??[]){const key=sourceKey(ts.resolveProjectReferencePath(ref));if(referenced.has(key))continue;referenced.add(key);const child=project.projects.find(item=>item.config&&sourceKey(item.config)===key);if(child)includeReferences(child);}};
      includeReferences(context.node);
      const referenceSources=new Set(project.projects.filter(node=>node.config&&referenced.has(sourceKey(node.config))).flatMap(node=>node.rootNames.map(sourceKey)));
      const files=selected?[selected]:context.program.getSourceFiles().filter(file=>texts.has(sourceKey(file.fileName))&&!referenceSources.has(sourceKey(file.fileName))).map(file=>file.fileName);
      if(!selected && !input.files)for(const diagnostic of [...context.service.getCompilerOptionsDiagnostics(),...(context.node.rootNames.length?context.program.getGlobalDiagnostics():[])])
        add({code:diagnostic.code,severity:ts.DiagnosticCategory[diagnostic.category].toLowerCase(),message:ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n'),...(project.projects.length>1?{project_config:config}:{})});
      for (const file of files) {
        for (const diagnostic of [...context.service.getSyntacticDiagnostics(file), ...context.service.getSemanticDiagnostics(file)]) {
          if (diagnostic.file && !texts.has(sourceKey(diagnostic.file.fileName))) continue;
          add({ code: diagnostic.code, severity: ts.DiagnosticCategory[diagnostic.category].toLowerCase(), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            ...(diagnostic.file && diagnostic.start !== undefined ? location(diagnostic.file.fileName, { start: diagnostic.start, length: diagnostic.length ?? 0 }) : {}),...(project.projects.length>1?{project_config:config}:{}),
          });
        }
      }
      }
    } else if (input.action === 'outline') {
      const visit = (item: ts.NavigationTree, parent: string) => {
        if (item.kind !== 'script') for (const span of item.spans) add({ name: item.text, kind: item.kind, parent, ...location(selected!, span) });
        for (const child of item.childItems ?? []) visit(child, item.kind === 'script' ? '' : item.text);
      };
      visit(service.getNavigationTree(selected!), '');
    } else {
      if (!input.line || !input.column) throw new Error('line and column (1-based) are required');
      const source = program.getSourceFile(selected!)!;
      const starts = source.getLineStarts();
      const start = starts[input.line - 1];
      if (start === undefined) throw new Error('Line outside file');
      const position = start + input.column - 1;
      const end = starts[input.line] ?? source.text.length;
      if (position >= end || position >= source.text.length || /[\r\n]/.test(source.text[position]!)) throw new Error('Column outside line');
      if (input.action === 'definition') {
        for (const entry of services.definition(selected!, position) ?? []) {
          if (capturedText(entry.fileName)!==undefined) add({ name: entry.name, kind: entry.kind, ...location(entry.fileName, entry.textSpan) });
        }
      } else if (input.action === 'references') {
        // An imported alias has its own reference group. Also query its resolved
        // declaration so callers using other import names are not lost.
        for (const entry of services.references(selected!, position)) {
          if (capturedText(entry.fileName)===undefined) continue;
          add({ is_write: entry.isWriteAccess, ...location(entry.fileName, entry.textSpan) });
        }
      } else {
        const info = service.getRenameInfo(selected!, position, { allowRenameOfImportPath: false });
        rename = info.canRename ? { can_rename: true, display_name: info.displayName } : { can_rename: false, reason: info.localizedErrorMessage };
        if (info.canRename) {
          const entries = services.rename(selected!, position);
          if (entries.length > 300) throw new Error('Rename exceeds 300 edits; no partial rename plan is returned');
          const byFile = new Map<string, RenameEdit>();
          for (const entry of entries) {
            const key = sourceKey(entry.fileName);
            const text = texts.get(key);
            if (text === undefined) throw new Error('Rename touches a read-only environment or a file outside the captured project');
            const place = location(entry.fileName, entry.textSpan);
            let edit = byFile.get(key);
            if (!edit) { edit = { file: place.file, sha256: sourceHash(text), replacements: [] }; byFile.set(key, edit); }
            const replacement = `${entry.prefixText ?? ''}${input.new_name!}${entry.suffixText ?? ''}`;
            const oldText = text.slice(entry.textSpan.start, entry.textSpan.start + entry.textSpan.length);
            edit.replacements.push({ start: entry.textSpan.start, length: entry.textSpan.length, old_text: oldText, new_text: replacement,
              line: place.line, column: place.column, end_line: place.end_line, end_column: place.end_column,
            });
            add({ ...place, old_text: oldText, new_text: replacement });
          }
          edits = [...byFile.values()];
          for (const edit of edits) edit.replacements.sort((a, b) => b.start - a.start);
        }
      }
    }
    return {
      scope: input.files ? 'selected_files_only' as const : 'project_files' as const,
      limitations: 'Bounded TS/JS snapshots with per-project settings, internal acyclic reference graphs, bundled libraries and reachable installed declarations. Source redirects support unbuilt referenced outputs; explicitly disabled redirects use captured read-only outputs and block graph rename. Unselected roots may load when imported. Dependency implementations, excluded source directories, links, external configs and other languages are not loaded. Selected-file mode omits libraries/dependencies/configs. Environment unresolved values are capture-time path misses; ambient declarations may satisfy them. Empty results do not prove no callers; diagnostics do not replace a build. Rename never edits read-only declarations, may have name collisions, and requires fresh verification. Re-query after edits.',
      project: {...metadata,environment:environment.metadata},
      snapshots: [...texts].map(([path, text]) => ({ file: relative(root, names.get(path)!), sha256: sourceHash(text) })),
      total, truncated: total > results.length, results, rename, edits,
    };
  } finally { services.dispose(); }
}

export function registerCodeNavigation(target: McpRegistrationTarget, roots: string[]) {
  target.registerTool('code_navigate', {
    description: 'Read-only TS/JS, Python, Go, Java and C# outline, definitions, references, symbols, diagnostics and rename previews. Target extensions select the language; project markers select queries without targets. TS/JS uses project settings/internal references. Python uses bundled Jedi/pinned Pyright. Go uses pinned gopls/captured toolchain inputs. Java uses JDK 21 private compiler snapshots and optional forge.java.json classpaths exported from separate Maven/Gradle builds. Optional source_archives associate a source JAR with its classpath_index; external definitions return original source content/hash and read-only archive metadata. JDK definitions also bind the actual jrt module to the running JDK installation source ZIP, return original read-only content/hash and pin runtime image/release inputs. Dependency JARs/class directories and source attachments are captured and rechecked; build scripts, dependency code and annotation processors are never executed by analysis. Java rename checks compiler errors and resolved bindings after candidate compilation, follows captured overrides and record components, and returns file_moves for public top-level types. Case-only Java filename moves preserve exact names through the recoverable batch; external override contracts remain read-only. C# uses pinned SDK 10.0.402 / Roslyn 5.9 / .NET 10.0.13 private compiler and AdhocWorkspace snapshots. Build projects require an exported forge.csharp.json source/reference/options/build-input model; navigation never executes MSBuild, project assemblies, analyzers or generators. C# rename follows captured interface/override/partial families with Roslyn binding-preserving edits and error-free candidate compilation; external contracts are read-only and type filenames are retained. External C# definitions identify assembly/symbol metadata, not original source. Explicit files limit coverage. Environment definitions are read-only; positions use 1-based UTF-16. Run actual acceptance after edits.',
    inputSchema: schema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input,extra) => {
    try { schema.parse(input);const result=await usesCSharpNavigation(input,roots)?await navigateCSharp(input,roots,extra.signal):await usesJavaNavigation(input,roots)?await navigateJava(input,roots,extra.signal):await usesGoNavigation(input,roots)?await navigateGo(input,roots,undefined,extra.signal):await usesPythonNavigation(input,roots)?await navigatePython(input,roots,undefined,extra.signal):await navigateCode(input,roots,undefined,extra.signal);return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }; }
  });
}
