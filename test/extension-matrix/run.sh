#!/usr/bin/env bash
# Runs extension matrix scenarios against an Axis desktop build.
#
# For each scenario it copies the fixture into a fresh work directory, prepares
# it (git history, npm packages), writes isolated user settings, and launches
# Axis as an extension test host with the probe extension:
#   --extensionDevelopmentPath=probe --extensionTestsPath=probe/runner.js
# The probe drives the installed extensions through the vscode API and writes
# result.json. Optionally (--activation-scan) the scenario is then opened in a
# normal window and scan-report.js attributes proposed-API and activation errors
# in its logs to the scenario's extensions. --proposed-api-scan opens one normal
# window with the full installed set and writes the per-extension table for D1.
#
# PENDING M2: needs a built Axis. Set AXIS_APP to the Electron executable of a
# packaged build and install the pinned extensions first with install.sh.
# The scans refuse a dev launcher (scripts/code.*, or VSCODE_DEV set): a
# development build allows every proposed API (extensionsProposedApi.ts:34-36,
# environmentService.ts:231), so the scan would measure nothing. Timeouts signal
# only the direct child process, so AXIS_APP should be the Electron binary, not
# a wrapper script. Web mode is pending (see
# docs/feasibility/extension-compatibility.md).
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
	cat <<'EOF'
Usage: AXIS_APP=<executable> run.sh (--scenario <id> | --all | --proposed-api-scan <s>) [options]

  --scenario <id>        Run one scenario from scenarios.json.
  --all                  Run every scenario of --tier (default core).
  --tier <tier>          core (default), optional or all; used with --all.
  --mode desktop|web     Host to test (default desktop; web is pending).
  --extensions-dir <dir> Installed pinned extensions
                         (default: .work/extensions-<platform>-<tier>).
  --timeout <seconds>    Per-scenario limit for the test host (default 900).
  --activation-scan <s>  After each scenario, open its fixture (and checked
                         files) in a normal window for <s> seconds and report
                         errors that name the scenario's extensions:
                         clean, findings, inconclusive, no-logs or error.
  --proposed-api-scan <s>
                         Open one normal window with the full installed set
                         for <s> seconds and write the per-extension
                         proposed-API table (proposed-api.tsv) for decision D1.

Both scans need a packaged build and node.

Exit status: 0 if every selected scenario passed, 1 otherwise.
EOF
}

scenario_id=""
run_all=0
tier="core"
mode="desktop"
ext_dir=""
timeout_s=900
scan_s=0
papi_s=0
while (($# > 0)); do
	case "$1" in
	--scenario)
		(($# >= 2)) || die "--scenario needs a value"
		scenario_id="$2"
		shift 2
		;;
	--all)
		run_all=1
		shift
		;;
	--tier)
		(($# >= 2)) || die "--tier needs a value"
		tier="$2"
		shift 2
		;;
	--mode)
		(($# >= 2)) || die "--mode needs a value"
		mode="$2"
		shift 2
		;;
	--extensions-dir)
		(($# >= 2)) || die "--extensions-dir needs a value"
		ext_dir="$2"
		shift 2
		;;
	--timeout)
		(($# >= 2)) || die "--timeout needs a value"
		timeout_s="$2"
		shift 2
		;;
	--activation-scan)
		(($# >= 2)) || die "--activation-scan needs a value"
		scan_s="$2"
		shift 2
		;;
	--proposed-api-scan)
		(($# >= 2)) || die "--proposed-api-scan needs a value"
		papi_s="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		die "unknown argument: $1"
		;;
	esac
done

require_cmd jq
validate_tier "$tier"
[[ "$timeout_s" =~ ^[0-9]+$ ]] || die "--timeout must be a number of seconds"
[[ "$scan_s" =~ ^[0-9]+$ ]] || die "--activation-scan must be a number of seconds"
[[ "$papi_s" =~ ^[0-9]+$ ]] || die "--proposed-api-scan must be a number of seconds"
case "$mode" in
desktop) ;;
web) die "web mode is pending: it needs an Axis reh-web build and a browser runner (see docs/feasibility/extension-compatibility.md)" ;;
*) die "unknown mode: $mode" ;;
esac
((run_all == 1)) || [[ -n "$scenario_id" ]] || ((papi_s > 0)) || {
	usage >&2
	die "pass --scenario <id>, --all or --proposed-api-scan <s>"
}
[[ -n "${AXIS_APP:-}" ]] || die "AXIS_APP is not set (pending M2: no Axis build exists yet)"
[[ -x "$AXIS_APP" ]] || die "AXIS_APP is not executable: $AXIS_APP"

# The scans measure proposed-API restriction, which only a packaged build
# applies. A development build allows every proposal, so a scan of it would
# report nothing.
if ((scan_s > 0 || papi_s > 0)); then
	[[ -z "${VSCODE_DEV:-}" ]] || die "scans need a packaged build: VSCODE_DEV is set, which makes the build allow every proposed API"
	case "$AXIS_APP" in
	*/scripts/code* | scripts/code*) die "scans need a packaged build, not the dev launcher $AXIS_APP (it sets VSCODE_DEV)" ;;
	esac
	require_cmd node
fi

platform="$(detect_platform)"
[[ -n "$ext_dir" ]] || ext_dir="$WORK_ROOT/extensions-$platform-$tier"
[[ -d "$ext_dir" ]] || die "extensions directory not found: $ext_dir (run install.sh first)"

run_root="$WORK_ROOT/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$run_root"
: >"$run_root/summary.tsv"

# Runs a command in the background and kills it after <seconds>.
# Returns the command's exit status, or 124 on timeout.
run_with_timeout() {
	local seconds="$1"
	shift
	"$@" &
	local pid=$! waited=0
	while kill -0 "$pid" 2>/dev/null; do
		if ((waited >= seconds)); then
			kill "$pid" 2>/dev/null || true
			sleep 5
			kill -9 "$pid" 2>/dev/null || true
			wait "$pid" 2>/dev/null || true
			return 124
		fi
		sleep 1
		waited=$((waited + 1))
	done
	wait "$pid"
}

scenario_json() {
	jq -e --arg id "$1" '.scenarios[] | select(.id == $id)' "$SCENARIOS"
}

# Checks the scenario fields that this script reads before any of them is used
# in a path or a command. probe/logic.js validateScenario checks the same
# fields plus the checks; tests/manifest.test.js runs it on every scenario.
validate_scenario_file() {
	jq -e '
		(.fixture | type == "string" and test("^[a-z0-9-]+$"))
		and (.requires | type == "array" and all(.[]; type == "string" and test("^[A-Za-z0-9._+-]+$")))
		and (.setup | type == "array" and all(.[]; . == "git-init" or . == "npm-install"))
		and (.settings | type == "object")
		and (.extensions | type == "array" and all(.[]; type == "string"))
		and (.disableExtensions | type == "array" and all(.[]; type == "string" and test("^[A-Za-z0-9-]+\\.[A-Za-z0-9.-]+$")))
		and ([.checks[]? | .file? // empty] | all(.[]; type == "string" and (startswith("/") | not) and (split("/") | index("..") | not)))
	' "$1" >/dev/null
}

# Writes user settings: baseSettings merged with the scenario's settings, with
# tool-path tokens replaced by absolute paths found on PATH.
write_settings() {
	local id="$1" dest="$2"
	mkdir -p "$(dirname "$dest")"
	jq --arg id "$id" \
		--arg py "$(command -v python3 || true)" \
		--arg gopls "$(command -v gopls || true)" \
		--arg clangd "$(command -v clangd || true)" '
		.baseSettings * (.scenarios[] | select(.id == $id) | .settings)
		| walk(if type == "string"
			then gsub("@PYTHON@"; $py) | gsub("@GOPLS@"; $gopls) | gsub("@CLANGD@"; $clangd)
			else . end)
	' "$SCENARIOS" >"$dest"
}

setup_git() {
	local ws="$1"
	local -a git_id=(-c user.name="Axis Matrix" -c user.email=matrix@example.invalid -c commit.gpgsign=false)
	# Ignore the user's global and system Git config (hooks, templates).
	# git init -b needs Git 2.28 or later.
	export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
	export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
	git -C "$ws" init -q -b main
	git -C "$ws" "${git_id[@]}" add -A
	git -C "$ws" "${git_id[@]}" commit -q -m "Add fixture files"
	printf 'second line\n' >>"$ws/notes.txt"
	export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"
	git -C "$ws" "${git_id[@]}" commit -q -am "Extend notes"
	unset GIT_AUTHOR_DATE GIT_COMMITTER_DATE GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
}

setup_npm() {
	local ws="$1"
	# package-lock.json pins every package with an integrity hash.
	# Install scripts are disabled.
	(cd "$ws" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
}

# Prints the --disable-extension arguments of a scenario, one per line.
disable_args() {
	jq -r '.disableExtensions[] | "--disable-extension=" + .' "$1"
}

# Launches a normal (non-development) window and analyses its logs with
# scan-report.js. Prints the status word.
#   $1 workspace  $2 user-data dir  $3 output dir  $4 seconds
#   $5 scenario file or "" (full-set scan)  remaining: extra app arguments
normal_window_scan() {
	local ws="$1" user_data="$2" out="$3" seconds="$4" scenario_file="$5"
	shift 5
	mkdir -p "$out"
	run_with_timeout "$seconds" "$AXIS_APP" "$ws" "$@" \
		--user-data-dir "$user_data" --extensions-dir "$ext_dir" --logsPath "$out/logs" \
		--skip-welcome --skip-release-notes --disable-telemetry --disable-updates \
		--disable-workspace-trust --disable-experiments --new-window \
		>"$out/stdout.log" 2>&1 || true
	local -a report_args=(--logs "$out/logs" --extensions-dir "$ext_dir" --out "$out")
	[[ -z "$scenario_file" ]] || report_args+=(--scenario-file "$scenario_file")
	local status
	status="$(node "$MATRIX_DIR/scan-report.js" "${report_args[@]}" 2>"$out/scan-report.stderr")" || status="error"
	printf '%s\n' "$status"
}

activation_scan() {
	local ws="$1" work="$2"
	local -a extra=()
	local arg lines
	# Open the files the checks use, so onLanguage activation events fire.
	lines="$(jq -r '[.checks[] | .file? // empty] | unique | .[]' "$work/scenario.json")" || die "cannot read checks from $work/scenario.json"
	while IFS= read -r arg; do
		[[ -z "$arg" ]] || extra+=("$ws/$arg")
	done <<<"$lines"
	lines="$(disable_args "$work/scenario.json")" || die "cannot read disableExtensions from $work/scenario.json"
	while IFS= read -r arg; do
		[[ -z "$arg" ]] || extra+=("$arg")
	done <<<"$lines"
	log "  activation scan: normal window for ${scan_s}s"
	normal_window_scan "$ws" "$work/user-data" "$work/scan" "$scan_s" "$work/scenario.json" ${extra[@]+"${extra[@]}"}
}

# One normal window with every installed extension and no scenario: the
# per-extension proposed-API table for decision D1.
proposed_api_scan() {
	local dir="$run_root/proposed-api-scan" status
	mkdir -p "$dir/workspace" "$dir/user-data/User"
	jq '.baseSettings' "$SCENARIOS" >"$dir/user-data/User/settings.json"
	log "proposed-api-scan: normal window with the full installed set for ${papi_s}s"
	status="$(normal_window_scan "$dir/workspace" "$dir/user-data" "$dir" "$papi_s" "")"
	log "proposed-api-scan: $status (table: $dir/proposed-api.tsv)"
	printf 'proposed-api-scan\t%s\tsee proposed-api.tsv\t%s\n' "$status" "$dir" >>"$run_root/summary.tsv"
	[[ "$status" == "complete" ]]
}

run_scenario() {
	local id="$1"
	local work="$run_root/$id" ws status scan="not run"
	local -a missing=() extra=()
	local lines
	mkdir -p "$work"
	scenario_json "$id" >"$work/scenario.json" || die "unknown scenario: $id"
	validate_scenario_file "$work/scenario.json" || die "$id: scenario fields are missing or malformed"

	local tool
	lines="$(jq -r '.requires[]' "$work/scenario.json")" || die "$id: cannot read requires"
	while IFS= read -r tool; do
		[[ -z "$tool" ]] || command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
	done <<<"$lines"
	if ((${#missing[@]} > 0)); then
		log "$id: blocked, missing host tools: ${missing[*]}"
		printf '%s\tblocked\tmissing: %s\t%s\n' "$id" "${missing[*]}" "$work" >>"$run_root/summary.tsv"
		return 1
	fi

	ws="$work/workspace"
	mkdir -p "$ws"
	local fixture
	fixture="$(jq -r '.fixture' "$work/scenario.json")" || die "$id: cannot read fixture"
	[[ -d "$MATRIX_DIR/fixtures/$fixture" ]] || die "$id: fixture not found: $fixture"
	cp -R "$MATRIX_DIR/fixtures/$fixture/." "$ws/"
	local step
	lines="$(jq -r '.setup[]' "$work/scenario.json")" || die "$id: cannot read setup"
	while IFS= read -r step; do
		case "$step" in
		"") ;;
		git-init) setup_git "$ws" ;;
		npm-install) setup_npm "$ws" ;;
		*) die "$id: unknown setup step '$step'" ;;
		esac
	done <<<"$lines"

	write_settings "$id" "$work/user-data/User/settings.json"
	local arg
	lines="$(disable_args "$work/scenario.json")" || die "$id: cannot read disableExtensions"
	while IFS= read -r arg; do
		[[ -z "$arg" ]] || extra+=("$arg")
	done <<<"$lines"

	log "$id: launching extension test host (timeout ${timeout_s}s)"
	local rc=0
	run_with_timeout "$timeout_s" env \
		AXIS_MATRIX_SCENARIO_FILE="$work/scenario.json" \
		AXIS_MATRIX_RESULT="$work/result.json" \
		"$AXIS_APP" "$ws" \
		--user-data-dir "$work/user-data" --extensions-dir "$ext_dir" \
		--logsPath "$work/logs" --crash-reporter-directory "$work/crashes" \
		--extensionDevelopmentPath="$MATRIX_DIR/probe" \
		--extensionTestsPath="$MATRIX_DIR/probe/runner.js" \
		--skip-welcome --skip-release-notes --disable-telemetry --disable-updates \
		--disable-workspace-trust --disable-experiments --no-cached-data ${extra[@]+"${extra[@]}"} \
		>"$work/stdout.log" 2>&1 || rc=$?

	if ((rc == 124)); then
		status="timeout"
	elif [[ -f "$work/result.json" ]]; then
		status="$(jq -r '.status' "$work/result.json")"
		jq -r '.checks[] | "  \(.status)\t\(.check)\t\(.detail)"' "$work/result.json" >&2
	else
		status="error (exit $rc, no result.json; see $work/stdout.log)"
	fi

	if ((scan_s > 0)); then
		scan="$(activation_scan "$ws" "$work")"
	fi
	log "$id: $status; activation scan: $scan"
	printf '%s\t%s\tactivation-scan: %s\t%s\n' "$id" "$status" "$scan" "$work" >>"$run_root/summary.tsv"
	[[ "$status" == "passed" ]]
}

ids=()
if ((run_all == 1)); then
	selected="$(jq -r --arg tier "$tier" '.scenarios[] | select($tier == "all" or .tier == $tier) | .id' "$SCENARIOS")" || die "cannot read $SCENARIOS"
	while IFS= read -r id; do
		[[ -z "$id" ]] || ids+=("$id")
	done <<<"$selected"
	((${#ids[@]} > 0)) || die "no scenarios selected"
elif [[ -n "$scenario_id" ]]; then
	ids=("$scenario_id")
fi
for id in ${ids[@]+"${ids[@]}"}; do
	scenario_json "$id" >/dev/null || die "unknown scenario: $id"
done

failures=0
if ((papi_s > 0)); then
	set +e
	(
		set -e
		proposed_api_scan
	)
	rc=$?
	set -e
	((rc == 0)) || failures=$((failures + 1))
fi

# Each scenario runs in a subshell with errexit active. Calling it from an
# "||" list would silently disable errexit inside the function.
for id in ${ids[@]+"${ids[@]}"}; do
	set +e
	(
		set -e
		run_scenario "$id"
	)
	rc=$?
	set -e
	if ((rc != 0)); then
		failures=$((failures + 1))
		# A setup or harness step failed before the scenario recorded a status.
		if ! cut -f1 "$run_root/summary.tsv" | grep -qxF "$id"; then
			log "$id: error (harness or fixture setup failed, exit $rc)"
			printf '%s\terror\tharness or setup failed (exit %s)\t%s\n' "$id" "$rc" "$run_root/$id" >>"$run_root/summary.tsv"
		fi
	fi
done

log "summary: $run_root/summary.tsv"
cat "$run_root/summary.tsv"
((failures == 0))
