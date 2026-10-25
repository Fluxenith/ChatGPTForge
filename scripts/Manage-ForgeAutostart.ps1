param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'install', 'uninstall')]
    [string]$Action,
    [string]$StartupDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
    throw 'Forge autostart is available only on Windows.'
}

$entry = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Invoke-ForgeAutostart.ps1')).Path
if (-not $StartupDirectory) {
    $StartupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
}
if ([string]::IsNullOrWhiteSpace($StartupDirectory)) { throw 'Cannot resolve the current user Startup directory.' }
$directory = [IO.Path]::GetFullPath($StartupDirectory)
$target = Join-Path $directory 'ChatGPTForge-Autostart.cmd'
$marker = 'REM ChatGPTForge managed autostart v1'

# Base64 UTF-16LE avoids shell metacharacter expansion in Windows user paths.
$escapedEntry = $entry.Replace("'", "''")
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& '$escapedEntry'"))
$expected = (@(
    '@echo off'
    $marker
    ('start "" /min powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + $encoded)
) -join [Environment]::NewLine) + [Environment]::NewLine

function Get-ManagedStatus {
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        return [pscustomobject]@{ path = $target; status = 'absent'; installed = $false; managed = $false }
    }
    $text = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
    $managed = $text -ceq $expected
    $state = if ($managed) { 'managed' } elseif ($text.Contains($marker)) { 'modified' } else { 'unmanaged' }
    return [pscustomobject]@{ path = $target; status = $state; installed = $true; managed = $managed }
}

$current = Get-ManagedStatus
if ($Action -eq 'status') {
    $current | ConvertTo-Json -Compress
    exit 0
}
if ($current.installed -and -not $current.managed) {
    throw "Refusing to change an existing $($current.status) Startup entry: $target"
}
if ($Action -eq 'uninstall') {
    if ($current.managed) { Remove-Item -LiteralPath $target }
    Get-ManagedStatus | ConvertTo-Json -Compress
    exit 0
}

if ($current.managed) {
    $current | ConvertTo-Json -Compress
    exit 0
}
if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $directory -Force
}
$temporary = Join-Path $directory ('.ChatGPTForge-Autostart-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($temporary, $expected, (New-Object Text.UTF8Encoding($false)))
    # File.Move refuses to replace an entry created after the first status
    # check, including one placed there by another startup manager.
    [IO.File]::Move($temporary, $target)
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
Get-ManagedStatus | ConvertTo-Json -Compress
