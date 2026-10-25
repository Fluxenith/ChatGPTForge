$ErrorActionPreference = 'Stop'
$forgeState = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$receiptPath = Join-Path $forgeState 'tunnel/process.json'
if (-not (Test-Path -LiteralPath $receiptPath)) { Write-Output 'No ChatGPTForge tunnel process receipt.'; exit 0 }
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$running = Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue
if (-not $running) { Write-Output 'ChatGPTForge tunnel is already stopped.'; exit 0 }
if ($running.StartTime.ToFileTimeUtc().ToString() -ne $receipt.startFileTime -or $running.Path -ne $receipt.executable) { throw 'Process identity changed; refusing to stop an unrelated process.' }
Stop-Process -Id $running.Id
if (-not $running.WaitForExit(5000)) { throw 'Tunnel process did not exit in time.' }
Write-Output 'ChatGPTForge OpenAI Tunnel stopped.'
