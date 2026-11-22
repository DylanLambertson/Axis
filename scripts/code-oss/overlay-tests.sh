#!/usr/bin/env bash
# Copyright (c) 2026 Dylan Lambertson. All rights reserved.
#
# Run the overlay's node unit tests (vs/axis/**/test/common) with upstream's own runner on an applied, transpiled
# vendor tree (ticket PV-X3). The gate calls it when GATE_OVERLAY_TREE names a builder's private vendor directory.
#
# Usage: AXIS_CODE_OSS_VENDOR_DIR=<vendor dir with code-oss/node_modules> scripts/code-oss/overlay-tests.sh
# Exit: 0 all passed, 1 a test failed or the tree could not be prepared, 3 no usable tree (reported as skipped).
#
# The tree is always re-applied from THIS checkout and re-transpiled first (about a minute, niced): the apply stamp
# lists overlay paths but not their contents, so it cannot prove the tree matches this overlay. Never point it at a
# tree another builder uses (env.sh's shared vendor dir is one): the apply rewrites it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
vendor="${AXIS_CODE_OSS_VENDOR_DIR:-}"
if [ -z "$vendor" ]; then
	echo "overlay tests: no vendor directory (set AXIS_CODE_OSS_VENDOR_DIR)" >&2
	exit 3
fi
tree="$vendor/code-oss"
if [ ! -f "$tree/node_modules/mocha/bin/mocha.js" ] || [ ! -f "$tree/test/unit/node/index.js" ]; then
	echo "overlay tests: $tree has no installed tree (fetch.sh, apply.sh, npm ci there first)" >&2
	exit 3
fi

# The pinned Node: the one on PATH when it is the manifest's version (a builder under the gate), else the toolchain
# build.sh installed (CI). Never downloaded here.
# shellcheck source=scripts/code-oss/lib.sh
. "$here/lib.sh"
load_manifest
if [ "$(node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
	resolve_node
	export PATH="$NODE_BIN_DIR:$PATH"
fi

if ! nice -n 10 "$here/apply.sh" --force >"$vendor/overlay-tests-apply.log" 2>&1; then
	echo "overlay tests: apply failed; see $vendor/overlay-tests-apply.log" >&2
	tail -n 20 "$vendor/overlay-tests-apply.log" >&2
	exit 1
fi
if ! (cd "$tree" && nice -n 10 npm run transpile-client >"$vendor/overlay-tests-transpile.log" 2>&1); then
	echo "overlay tests: transpile failed; see $vendor/overlay-tests-transpile.log" >&2
	tail -n 20 "$vendor/overlay-tests-transpile.log" >&2
	exit 1
fi
cd "$tree"
exec nice -n 10 node node_modules/mocha/bin/mocha.js test/unit/node/index.js --delay --ui=tdd --exit \
	--runGlob 'vs/axis/**/test/common/**/*.test.js'
