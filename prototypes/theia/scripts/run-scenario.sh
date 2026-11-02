#!/usr/bin/env bash
# Runs one extension-matrix scenario (test/extension-matrix/scenarios.json)
# against the built Theia browser-app, using the unchanged matrix probe.
#
# Mirrors test/extension-matrix/run.sh where Theia allows it:
#   - same fixture copy and setup steps (git-init, npm-install without scripts);
#   - same user settings (baseSettings merged with the scenario settings);
#   - every prepared plugin is installed, minus the scenario's disableExtensions
#     (Theia has no --disable-extension flag, so those are left out of the
#     per-scenario plugins directory instead);
#   - the probe runs inside the plugin host through probe-plugin/ (Theia has no
#     --extensionTestsPath).
# Usage: run-scenario.sh <scenario-id> [--timeout <seconds>] [--port <port>]
set -euo pipefail

proto_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$proto_dir/../.." && pwd)"
matrix_dir="$repo_dir/test/extension-matrix"
# shellcheck source-path=SCRIPTDIR source=../../../test/extension-matrix/lib.sh
source "$matrix_dir/lib.sh"

id="${1:-}"
[[ -n "$id" ]] || die "usage: run-scenario.sh <scenario-id> [--timeout <s>] [--port <p>]"
shift
timeout_s=420
port=3110
while (($# > 0)); do
	case "$1" in
	--timeout) timeout_s="${2:?}"; shift 2 ;;
	--port) port="${2:?}"; shift 2 ;;
	*) die "unknown argument: $1" ;;
	esac
done
[[ "$timeout_s" =~ ^[0-9]+$ && "$port" =~ ^[0-9]+$ ]] || die "timeout and port must be numbers"

require_cmd jq node
plugins_src="$proto_dir/plugins"
[[ -d "$plugins_src" ]] || die "run scripts/prepare-plugins.sh first"

work="$proto_dir/.work/scenarios/$id"
rm -rf "$work"
mkdir -p "$work"
jq -e --arg id "$id" '.scenarios[] | select(.id == $id)' "$SCENARIOS" >"$work/scenario.json" ||
	die "unknown scenario: $id"

missing=()
while IFS= read -r tool; do
	[[ -z "$tool" ]] || command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done < <(jq -r '.requires[]' "$work/scenario.json")
if ((${#missing[@]} > 0)); then
	log "$id: blocked, missing host tools: ${missing[*]}"
	jq -n --arg id "$id" --arg m "${missing[*]}" '{scenario: $id, status: "blocked", detail: ("missing: " + $m)}' >"$work/result.json"
	exit 2
fi

fixture="$(jq -r '.fixture' "$work/scenario.json")"
[[ "$fixture" =~ ^[a-z0-9-]+$ && -d "$matrix_dir/fixtures/$fixture" ]] || die "$id: bad fixture $fixture"
ws="$work/workspace"
mkdir -p "$ws"
cp -R "$matrix_dir/fixtures/$fixture/." "$ws/"

while IFS= read -r step; do
	case "$step" in
	"") ;;
	git-init)
		git_id=(-c user.name="Axis Matrix" -c user.email=matrix@example.invalid -c commit.gpgsign=false)
		(
			export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
			export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
			git -C "$ws" init -q -b main
			git -C "$ws" "${git_id[@]}" add -A
			git -C "$ws" "${git_id[@]}" commit -q -m "Add fixture files"
			printf 'second line\n' >>"$ws/notes.txt"
			export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"
			git -C "$ws" "${git_id[@]}" commit -q -am "Extend notes"
		)
		;;
	npm-install) (cd "$ws" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) ;;
	*) die "$id: unknown setup step '$step'" ;;
	esac
done < <(jq -r '.setup[]' "$work/scenario.json")

# User settings: Theia reads <THEIA_CONFIG_DIR>/settings.json.
config="$work/config"
mkdir -p "$config"
jq --arg id "$id" \
	--arg py "$(command -v python3 || true)" \
	--arg gopls "$(command -v gopls || true)" \
	--arg clangd "$(command -v clangd || true)" '
	.baseSettings * (.scenarios[] | select(.id == $id) | .settings)
	| walk(if type == "string"
		then gsub("@PYTHON@"; $py) | gsub("@GOPLS@"; $gopls) | gsub("@CLANGD@"; $clangd)
		else . end)
' "$SCENARIOS" >"$config/settings.json"

# Per-scenario plugins directory: symlinks to every prepared plugin except the
# disabled ones, plus the probe wrapper with the unchanged probe sources.
plugins="$work/plugins"
mkdir -p "$plugins"
disabled=",$(jq -r '.disableExtensions | join(",")' "$work/scenario.json"),"
for dir in "$plugins_src"/*/; do
	name="$(basename "$dir")"
	shopt -s nocasematch
	if [[ "$disabled" == *",$name,"* ]]; then
		log "$id: leaving out $name (disableExtensions)"
		shopt -u nocasematch
		continue
	fi
	shopt -u nocasematch
	ln -s "${dir%/}" "$plugins/$name"
done
mkdir -p "$plugins/axis-test.extension-matrix-probe-theia"
cp "$proto_dir/probe-plugin/package.json" "$proto_dir/probe-plugin/main.js" \
	"$matrix_dir/probe/runner.js" "$matrix_dir/probe/logic.js" \
	"$plugins/axis-test.extension-matrix-probe-theia/"

log "$id: starting Theia (timeout ${timeout_s}s)"
rc=0
AXIS_MATRIX_SCENARIO_FILE="$work/scenario.json" AXIS_MATRIX_RESULT="$work/result.json" \
	node "$proto_dir/scripts/run-app.mjs" --workspace "$ws" --plugins "$plugins" --config-dir "$config" \
	--port "$port" --result "$work/result.json" --timeout-ms "$((timeout_s * 1000))" \
	--out "$work/metrics.json" >/dev/null 2>"$work/run-app.stderr" || rc=$?

if [[ -f "$work/result.json" ]]; then
	status="$(jq -r '.status' "$work/result.json")"
	jq -r '.checks[]? | "  \(.status)\t\(.check)\t\(.detail)"' "$work/result.json" >&2
else
	status="no-result (run-app exit $rc)"
fi
log "$id: $status"
