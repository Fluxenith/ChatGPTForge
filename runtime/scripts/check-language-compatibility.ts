import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {planSerenaRename,planSerenaSymbolEdit,serenaLanguageCapabilities} from '../src/serena-workspace-edit.js';
const out=resolve(process.argv[2]??'../artifacts/language-compatibility');mkdirSync(out,{recursive:true});
const fixtures:Record<string,{files:Record<string,string>;file:string;name:string;body?:string}>={
 python:{files:{'calc.py':'def twice(value):\n    return value * 2\n','main.py':'from calc import twice\nprint(twice(3))\n'},file:'calc.py',name:'twice'},
 typescript:{files:{'calc.ts':'export function twice(value: number) { return value * 2; }\n','main.ts':'import {twice} from "./calc";\nconsole.log(twice(3));\n','tsconfig.json':'{"compilerOptions":{"strict":true,"target":"ES2022","module":"commonjs"},"include":["*.ts"]}'},file:'calc.ts',name:'twice'},
 go:{files:{'go.mod':'module demo\n\ngo 1.21\n','calc/calc.go':'package calc\nfunc Twice(v int) int { return v * 2 }\n','main.go':'package main\nimport "demo/calc"\nfunc main() { println(calc.Twice(3)) }\n'},file:'calc/calc.go',name:'Twice'},
 java:{files:{'src/demo/Calc.java':'package demo;\npublic class Calc {\n public static int twice(int v) { return v * 2; }\n}\n','src/demo/Main.java':'package demo;\npublic class Main { public static void main(String[] args) { System.out.println(Calc.twice(3)); } }\n'},file:'src/demo/Calc.java',name:'twice'},
 lua:{files:{'calc.lua':'local M = {}\nfunction M.twice(v)\n return v * 2\nend\nreturn M\n','main.lua':'local calc = require("calc")\nprint(calc.twice(3))\n'},file:'calc.lua',name:'twice'},
 bash:{files:{'calc.sh':'twice() {\n echo $(($1 * 2))\n}\n','main.sh':'#!/bin/bash\nsource ./calc.sh\ntwice 3\n'},file:'calc.sh',name:'twice'},
 cpp:{files:{'calc.h':'inline int twice(int v) { return v * 2; }\n','main.cpp':'#include "calc.h"\nint main() { return twice(3) == 6 ? 0 : 1; }\n','compile_commands.json':'[{"directory":".","file":"main.cpp","arguments":["clang++","-std=c++17","-c","main.cpp"]}]'},file:'calc.h',name:'twice',body:'inline int twice(int v) { return v + v; }'},
 php:{files:{'calc.php':'<?php\nfunction twice($v) { return $v * 2; }\n'},file:'calc.php',name:'twice',body:'function twice($v) { return $v + $v; }'},
 vue:{files:{'calc.ts':'export function twice(v: number) { return v * 2; }\n','App.vue':'<script setup lang="ts">\nimport { twice } from "./calc";\nconst result = twice(3);\n</script>\n<template><div>{{ result }}</div></template>\n','tsconfig.json':'{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","strict":true},"include":["*.ts","*.vue"]}'},file:'calc.ts',name:'twice',body:'export function twice(v: number) { return v + v; }'},
 kotlin:{files:{'Main.kt':'fun twice(v: Int) = v * 2\n','App.kt':'fun main() { println(twice(3)) }\n'},file:'Main.kt',name:'twice',body:'fun twice(v: Int) = v + v'},
};
const results:unknown[]=[];
for(const capability of serenaLanguageCapabilities()){
 if(process.argv[3]&&capability.language!==process.argv[3])continue;
 const language=capability.language,f=fixtures[language];if(!f){results.push({language,state:'no-fixture'});continue;}
 const root=join(out,language);mkdirSync(root,{recursive:true});
 for(const [name,text]of Object.entries(f.files)){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
 const began=Date.now();
 try{
  let count:number;
  if(capability.rename){const lines=f.files[f.file]!.split('\n'),line=lines.findIndex(l=>l.includes(f.name));
   const plan=await planSerenaRename({root,language,file:f.file,line:line+1,column:lines[line]!.indexOf(f.name)+1,new_name:language==='go'?'Scale':'scale'});
   count=plan.files.length;if(count<2)throw Error('Cross-file fixture produced fewer than two changed files');
  }else{const plan=await planSerenaSymbolEdit({root,language,file:f.file,operation:'replace_body',name_path:f.name,body:f.body});count=plan.changes.length;if(!count)throw Error('Empty edit');}
  for(const [name,text]of Object.entries(f.files))if(readFileSync(join(root,name),'utf8')!==text)throw Error('Probe changed source');
  results.push({language,state:'passed',operation:capability.rename?'cross-file-rename':'symbol-edit',files:count,source_unchanged:true,ms:Date.now()-began});
 }catch(error){results.push({language,state:'failed',error:String(error).slice(0,1600),ms:Date.now()-began});}
 writeFileSync(join(out,'results.json'),JSON.stringify({serena:'1.7.0',checked:new Date().toISOString(),results},null,2));console.log(JSON.stringify(results.at(-1)));
}
if(results.some((r:any)=>r.state!=='passed'))process.exitCode=1;
