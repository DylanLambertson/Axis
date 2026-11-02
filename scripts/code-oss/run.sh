#!/usr/bin/env bash
# Launches the Code OSS development build (upstream scripts/code.sh) with
# isolated user-data, extensions and shared-data directories, so it does not
# read or write the profile of an installed VS Code or Code OSS (without
# --shared-data-dir it would use ~/.vscode-oss-shared). Extra arguments are
# passed to Code OSS.
#
# The profile lives in vendor/run/ unless AXIS_CODE_OSS_RUN_DIR is set (for
# example to a fresh directory for a cold-start measurement).
#
# The development build loads every extensions/*/ folder as a built-in. Under
# ADR 0002 decision 6 extensions/copilot stays in the tree but is never built or
# packaged, so it is skipped here too (upstream's VSCODE_SKIP_BUILTIN_EXTENSIONS),
# matching what a packaged build ships.
#
# Usage: scripts/code-oss/run.sh [code-oss arguments...]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

case "${1:-}" in
-h | --help)
	sed -n '2,16p' "$0"
	exit 0
	;;
esac

load_manifest
require_applied_tree
resolve_node
export PATH="$NODE_BIN_DIR:$PATH"

run_dir="${AXIS_CODE_OSS_RUN_DIR:-$VENDOR_DIR/run}"
mkdir -p "$run_dir/user-data" "$run_dir/extensions" "$run_dir/shared-data"
run_dir="$(cd "$run_dir" && pwd -P)"

export VSCODE_SKIP_BUILTIN_EXTENSIONS="GitHub.copilot-chat${VSCODE_SKIP_BUILTIN_EXTENSIONS:+,$VSCODE_SKIP_BUILTIN_EXTENSIONS}"

log "Launching Code OSS $UPSTREAM_TAG with profile $run_dir"
cd "$TREE_DIR"
exec ./scripts/code.sh \
	--user-data-dir "$run_dir/user-data" \
	--extensions-dir "$run_dir/extensions" \
	--shared-data-dir "$run_dir/shared-data" \
	"$@"
