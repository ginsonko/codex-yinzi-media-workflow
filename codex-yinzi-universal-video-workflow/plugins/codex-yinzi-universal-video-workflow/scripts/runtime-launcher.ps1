[CmdletBinding()]
param(
  [ValidateSet('ensure', 'status', 'stop')][string]$Command = 'ensure',
  [switch]$Build,
  [switch]$Json,
  [string]$ProjectRoot = '',
  [string]$RuntimeDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir 'runtime-launcher.mjs'
if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) { throw "运行时桥接脚本不存在：$nodeScript" }
$node = Get-Command node.exe -ErrorAction Stop
$arguments = @($nodeScript, $Command)
if ($Build) { $arguments += '--build' }
if ($Json) { $arguments += '--json' }
if ($ProjectRoot) { $arguments += @('--project-root', $ProjectRoot) }
if ($RuntimeDir) { $arguments += @('--runtime-dir', $RuntimeDir) }

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
