#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="${YINZI_WORKFLOW_RUNTIME_DIR:-}"
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
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js 22 LTS。" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "需要先安装 npm。" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || { echo "当前 Node.js 版本不足 22：$(node --version)" >&2; exit 1; }
PLUGIN="$SOURCE_ROOT/codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow"
if [ -z "$STATE_ROOT" ]; then STATE_ROOT="$(node "$PLUGIN/scripts/runtime-launcher.mjs" state-root | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!r.ok)throw Error(r.error);process.stdout.write(r.state_root)})')"; fi
mkdir -p "$STATE_ROOT" "$SKILLS_ROOT"
export YINZI_WORKFLOW_RUNTIME_DIR="$STATE_ROOT" YINZI_WORKFLOW_PROJECT_ROOT="$SOURCE_ROOT"
if [ -d "$SOURCE_ROOT/backend-node/node_modules/better-sqlite3" ]; then node "$PLUGIN/scripts/runtime-launcher.mjs" prepare-update --project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT" --owner-pid "$$"; fi
node "$PLUGIN/scripts/runtime-launcher.mjs" stop --json --runtime-dir "$STATE_ROOT"
for component in backend-node frontweb; do
  if node "$SOURCE_ROOT/scripts/dependencies-current.cjs" "$SOURCE_ROOT/$component"; then continue; fi
  (cd "$SOURCE_ROOT/$component" && if [ "$component" = backend-node ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm ci --no-audit --no-fund; fi)
done
node "$SOURCE_ROOT/scripts/verify-runtime.cjs"
if [ "$SKIP_CODEX_INSTALL" -eq 0 ] && command -v codex >/dev/null 2>&1; then
  SKILL_ARGS=(--project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT")
  if [ -n "${CODEX_SKILLS_ROOT:-}" ]; then SKILL_ARGS+=(--skills-root "$SKILLS_ROOT"); fi
  skill_receipt="$(node "$PLUGIN/scripts/install-skills.mjs" "${SKILL_ARGS[@]}")"
  mcp_entry="$(printf '%s' "$skill_receipt" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).mcp_entry))')"
  codex mcp add yinzi_video_workflow --env "YINZI_WORKFLOW_PROJECT_ROOT=$SOURCE_ROOT" --env "YINZI_WORKFLOW_RUNTIME_DIR=$STATE_ROOT" -- node "$mcp_entry" >/dev/null
  CODEX_MODE="skills-and-mcp"
else
  CODEX_MODE="skipped-or-codex-not-found"
fi
ARGS=("$PLUGIN/scripts/runtime-launcher.mjs" ensure --json --project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT" --maintenance-owner "$$")
node "$PLUGIN/scripts/runtime-launcher.mjs" prepare-update --project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT" --owner-pid "$$"
[ "$NO_BROWSER" -eq 1 ] || ARGS+=(--open)
runtime="$(node "${ARGS[@]}")"
printf '%s\n' "$runtime" > "$STATE_ROOT/installation.json"
node "$PLUGIN/scripts/check-update.mjs" --acknowledge --project-root "$SOURCE_ROOT" >/dev/null
printf '%s\n' "$runtime"
printf '安装完成。Codex 注册：%s。\n' "$CODEX_MODE" >&2
