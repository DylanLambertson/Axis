#!/usr/bin/env bash
# SC-3 artifact check (docs/security/threat-model-phase0.md SC-3,
# docs/design/axis-shell.md §2.7): fails if a built Axis artifact contains
# Copilot or agent-host code.
#
# For each artifact directory (a packaged desktop app such as
# VSCode-darwin-x64/Axis.app, a vscode-reh-<os>-<arch> server or a
# vscode-reh-web-<os>-<arch> output) it fails on:
#   - any path containing node_modules/@github/copilot, node_modules/@vscode/copilot-api,
#     node_modules/@anthropic-ai or extensions/copilot, including inside
#     node_modules.asar (its header is read directly; no asar tool needed);
#   - any agentHostMain or diffWorkerMain file;
#   - any .js file that imports or requires those packages (import specifiers,
#     not plain strings: the workbench names some packages as strings).
# With --notices it also fails when LICENSE.txt or ThirdPartyNotices.txt is
# missing, and with --axis-license when the Axis LICENSE is missing as well.
#
# Without directories it checks every VSCode-*, vscode-reh-* and
# vscode-reh-web-* directory next to the Code OSS tree (the upstream gulp
# packaging output location).
#
# Usage: scripts/code-oss/check-artifacts.sh [--notices] [--axis-license] [DIR...]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

notices=0
axis_license=0
dirs=()
for arg in "$@"; do
	case "$arg" in
	--notices) notices=1 ;;
	--axis-license) notices=1 axis_license=1 ;;
	-h | --help)
		sed -n '2,22p' "$0"
		exit 0
		;;
	-*) die "unknown argument: $arg" ;;
	*) dirs+=("$arg") ;;
	esac
done

if [ "${#dirs[@]}" -eq 0 ]; then
	for d in "$VENDOR_DIR"/VSCode-* "$VENDOR_DIR"/vscode-reh-*; do
		[ -d "$d" ] || continue
		case "$d" in
		*/VSCode-darwin-*)
			for app in "$d"/*.app; do [ -d "$app" ] && dirs+=("$app"); done
			;;
		*) dirs+=("$d") ;;
		esac
	done
	[ "${#dirs[@]}" -gt 0 ] || die "no packaged artifacts found in $VENDOR_DIR; pass directories explicitly"
fi

FORBIDDEN_PATHS='node_modules/@github/copilot|node_modules/@vscode/copilot-api|node_modules/@anthropic-ai/|node_modules/@anthropic-ai$|extensions/copilot(/|$)|agentHostMain|diffWorkerMain'
FORBIDDEN_IMPORTS='(\bfrom|\bimport|\brequire)[[:space:]]*\(?[[:space:]]*["'"'"'`]@(github/copilot|vscode/copilot-api|anthropic-ai/)'

# asar_list FILE: prints every path inside an asar archive, one per line.
asar_list() {
	command -v node >/dev/null || die "node is needed to read $1"
	node -e '
		const fs = require("fs");
		const fd = fs.openSync(process.argv[1], "r");
		const head = Buffer.alloc(16);
		fs.readSync(fd, head, 0, 16, 0);
		const jsonLength = head.readUInt32LE(12);
		const json = Buffer.alloc(jsonLength);
		fs.readSync(fd, json, 0, jsonLength, 16);
		const walk = (node, prefix) => {
			for (const [name, child] of Object.entries(node.files || {})) {
				const p = prefix + "/" + name;
				console.log(p);
				walk(child, p);
			}
		};
		walk(JSON.parse(json.toString("utf8")), "");
	' "$1"
}

failures=0
fail() {
	printf 'FAIL %s\n' "$*" >&2
	failures=$((failures + 1))
}

for dir in "${dirs[@]}"; do
	[ -d "$dir" ] || die "not a directory: $dir"
	log "Checking $dir"
	before=$failures

	while IFS= read -r p; do
		fail "$dir: forbidden path ${p#"$dir"/}"
	done < <(find "$dir" \( -type f -o -type d -o -type l \) | grep -E "$FORBIDDEN_PATHS" | grep -vE '\.asar(\.unpacked)?$' || true)

	while IFS= read -r asar; do
		# node_modules.asar lists "/@scope/pkg/..."; prefix the archive name so the
		# node_modules/ patterns match.
		prefix="$(basename "$asar" .asar)"
		while IFS= read -r p; do
			fail "$dir: forbidden path ${asar#"$dir"/}:$p"
		done < <(asar_list "$asar" | sed "s|^|$prefix|" | grep -E "$FORBIDDEN_PATHS" || true)
	done < <(find "$dir" -type f -name '*.asar')

	while IFS= read -r js; do
		fail "$dir: ${js#"$dir"/} imports a Copilot or agent SDK package"
	done < <(find "$dir" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print0 | xargs -0 grep -lE "$FORBIDDEN_IMPORTS" 2>/dev/null || true)

	if [ "$notices" = 1 ]; then
		# Desktop apps keep the notices under Contents/Resources/app; servers at the root.
		root="$dir"
		[ -d "$dir/Contents/Resources/app" ] && root="$dir/Contents/Resources/app"
		[ -d "$dir/resources/app" ] && root="$dir/resources/app"
		required="LICENSE.txt ThirdPartyNotices.txt"
		[ "$axis_license" = 1 ] && required="$required LICENSE"
		for f in $required; do
			[ -f "$root/$f" ] || fail "$dir: missing ${root#"$dir"}/$f"
		done
	fi

	[ "$failures" = "$before" ] && log "passed: $dir"
done

[ "$failures" = 0 ] || die "$failures artifact check failure(s)"
log "All artifact checks passed (${#dirs[@]} artifact(s))"
