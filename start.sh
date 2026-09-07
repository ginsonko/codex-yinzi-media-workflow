#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="${YINZI_WORKFLOW_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-yinzi-media-workflow}"
PLUGIN="$SOURCE_ROOT/codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow"
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js 22 LTS，或先运行 ./install.sh。" >&2; exit 1; }
export YINZI_WORKFLOW_RUNTIME_DIR="$STATE_ROOT" YINZI_WORKFLOW_PROJECT_ROOT="$SOURCE_ROOT"
ARGS=("$PLUGIN/scripts/runtime-launcher.mjs" ensure --json --project-root "$SOURCE_ROOT" --runtime-dir "$STATE_ROOT" --open)
node "${ARGS[@]}"
