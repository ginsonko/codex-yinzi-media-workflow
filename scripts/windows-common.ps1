Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-YinziStateRoot {
  param([string]$Override = '')
  if ($Override) { return [IO.Path]::GetFullPath($Override) }
  if ($env:YINZI_WORKFLOW_RUNTIME_DIR) { return [IO.Path]::GetFullPath($env:YINZI_WORKFLOW_RUNTIME_DIR) }
  $localData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  return Join-Path $localData 'Yinzi\CodexVideoWorkflow'
}

function Get-YinziNode {
  param([string]$StateRoot, [switch]$Install)
  $nodePath = ''
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $nodePath = $command.Source }
  $saved = Join-Path $StateRoot 'node-path.txt'
  if (-not $nodePath -and (Test-Path -LiteralPath $saved)) { $nodePath = (Get-Content -LiteralPath $saved -Raw).Trim() }
  if ($nodePath -and (Test-Path -LiteralPath $nodePath)) {
    $major = & $nodePath -p 'parseInt(process.versions.node)'
    if ($LASTEXITCODE -eq 0 -and [int]$major -ge 22) { return $nodePath }
  }
  if (-not $Install) { throw 'Node.js 22+ is missing. Run install.cmd first.' }
  Write-Host '[1/5] Downloading official Node.js 22 LTS (SHA-256 verified)...'
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 60
  $release = $index | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1
  if (-not $release) { throw 'Cannot find the Node.js 22 LTS release.' }
  $arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
  $name = "node-$($release.version)-win-$arch.zip"
  $toolsDir = Join-Path $StateRoot 'tools'
  New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
  $archive = Join-Path $toolsDir $name
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $line = $sums -split "`n" | Where-Object { $_.TrimEnd().EndsWith(" $name") } | Select-Object -First 1
  if (-not $line) { throw 'Official Node checksum is unavailable.' }
  Get-VerifiedDownload "https://nodejs.org/dist/$($release.version)/$name" $archive ($line -split '\s+')[0]
  Expand-Archive -LiteralPath $archive -DestinationPath $toolsDir -Force
  $nodePath = Join-Path $toolsDir "node-$($release.version)-win-$arch\node.exe"
  [IO.File]::WriteAllText($saved, $nodePath)
  return $nodePath
}

function Get-VerifiedDownload {
  param([string]$Url, [string]$Destination, [string]$Sha256, [string]$FallbackUrl = '')
  if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256) { return }
  $partial = "$Destination.partial"
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  $downloaded = $false
  foreach ($candidate in @($Url,$FallbackUrl) | Where-Object { $_ }) {
    if ($curl) {
      & $curl.Source --fail --location --retry 1 --connect-timeout 20 --speed-limit 10240 --speed-time 30 --max-time 900 --output $partial $candidate
      if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
    } else {
      try { Invoke-WebRequest $candidate -UseBasicParsing -TimeoutSec 900 -OutFile $partial; $downloaded = $true; break }
      catch { Write-Warning 'Download source unavailable; trying the next publisher source.' }
    }
  }
  if (-not $downloaded) { throw "Download failed: $Url. Check your connection and rerun install.cmd." }
  if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) { throw "Checksum mismatch: $Url. Download was not installed." }
  Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Install-YinziMediaTools {
  param([string]$SourceRoot, [string]$StateRoot)
  $target = Join-Path $SourceRoot 'backend-node\tools\ffmpeg'
  $lock = Get-Content -LiteralPath (Join-Path $SourceRoot 'scripts\dependencies.json') -Raw | ConvertFrom-Json
  $receiptPath = Join-Path $StateRoot 'media-tools.json'
  if (Test-Path -LiteralPath $receiptPath) {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $valid = $receipt.archive_sha256 -eq $lock.ffmpeg.sha256
    foreach ($tool in @('ffmpeg','ffprobe')) {
      $file = Join-Path $target "$tool.exe"
      $valid = $valid -and (Test-Path -LiteralPath $file)
      if ($valid) { $valid = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $receipt.$tool }
    }
    if ($valid) { return }
  }
  $downloads = Join-Path $StateRoot 'downloads'
  New-Item -ItemType Directory -Path $downloads,$target -Force | Out-Null
  $archive = Join-Path $downloads "ffmpeg-$($lock.ffmpeg.version).zip"
  Get-VerifiedDownload $lock.ffmpeg.url $archive $lock.ffmpeg.sha256 $lock.ffmpeg.fallback_url
  $extract = Join-Path $downloads "ffmpeg-$($lock.ffmpeg.version)"
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $binary = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter ffmpeg.exe | Select-Object -First 1
  if (-not $binary) { throw 'The FFmpeg archive has no executable.' }
  $packageRoot = Split-Path -Parent $binary.DirectoryName
  $receipt = @{ archive_sha256=$lock.ffmpeg.sha256; source=$lock.ffmpeg.url }
  foreach ($tool in @('ffmpeg','ffprobe')) {
    $source = Join-Path $binary.DirectoryName "$tool.exe"
    & $source -version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$tool cannot run on this Windows installation." }
    Copy-Item -LiteralPath $source -Destination (Join-Path $target "$tool.exe") -Force
    $receipt[$tool] = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  }
  foreach ($pair in @(@('LICENSE','LICENSE-DOWNLOADED.txt'),@('README.txt','README-DOWNLOADED.txt'))) {
    Copy-Item -LiteralPath (Join-Path $packageRoot $pair[0]) -Destination (Join-Path $target $pair[1]) -Force
  }
  $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
}
