import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { isPathInsideRoot } from './roots.js';
import { sourceHash, sourceKey, sourceFileLimit } from './code-project.js';

type Kind = 'library' | 'dependency' | 'manifest' | 'project_output';
const DECLARATION_LIMIT = 4 * 1024 * 1024;
const DEPENDENCY_FILE_LIMIT = 2048;
const DEPENDENCY_BYTE_LIMIT = 64 * 1024 * 1024;
const MANIFEST_LIMIT = 1024 * 1024;
const captureLimit = (kind:Kind) => kind === 'manifest' ? MANIFEST_LIMIT : DECLARATION_LIMIT;
function implicitImports(file:string,text:string,options:ts.CompilerOptions) {
  if(/\.d\.[cm]?ts$/i.test(file))return [];
  let factory:string|undefined, runtime:string|undefined;
  for(const range of ts.getLeadingCommentRanges(text,0)??[]) {
    if(range.kind!==ts.SyntaxKind.MultiLineCommentTrivia)continue;
    for(const match of text.slice(range.pos,range.end).matchAll(/@(jsximportsource|jsxruntime)\s+(\S+)/gi)) {
      if(match[1]!.toLowerCase()==='jsximportsource')factory=match[2];else runtime=match[2];
    }
  }
  const imports=options.importHelpers?['tslib']:[];
  if(runtime!=='classic'&&(options.jsx===ts.JsxEmit.ReactJSX||options.jsx===ts.JsxEmit.ReactJSXDev||options.jsxImportSource||factory||runtime==='automatic')) {
    imports.push(`${factory??options.jsxImportSource??'react'}/${options.jsx===ts.JsxEmit.ReactJSXDev?'jsx-dev-runtime':'jsx-runtime'}`);
  }
  return imports;
}
interface Captured { path: string; text: string; kind: Kind; bytes: number; boundary: string }
export interface CodeEnvironment {
  captures: Map<string, Captured>;
  defaultLib: string;
  unresolvedNames?:string[];
  metadata: {
    typescript_version: string; fingerprint: string; files: number; bytes: number;
    snapshots: { file: string; kind: Kind; sha256: string }[]; snapshots_truncated: boolean;
    unresolved: string[]; unresolved_total: number;
  };
}

function regularPath(path: string, root: string) {
  if (!isPathInsideRoot(path, root)) return false;
  const parts = relative(root, path).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Code environment refuses symbolic links/junctions'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
  }
  return true;
}
function readText(path: string, limit: number) {
  const fd = openSync(path, 'r');
  try {
    const before = lstatSync(path);
    if (!before.isFile()) throw new Error('Code environment requires regular files');
    const data = Buffer.alloc(limit + 1); let count = 0;
    while (count < data.length) { const got = readSync(fd, data, count, data.length - count, null); if (!got) break; count += got; }
    if (count > limit) throw new Error(`Code environment file exceeds ${limit / 1024} KiB capture limit: ${basename(path)}`);
    const after = lstatSync(path), text = data.subarray(0, count).toString('utf8');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Code environment changed during capture');
    if (!Buffer.from(text).equals(data.subarray(0, count))) throw new Error('Code environment requires UTF-8');
    return { text, bytes: count };
  } finally { closeSync(fd); }
}
export function readProjectSource(path:string,root:string) {
  if(!regularPath(path,root))throw new Error('Project source disappeared during capture');
  return readText(path,sourceFileLimit(path));
}

// Only this bounded loader touches disk. TypeScript resolution during analysis
// uses the returned immutable text/metadata maps, never ts.sys.
export function captureCodeEnvironment(root: string, sources: Map<string, string>, names: Map<string, string>, options: ts.CompilerOptions,loadSource?:(path:string)=>boolean,graph:{cachedCaptures?:CodeEnvironment['captures'];rootNames?:string[];redirects?:Map<string,string[]>;outputs?:Set<string>}={}): CodeEnvironment {
  const captures = new Map<string, Captured>(), unresolved = new Set<string>();
  const cached=graph.cachedCaptures??captures;
  const compilerRoot = realpathSync.native(dirname(ts.getDefaultLibFilePath(options)));
  let libraryCount = [...cached.values()].filter(item=>item.kind==='library').length, libraryBytes = [...cached.values()].filter(item=>item.kind==='library').reduce((sum,item)=>sum+item.bytes,0), dependencyCount = cached.size-libraryCount, dependencyBytes = [...cached.values()].filter(item=>item.kind!=='library').reduce((sum,item)=>sum+item.bytes,0), lookups = 0;
  const capture = (path: string, kind: Kind, boundary: string) => {
    const key = sourceKey(path);
    if (captures.has(key)) return captures.get(key)!;
    if(cached.has(key)){const item=cached.get(key)!;captures.set(key,item);return item;}
    if (!regularPath(path, boundary)) return undefined;
    if (!lstatSync(path).isFile()) return undefined;
    let data:ReturnType<typeof readText>;
    try { data=readText(path, captureLimit(kind)); }
    catch(error) { throw new Error(`${error instanceof Error?error.message:String(error)} (${kind}:${kind==='library'?basename(path):relative(root,path).replaceAll('\\','/')})`); }
    if (kind === 'library') {
      if (++libraryCount > 160 || (libraryBytes += data.bytes) > 16 * 1024 * 1024) throw new Error('Standard library capture exceeds bounds');
    } else if (++dependencyCount > DEPENDENCY_FILE_LIMIT || (dependencyBytes += data.bytes) > DEPENDENCY_BYTE_LIMIT) throw new Error('Dependency capture exceeds 2048 files / 64 MiB');
    if (kind === 'manifest') {
      try { const json = JSON.parse(data.text); if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('object required'); }
      catch { throw new Error('Invalid captured package.json'); }
    }
    const item = { path, ...data, kind, boundary }; captures.set(key, item);cached.set(key,item); return item;
  };
  const loadLib = (name: string, required=true) => {
    if (!/^lib(?:\.[a-z0-9]+)*\.d\.ts$/i.test(name)) throw new Error('Only bundled TypeScript standard libraries are supported');
    const path = join(compilerRoot, name), key = sourceKey(path);
    if (captures.has(key)) return;
    const item = capture(path, 'library', compilerRoot);
    if (!item) {
      if(required)throw new Error(`Bundled library not found: ${name}`);
      unresolved.add(`library:${name}`);return;
    }
    const info = ts.preProcessFile(item.text, true, true);
    for (const ref of info.libReferenceDirectives) loadLib(`lib.${ref.fileName.toLowerCase()}.d.ts`,required);
    for (const ref of info.referencedFiles) loadLib(ref.fileName,required);
  };
  let defaultLib = '';
  if (!options.noLib) {
    const libs = options.lib ?? [basename(ts.getDefaultLibFilePath(options))];
    for (const lib of libs) loadLib(lib);
    defaultLib = join(compilerRoot, basename(ts.getDefaultLibFilePath(options)));
  }
  for(const dir of options.typeRoots??[])if(!isPathInsideRoot(dir,root))throw new Error('External typeRoots are unsupported');
  const typeRoots=(ts.getEffectiveTypeRoots(options,{getCurrentDirectory:()=>root})??[])
    .filter(directory=>isPathInsideRoot(directory,root));
  const sourceQueue = [...graph.rootNames??names.values()], queued = new Set(sourceQueue.map(sourceKey));
  const queue = (path: string) => { for(const name of graph.redirects?.get(sourceKey(path))??[path]){const key = sourceKey(name); if (!queued.has(key)) { queued.add(key); sourceQueue.push(name); }} };
  const misses = new Set<string>();
  const maybe = (path: string): Captured | undefined => {
    const key = sourceKey(path); if (captures.has(key)) return captures.get(key);
    if (misses.has(key) || !isPathInsideRoot(path, root)) return undefined;
    if (++lookups > 20000) throw new Error('Dependency resolution exceeds 20,000 lookups');
    const rel = relative(root, path).replaceAll('\\', '/');
    const manifest = basename(path).toLowerCase() === 'package.json';
    const declaration = /\.d\.[cm]?ts$/i.test(path) && (/(^|\/)node_modules\//i.test(rel) || typeRoots.some(dir => isPathInsideRoot(path, dir)));
    const projectOutput=graph.outputs?.has(key);
    if (!manifest && !declaration&&!projectOutput) { misses.add(key); return undefined; }
    const item = capture(path, manifest ? 'manifest' : projectOutput?'project_output':'dependency', root);
    if (!item) misses.add(key);
    else if (item.kind !== 'manifest') queue(path);
    return item;
  };
  const directories = new Map<string, boolean>();
  const directoryExists = (path: string) => {
    const key = sourceKey(path); if (directories.has(key)) return directories.get(key)!;
    if (!isPathInsideRoot(path, root)) return false;
    if(graph.redirects&&[...graph.redirects.keys()].some(file=>file.startsWith(key.replace(/\/$/,'')+'/')))return true;
    if (++lookups > 20000) throw new Error('Dependency resolution exceeds 20,000 lookups');
    const exists = regularPath(path, root) && lstatSync(path).isDirectory(); directories.set(key, exists); return exists;
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: path => sources.has(sourceKey(path)) || !!graph.redirects?.has(sourceKey(path)) || !!maybe(path) || !!loadSource?.(path),
    readFile: path => sources.get(sourceKey(path)) ?? maybe(path)?.text ?? (loadSource?.(path)?sources.get(sourceKey(path)):undefined),
    directoryExists, getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: process.platform !== 'win32',
    getDirectories: path => {
      if (!directoryExists(path)) return [];
      const children = readdirSync(path, { withFileTypes: true });
      if (children.length > 256) throw new Error('Automatic types exceed 256 packages; configure compilerOptions.types');
      return children.filter(child => child.isDirectory() || child.isSymbolicLink()).map(child => child.name);
    },
  };
  const resolveType = (name: string, file?: string) => {
    const resolved = ts.resolveTypeReferenceDirective(name, file, options, host).resolvedTypeReferenceDirective;
    if (resolved?.resolvedFileName) queue(resolved.resolvedFileName); else unresolved.add(`types:${name}`);
  };
  // Delegate implicit/explicit/wildcard type selection to the pinned compiler.
  // TypeScript 6 requires types:["*"] for automatic package inclusion.
  for (const name of ts.getAutomaticTypeDirectiveNames({...options,typeRoots},host)) resolveType(name);
  for (let index = 0; index < sourceQueue.length; index++) {
    const file = sourceQueue[index]!, text = sources.get(sourceKey(file)) ?? captures.get(sourceKey(file))?.text;
    if (text === undefined) continue;
    const info = ts.preProcessFile(text, true, true);
    const mode = ts.getImpliedNodeFormatForFile(file, undefined, host, options);
    for (const imported of [...info.importedFiles.map(ref=>ref.fileName),...implicitImports(file,text,options)]) {
      const result = ts.resolveModuleName(imported, file, options, host, undefined, undefined, mode).resolvedModule;
      if (result) queue(result.resolvedFileName); else unresolved.add(imported);
    }
    for (const ref of info.typeReferenceDirectives) resolveType(ref.fileName, file);
    for (const ref of info.referencedFiles) {
      const path = resolve(dirname(file), ref.fileName);
      if (sources.has(sourceKey(path)) || maybe(path)) queue(path); else unresolved.add(`reference:${ref.fileName}`);
    }
    for (const ref of info.libReferenceDirectives) if (!options.noLib) loadLib(`lib.${ref.fileName.toLowerCase()}.d.ts`,false);
  }
  const snapshots = [...captures.values()].map(item => ({
    file: item.kind === 'library' ? `typescript:${basename(item.path)}` : relative(root, item.path).replaceAll('\\', '/'), kind: item.kind, sha256: sourceHash(item.text),
  })).sort((a, b) => a.file.localeCompare(b.file));
  return { captures, defaultLib, unresolvedNames:[...unresolved].sort(),metadata: {
    typescript_version: ts.version, fingerprint: sourceHash(JSON.stringify(snapshots)), files: captures.size, bytes: [...captures.values()].reduce((sum,item)=>sum+item.bytes,0),
    snapshots: snapshots.slice(0, 100), snapshots_truncated: snapshots.length > 100,
    unresolved: [...unresolved].sort().slice(0, 100), unresolved_total: unresolved.size,
  } };
}

export function verifyCodeEnvironment(environment: CodeEnvironment) {
  for (const item of environment.captures.values()) {
    if (!regularPath(item.path, item.boundary) || sourceHash(readText(item.path, captureLimit(item.kind)).text) !== sourceHash(item.text))
      throw new Error('Code environment changed since analysis; inspect again before rename');
  }
}
