param(
  [string]$ProfileName = 'portable-universal-laoli-beta7',
  [ValidateRange(0, 65535)]
  [int]$RemoteDebuggingPort = 9227
)

$ErrorActionPreference = 'Stop'
$desktopDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profileRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir (Join-Path 'release-acceptance' $ProfileName)))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir 'release-acceptance'))
if (-not $profileRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Acceptance profile is outside allowed directory: $profileRoot" }
$appData = Join-Path $profileRoot 'AppData\Roaming'
$localAppData = Join-Path $profileRoot 'AppData\Local'
$releaseDir = Join-Path $desktopDir 'release-universal'
$portable = Get-ChildItem -LiteralPath $releaseDir -Filter '*Portable-*.exe' -File | Select-Object -First 1
if (-not $portable) { throw "Universal portable release not found: $releaseDir" }
New-Item -ItemType Directory -Path $appData -Force | Out-Null
New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:YINZI_ACCEPTANCE_APPDATA = $appData
$env:Path = 'C:\Windows\System32;C:\Windows'
$process = Start-Process -FilePath $portable.FullName -ArgumentList "--remote-debugging-port=$RemoteDebuggingPort" -PassThru -WindowStyle Hidden
Write-Output "ACCEPTANCE_PROFILE=$profileRoot"
Write-Output "ACCEPTANCE_APPDATA=$appData"
Write-Output "ACCEPTANCE_EXE=$($portable.FullName)"
Write-Output "ACCEPTANCE_PID=$($process.Id)"
