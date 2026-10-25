import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {deploymentPlan,exportDeployment,exportOperationGuide} from './forge-deployment.js';
test('portable release retains lock/integrity and excludes local state; never overwrites or nests',t=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-release-')),source=join(dir,'runtime'),target=join(dir,'release');
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:10}));mkdirSync(source);
 const put=(name:string,text='fixture')=>{mkdirSync(dirname(join(source,name)),{recursive:true});writeFileSync(join(source,name),text);};
 put('package.json',JSON.stringify({version:'1',engines:{node:'>=22.19 <27'}}));
 for(const file of ['package-lock.json','LICENSE','UPSTREAM.md','README.md','dist/forge-cli.js','bin/chatgptforge.js','scripts/fix-node-pty-permissions.mjs','scripts/deployment-setup.mjs','node_modules/private.txt','.env','scripts/__pycache__/private.pyc'])put(file);
 const result=exportDeployment(target,source);const manifest=JSON.parse(readFileSync(join(target,'manifest.json'),'utf8'));
 assert.equal(manifest.files.length,result.files);assert.ok(manifest.files.some((f:any)=>f.path==='runtime/package-lock.json'));
 assert.ok(!manifest.files.some((f:any)=>/private|\.env/.test(f.path)));
 for(const f of manifest.files)assert.equal(createHash('sha256').update(readFileSync(join(target,f.path))).digest('hex'),f.sha256);
 assert.throws(()=>exportDeployment(target,source),/exists/);
 assert.throws(()=>exportDeployment(join(source,'..nested'),source),/outside/);
 assert.throws(()=>exportOperationGuide(join(source,'guide'),source),/outside/);
});
test('mixed deployment profile validates pins/ownership and never installs optional services',()=>{
 const plan=deploymentPlan({version:1,components:[{id:'playwright',version:'0.0.80'}],gateways:[{id:'external',transport:'http',ownership:'external',required:false}]});
 assert.match(plan.steps.at(-1)!.gate,/optional/);
 assert.match((plan.steps.at(-1) as any).lifecycle,/Do not stop/);
 assert.throws(()=>deploymentPlan({version:1,components:[{id:'playwright',version:'latest'}]}),/Unreviewed/);
 assert.throws(()=>deploymentPlan({version:1,token:'secret'}));
 assert.throws(()=>deploymentPlan({version:1,gateways:[{id:'x',transport:'http',ownership:'external'},{id:'x',transport:'http',ownership:'external'}]}),/Duplicate/);
});
