$ErrorActionPreference = 'Stop'
$forgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$forgeRuntime = Join-Path $forgeRoot 'runtime'
$forgeState = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$forgeConfig = Join-Path $forgeState 'config.jsonc'
if (-not (Test-Path -LiteralPath $forgeConfig)) { throw 'Run the ChatGPTForge init command first.' }
if (-not (Test-Path -LiteralPath (Join-Path $forgeRuntime 'dist/forge-cli.js'))) { throw 'Build runtime first: npm --prefix runtime run build' }
$receiptPath = Join-Path $forgeState 'process.json'
# One start at a time per machine: the rescue supervisor and a manual deploy can
# call this script together. The second caller waits, then finds Forge running.
$forgeStartLock = New-Object System.Threading.Mutex($false, 'Global\ChatGPTForgeStart')
try { $forgeLocked = $forgeStartLock.WaitOne(180000) } catch [System.Threading.AbandonedMutexException] { $forgeLocked = $true }
if (-not $forgeLocked) { throw 'Another ChatGPTForge start is still running; try again shortly.' }
try {
if (Test-Path -LiteralPath $receiptPath) {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $running = Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime.ToFileTimeUtc().ToString() -eq $receipt.startFileTime -and $running.Path -eq $receipt.executable) {
        $null = & (Join-Path $PSScriptRoot 'Test-ForgeLocal.ps1') -StateDirectory $forgeState
        Write-Output "ChatGPTForge is already running and local MCP/manager are ready (PID $($running.Id))."
        return
    }
}
$forgeNode = (Get-Command node.exe).Source
$forgeBootstrap = Join-Path $PSScriptRoot 'forge-start-daemon.mjs'
$forgeManagerPort = if ($env:CHATGPTFORGE_MANAGER_PORT) { $env:CHATGPTFORGE_MANAGER_PORT } else { '8768' }
# Quote native executable arguments; no command shell interprets these paths.
$forgeNativeArgs = @($forgeBootstrap, $forgeState, $forgeManagerPort) | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
$forgeStartInfo = New-Object System.Diagnostics.ProcessStartInfo
$forgeStartInfo.FileName = $forgeNode
$forgeStartInfo.Arguments = $forgeNativeArgs -join ' '
$forgeStartInfo.WorkingDirectory = $forgeRuntime
$forgeStartInfo.UseShellExecute = $true
$forgeStartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$forgeChild = [System.Diagnostics.Process]::Start($forgeStartInfo)
if ($forgeChild.WaitForExit(5000)) { throw "ChatGPTForge failed to start; inspect $forgeState/stderr.log" }
@{ pid = $forgeChild.Id; startFileTime = $forgeChild.StartTime.ToFileTimeUtc().ToString(); executable = $forgeNode; root = $forgeRuntime } | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
Write-Output "ChatGPTForge process started (PID $($forgeChild.Id)); checking local MCP and manager readiness."
# Native Windows readiness probes can be slow while language-server tests
# saturate the host. The child may finish manager registration after the
# first MCP listener becomes available; keep verifying the exact PID/receipt.
$forgeReadinessDeadline = [DateTime]::UtcNow.AddSeconds(120)
while ([DateTime]::UtcNow -lt $forgeReadinessDeadline) {
    try {
        $null = & (Join-Path $PSScriptRoot 'Test-ForgeLocal.ps1') -StateDirectory $forgeState
        Write-Output 'Local MCP and authenticated manager are ready.'
        return
    } catch {
        $forgeReadinessError = $_.Exception.Message
        if ($forgeChild.HasExited) { throw "Forge exited during readiness checks; inspect $forgeState/stderr.log" }
        Start-Sleep -Milliseconds 300
    }
}
throw "Forge process exists but local readiness failed: $forgeReadinessError"
} finally {
    if ($forgeLocked) { $forgeStartLock.ReleaseMutex() }
    $forgeStartLock.Dispose()
}
