import {desktopNative,desktopIdentityNative} from './desktop-native.js';
import {desktopCaptureNative} from './desktop-capture.js';
import {desktopWindowPointerNative} from './desktop-window-pointer.js';
import {desktopSurfaceNative} from './desktop-surface-native.js';
export const desktopNativeSources={identity:desktopIdentityNative,capture:desktopCaptureNative,pointer:desktopWindowPointerNative,uia:desktopNative,surface:desktopSurfaceNative};
// JSON travels through stdin. No user value is interpolated into executable code.
export const desktopScript=String.raw`
$ErrorActionPreference='Stop'
if([Console]::InputEncoding.CodePage -ne 65001){[Console]::InputEncoding=New-Object System.Text.UTF8Encoding}
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding
$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
[Environment]::SetEnvironmentVariable('FORGE_INPUT_GUARD',[string]$r.input_guard.name,'Process')
[Environment]::SetEnvironmentVariable('FORGE_INPUT_EPOCH',[string]$r.input_guard.epoch,'Process')
function loadNative($name,$source,$drawing=$false){
  $assembly=if($r.native_directory){Join-Path ([string]$r.native_directory) ('forge-desktop-'+$name+'.dll')}else{$null}
  if($assembly -and [IO.File]::Exists($assembly)){Add-Type -Path $assembly;return}
  if($drawing){Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing}
  else{Add-Type -TypeDefinition $source}
}
if($r.action -eq 'screen'){
  Add-Type -AssemblyName System.Drawing
  loadNative 'capture' @'
${desktopCaptureNative}
'@ $true
  [ForgeWindowCapture]::CaptureDesktop()|ConvertTo-Json -Compress
  exit
}
$deny='^(powershell|pwsh|cmd|WindowsTerminal|regedit|Taskmgr|consent|CredentialUIBroker|LogonUI|LockApp|SecurityHealthSystray|SecHealthUI|chrome|msedge|firefox|Codex|ChatGPT)$'
loadNative 'identity' @'
${desktopIdentityNative}
'@
[ForgeWindowIdentity]::ConfigureDpi()
if($r.action -notin @('list','inspect','observe','screenshot','screen')){[ForgeIdentityGuard]::Check()}
function windows {
  $processes=@{}
  @([ForgeWindowIdentity]::VisibleWindows() | Where-Object {-not $r.pid -or $_.pid -eq [int]$r.pid} | ForEach-Object {
    try {
      $key=[int]$_.pid
      if(-not $processes.ContainsKey($key)){
        $processes[$key]=$null
        $process=[Diagnostics.Process]::GetProcessById($key)
        try {if($process.ProcessName -notmatch $deny){$processes[$key]=@{name=$process.ProcessName;creation=$process.StartTime.ToFileTimeUtc().ToString()}}}finally{$process.Dispose()}
      }
      $info=$processes[$key]
      if($info -and [ForgeWindowIdentity]::OwnedTopLevel([IntPtr]::new([long]::Parse($_.hwnd)),$key)){
        @{pid=$key;creation=$info.creation;title=$_.title;app=$info.name;hwnd=$_.hwnd;window=[ForgeWindowIdentity]::State([IntPtr]::new([long]::Parse($_.hwnd)))}
      }
    }catch{}
  })
}
if($r.action -eq 'list'){ConvertTo-Json -InputObject @(windows) -Compress;exit}
if($r.action -in @('surface_catalog','surface_input')){
  loadNative 'surface' @'
${desktopSurfaceNative}
'@
  if($r.action -eq 'surface_catalog'){ConvertTo-Json -InputObject @([ForgeSurface]::Surfaces()) -Compress;exit}
  $g=$r.geometry
  function surfaceTarget($value){$t=New-Object 'ForgeSurface+Target';foreach($k in @('hwnd','creation','kind','pid','x','y','width','height')){$t.$k=$value.$k};return $t}
  [ForgeSurface]::Perform((surfaceTarget $r.source),(surfaceTarget $r.destination),[string]$r.operation,[int]$r.x,[int]$r.y,[int]$r.end_x,[int]$r.end_y,[int]$g.x,[int]$g.y,[int]$g.width,[int]$g.height,[int]$g.image_width,[int]$g.image_height)
  @{state='performed';verification='needs_observation'}|ConvertTo-Json -Compress;exit
}
$p=Get-Process -Id $r.pid
if($p.ProcessName -match $deny -or $p.StartTime.ToFileTimeUtc().ToString() -ne $r.creation){throw 'Window identity changed or unsupported app'}
$handle=$p.MainWindowHandle
if($r.hwnd){$handle=[IntPtr]::new([long]::Parse([string]$r.hwnd))}
if(-not [ForgeWindowIdentity]::OwnedTopLevel($handle,$p.Id)){throw 'Window handle changed after grant'}
if($r.action -eq 'focus'){
  [ForgeWindowIdentity]::Focus($handle)
  @{state='performed';pid=$p.Id;hwnd=$r.hwnd;window=[ForgeWindowIdentity]::State($handle)}|ConvertTo-Json -Depth 4 -Compress
  exit
}
if($r.action -in @('screenshot','observe')){
  Add-Type -AssemblyName System.Drawing
  loadNative 'capture' @'
${desktopCaptureNative}
'@ $true
  $capture=$null
  if($r.wgc_executable -and [IO.File]::Exists([string]$r.wgc_executable)){
    try {
      $visibleBounds=[ForgeWindowCapture]::VisibleBounds($handle)
      $nativePng=& ([string]$r.wgc_executable) ([string]$handle.ToInt64()) ([string]$p.Id) 2>$null
      if($LASTEXITCODE -ne 0 -or -not $nativePng){throw 'Windows Graphics Capture helper unavailable'}
      $capture=[ForgeWindowCapture]::FromWindowsCapture($handle,[Convert]::FromBase64String([string]$nativePng),$visibleBounds)
    }catch{$capture=$null}
  }
  if($null -eq $capture){$capture=[ForgeWindowCapture]::Capture($handle)}
  if($r.action -eq 'screenshot'){
    @{state='captured';pid=$p.Id;image=$capture.image;window_x=$capture.window_x;window_y=$capture.window_y;width=$capture.width;height=$capture.height;image_width=$capture.image_width;image_height=$capture.image_height;capture_method=$capture.capture_method}|ConvertTo-Json -Compress
    exit
  }
}
if($r.action -in @('click','double_click','drag') -and $r.coordinate_space -eq 'window'){
  if($r.input_mode -ne 'physical' -or -not $r.capture){throw 'Screenshot pointer requires a physical input mode and captured geometry'}
  loadNative 'pointer' @'
${desktopWindowPointerNative}
'@
  $endX=$r.x;$endY=$r.y
  if($r.action -eq 'drag'){$endX=$r.end_x;$endY=$r.end_y}
  [ForgeWindowPointer]::Perform($handle,[string]$r.action,[string]$r.button,[int]$r.x,[int]$r.y,[int]$endX,[int]$endY,[int]$r.capture.window_x,[int]$r.capture.window_y,[int]$r.capture.width,[int]$r.capture.height,[int]$r.capture.image_width,[int]$r.capture.image_height)
  @{state='performed';pid=$p.Id;verification='needs_observation';coordinate_space='window'}|ConvertTo-Json -Compress
  exit
}
if($r.action -eq 'window'){
  if($r.window_state){[ForgeWindowIdentity]::Show($handle,[string]$r.window_state)}
  else{[ForgeWindowIdentity]::Move($handle,[int]$r.x,[int]$r.y,[int]$r.width,[int]$r.height)}
  Start-Sleep -Milliseconds 150
  $state=[ForgeWindowIdentity]::State($handle)
  if(($r.window_state -eq 'maximize' -and (-not $state.maximized -or $state.minimized)) -or ($r.window_state -eq 'minimize' -and -not $state.minimized) -or ($r.window_state -eq 'restore' -and ($state.minimized -or $state.maximized))){throw 'Window did not reach requested state; inspect before proceeding'}
  @{state='performed';pid=$p.Id;window=$state}|ConvertTo-Json -Depth 4 -Compress
  exit
}
try {
loadNative 'uia' @'
${desktopNative}
'@
$window=New-Object ForgeUIA.Window($handle)
$root=$window.Root
if(-not $root -or -not $root.Enabled){throw 'Window unavailable'}
} catch {
  if($r.action -ne 'observe'){throw}
  @{state='captured';pid=$p.Id;image=$capture.image;window_x=$capture.window_x;window_y=$capture.window_y;width=$capture.width;height=$capture.height;image_width=$capture.image_width;image_height=$capture.image_height;capture_method=$capture.capture_method;controls=@();accessibility_available=$false}|ConvertTo-Json -Depth 5 -Compress
  exit
}
$types='Button,Calendar,CheckBox,ComboBox,Edit,Hyperlink,Image,ListItem,List,Menu,MenuBar,MenuItem,ProgressBar,RadioButton,ScrollBar,Slider,Spinner,StatusBar,Tab,TabItem,Text,ToolBar,ToolTip,Tree,TreeItem,Custom,Group,Thumb,DataGrid,DataItem,Document,SplitButton,Window,Pane,Header,HeaderItem,Table,TitleBar,Separator,SemanticZoom,AppBar'.Split(',')
function describe($e,$index){
  $typeIndex=$e.ControlType-50000
  $type=if($typeIndex -ge 0 -and $typeIndex -lt $types.Length){'ControlType.'+$types[$typeIndex]}else{'ControlType.Unknown'}
  $info=@{index=$index;name=$e.Name;automation_id=$e.AutomationId;type=$type;runtime_id=$e.RuntimeId;enabled=$e.Enabled;password=$e.Password}
  if($type -eq 'ControlType.CheckBox'){$info.checked=$e.Checked}
  $bounds=$e.PointerBounds
  if($null -ne $bounds){$info.pointer_bounds=@($bounds)}
  $selected=$e.Selected
  if($null -ne $selected){$info.selected=$selected}
  $scroll=$e.ScrollPosition
  if($null -ne $scroll){$info.scroll=$scroll}
  $info
}
if($r.action -in @('inspect','observe')){
  $items=@();$available=$true;$title=''
  try{
    $title=$root.Name
    for($i=0;$i -lt [Math]::Min($window.Count,200);$i++){$items+=describe $window.Get($i) $i}
  }catch{
    if($r.action -eq 'inspect'){throw}
    $items=@();$available=$false
  }
  $result=@{title=$title;pid=$p.Id;creation=$r.creation;window=[ForgeWindowIdentity]::State($handle);controls=$items}
  if($r.action -eq 'observe'){
    $result.state='captured';$result.image=$capture.image
    $result.width=$capture.width;$result.height=$capture.height
    $result.window_x=$capture.window_x;$result.window_y=$capture.window_y
    $result.image_width=$capture.image_width;$result.image_height=$capture.image_height
    $result.capture_method=$capture.capture_method
    $result.accessibility_available=$available
  }
  $result|ConvertTo-Json -Depth 5 -Compress;exit
}
if($r.action -notin @('invoke','fill','check','select','scroll','press','click','double_click','drag','hotkey','type_text')){throw 'Unsupported desktop action'}
if($r.element.index -lt 0 -or $r.element.index -ge $window.Count){throw 'Stale element'}
$e=$window.Get($r.element.index);$now=describe $e $r.element.index
if($now.runtime_id -ne $r.element.runtime_id -or $now.name -ne $r.element.name -or $now.type -ne $r.element.type -or -not $now.enabled -or $now.password){throw 'Element changed, disabled, or password field'}
$keys=@{Tab=0x09;Enter=0x0D;Escape=0x1B;Space=0x20;PageUp=0x21;PageDown=0x22;End=0x23;Home=0x24;ArrowLeft=0x25;ArrowUp=0x26;ArrowRight=0x27;ArrowDown=0x28;Backspace=0x08;Delete=0x2E}
if($r.action -eq 'type_text'){
  $e.TypeText([string]$r.text,$handle)
}elseif($r.action -eq 'hotkey'){
  $e.Hotkey([int[]]$r.keys,$handle)
}elseif($r.action -in @('click','double_click','drag')){
  if($now.pointer_bounds.Count -ne 2 -or $now.pointer_bounds[0] -ne $r.element.pointer_bounds[0] -or $now.pointer_bounds[1] -ne $r.element.pointer_bounds[1]){throw 'Control client bounds changed; inspect again'}
  $endX=$r.x;$endY=$r.y
  if($r.action -eq 'drag'){$endX=$r.end_x;$endY=$r.end_y}
  $button='left';if($r.button){$button=[string]$r.button}
  $e.Pointer([string]$r.action,[int]$r.x,[int]$r.y,[int]$endX,[int]$endY,$button,$handle,($r.input_mode -eq 'physical'))
}elseif($r.action -eq 'press'){
  if(-not $keys.ContainsKey([string]$r.key)){throw 'Unsupported key'}
  $e.Key([int]$keys[[string]$r.key],$handle)
}elseif($r.action -eq 'select'){
  if($null -eq $now.selected){throw 'Control does not support selection'}
  $e.Select()
}elseif($r.action -eq 'scroll'){
  $horizontal=-1.0;$vertical=-1.0
  if($null -ne $r.horizontal_percent){$horizontal=[double]$r.horizontal_percent}
  if($null -ne $r.vertical_percent){$vertical=[double]$r.vertical_percent}
  $e.ScrollTo($horizontal,$vertical)
}elseif($r.action -eq 'check'){
  if($now.type -ne 'ControlType.CheckBox' -or $r.checked -isnot [bool]){throw 'Only accessible checkboxes accept an explicit boolean state'}
  $e.Check([bool]$r.checked)
}elseif($r.action -eq 'invoke'){
  if($now.type -ne 'ControlType.Button'){throw 'Only accessible buttons can be invoked'}
  $e.Invoke()
}else{
  if($now.type -ne 'ControlType.Edit'){throw 'Only accessible text fields can be filled'}
  $e.Fill([string]$r.text)
}
$result=@{state='performed';pid=$p.Id}
if($r.action -eq 'select'){$result.selected=$e.Selected}
if($r.action -eq 'scroll'){$result.scroll=$e.ScrollPosition}
if($r.action -in @('fill','check','select')){$result.verification='target_state_verified'}
elseif($r.action -eq 'scroll'){$result.verification='scroll_position_observed'}
else{$result.verification='needs_observation'}
$result|ConvertTo-Json -Depth 5 -Compress
`;
