import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./plugin-setup.js',import.meta.url),'utf8').replaceAll('export async function','async function');
test('form preparation opens pointer-driven menu and fills aria-labelled tunnel without submitting',async()=>{
 let menu=false,dialog=false,tunnel=false,submitted=false;
 class Event{constructor(type,options){this.type=type;Object.assign(this,options);}}
 class Input{get value(){return this._value||'';}set value(v){this._value=v;}getClientRects(){return [1];}dispatchEvent(){}getAttribute(n){return n==='aria-label'?this.aria:null;}}
 const name=new Input(),id=new Input();id.aria='Tunnel ID';
 const button=(text,click)=>({textContent:text,getClientRects:()=>[1],getAttribute:()=>null,click,dispatchEvent(e){if(text==='Add'&&e.type==='pointerdown'&&e.button===0)menu=true;}});
 const add=button('Add',()=>{}),custom=button('Add custom MCP server',()=>{dialog=true;}),connection=button('Tunnel',()=>{tunnel=true;}),create=button('Create as a plugin',()=>{submitted=true;});
 const label={textContent:'Name',control:name,getClientRects:()=>[1]};
 const form={querySelectorAll:s=>s==='input'?(tunnel?[name,id]:[name]):s==='label'?[label]:[]};
 const document={getElementById:()=>null,querySelector:()=>dialog?form:null,querySelectorAll:()=>[add,...menu?[custom]:[],...dialog?[connection,create]:[]]};
 const context=vm.createContext({location:{origin:'https://chatgpt.com',pathname:'/plugins'},document,HTMLInputElement:Input,PointerEvent:Event,Event,setTimeout});
 vm.runInContext(source,context);
 const result=await vm.runInContext("fillPluginForm('Forge project','tunnel_test')",context);
 assert.equal(result.ok,true);assert.equal(name.value,'Forge project');assert.equal(id.value,'tunnel_test');assert.equal(submitted,false);
});

test('navigation races retry injection in the original tab after stable plugin navigation',async()=>{
 let created=0,injections=0,reads=0;const reports=[];
 const context=vm.createContext({URL,Error,String,chrome:{tabs:{create:async()=>{created++;return {id:42};},get:async()=>{reads++;return reads===1?{url:'about:blank',status:'complete'}:{url:'https://chatgpt.com/plugins',status:'complete'};}},scripting:{executeScript:async options=>{assert.equal(options.target.tabId,42);injections++;if(injections===1)throw Error('Frame with ID 0 was removed.');return [{result:{ok:true}}];}}},setTimeout:callback=>{callback();}});
 vm.runInContext(source,context);
 context.api=async(path,body)=>{if(path==='plugin-setup-take')return {id:'demo',name:'Demo',tunnelId:'tunnel_test'};reports.push(body);};
 await vm.runInContext('runPluginSetup(api)',context);
 assert.equal(created,1);assert.equal(injections,2);assert.ok(reads>=9);assert.equal(reports.length,1);assert.equal(reports[0].state,'ready');
});

test('non-navigation injection errors stop without replay',async()=>{
 let injections=0;const reports=[];
 const context=vm.createContext({URL,Error,String,chrome:{tabs:{create:async()=>({id:42}),get:async()=>({url:'https://chatgpt.com/plugins',status:'complete'})},scripting:{executeScript:async()=>{injections++;throw Error('Permission denied');}}},setTimeout:callback=>{callback();}});
 vm.runInContext(source,context);context.api=async(path,body)=>path==='plugin-setup-take'?{id:'demo',name:'Demo',tunnelId:'tunnel_test'}:reports.push(body);
 await vm.runInContext('runPluginSetup(api)',context);
 assert.equal(injections,1);assert.equal(reports[0].state,'blocked');
});
