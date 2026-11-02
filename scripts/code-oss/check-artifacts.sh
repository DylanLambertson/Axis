#!/usr/bin/env bash
# Copyright (c) 2026 Dylan Lambertson. All rights reserved.
#
# SC-3 artifact check (docs/security/threat-model-phase0.md SC-3,
# docs/design/axis-shell.md §2.7): fails if a built Axis artifact contains
# Copilot or agent-host code. It fails closed: any error while listing or
# reading an artifact is a failure, never a pass.
#
# For each artifact directory (a packaged desktop app such as
# VSCode-darwin-x64/Axis.app, a vscode-reh-<os>-<arch> server or a
# vscode-reh-web-<os>-<arch> output) it fails on:
#   - an artifact without an out/ directory (an empty or wrong directory);
#   - any path with a component @github/copilot*, @vscode/copilot-api,
#     @anthropic-ai, @openai/codex, extensions/copilot or a GitHub.copilot*
#     extension folder, anywhere in the tree (node_modules.asar.unpacked
#     included) and inside every .asar archive (its header is read directly;
#     no asar tool needed);
#   - any agentHostMain or diffWorkerMain file;
#   - any .js, .mjs or .cjs file that imports or requires those packages
#     (import specifiers, not plain strings: the workbench names some packages
#     as strings).
# With --notices it also fails when LICENSE.txt or ThirdPartyNotices.txt is
# missing, and with --axis-license when the Axis LICENSE is missing as well.
#
# Without directories it checks the VSCode-*/*.app, vscode-reh-* and
# vscode-reh-web-* directories next to the Code OSS tree (the upstream gulp
# packaging output location) and requires all three kinds. --expect
# KIND[,KIND...] (desktop, reh, reh-web) requires those kinds among the
# directories given; a kind is recognised by the directory name.
#
# Usage: scripts/code-oss/check-artifacts.sh [--notices] [--axis-license] [--expect KINDS] [DIR...]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

notices=0
axis_license=0
expect=''
dirs=()
while [ $# -gt 0 ]; do
	case "$1" in
	--notices) notices=1 ;;
	--axis-license) notices=1 axis_license=1 ;;
	--expect)
		[ $# -ge 2 ] || die "--expect needs a value"
		expect="$2"
		shift
		;;
	--expect=*) expect="${1#--expect=}" ;;
	-h | --help)
		sed -n '2,31p' "$0"
		exit 0
		;;
	-*) die "unknown argument: $1" ;;
	*) dirs+=("$1") ;;
	esac
	shift
done

# artifact_kind DIR: prints desktop, reh or reh-web from the directory name, or nothing.
artifact_kind() {
	case "$1" in
	*.app | */VSCode-* | VSCode-*) echo desktop ;;
	*/vscode-reh-web-* | vscode-reh-web-*) echo reh-web ;;
	*/vscode-reh-* | vscode-reh-*) echo reh ;;
	esac
}

if [ "${#dirs[@]}" -eq 0 ]; then
	[ -n "$expect" ] || expect='desktop,reh,reh-web'
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

for d in "${dirs[@]}"; do
	[ -d "$d" ] || die "not a directory: $d"
done

if [ -n "$expect" ]; then
	IFS=',' read -r -a kinds <<<"$expect"
	for kind in "${kinds[@]}"; do
		case "$kind" in desktop | reh | reh-web) ;; *) die "--expect: unknown kind '$kind' (desktop, reh, reh-web)" ;; esac
		found=0
		for d in "${dirs[@]}"; do
			[ "$(artifact_kind "${d%/}")" = "$kind" ] && found=1
		done
		[ "$found" = 1 ] || die "missing $kind artifact (expected: $expect)"
	done
fi

FORBIDDEN_PATHS='(^|/)@github/copilot|(^|/)@vscode/copilot-api(/|$)|(^|/)@anthropic-ai(/|$)|(^|/)@openai/codex(/|$)|(^|/)extensions/copilot(/|$)|(^|/)github\.copilot[^/]*(/|$)|agentHostMain|diffWorkerMain'
FORBIDDEN_IMPORTS='(\bfrom|\bimport|\brequire)[[:space:]]*\(?[[:space:]]*["'"'"'`]@(github/copilot|vscode/copilot-api|anthropic-ai/|openai/codex)'

work="$(mktemp -d "${TMPDIR:-/tmp}/axis-check-artifacts.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Node is needed only to read .asar headers, so resolve it in this shell before
# any listing: a missing node must stop the run, not a subshell.
NODE_BIN="$(command -v node || true)"

# grep_hits PATTERN IN OUT: case-insensitive extended grep; no match is fine,
# any other non-zero status is fatal.
grep_hits() {
	local rc=0
	grep -iE "$1" "$2" >"$3" || rc=$?
	[ "$rc" -le 1 ] || die "grep failed ($rc) on $2"
}

# asar_list FILE OUT: writes every path inside an asar archive to OUT, one per
# line. Fails on an unreadable, truncated or corrupt archive.
asar_list() {
	"$NODE_BIN" -e '
		const fs = require("fs");
		const file = process.argv[1];
		const size = fs.statSync(file).size;
		const fd = fs.openSync(file, "r");
		const head = Buffer.alloc(16);
		if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error("truncated asar header");
		const jsonLength = head.readUInt32LE(12);
		if (jsonLength <= 0 || 16 + jsonLength > size) throw new Error("asar header length " + jsonLength + " exceeds the file size " + size);
		const json = Buffer.alloc(jsonLength);
		if (fs.readSync(fd, json, 0, jsonLength, 16) !== jsonLength) throw new Error("truncated asar header");
		const table = JSON.parse(json.toString("utf8"));
		if (!table || typeof table.files !== "object") throw new Error("asar header has no file table");
		const out = [];
		const walk = (node, prefix) => {
			for (const [name, child] of Object.entries(node.files || {})) {
				const p = prefix + "/" + name;
				out.push(p);
				walk(child, p);
			}
		};
		walk(table, "");
		fs.writeFileSync(process.argv[2], out.length ? out.join("\n") + "\n" : "");
	' "$1" "$2" || die "cannot read asar archive $1"
}

failures=0
fail() {
	printf 'FAIL %s\n' "$*" >&2
	failures=$((failures + 1))
}

for dir in "${dirs[@]}"; do
	dir="${dir%/}"
	log "Checking $dir"
	before=$failures

	# Desktop apps keep the application under Contents/Resources/app (macOS) or resources/app.
	root="$dir"
	[ -d "$dir/Contents/Resources/app" ] && root="$dir/Contents/Resources/app"
	[ -d "$dir/resources/app" ] && root="$dir/resources/app"
	[ -d "$root/out" ] || fail "$dir: no out/ directory under ${root#"$dir"}/ (not a packaged artifact?)"

	find "$dir" \( -type f -o -type d -o -type l \) >"$work/paths" 2>"$work/find.err" ||
		die "cannot list $dir: $(head -3 "$work/find.err")"

	grep_hits "$FORBIDDEN_PATHS" "$work/paths" "$work/hits"
	while IFS= read -r p; do
		case "$p" in *.asar) continue ;; esac
		fail "$dir: forbidden path ${p#"$dir"/}"
	done <"$work/hits"

	grep_hits '\.asar$' "$work/paths" "$work/asars"
	while IFS= read -r asar; do
		[ -f "$asar" ] || continue
		[ -n "$NODE_BIN" ] || die "node is needed to read $asar; put node on PATH"
		asar_list "$asar" "$work/asar-paths"
		# node_modules.asar lists "/@scope/pkg/..."; prefix the archive name so
		# the messages show where the entry lives.
		prefix="$(basename "$asar" .asar)"
		sed "s|^|$prefix|" "$work/asar-paths" >"$work/asar-prefixed"
		grep_hits "$FORBIDDEN_PATHS" "$work/asar-prefixed" "$work/asar-hits"
		while IFS= read -r p; do
			fail "$dir: forbidden path ${asar#"$dir"/}:$p"
		done <"$work/asar-hits"
	done <"$work/asars"

	rc=0
	grep -rlE --include='*.js' --include='*.mjs' --include='*.cjs' "$FORBIDDEN_IMPORTS" "$dir" >"$work/imports" 2>"$work/grep.err" || rc=$?
	[ "$rc" -le 1 ] || die "cannot scan $dir for imports: $(head -3 "$work/grep.err")"
	while IFS= read -r js; do
		fail "$dir: ${js#"$dir"/} imports a Copilot or agent SDK package"
	done <"$work/imports"

	if [ "$notices" = 1 ]; then
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
