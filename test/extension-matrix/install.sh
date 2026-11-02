#!/usr/bin/env bash
# Installs the pinned, sha256-verified VSIXs into an isolated extensions
# directory using an Axis command-line launcher, then checks that the
# installed set is exactly the pinned set.
#
# PENDING M2: needs a built Axis. Point AXIS_CLI at the desktop CLI launcher
# (for example <build>/bin/axis) or, with --server, at the reh/reh-web server
# launcher (<server>/bin/<serverApplicationName>).
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
	cat <<'EOF'
Usage: AXIS_CLI=<launcher> install.sh [--platform <target>] [--tier core|optional|all]
                                      [--extensions-dir <dir>] [--server]

  --platform        Target platform of the VSIXs (default: this machine).
  --tier            core (default; includes supporting extensions), optional, all.
  --extensions-dir  Destination (default: .work/extensions-<platform>-<tier>).
  --server          AXIS_CLI is a server launcher; skip --user-data-dir.

Every VSIX is installed with --do-not-include-pack-dependencies so that no
dependency or pack member is resolved from a gallery behind the pins.
EOF
}

platform=""
tier="core"
ext_dir=""
server=0
while (($# > 0)); do
	case "$1" in
	--platform)
		(($# >= 2)) || die "--platform needs a value"
		platform="$2"
		shift 2
		;;
	--tier)
		(($# >= 2)) || die "--tier needs a value"
		tier="$2"
		shift 2
		;;
	--extensions-dir)
		(($# >= 2)) || die "--extensions-dir needs a value"
		ext_dir="$2"
		shift 2
		;;
	--server)
		server=1
		shift
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
[[ -n "${AXIS_CLI:-}" ]] || die "AXIS_CLI is not set (pending M2: no Axis build exists yet)"
[[ -x "$AXIS_CLI" ]] || die "AXIS_CLI is not executable: $AXIS_CLI"
[[ -n "$platform" ]] || platform="$(detect_platform)"
[[ "$platform" != "all" ]] || die "install needs one concrete platform"
validate_platform "$platform"
validate_tier "$tier"
[[ -n "$ext_dir" ]] || ext_dir="$WORK_ROOT/extensions-$platform-$tier"

# Verify (and if needed download) the pinned artifacts before installing.
"$MATRIX_DIR/fetch.sh" --platform "$platform" --tier "$tier"

mkdir -p "$ext_dir"
cli_args=(--extensions-dir "$ext_dir")
if ((server == 0)); then
	mkdir -p "$WORK_ROOT/install-user-data"
	cli_args+=(--user-data-dir "$WORK_ROOT/install-user-data")
fi

rows="$(select_artifacts "$platform" "$tier")"
[[ -n "$rows" ]] || die "no artifacts selected for platform=$platform tier=$tier"
expected=()
while IFS=$'\t' read -r id version art_platform url sha; do
	[[ "$art_platform" != "MISSING" ]] || die "$id@$version has no artifact for $platform"
	validate_artifact_row "$id" "$version" "$art_platform" "$url" "$sha"
	vsix="$(artifact_file "$id" "$version" "$art_platform")"
	# Re-check right before use; the cache directory is writable by the user.
	[[ "$(sha256_of "$vsix")" == "$sha" ]] || die "sha256 changed since fetch: $vsix"
	log "install $id@$version ($art_platform)"
	"$AXIS_CLI" "${cli_args[@]}" --install-extension "$vsix" \
		--do-not-include-pack-dependencies --force </dev/null
	expected+=("$(printf '%s@%s' "$id" "$version" | tr '[:upper:]' '[:lower:]')")
done <<<"$rows"

actual="$("$AXIS_CLI" "${cli_args[@]}" --list-extensions --show-versions | tr '[:upper:]' '[:lower:]' | sort -u)"
wanted="$(printf '%s\n' "${expected[@]}" | sort -u)"

if [[ "$actual" != "$wanted" ]]; then
	log "installed set differs from the pins:"
	diff <(printf '%s\n' "$wanted") <(printf '%s\n' "$actual") >&2 || true
	die "extension set mismatch in $ext_dir"
fi
log "installed ${#expected[@]} pinned extensions into $ext_dir"
printf '%s\n' "$ext_dir"
