param([switch]$OpenManager)
$ErrorActionPreference = 'Stop'
$forgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$forgeNode = (Get-Command node.exe -ErrorAction Stop).Source

$forgeStateDirectory = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$forgeLocalConfig = (& $forgeNode (Join-Path $PSScriptRoot 'forge-local-config.mjs') $forgeStateDirectory) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read Forge startup configuration.' }
if ($forgeLocalConfig.skillsManagerEndpoint -eq 'http://127.0.0.1:8943/mcp') {
    # This script returns normally and propagates terminating errors. Calling it
    # in-process avoids waiting for inherited native output handles held by the
    # long-running Python services after a child PowerShell has already exited.
    & (Join-Path $PSScriptRoot 'Start-ForgeSkills.ps1')
}

# Launchers return normally and propagate terminating errors. Native child
# shells can leave their output handles inherited by long-running daemons.
& (Join-Path $PSScriptRoot 'Start-Forge.ps1')

& $forgeNode (Join-Path $forgeRoot 'runtime/dist/forge-cli.js') doctor
if ($LASTEXITCODE -ne 0) {
    throw 'Connection diagnostics failed. Local MCP remains available; repair the reported layer before starting the tunnel.'
}

& (Join-Path $PSScriptRoot 'Start-ForgeTunnel.ps1')

Write-Output 'Local MCP, HTTPS/OAuth discovery and OpenAI tunnel readiness passed. ChatGPT tool use is a separate acceptance check.'
if ($OpenManager) { & (Join-Path $PSScriptRoot 'Open-ForgeManager.ps1') }
