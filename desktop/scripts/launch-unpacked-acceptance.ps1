param(
  [string]$ProfileName = 'fresh-user',
  [ValidateRange(0, 65535)]
  [int]$RemoteDebuggingPort = 0
)

$ErrorActionPreference = 'Stop'
$desktopDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profileRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir (Join-Path 'release-acceptance' $ProfileName)))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir 'release-acceptance'))
if (-not $profileRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Acceptance profile is outside the allowed directory: $profileRoot"
}

$appData = Join-Path $profileRoot 'AppData\Roaming'
$localAppData = Join-Path $profileRoot 'AppData\Local'
$unpackedDir = Join-Path $desktopDir 'release\win-unpacked'
$executables = @(Get-ChildItem -LiteralPath $unpackedDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)
if ($executables.Count -ne 1) {
  throw "Expected exactly one application executable in: $unpackedDir"
}
$exe = $executables[0].FullName

New-Item -ItemType Directory -Path $appData -Force | Out-Null
New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:YINZI_ACCEPTANCE_APPDATA = $appData
$env:Path = 'C:\Windows\System32;C:\Windows'

Write-Output "ACCEPTANCE_PROFILE=$profileRoot"
Write-Output "ACCEPTANCE_APPDATA=$appData"
Write-Output "ACCEPTANCE_EXE=$exe"
if ($RemoteDebuggingPort -gt 0) {
  Write-Output "ACCEPTANCE_REMOTE_DEBUGGING_PORT=$RemoteDebuggingPort"
  & $exe "--remote-debugging-port=$RemoteDebuggingPort"
} else {
  & $exe
}
