param(
  [string]$ProfileName = 'setup-v012-final-media-20260815',
  [ValidateRange(1, 65535)]
  [int]$RemoteDebuggingPort = 9234
)

$ErrorActionPreference = 'Stop'
$desktopDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir 'release-acceptance'))
$profileRoot = [IO.Path]::GetFullPath((Join-Path $allowedRoot $ProfileName))
if (-not $profileRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Acceptance profile is outside the allowed directory: $profileRoot"
}

$installRoot = Join-Path $profileRoot 'app'
$applicationExecutables = @(
  Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'Uninstall*' }
)
if ($applicationExecutables.Count -ne 1) {
  throw "Expected exactly one installed application executable in: $installRoot"
}
$installedExe = $applicationExecutables[0].FullName

$runtimeAcceptanceRoot = [IO.Path]::GetFullPath((Join-Path $installRoot '..\..\release-acceptance'))
$acceptedDataRoot = Join-Path $runtimeAcceptanceRoot $ProfileName
$appData = Join-Path $acceptedDataRoot 'AppData\Roaming'
$localAppData = Join-Path $acceptedDataRoot 'AppData\Local'
New-Item -ItemType Directory -Path $appData -Force | Out-Null
New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:YINZI_ACCEPTANCE_APPDATA = $appData
$env:Path = 'C:\Windows\System32;C:\Windows'

$process = Start-Process -FilePath $installedExe -ArgumentList "--remote-debugging-port=$RemoteDebuggingPort" -PassThru -WindowStyle Hidden
Write-Output "ACCEPTANCE_PROFILE=$profileRoot"
Write-Output "ACCEPTANCE_APPDATA=$appData"
Write-Output "ACCEPTANCE_EXE=$installedExe"
Write-Output "ACCEPTANCE_PID=$($process.Id)"
