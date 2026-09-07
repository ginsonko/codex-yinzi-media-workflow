param(
  [string]$ProfileName = 'portable-v013-beta4',
  [ValidateRange(0, 65535)]
  [int]$RemoteDebuggingPort = 9226
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
$releaseDir = Join-Path $desktopDir 'release'
$packageFile = Join-Path $desktopDir 'package.json'
$packageJsonText = [IO.File]::ReadAllText($packageFile, [Text.Encoding]::UTF8)
$packageJson = $packageJsonText | ConvertFrom-Json
$packageVersion = [string]$packageJson.version
$productName = [string]$packageJson.build.productName
if ([string]::IsNullOrWhiteSpace($packageVersion)) { throw "Package version is missing: $packageFile" }
if ([string]::IsNullOrWhiteSpace($productName)) { throw "Package product name is missing: $packageFile" }
$portable = Join-Path $releaseDir "${productName}-Portable-$packageVersion-x64.exe"
if (-not (Test-Path -LiteralPath $portable -PathType Leaf)) { throw "Portable release not found: $portable" }
New-Item -ItemType Directory -Path $appData -Force | Out-Null
New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:YINZI_ACCEPTANCE_APPDATA = $appData
$env:Path = 'C:\Windows\System32;C:\Windows'

$process = Start-Process -FilePath $portable -ArgumentList "--remote-debugging-port=$RemoteDebuggingPort" -PassThru -WindowStyle Hidden
Write-Output "ACCEPTANCE_PROFILE=$profileRoot"
Write-Output "ACCEPTANCE_APPDATA=$appData"
Write-Output "ACCEPTANCE_EXE=$portable"
Write-Output "ACCEPTANCE_PID=$($process.Id)"
