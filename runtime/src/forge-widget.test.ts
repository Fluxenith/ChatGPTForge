import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import test from 'node:test';
import ts from 'typescript';
import {workspaceAppHtml} from './server.js';

test('packaged MCP card runs without fetching scripts, styles or module chunks', () => {
  const html=workspaceAppHtml();
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=|<link\b[^>]*\brel=["']stylesheet/i);
  assert.doesNotMatch(html, /https:\/\/[^\s"'<>]+\/mcp-app-assets/);
  assert.ok(Buffer.byteLength(html)<1.5*1024*1024,'Card resource must fit within a 1.5 MiB transport budget');
  const scripts=[...html.matchAll(/<script type="module" data-forge-bundle="gzip-base64">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);
  assert.ok(scripts[0]![1]!.length>1000);
  const encoded=scripts[0]![1]!.match(/atob\("([A-Za-z0-9+/=]+)"\)/)?.[1];
  assert.ok(encoded);
  const code=gunzipSync(Buffer.from(encoded,'base64')).toString('utf8');
  const source=ts.createSourceFile('widget.js',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const imports:string[]=[];
  function visit(node:ts.Node) {
    if(ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier ||
      ts.isCallExpression(node) && node.expression.kind===ts.SyntaxKind.ImportKeyword) imports.push(node.getText(source));
    ts.forEachChild(node,visit);
  }
  visit(source);
  assert.deepEqual(imports,[], 'No module fetch may depend on publicBaseUrl');
  assert.match(html, /<style>[\s\S]+<\/style>/);
  const manifest=JSON.parse(readFileSync(new URL('../dist/ui/.vite/manifest.json',import.meta.url),'utf8'));
  assert.equal(Object.values(manifest).filter((e:any)=>e.isDynamicEntry).length,0);
});
