#!/usr/bin/env bash
# Runs extension matrix scenarios against an Axis desktop build.
#
# For each scenario it copies the fixture into a fresh work directory, prepares
# it (git history, npm packages), writes isolated user settings, and launches
# Axis as an extension test host with the probe extension:
#   --extensionDevelopmentPath=probe --extensionTestsPath=probe/runner.js
# The probe drives the installed extensions through the vscode API and writes
# result.json. Optionally (--activation-scan) the scenario is then opened in a
# normal window and the logs are scanned for proposed-API and activation errors.
#
# PENDING M2: needs a built Axis. Set AXIS_APP to the Electron executable (or
# a dev launcher such as <checkout>/scripts/code.sh) and install the pinned
# extensions first with install.sh. Web mode is pending (see
# docs/feasibility/extension-compatibility.md).
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
	cat <<'EOF'
Usage: AXIS_APP=<executable> run.sh (--scenario <id> | --all) [options]

  --scenario <id>        Run one scenario from scenarios.json.
  --all                  Run every scenario of --tier (default core).
  --tier <tier>          core (default), optional or all; used with --all.
  --mode desktop|web     Host to test (default desktop; web is pending).
  --extensions-dir <dir> Installed pinned extensions
                         (default: .work/extensions-<platform>-<tier>).
  --timeout <seconds>    Per-scenario limit for the test host (default 900).
  --activation-scan <s>  Also open a normal window for <s> seconds and scan
                         its logs for proposed-API and activation errors.

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
case "$mode" in
desktop) ;;
web) die "web mode is pending: it needs an Axis reh-web build and a browser runner (see docs/feasibility/extension-compatibility.md)" ;;
*) die "unknown mode: $mode" ;;
esac
((run_all == 1)) || [[ -n "$scenario_id" ]] || {
	usage >&2
	die "pass --scenario <id> or --all"
}
[[ -n "${AXIS_APP:-}" ]] || die "AXIS_APP is not set (pending M2: no Axis build exists yet)"
[[ -x "$AXIS_APP" ]] || die "AXIS_APP is not executable: $AXIS_APP"

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
	export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
	git -C "$ws" init -q -b main
	git -C "$ws" "${git_id[@]}" add -A
	git -C "$ws" "${git_id[@]}" commit -q -m "Add fixture files"
	printf 'second line\n' >>"$ws/notes.txt"
	export GIT_AUTHOR_DATE="2026-01-02T00:00:00Z" GIT_COMMITTER_DATE="2026-01-02T00:00:00Z"
	git -C "$ws" "${git_id[@]}" commit -q -am "Extend notes"
	unset GIT_AUTHOR_DATE GIT_COMMITTER_DATE
}

setup_npm() {
	local ws="$1"
	# package-lock.json pins every package with an integrity hash.
	# Install scripts are disabled.
	(cd "$ws" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
}

# Prints the --disable-extension arguments of a scenario, one per line.
disable_args() {
	jq -r --arg id "$1" '.scenarios[] | select(.id == $id) | .disableExtensions[] | "--disable-extension=" + .' "$SCENARIOS"
}

activation_scan() {
	local ws="$1" work="$2" id="$3"
	local logs="$work/logs-normal" report="$work/activation-scan.txt"
	local -a extra=()
	local arg
	while IFS= read -r arg; do
		[[ -z "$arg" ]] || extra+=("$arg")
	done < <(disable_args "$id")
	log "  activation scan: normal window for ${scan_s}s"
	run_with_timeout "$scan_s" "$AXIS_APP" "$ws" \
		--user-data-dir "$work/user-data" --extensions-dir "$ext_dir" --logsPath "$logs" \
		--skip-welcome --skip-release-notes --disable-telemetry --disable-updates \
		--disable-workspace-trust --disable-experiments --new-window ${extra[@]+"${extra[@]}"} \
		>"$work/normal.stdout.log" 2>&1 || true
	if [[ ! -d "$logs" ]]; then
		echo "no logs written to $logs" >"$report"
		echo "no logs"
	elif grep -rhE "CANNOT USE these API proposals|Activating extension .* failed|Cannot activate the '" "$logs" >"$report" 2>/dev/null; then
		log "  activation scan: findings in $report"
		echo findings
	else
		echo "no matching log lines" >"$report"
		echo clean
	fi
}

run_scenario() {
	local id="$1"
	local work="$run_root/$id" ws status scan="not run"
	local -a missing=() extra=()
	scenario_json "$id" >/dev/null || die "unknown scenario: $id"
	mkdir -p "$work"
	scenario_json "$id" >"$work/scenario.json"

	local tool
	while IFS= read -r tool; do
		[[ -z "$tool" ]] || command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
	done < <(jq -r '.requires[]' "$work/scenario.json")
	if ((${#missing[@]} > 0)); then
		log "$id: blocked, missing host tools: ${missing[*]}"
		printf '%s\tblocked\tmissing: %s\t%s\n' "$id" "${missing[*]}" "$work" >>"$run_root/summary.tsv"
		return 1
	fi

	ws="$work/workspace"
	mkdir -p "$ws"
	cp -R "$MATRIX_DIR/fixtures/$(jq -r '.fixture' "$work/scenario.json")/." "$ws/"
	local step
	while IFS= read -r step; do
		case "$step" in
		"") ;;
		git-init) setup_git "$ws" ;;
		npm-install) setup_npm "$ws" ;;
		*) die "$id: unknown setup step '$step'" ;;
		esac
	done < <(jq -r '.setup[]' "$work/scenario.json")

	write_settings "$id" "$work/user-data/User/settings.json"
	local arg
	while IFS= read -r arg; do
		[[ -z "$arg" ]] || extra+=("$arg")
	done < <(disable_args "$id")

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
		scan="$(activation_scan "$ws" "$work" "$id")"
	fi
	log "$id: $status; activation scan: $scan"
	printf '%s\t%s\tactivation-scan: %s\t%s\n' "$id" "$status" "$scan" "$work" >>"$run_root/summary.tsv"
	[[ "$status" == "passed" ]]
}

ids=()
if ((run_all == 1)); then
	while IFS= read -r id; do
		ids+=("$id")
	done < <(jq -r --arg tier "$tier" '.scenarios[] | select($tier == "all" or .tier == $tier) | .id' "$SCENARIOS")
else
	ids=("$scenario_id")
fi
((${#ids[@]} > 0)) || die "no scenarios selected"
for id in "${ids[@]}"; do
	scenario_json "$id" >/dev/null || die "unknown scenario: $id"
done

# Each scenario runs in a subshell with errexit active. Calling it from an
# "||" list would silently disable errexit inside the function.
failures=0
for id in "${ids[@]}"; do
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
