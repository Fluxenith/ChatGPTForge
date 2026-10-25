param([ValidateRange(1, 30)][int]$RecoveryMinutes = 5)
$ErrorActionPreference = 'Stop'

$state = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
if (-not (Test-Path -LiteralPath $state -PathType Container)) {
    $null = New-Item -Path $state -ItemType Directory -Force
}
$log = Join-Path $state 'autostart.log'
$shell = (Get-Process -Id $PID).Path
$launcher = Join-Path $PSScriptRoot 'Start-ForgeAll.ps1'
$deadline = [DateTime]::UtcNow.AddMinutes($RecoveryMinutes)
$attempt = 0

function Write-StartupLog([string]$message) {
    Add-Content -LiteralPath $log -Encoding utf8 -Value ((Get-Date).ToString('o') + ' ' + $message)
}

# Sign-in can precede local networking and Tailscale/Funnel readiness. Existing
# launchers validate PID ownership and avoid creating duplicate Forge processes.
do {
    $attempt++
    try {
        & $shell -NoProfile -NonInteractive -File $launcher *> $null
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            Write-StartupLog "ready attempt=$attempt"
            exit 0
        }
        Write-StartupLog "not-ready attempt=$attempt exit=$code"
    } catch {
        Write-StartupLog "not-ready attempt=$attempt error=$($_.Exception.GetType().Name)"
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 10
} while ([DateTime]::UtcNow -lt $deadline)

Write-StartupLog "failed after $attempt attempts; run Start-ChatGPTForge.cmd to inspect readiness"
exit 1
