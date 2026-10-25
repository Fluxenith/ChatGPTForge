$ErrorActionPreference = 'Stop'
$forgeState = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$tunnelState = Join-Path $forgeState 'tunnel'
$connection = Get-Content -LiteralPath (Join-Path $tunnelState 'connection.json') -Raw | ConvertFrom-Json
if ($connection.alias -ne 'chatgptforge') { throw 'Refusing to manage an unrelated tunnel.' }
$clientPath = (Resolve-Path -LiteralPath $connection.clientPath).Path
$profilePath = (Resolve-Path -LiteralPath (Join-Path $connection.profileDir 'chatgptforge.yaml')).Path
$receiptPath = Join-Path $tunnelState 'process.json'
$healthFile = Join-Path $tunnelState 'health.url'
$running = $null
if (Test-Path -LiteralPath $receiptPath) {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $candidate = Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.StartTime.ToFileTimeUtc().ToString() -eq $receipt.startFileTime -and $candidate.Path -eq $clientPath) { $running = $candidate }
}
if (-not $running) {
    if (Test-Path -LiteralPath $healthFile) { Remove-Item -LiteralPath $healthFile }
    $running = Start-Process -FilePath $clientPath -ArgumentList @('run','--config',('"{0}"' -f $profilePath)) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $tunnelState 'stdout.log') -RedirectStandardError (Join-Path $tunnelState 'stderr.log')
    if ($running.WaitForExit(1000)) { throw "Tunnel failed to start; inspect $tunnelState/stderr.log" }
    @{pid=$running.Id; startFileTime=$running.StartTime.ToFileTimeUtc().ToString(); executable=$clientPath} | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
}
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    if ($running.HasExited) { throw 'Tunnel process exited during startup.' }
    if (Test-Path -LiteralPath $healthFile) {
        $healthBase = (Get-Content -LiteralPath $healthFile -Raw).Trim().TrimEnd('/')
        $healthUri = [Uri]$healthBase
        if ($healthUri.Scheme -ne 'http' -or $healthUri.Host -ne '127.0.0.1') { throw 'Unexpected tunnel health address.' }
        try {
            $ready = Invoke-WebRequest -Uri "$healthBase/readyz" -UseBasicParsing -TimeoutSec 2
            if ($ready.StatusCode -eq 200) {
                Write-Output "OpenAI Tunnel ready (PID $($running.Id)). Status: $healthBase/ui"
                return
            }
        } catch { }
    }
    Start-Sleep -Milliseconds 500
}
throw "Tunnel process is running but not ready; inspect $tunnelState/runtime.log"
