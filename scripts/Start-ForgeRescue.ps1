# Starts the Forge rescue supervisor (forge-cli rescue run) once. A responsive
# supervisor is reused. It recovers Forge, the Forge Tunnel and the configured
# Skills service only through the existing start scripts.
$ErrorActionPreference = 'Stop'
$forgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$state = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8770/status' -TimeoutSec 5
    Write-Output "Forge rescue supervisor already running (PID $($status.pid))."
    exit 0
} catch {}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$dir = Join-Path $state 'rescue'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$process = Start-Process -FilePath $node -ArgumentList @((Join-Path $forgeRoot 'runtime/dist/forge-cli.js'), 'rescue', 'run') -WorkingDirectory $forgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dir 'stdout.log') -RedirectStandardError (Join-Path $dir 'stderr.log')
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8770/status' -TimeoutSec 3; Write-Output "Forge rescue supervisor ready (PID $($status.pid))."; exit 0 } catch {}
    if ($process.HasExited) { throw "Rescue supervisor exited; inspect $dir/stderr.log" }
}
throw "Rescue supervisor did not become ready; inspect $dir/stderr.log"
