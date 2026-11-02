#!/usr/bin/env bash
# Builds the patched Code OSS tree in vendor/code-oss for local development:
# npm ci, npm run compile, then the Electron binary and built-in extensions that
# scripts/code.sh would otherwise fetch at first launch. Each step is timed and
# appended to vendor/logs/build-times.tsv.
#
# Node.js must be major 24 and >= the manifest "node" version. Lookup order:
#   1. $NODE24_BIN (directory containing node, or the node binary itself)
#   2. /usr/local/opt/node@24/bin
#   3. the official nodejs.org tarball for this OS/CPU, unpacked into .tools/
#      only if it matches the SHA-256 pinned in code-oss/upstream.json (and the
#      release's SHASUMS256.txt agrees); an unpinned OS/CPU fails closed
#
# The tree and .tools/ paths must not contain whitespace (node-gyp limitation);
# use AXIS_CODE_OSS_VENDOR_DIR / AXIS_CODE_OSS_TOOLS_DIR to relocate them.
#
# Usage: scripts/code-oss/build.sh [--skip-install]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

skip_install=0
for arg in "$@"; do
	case "$arg" in
	--skip-install) skip_install=1 ;;
	-h | --help)
		sed -n '2,17p' "$0"
		exit 0
		;;
	*) die "unknown argument: $arg" ;;
	esac
done

load_manifest
require_applied_tree
require_build_paths_without_whitespace
resolve_node download
export PATH="$NODE_BIN_DIR:$PATH"

node_v="$(node --version)"
npm_v="$(npm --version)"
log "Using node $node_v and npm $npm_v from $NODE_BIN_DIR"
npm_major="${npm_v%%.*}"
[ "$npm_major" -lt 13 ] || die "Code OSS requires npm < 13; found $npm_v"

mkdir -p "$VENDOR_DIR/logs"
times="$VENDOR_DIR/logs/build-times.tsv"
[ -f "$times" ] || printf 'date\tcommit\tnode\tstep\tseconds\texit\n' >"$times"

# step NAME CMD...: runs CMD inside the tree, timing it.
step() {
	local name="$1" start rc=0 elapsed
	shift
	log "$name: $*"
	start="$(date +%s)"
	(cd "$TREE_DIR" && "$@") || rc=$?
	elapsed=$(($(date +%s) - start))
	printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${UPSTREAM_COMMIT:0:10}" \
		"$node_v" "$name" "$elapsed" "$rc" >>"$times"
	[ "$rc" -eq 0 ] || die "$name failed (exit $rc) after ${elapsed}s"
	log "$name finished in ${elapsed}s"
}

if [ "$skip_install" = 1 ]; then
	[ -d "$TREE_DIR/node_modules" ] || die "--skip-install given but $TREE_DIR/node_modules is missing"
else
	step "npm ci" npm ci
fi
step "compile" npm run compile
step "electron" npm run electron
step "builtin extensions" npm run download-builtin-extensions

log "Build complete; timings in $times. Launch with scripts/code-oss/run.sh"
