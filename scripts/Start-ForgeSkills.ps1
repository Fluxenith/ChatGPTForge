param([string]$ProfilePath)
$ErrorActionPreference = 'Stop'
$forgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$forgeSkillsDirectory = Join-Path $env:USERPROFILE '.chatgptforge/skills-manager'
if (-not $ProfilePath) { $ProfilePath = Join-Path $forgeSkillsDirectory 'profile.json' }
$ProfilePath = (Resolve-Path -LiteralPath $ProfilePath).Path
$forgeSkillsDirectory = Split-Path -Parent $ProfilePath
$forgeSkillsProfile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
$forgeSkillsPython = (Resolve-Path -LiteralPath $forgeSkillsProfile.python_path).Path
$forgeSkillsLauncher = Join-Path $PSScriptRoot 'forge-skills-service.py'
foreach ($forgeSkillsMode in @('headless','manager')) {
    $forgeSkillsPort = if ($forgeSkillsMode -eq 'headless') { 8943 } else { 8955 }
    $forgeSkillsReceipt = Join-Path $forgeSkillsDirectory ($forgeSkillsMode + '-process.json')
    $forgeSkillsProcess = $null
    if (Test-Path -LiteralPath $forgeSkillsReceipt) {
        $forgeSkillsIdentity = Get-Content -LiteralPath $forgeSkillsReceipt -Raw | ConvertFrom-Json
        $forgeSkillsCandidate = Get-Process -Id $forgeSkillsIdentity.pid -ErrorAction SilentlyContinue
        if ($forgeSkillsCandidate -and $forgeSkillsCandidate.StartTime.ToFileTimeUtc().ToString() -eq $forgeSkillsIdentity.startFileTime -and $forgeSkillsCandidate.Path -eq $forgeSkillsIdentity.executable) { $forgeSkillsProcess = $forgeSkillsCandidate }
    }
    $forgeSkillsListener = Get-NetTCPConnection -State Listen -LocalPort $forgeSkillsPort -ErrorAction SilentlyContinue
    if ($forgeSkillsListener -and (-not $forgeSkillsProcess -or ($forgeSkillsListener | Where-Object { $_.OwningProcess -ne $forgeSkillsProcess.Id -or $_.LocalAddress -ne '127.0.0.1' }))) {
        throw "Port $forgeSkillsPort belongs to another service; no process was replaced."
    }
    if (-not $forgeSkillsProcess) {
        $forgeSkillsArguments = @($forgeSkillsLauncher,$forgeSkillsMode,'--profile',$ProfilePath) | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
        $forgeSkillsProcess = Start-Process -FilePath $forgeSkillsPython -ArgumentList $forgeSkillsArguments -WorkingDirectory $forgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $forgeSkillsDirectory ($forgeSkillsMode + '-stdout.log')) -RedirectStandardError (Join-Path $forgeSkillsDirectory ($forgeSkillsMode + '-stderr.log'))
        @{pid=$forgeSkillsProcess.Id;startFileTime=$forgeSkillsProcess.StartTime.ToFileTimeUtc().ToString();executable=$forgeSkillsPython;profile=$ProfilePath} | ConvertTo-Json | Set-Content -LiteralPath $forgeSkillsReceipt -Encoding utf8
    }
    $forgeSkillsReady = $false
    for ($forgeSkillsAttempt=0; $forgeSkillsAttempt -lt 40; $forgeSkillsAttempt++) {
        if ($forgeSkillsProcess.HasExited) { throw "Skills $forgeSkillsMode exited; inspect its stderr log." }
        try {
            $forgeSkillsHealthPath = if ($forgeSkillsMode -eq 'headless') { '/healthz' } else { '/api/health' }
            $forgeSkillsHealth = Invoke-RestMethod -Uri ("http://127.0.0.1:$forgeSkillsPort" + $forgeSkillsHealthPath) -TimeoutSec 2
            $forgeSkillsIndex = if ($forgeSkillsMode -eq 'headless') { $forgeSkillsHealth.index_path } else { $forgeSkillsHealth.registry.index_path }
            if ([IO.Path]::GetFullPath($forgeSkillsIndex) -ne [IO.Path]::GetFullPath((Join-Path $forgeSkillsProfile.state_dir 'index.json'))) { throw 'Skills registry identity mismatch' }
            if (-not $forgeSkillsHealth.ok) { throw 'Skills health not ready' }
            if ($forgeSkillsMode -eq 'manager' -and (-not $forgeSkillsHealth.mutations_allowed -or -not $forgeSkillsHealth.parity.ok)) { throw 'Skills UI and registry are inconsistent' }
            $forgeSkillsReady = $true
            break
        } catch { $forgeSkillsLastError = $_.Exception.Message; Start-Sleep -Milliseconds 250 }
    }
    if (-not $forgeSkillsReady) { throw "Skills $forgeSkillsMode readiness failed: $forgeSkillsLastError" }
    Write-Output "Skills $forgeSkillsMode ready on loopback port $forgeSkillsPort (PID $($forgeSkillsProcess.Id))."
}
