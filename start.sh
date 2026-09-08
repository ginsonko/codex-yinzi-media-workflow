#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="${YINZI_WORKFLOW_RUNTIME_DIR:-}"
PLUGIN="$SOURCE_ROOT/codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow"
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js 22 LTS，或先运行 ./install.sh。" >&2; exit 1; }
if [ -z "$STATE_ROOT" ]; then STATE_ROOT="$(node "$PLUGIN/scripts/runtime-launcher.mjs" state-root | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);if(!r.ok)throw Error(r.error);process.stdout.write(r.state_root)})')"; fi
export YINZI_WORKFLOW_RUNTIME_DIR="$STATE_ROOT" YINZI_WORKFLOW_PROJECT_ROOT="$SOURCE_ROOT"
ARGS=("$PLUGIN/scripts/runtime-launcher.mjs" ensure --json --project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT" --open)
node "${ARGS[@]}"
