// The MCP card is transported as one resource. Do not ship every Shiki grammar
// and theme to open a workspace; unlisted languages retain a plain-text diff.
import {createBundledHighlighter,createSingletonShorthands} from '@shikijs/core';
import {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
export * from '@shikijs/core';
export {createJavaScriptRegexEngine} from '@shikijs/engine-javascript';
export {createOnigurumaEngine} from '@shikijs/engine-oniguruma';

export const bundledLanguages = {
  typescript:()=>import('@shikijs/langs/typescript'),
  tsx:()=>import('@shikijs/langs/tsx'),
  javascript:()=>import('@shikijs/langs/javascript'),
  jsx:()=>import('@shikijs/langs/jsx'),
  python:()=>import('@shikijs/langs/python'),
  go:()=>import('@shikijs/langs/go'),
  java:()=>import('@shikijs/langs/java'),
  csharp:()=>import('@shikijs/langs/csharp'),
  c:()=>import('@shikijs/langs/c'),
  cpp:()=>import('@shikijs/langs/cpp'),
  shellscript:()=>import('@shikijs/langs/shellscript'),
  powershell:()=>import('@shikijs/langs/powershell'),
  lua:()=>import('@shikijs/langs/lua'),
  php:()=>import('@shikijs/langs/php'),
  rust:()=>import('@shikijs/langs/rust'),
  kotlin:()=>import('@shikijs/langs/kotlin'),
  json:()=>import('@shikijs/langs/json'),
  html:()=>import('@shikijs/langs/html'),
  css:()=>import('@shikijs/langs/css'),
  yaml:()=>import('@shikijs/langs/yaml'),
  markdown:()=>import('@shikijs/langs/markdown'),
  sql:()=>import('@shikijs/langs/sql'),
};
export const createHighlighter=createBundledHighlighter({langs:bundledLanguages,themes:{},engine:createJavaScriptRegexEngine});
export const {codeToHtml}=createSingletonShorthands(createHighlighter);

export function diffLanguage(path:string):keyof typeof bundledLanguages|'text' {
  const extension=path.toLowerCase().split('.').at(-1)??'';
  const languages:Record<string,keyof typeof bundledLanguages>={
    ts:'typescript',mts:'typescript',cts:'typescript',tsx:'tsx',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',
    py:'python',pyi:'python',go:'go',java:'java',cs:'csharp',c:'c',h:'c',cpp:'cpp',cc:'cpp',hpp:'cpp',
    sh:'shellscript',bash:'shellscript',ps1:'powershell',psm1:'powershell',lua:'lua',php:'php',rs:'rust',kt:'kotlin',kts:'kotlin',
    json:'json',html:'html',htm:'html',css:'css',yaml:'yaml',yml:'yaml',md:'markdown',sql:'sql',
  };
  return languages[extension]??'text';
}
