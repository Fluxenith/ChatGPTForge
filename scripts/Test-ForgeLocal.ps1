param([string]$StateDirectory)
$ErrorActionPreference = 'Stop'
if (-not $StateDirectory) {
    $StateDirectory = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
}
$forgeReceipt = Get-Content -LiteralPath (Join-Path $StateDirectory 'process.json') -Raw | ConvertFrom-Json
$forgeProcess = Get-Process -Id $forgeReceipt.pid -ErrorAction SilentlyContinue
if (-not $forgeProcess -or $forgeProcess.StartTime.ToFileTimeUtc().ToString() -ne $forgeReceipt.startFileTime -or $forgeProcess.Path -ne $forgeReceipt.executable) {
    throw 'Forge process identity does not match its receipt.'
}
$forgeNode = (Get-Command node.exe -ErrorAction Stop).Source
$forgeConfigText = & $forgeNode (Join-Path $PSScriptRoot 'forge-local-config.mjs') $StateDirectory
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the dedicated Forge listener configuration.' }
$forgeLocalConfig = $forgeConfigText | ConvertFrom-Json
$forgeManager = Get-Content -LiteralPath (Join-Path $StateDirectory 'manager.json') -Raw | ConvertFrom-Json
$forgeManagerUri = [Uri]$forgeManager.url
if ($forgeManager.pid -ne $forgeProcess.Id -or $forgeManagerUri.Scheme -ne 'http' -or $forgeManagerUri.Host -ne '127.0.0.1' -or -not $forgeManagerUri.Fragment) {
    throw 'Manager receipt does not belong to the running Forge process.'
}
foreach ($forgePort in @($forgeLocalConfig.port, $forgeManagerUri.Port)) {
    $forgeListener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $forgePort -ErrorAction SilentlyContinue
    if (-not ($forgeListener | Where-Object { $_.OwningProcess -eq $forgeProcess.Id })) { throw "Forge does not own its expected local listener on port $forgePort." }
}
$forgeMcpStatus = 0
try {
    $forgeResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$($forgeLocalConfig.port)/mcp" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 3
    $forgeMcpStatus = [int]$forgeResponse.StatusCode
} catch {
    if ($_.Exception.Response) { $forgeMcpStatus = [int]$_.Exception.Response.StatusCode }
}
if ($forgeMcpStatus -ne 401) { throw 'Local MCP is unavailable or is not requiring authentication.' }
$forgeHeaders = @{ Authorization = ('Bearer ' + $forgeManagerUri.Fragment.TrimStart('#')) }
try {
    $forgeManagerResponse = Invoke-WebRequest -Uri ($forgeManagerUri.GetLeftPart([UriPartial]::Authority) + '/api/tasks') -Headers $forgeHeaders -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 3
    if ($forgeManagerResponse.StatusCode -ne 200) { throw 'Unexpected manager response.' }
    $null = $forgeManagerResponse.Content | ConvertFrom-Json
} catch { throw 'Local manager authentication/readiness check failed. Reopen it through the launcher after repairing the service.' }
[pscustomobject]@{ ready = $true; pid = $forgeProcess.Id; mcpPort = $forgeLocalConfig.port; managerPort = $forgeManagerUri.Port }
