# Shared helpers for the extension compatibility matrix scripts.
# Sourced by fetch.sh, install.sh and run.sh; not executable on its own.
# shellcheck shell=bash

# The variables below are used by the scripts that source this file.
# shellcheck disable=SC2034
MATRIX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034
MANIFEST="${MATRIX_MANIFEST:-$MATRIX_DIR/extensions.json}"
# shellcheck disable=SC2034
SCENARIOS="${MATRIX_SCENARIOS:-$MATRIX_DIR/scenarios.json}"
# shellcheck disable=SC2034
CACHE_DIR="${MATRIX_CACHE_DIR:-$MATRIX_DIR/.vsix-cache}"
# shellcheck disable=SC2034
WORK_ROOT="${MATRIX_WORK_DIR:-$MATRIX_DIR/.work}"

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

log() {
	printf '%s\n' "$*" >&2
}

require_cmd() {
	local cmd
	for cmd in "$@"; do
		command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
	done
}

# Prints the Open VSX target platform of this machine, e.g. darwin-arm64.
detect_platform() {
	local os arch
	case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	MINGW* | MSYS* | CYGWIN*) os=win32 ;;
	*) die "unsupported operating system: $(uname -s)" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) die "unsupported architecture: $(uname -m)" ;;
	esac
	printf '%s-%s\n' "$os" "$arch"
}

validate_platform() {
	case "$1" in
	all | darwin-x64 | darwin-arm64 | linux-x64 | win32-x64) ;;
	*) die "unsupported platform '$1' (expected darwin-x64, darwin-arm64, linux-x64, win32-x64 or all)" ;;
	esac
}

validate_tier() {
	case "$1" in
	core | optional | all) ;;
	*) die "unsupported tier '$1' (expected core, optional or all)" ;;
	esac
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		die "neither sha256sum nor shasum is available"
	fi
}

# Local file name for a pinned artifact: <id>-<version>@<platform>.vsix
artifact_file() {
	printf '%s/%s-%s@%s.vsix\n' "$CACHE_DIR" "$1" "$2" "$3"
}

# Prints one tab-separated line per artifact to fetch or install:
#   id  version  platform  url  sha256
# For a concrete platform it selects the platform-specific artifact when one
# exists and falls back to the universal one. An extension with neither is
# printed with platform MISSING so callers can fail loudly.
# Tier "core" is the core and supporting extensions. Tier "optional" is the
# optional extensions plus the core set, because optional scenarios depend on
# core extensions (S14 needs ms-python.python); it selects the same set as
# "all".
select_artifacts() {
	local platform="$1" tier="$2"
	jq -r --arg plat "$platform" --arg tier "$tier" '
		.extensions[]
		| select($tier == "all" or $tier == "optional"
			or .tier == "core" or .tier == "supporting")
		| . as $e
		| (if $plat == "all" then .artifacts
		   else ([.artifacts[] | select(.platform == $plat)]) as $exact
		     | if ($exact | length) > 0 then $exact
		       else [.artifacts[] | select(.platform == "universal")] end
		   end) as $picked
		| if ($picked | length) == 0 then [$e.id, $e.version, "MISSING", "", ""]
		  else ($picked[] | [$e.id, $e.version, .platform, .url, .sha256]) end
		| @tsv
	' "$MANIFEST"
}

# Rejects manifest rows that are not well-formed before they reach curl or
# the file system.
validate_artifact_row() {
	local id="$1" version="$2" platform="$3" url="$4" sha="$5"
	[[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "invalid extension id in manifest: $id"
	[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid version for $id: $version"
	[[ "$platform" =~ ^(universal|darwin-x64|darwin-arm64|linux-x64|win32-x64)$ ]] || die "invalid platform for $id: $platform"
	[[ "$url" =~ ^https://(open-vsx\.org/api/|github\.com/vadimcn/codelldb/releases/download/) ]] || die "unexpected download host for $id: $url"
	[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "invalid sha256 for $id: $sha"
}
