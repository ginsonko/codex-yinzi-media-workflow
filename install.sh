#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="${YINZI_WORKFLOW_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-yinzi-media-workflow}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
SKILLS_ROOT="${CODEX_SKILLS_ROOT:-$HOME/.agents/skills}"
NO_BROWSER=0
SKIP_CODEX_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-browser) NO_BROWSER=1 ;;
    --skip-codex-install) SKIP_CODEX_INSTALL=1 ;;
    --state-root=*) STATE_ROOT="${arg#*=}" ;;
    -h|--help) echo "Usage: ./install.sh [--no-browser] [--skip-codex-install] [--state-root=DIR]"; exit 0 ;;
  esac
done
mkdir -p "$STATE_ROOT" "$SKILLS_ROOT"
export YINZI_WORKFLOW_RUNTIME_DIR="$STATE_ROOT" YINZI_WORKFLOW_PROJECT_ROOT="$SOURCE_ROOT"
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js 22 LTS。" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "需要先安装 npm。" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || { echo "当前 Node.js 版本不足 22：$(node --version)" >&2; exit 1; }
PLUGIN="$SOURCE_ROOT/codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow"
node "$PLUGIN/scripts/runtime-launcher.mjs" stop --json --runtime-dir "$STATE_ROOT" >/dev/null 2>&1 || true
for component in backend-node frontweb; do
  if node "$SOURCE_ROOT/scripts/dependencies-current.cjs" "$SOURCE_ROOT/$component"; then continue; fi
  (cd "$SOURCE_ROOT/$component" && if [ "$component" = backend-node ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm ci --no-audit --no-fund; fi)
done
node "$SOURCE_ROOT/scripts/verify-runtime.cjs"
if [ "$SKIP_CODEX_INSTALL" -eq 0 ] && command -v codex >/dev/null 2>&1; then
  mkdir -p "$SKILLS_ROOT"
  for skill in "$PLUGIN/skills"/*; do
    [ -d "$skill" ] || continue
    name="$(basename "$skill")"; dest="$SKILLS_ROOT/$name"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then echo "保留已有 Skill：$dest，请让 Codex 处理冲突后重试。" >&2; exit 1; fi
    ln -sfn "$skill" "$dest"
  done
  if codex mcp remove yinzi_video_workflow >/dev/null 2>&1; then :; fi
  codex mcp add yinzi_video_workflow --env "YINZI_WORKFLOW_PROJECT_ROOT=$SOURCE_ROOT" --env "YINZI_WORKFLOW_RUNTIME_DIR=$STATE_ROOT" -- node "$PLUGIN/mcp/server.mjs" >/dev/null
  CODEX_MODE="skills-and-mcp"
else
  CODEX_MODE="skipped-or-codex-not-found"
fi
ARGS=("$PLUGIN/scripts/runtime-launcher.mjs" ensure --json --project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT")
[ "$NO_BROWSER" -eq 1 ] || ARGS+=(--open)
runtime="$(node "${ARGS[@]}")"
printf '%s\n' "$runtime" > "$STATE_ROOT/installation.json"
node "$PLUGIN/scripts/check-update.mjs" --acknowledge --project-root "$SOURCE_ROOT" >/dev/null
printf '%s\n' "$runtime"
printf '安装完成。Codex 注册：%s。\n' "$CODEX_MODE" >&2
