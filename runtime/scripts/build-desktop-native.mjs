// Optional ahead-of-time compilation of the bundled Windows helper classes.
// Runtime retains its source compilation fallback when these DLLs are absent.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,renameSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {desktopIdentityNative,desktopNative} from '../dist/desktop-native.js';
import {desktopCaptureNative} from '../dist/desktop-capture.js';
import {desktopWindowPointerNative} from '../dist/desktop-window-pointer.js';
import {desktopSurfaceNative} from '../dist/desktop-surface-native.js';
if(process.platform!=='win32')throw Error('Desktop native helpers require Windows');
const stage=mkdtempSync(join(tmpdir(),'forge-desktop-build-'));
const bin=fileURLToPath(new URL('../bin/',import.meta.url));
const units=[
  {name:'identity',source:desktopIdentityNative},
  {name:'capture',source:desktopCaptureNative,drawing:true},
  {name:'pointer',source:desktopWindowPointerNative},
  {name:'uia',source:desktopNative},
  {name:'surface',source:desktopSurfaceNative},
];
try {
  const script=String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
foreach($unit in $request.units){
 $file=Join-Path $request.stage ('forge-desktop-'+$unit.name+'.dll')
 if($unit.drawing){Add-Type -TypeDefinition $unit.source -ReferencedAssemblies System.Drawing -OutputAssembly $file}
 else{Add-Type -TypeDefinition $unit.source -OutputAssembly $file}
}`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:JSON.stringify({stage,units}),encoding:'utf8',windowsHide:true,timeout:60000});
  if(result.status!==0)throw Error(result.stderr||String(result.error||'Native helper compilation failed'));
  const manifest={};
  for(const unit of units){const name='forge-desktop-'+unit.name+'.dll';manifest[unit.name]={source_sha256:createHash('sha256').update(unit.source).digest('hex'),binary_sha256:createHash('sha256').update(readFileSync(join(stage,name))).digest('hex')};renameSync(join(stage,name),join(bin,name));}
  writeFileSync(join(bin,'forge-desktop-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log('Built '+units.length+' optional desktop assemblies');
} finally {
  if(!resolve(stage).startsWith(resolve(tmpdir())+sep))throw Error('Unexpected desktop build directory');
  rmSync(stage,{recursive:true,force:true,maxRetries:5});
}
