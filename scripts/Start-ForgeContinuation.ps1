param([ValidateSet('login','once','watch')][string]$Mode='watch',[ValidateSet('chrome','msedge')][string]$Browser='chrome')
$ErrorActionPreference = 'Stop'
$forgeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$forgeState = if ($env:CHATGPTFORGE_CONFIG_DIR) { $env:CHATGPTFORGE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.chatgptforge' }
$forgeReceiptPath = Join-Path $forgeState 'continuation-process.json'
if (Test-Path -LiteralPath $forgeReceiptPath) {
    $forgeReceipt = Get-Content -LiteralPath $forgeReceiptPath -Raw | ConvertFrom-Json
    $forgeExisting = Get-Process -Id $forgeReceipt.pid -ErrorAction SilentlyContinue
    if ($forgeExisting -and $forgeExisting.StartTime.ToFileTimeUtc().ToString() -eq $forgeReceipt.startFileTime) { throw 'Continuation browser is already running. Close its dedicated browser window before changing mode.' }
}
$env:CHATGPTFORGE_BROWSER = $Browser
$forgeNode = (Get-Command node.exe).Source
$forgeChild = Start-Process -FilePath $forgeNode -ArgumentList 'dist/forge-continuation.js',$Mode -WorkingDirectory (Join-Path $forgeRoot 'runtime') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $forgeState 'continuation.log') -RedirectStandardError (Join-Path $forgeState 'continuation-error.log')
@{pid=$forgeChild.Id;startFileTime=$forgeChild.StartTime.ToFileTimeUtc().ToString();executable=$forgeNode;mode=$Mode;browser=$Browser} | ConvertTo-Json | Set-Content -LiteralPath $forgeReceiptPath -Encoding utf8
Write-Output "ChatGPTForge continuation started ($Browser / $Mode)."
