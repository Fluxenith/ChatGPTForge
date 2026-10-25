# Builds Forge's optional single-HWND Windows.Graphics.Capture helper.
# This does not download tools or make WGC a requirement on other platforms.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows Graphics Capture requires Windows' }

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'native\forge-window-capture.cpp'
$destination = Join-Path $root 'bin\forge-window-capture.exe'
$programFiles86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$vswhere = Join-Path $programFiles86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio C++ Build Tools were not found' }

$vsInstall = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $vsInstall) { throw 'MSVC C++ x64 tools are not installed' }
$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC x64 environment script not found' }

$sdkRoot = Join-Path $programFiles86 'Windows Kits\10\Include'
$sdkVersion = Get-ChildItem -LiteralPath $sdkRoot -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'cppwinrt\winrt\Windows.Graphics.Capture.h') } |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdkVersion) { throw 'Windows SDK C++/WinRT headers are not installed' }
$cppwinrt = Join-Path $sdkVersion.FullName 'cppwinrt'

$buildDir = Join-Path $env:TEMP ('forge-wgc-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDir | Out-Null
try {
  $output = Join-Path $buildDir 'forge-window-capture.exe'
  $obj = Join-Path $buildDir 'forge-window-capture.obj'
  $command = 'call "' + $vcvars + '" >nul && cl.exe /nologo /std:c++17 /EHsc /O2 /MT /DUNICODE /D_UNICODE /I"' +
    $cppwinrt + '" /Fo:"' + $obj + '" /Fe:"' + $output + '" "' + $source +
    '" /link d3d11.lib windowsapp.lib windowscodecs.lib ole32.lib user32.lib'
  # vcvars expands PATH through cmd.exe, whose line limit is much smaller than
  # PowerShell's. Do not inherit the host's potentially very long tool PATH.
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $env:ComSpec
  $start.Arguments = '/d /s /c "' + $command + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem"
  $compiler = [System.Diagnostics.Process]::Start($start)
  $compiler.WaitForExit()
  if ($compiler.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    throw 'Native Windows Graphics Capture compilation failed'
  }
  # The existing output is replaced only after successful compilation.
  Move-Item -LiteralPath $output -Destination $destination -Force
  $file = Get-Item -LiteralPath $destination
  Write-Output ('Built ' + $file.FullName + ' (' + $file.Length + ' bytes)')
} finally {
  # Only this script-created, GUID-named temporary build directory is deleted.
  $resolvedBuildDir = [IO.Path]::GetFullPath($buildDir)
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $resolvedBuildDir.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedBuildDir) -notmatch '^forge-wgc-build-[0-9a-f]{32}$') {
    throw 'Refusing to clean an unexpected native build directory'
  }
  if (Test-Path -LiteralPath $resolvedBuildDir) {
    Remove-Item -LiteralPath $resolvedBuildDir -Recurse -Force
  }
}
