$ErrorActionPreference = 'Stop'
$forgeState = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$forgeManager = Get-Content -LiteralPath (Join-Path $forgeState 'manager.json') -Raw | ConvertFrom-Json
$forgeUrl = [Uri]$forgeManager.url
if ($forgeUrl.Scheme -ne 'http' -or $forgeUrl.Host -ne '127.0.0.1') { throw 'Invalid local manager URL' }
Start-Process -FilePath $forgeUrl.AbsoluteUri
