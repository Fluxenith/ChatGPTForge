import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {auth,type OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthClientInformationMixed,OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface GatewayOAuthConfig {port:number;origins:string[]}
type Saved={endpoint:string;client?:OAuthClientInformationMixed;tokens?:OAuthTokens;verifier?:string};
export class GatewayOAuth implements OAuthClientProvider {
  private saved:Saved;
  private path:string;
  private nonce=randomBytes(32).toString('hex');
  constructor(readonly id:string,readonly endpoint:string,readonly config:GatewayOAuthConfig,private redirect?:(url:URL)=>void,root=join(homedir(),'.chatgptforge','gateway-oauth')){
    if(!/^[a-z][a-z0-9-]{0,47}$/.test(id))throw Error('Invalid gateway id');
    mkdirSync(root,{recursive:true});this.path=join(root,id+'.json');
    this.saved=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{endpoint};
    if(this.saved.endpoint!==endpoint)throw Error('OAuth endpoint changed; use a separate gateway identity');
  }
  get redirectUrl(){return `http://127.0.0.1:${this.config.port}/callback`;}
  get clientMetadata(){return {client_name:'ChatGPTForge gateway',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};}
  state(){return this.nonce;}
  clientInformation(){return this.saved.client;}
  tokens(){return this.saved.tokens;}
  saveClientInformation(client:OAuthClientInformationMixed){this.saved.client=client;this.save();}
  saveTokens(tokens:OAuthTokens){this.saved.tokens=tokens;delete this.saved.verifier;this.save();}
  saveCodeVerifier(verifier:string){this.saved.verifier=verifier;this.save();}
  codeVerifier(){if(!this.saved.verifier)throw Error('OAuth verifier missing; restart login');return this.saved.verifier;}
  redirectToAuthorization(url:URL){this.check(url);if(!this.redirect)throw Error(`Gateway ${this.id} needs local login: gateway login ${this.id}`);this.redirect(url);}
  invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'){
    if(scope==='all')this.saved={endpoint:this.endpoint};
    else if(scope==='client')delete this.saved.client;
    else if(scope==='tokens')delete this.saved.tokens;
    else if(scope==='verifier')delete this.saved.verifier;
    this.save();
  }
  private save(){const temp=this.path+'.'+randomBytes(8).toString('hex')+'.tmp';writeFileSync(temp,JSON.stringify(this.saved),{mode:0o600,flag:'wx'});renameSync(temp,this.path);}
  private check(url:URL){if(url.protocol!=='https:'||url.username||url.password||![new URL(this.endpoint).origin,...this.config.origins].includes(url.origin))throw Error('OAuth destination is outside configured HTTPS origins');}
  fetch:typeof fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);this.check(url);return fetch(input,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000)});};
}

export async function loginGateway(id:string,endpoint:string,config:GatewayOAuthConfig,show:(url:string)=>void){
  const provider=new GatewayOAuth(id,endpoint,config,url=>show(url.href));
  let finish!:(code:string)=>void,reject!:(error:Error)=>void,accepted=false;
  const code=new Promise<string>((yes,no)=>{finish=yes;reject=no;});
  // Attach immediately: server errors can precede the first await on code.
  void code.catch(()=>{});
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');
    if(req.headers.host!==`127.0.0.1:${config.port}`||req.method!=='GET'){res.writeHead(400).end('Invalid callback');return;}
    const url=new URL(req.url??'/','http://127.0.0.1');
    if(url.pathname!=='/callback'||url.searchParams.get('state')!==provider.state()||accepted){res.writeHead(400).end('Invalid or expired login state');return;}
    if(url.searchParams.has('error')){accepted=true;res.writeHead(400).end('Authorization declined');reject(Error('OAuth authorization declined'));return;}
    const value=url.searchParams.get('code');if(!value||value.length>8192){res.writeHead(400).end('Missing code');return;}
    accepted=true;res.end('Authorization received. Return to Forge for the final result.');finish(value);
  });
  const timer=setTimeout(()=>reject(Error('OAuth login expired after five minutes')),300_000);
  try{
    await new Promise<void>((resolve,rejectListen)=>{server.once('error',rejectListen);server.listen(config.port,'127.0.0.1',resolve);});
    const result=await auth(provider,{serverUrl:endpoint,fetchFn:provider.fetch});
    if(result==='REDIRECT')await auth(provider,{serverUrl:endpoint,authorizationCode:await code,fetchFn:provider.fetch});
    return {authenticated:!!provider.tokens(),server:id};
  }finally{clearTimeout(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
