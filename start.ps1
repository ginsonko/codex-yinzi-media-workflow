[CmdletBinding()]
param([string]$StateRoot = '', [switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
$StateRoot = Get-YinziStateRoot $StateRoot
$node = Get-YinziNode $StateRoot
$env:YINZI_WORKFLOW_RUNTIME_DIR = $StateRoot
$launcher = Join-Path $PSScriptRoot 'codex-yinzi-universal-video-workflow\plugins\codex-yinzi-universal-video-workflow\scripts\runtime-launcher.mjs'
$argsList = @($launcher,'ensure','--json','--project-root',$PSScriptRoot,'--runtime-dir',$StateRoot)
if (-not $NoBrowser) { $argsList += '--open' }
& $node @argsList
if ($LASTEXITCODE -ne 0) { throw 'Startup failed. Run install.cmd to repair dependencies, or give this error to Codex.' }
