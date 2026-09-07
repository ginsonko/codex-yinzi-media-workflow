[CmdletBinding()]
param([string]$Repository = 'https://github.com/ginsonko/codex-yinzi-media-workflow.git', [string]$InstallRoot = '', [string]$Ref = '', [switch]$SkipMarketplaceInstall, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$checkout = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($InstallRoot) {
  $checkout = [IO.Path]::GetFullPath($InstallRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
    $gitArgs = @('clone','--depth','1')
    if ($Ref) { $gitArgs += @('--branch',$Ref) }
    & git @gitArgs -- $Repository $checkout
    if ($LASTEXITCODE -ne 0) { throw 'Repository download failed.' }
  }
}
& (Join-Path $checkout 'install.ps1') -NoBrowser:$NoBrowser -SkipCodexInstall:$SkipMarketplaceInstall
