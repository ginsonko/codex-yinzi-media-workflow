[CmdletBinding()]
param(
  [string]$StateRoot = '',
  [string]$CodexHome = '',
  [string]$SkillsRoot = '',
  [switch]$NoBrowser,
  [switch]$SkipCodexInstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'scripts\windows-common.ps1')
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$StateRoot = Get-YinziStateRoot $StateRoot
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
if ($CodexHome) {
  $CodexHome = [IO.Path]::GetFullPath($CodexHome)
  New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
  $env:CODEX_HOME = $CodexHome
}
if (-not $SkillsRoot) {
  $SkillsRoot = if ($CodexHome) { Join-Path $CodexHome 'skills' } else { Join-Path $HOME '.agents\skills' }
}
$SkillsRoot = [IO.Path]::GetFullPath($SkillsRoot)
$env:YINZI_WORKFLOW_RUNTIME_DIR = $StateRoot
$env:YINZI_WORKFLOW_PROJECT_ROOT = $sourceRoot
Write-Host 'Codex Yinzi Media Workflow - installing from this checkout'
Write-Host "Source: $sourceRoot"
Write-Host "Local data: $StateRoot"
$node = Get-YinziNode $StateRoot -Install
[IO.File]::WriteAllText((Join-Path $StateRoot 'node-path.txt'), $node)
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"
$npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
$plugin = Join-Path $sourceRoot 'codex-yinzi-universal-video-workflow\plugins\codex-yinzi-universal-video-workflow'
# Release native module handles before npm replaces dependencies on Windows.
# The launcher verifies ownership and retains the runtime/data directory.
& $node (Join-Path $plugin 'scripts\runtime-launcher.mjs') stop --json --runtime-dir $StateRoot
if ($LASTEXITCODE -ne 0) { throw 'The registered workbench could not be safely stopped. Give the error above to Codex; other processes and data were preserved.' }
Write-Host '[2/5] Installing locked frontend and backend dependencies...'
foreach ($component in @('backend-node','frontweb')) {
  Push-Location (Join-Path $sourceRoot $component)
  try {
    $npmArgs = @('ci','--no-audit','--no-fund')
    # better-sqlite3 13 ships N-API prebuilds. Some npm releases nevertheless
    # run implicit node-gyp; backend dependencies need no installation scripts.
    if ($component -eq 'backend-node') { $npmArgs += '--ignore-scripts' }
    & $npm @npmArgs
    if ($LASTEXITCODE -ne 0) { throw "$component dependencies failed. Check the network and rerun install.cmd." }
  }
  finally { Pop-Location }
}
& $node (Join-Path $sourceRoot 'scripts\verify-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Native runtime verification failed. Give the error above to Codex.' }
Write-Host '[3/5] Preparing verified FFmpeg and FFprobe...'
Install-YinziMediaTools $sourceRoot $StateRoot
$plugin = Join-Path $sourceRoot 'codex-yinzi-universal-video-workflow\plugins\codex-yinzi-universal-video-workflow'
$manifest = Get-Content -LiteralPath (Join-Path $plugin '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json
$codexMode = 'skipped'
if (-not $SkipCodexInstall) {
  Write-Host '[4/5] Registering Codex Skills and tools...'
  $codex = Get-Command codex.exe,codex.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $codex) {
    $cliRoot = Join-Path $StateRoot 'codex-cli'
    & $npm install --prefix $cliRoot --no-audit --no-fund '@openai/codex'
    if ($LASTEXITCODE -ne 0) { throw 'Codex CLI installation failed. Install it, then rerun install.cmd.' }
    $codexPath = Join-Path $cliRoot 'node_modules\.bin\codex.cmd'
  } else { $codexPath = $codex.Source }
  # An older CLI can print an unsupported-command warning to stderr. This is
  # capability discovery, so PowerShell 5 must not terminate on that warning.
  $priorErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $help = (& $codexPath plugin --help 2>&1 | Out-String)
  } finally { $ErrorActionPreference = $priorErrorPreference }
  if ($help -match '(?m)^\s+add\s') {
    $marketplace = Join-Path $StateRoot 'plugin-runtime'
    New-Item -ItemType Directory -Path $marketplace -Force | Out-Null
    foreach ($entry in @('.agents','plugins')) {
      Copy-Item -LiteralPath (Join-Path $sourceRoot "codex-yinzi-universal-video-workflow\$entry") -Destination $marketplace -Recurse -Force
    }
    $installedPlugin = Join-Path $marketplace 'plugins\codex-yinzi-universal-video-workflow'
    $mcpPath = Join-Path $installedPlugin '.mcp.json'
    $mcp = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
    $mcp.mcpServers.yinzi_video_workflow.command = $node
    $mcp.mcpServers.yinzi_video_workflow.args = @((Join-Path $installedPlugin 'mcp\server.mjs'))
    $mcp.mcpServers.yinzi_video_workflow.cwd = $installedPlugin
    $mcp.mcpServers.yinzi_video_workflow | Add-Member -MemberType NoteProperty -Name env -Value @{YINZI_WORKFLOW_PROJECT_ROOT=$sourceRoot;YINZI_WORKFLOW_RUNTIME_DIR=$StateRoot} -Force
    $mcp | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mcpPath -Encoding utf8
    & $codexPath plugin marketplace add $marketplace
    if ($LASTEXITCODE -ne 0) { throw 'Codex marketplace registration failed.' }
    & $codexPath plugin add 'codex-yinzi-universal-video-workflow@yinzi-video-workflow'
    if ($LASTEXITCODE -ne 0) { throw 'Codex plugin registration failed.' }
    $codexMode = 'plugin'
  } else {
    # Junctions preserve relative imports between the Skill and its sibling runtime.
    New-Item -ItemType Directory -Path $SkillsRoot -Force | Out-Null
    $recordPath = Join-Path $StateRoot 'skill-installation.json'
    $previous = if (Test-Path -LiteralPath $recordPath) { Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json } else { $null }
    $links = @()
    foreach ($skill in (Get-ChildItem -LiteralPath (Join-Path $plugin 'skills') -Directory)) {
      $destination = Join-Path $SkillsRoot $skill.Name
      if (Test-Path -LiteralPath $destination) {
        $item = Get-Item -LiteralPath $destination -Force
        if ($item.LinkType -eq 'Junction' -and [string]$item.Target -eq $skill.FullName) {
          $links += @{ path=$destination; target=$skill.FullName }; continue
        }
        $owned = $previous -and @($previous.links | Where-Object { $_.path -eq $destination -and $_.target -eq [string]$item.Target }).Count -gt 0
        if (-not $owned -or $item.LinkType -ne 'Junction') { throw "An existing Skill was preserved: $destination. Ask Codex to migrate it, then rerun the installer." }
        [IO.Directory]::Delete($destination) # Remove this verified junction only; never recurse into its target.
      }
      New-Item -ItemType Junction -Path $destination -Target $skill.FullName | Out-Null
      $links += @{ path=$destination; target=$skill.FullName }
    }
    @{ source_root=$sourceRoot; links=$links } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordPath -Encoding utf8
    & $codexPath mcp add yinzi_video_workflow --env "YINZI_WORKFLOW_PROJECT_ROOT=$sourceRoot" --env "YINZI_WORKFLOW_RUNTIME_DIR=$StateRoot" -- $node (Join-Path $plugin 'mcp\server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'MCP registration failed. Skills are installed; rerun install.cmd to finish.' }
    $codexMode = 'skills-and-mcp'
  }
}
Write-Host '[5/5] Building and opening the verified local workbench...'
$runtimeArgs = @((Join-Path $plugin 'scripts\runtime-launcher.mjs'),'ensure','--json','--project-root',$sourceRoot,'--runtime-dir',$StateRoot)
if (-not $NoBrowser) { $runtimeArgs += '--open' }
$output = & $node @runtimeArgs
if ($LASTEXITCODE -ne 0) { throw "Workbench startup failed: $output" }
$runtime = ($output | Select-Object -Last 1) | ConvertFrom-Json
$result = [ordered]@{ ok=$true; source_root=$sourceRoot; frontend_url=$runtime.frontend_url; runtime_id=$runtime.runtime_id; codex_installation=$codexMode; skills_root=$SkillsRoot; plugin_version=$manifest.version; paid_calls_started=$false; next_step='Open a new Codex task; if Skills/tools do not appear yet, restart Codex. Describe your media task. Model keys are optional and configured in the workbench.' }
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $StateRoot 'installation.json') -Encoding utf8
Write-Host "Ready: $($runtime.frontend_url)"
$result | ConvertTo-Json -Depth 5
