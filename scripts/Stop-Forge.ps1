$ErrorActionPreference = 'Stop'
$forgeState = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$receiptPath = Join-Path $forgeState 'process.json'
if (-not (Test-Path -LiteralPath $receiptPath)) { Write-Output 'No ChatGPTForge process receipt.'; exit 0 }
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$running = Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue
if (-not $running) { Write-Output 'ChatGPTForge is already stopped.'; exit 0 }
if ($running.StartTime.ToFileTimeUtc().ToString() -ne $receipt.startFileTime -or $running.Path -ne $receipt.executable) { throw 'Process identity changed; refusing to stop an unrelated process.' }
Stop-Process -Id $running.Id
Write-Output 'ChatGPTForge stopped. Durable task workers continue; inspect task_resume after restart. Legacy commands may need manual inspection.'
