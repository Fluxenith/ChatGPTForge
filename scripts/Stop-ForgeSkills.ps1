param([ValidateSet('headless','manager','all')][string]$Mode='all',[string]$ProfilePath)
$ErrorActionPreference = 'Stop'
$forgeSkillsDirectory = Join-Path $env:USERPROFILE '.chatgptforge/skills-manager'
if ($ProfilePath) { $forgeSkillsDirectory = Split-Path -Parent (Resolve-Path -LiteralPath $ProfilePath).Path }
$forgeSkillsModes = if ($Mode -eq 'all') { @('manager','headless') } else { @($Mode) }
foreach ($forgeSkillsMode in $forgeSkillsModes) {
    $forgeSkillsReceipt = Join-Path $forgeSkillsDirectory ($forgeSkillsMode + '-process.json')
    if (-not (Test-Path -LiteralPath $forgeSkillsReceipt)) { continue }
    $forgeSkillsIdentity = Get-Content -LiteralPath $forgeSkillsReceipt -Raw | ConvertFrom-Json
    $forgeSkillsProcess = Get-Process -Id $forgeSkillsIdentity.pid -ErrorAction SilentlyContinue
    if (-not $forgeSkillsProcess) { continue }
    if ($forgeSkillsProcess.StartTime.ToFileTimeUtc().ToString() -ne $forgeSkillsIdentity.startFileTime -or $forgeSkillsProcess.Path -ne $forgeSkillsIdentity.executable) {
        throw 'Skills process identity changed; refusing to stop another process.'
    }
    Stop-Process -Id $forgeSkillsProcess.Id
    Write-Output "Stopped owned Skills $forgeSkillsMode (PID $($forgeSkillsProcess.Id)); persistent state retained."
}
