import {readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {captureCSharpFile,csharpHash} from './csharp-project.js';
export const CSHARP_SDK='10.0.402',CSHARP_RUNTIME='10.0.13',CSHARP_COMPILER='5.9.0.0';
export interface CSharpToolchain {root:string;dotnet:string;files:Map<string,Buffer>;pins:{path:string;sha256:string}[];framework:string[];libraries:string[];compiler:string[];inventory:{directory:string;names:string[]}[];fingerprint:string}
export async function loadCSharpToolchain(signal?:AbortSignal):Promise<CSharpToolchain>{
 const requested=process.env.CHATGPTFORGE_DOTNET_ROOT??join(homedir(),'.chatgptforge','toolchains','dotnet-'+CSHARP_SDK);
 const root=await realpath(requested),files=new Map<string,Buffer>(),pins:CSharpToolchain['pins']=[],inventory:CSharpToolchain['inventory']=[];
 let total=0,reserved=0;
 const add=async(file:string)=>{const data=await captureCSharpFile(root,file,[root],64*1024*1024,signal);
  if(++reserved>768||(total+=data.bytes)>256*1024*1024)throw Error('C# toolchain exceeds capture budget');
  files.set(file,data.raw);pins.push({path:data.path,sha256:data.sha256});
 };
 const group=async(directory:string,accept:(name:string)=>boolean)=>{
  const entries=await readdir(join(root,directory),{withFileTypes:true}),names=entries.map(e=>e.name).sort();inventory.push({directory,names});
  const selected:string[]=[];for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name)))if(accept(entry.name)){
   if(!entry.isFile()||entry.isSymbolicLink())throw Error('C# toolchain contains an unexpected entry');selected.push(directory+'/'+entry.name);
  }
  // Pinning every runtime/reference file is required before execution. Bound
  // filesystem work and drain in-flight reads even on cancellation/failure.
  for(let at=0;at<selected.length;at+=16){const replies=await Promise.allSettled(selected.slice(at,at+16).map(add));const failure=replies.find(r=>r.status==='rejected');if(failure?.status==='rejected')throw failure.reason;}
  return selected;
 };
 await add('dotnet.exe');
 const hostVersions=(await readdir(join(root,'host/fxr'))).sort();
 if(hostVersions.length!==1||hostVersions[0]!==CSHARP_RUNTIME)throw Error('C# toolchain requires its isolated pinned hostfxr');inventory.push({directory:'host/fxr',names:hostVersions});
 await group('host/fxr/'+CSHARP_RUNTIME,()=>true);
 await group('shared/Microsoft.NETCore.App/'+CSHARP_RUNTIME,()=>true);
 const framework=await group('packs/Microsoft.NETCore.App.Ref/'+CSHARP_RUNTIME+'/ref/net10.0',n=>n.endsWith('.dll'));
 const libraries=await group('sdk/'+CSHARP_SDK+'/DotnetTools/dotnet-format',n=>n.endsWith('.dll'));
 const compiler=await group('sdk/'+CSHARP_SDK+'/Roslyn/bincore',n=>n.endsWith('.dll')||n.endsWith('.json'));
 for(const expected of ['Microsoft.CodeAnalysis.dll','Microsoft.CodeAnalysis.CSharp.dll','Microsoft.CodeAnalysis.Workspaces.dll','Microsoft.CodeAnalysis.CSharp.Workspaces.dll'])if(!libraries.some(p=>p.endsWith('/'+expected)))throw Error('Pinned Roslyn Workspaces is missing '+expected);
 if(framework.length===0||!compiler.some(p=>p.endsWith('/csc.dll')))throw Error('Incomplete C# compiler/reference pack');
 pins.sort((a,b)=>a.path.localeCompare(b.path));
 return {root,dotnet:join(root,'dotnet.exe'),files,pins,framework,libraries,compiler,inventory,fingerprint:csharpHash(JSON.stringify(pins)+JSON.stringify(inventory))};
}
export async function verifyCSharpToolchain(toolchain:CSharpToolchain,signal?:AbortSignal){
 const fresh=await loadCSharpToolchain(signal);if(fresh.fingerprint!==toolchain.fingerprint||fresh.root!==toolchain.root)throw Error('C# toolchain inputs changed during analysis');
}
