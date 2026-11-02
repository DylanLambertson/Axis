#!/usr/bin/env bash
# Downloads the pinned extension VSIXs listed in extensions.json into an
# ignored cache directory and verifies each file's sha256. Exits non-zero on
# any download failure or checksum mismatch. Downloaded files are data only:
# this script never unpacks or executes them.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
	cat <<'EOF'
Usage: fetch.sh [--platform <target>|all] [--tier core|optional|all] [--dest <dir>]

  --platform  Open VSX target platform to fetch (default: this machine).
              One of darwin-x64, darwin-arm64, linux-x64, win32-x64, all.
  --tier      core (default; includes supporting extensions), optional, all.
  --dest      Cache directory (default: test/extension-matrix/.vsix-cache).

Files already in the cache are re-hashed and kept only if they match.
EOF
}

platform=""
tier="core"
while (($# > 0)); do
	case "$1" in
	--platform)
		(($# >= 2)) || die "--platform needs a value"
		platform="${2:-}"
		shift 2
		;;
	--tier)
		(($# >= 2)) || die "--tier needs a value"
		tier="${2:-}"
		shift 2
		;;
	--dest)
		(($# >= 2)) || die "--dest needs a value"
		CACHE_DIR="${2:-}"
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

require_cmd jq curl
[[ -n "$platform" ]] || platform="$(detect_platform)"
validate_platform "$platform"
validate_tier "$tier"
[[ -n "$CACHE_DIR" ]] || die "--dest needs a directory"
[[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST"

mkdir -p "$CACHE_DIR"
rows="$(select_artifacts "$platform" "$tier")"
[[ -n "$rows" ]] || die "no artifacts selected for platform=$platform tier=$tier"

fetched=0
reused=0
while IFS=$'\t' read -r id version art_platform url sha; do
	if [[ "$art_platform" == "MISSING" ]]; then
		die "$id@$version has no artifact for $platform (and no universal fallback)"
	fi
	validate_artifact_row "$id" "$version" "$art_platform" "$url" "$sha"
	dest="$(artifact_file "$id" "$version" "$art_platform")"

	if [[ -f "$dest" ]]; then
		if [[ "$(sha256_of "$dest")" == "$sha" ]]; then
			log "ok      $id@$version ($art_platform) [cached]"
			reused=$((reused + 1))
			continue
		fi
		log "stale   $id@$version ($art_platform): cached file does not match, downloading again"
		rm -f "$dest"
	fi

	tmp="$dest.partial"
	rm -f "$tmp"
	if ! curl --fail --location --silent --show-error \
		--proto '=https' --proto-redir '=https' \
		--retry 3 --connect-timeout 20 --max-time 900 \
		--output "$tmp" "$url"; then
		rm -f "$tmp"
		die "download failed: $url"
	fi

	actual="$(sha256_of "$tmp")"
	if [[ "$actual" != "$sha" ]]; then
		rm -f "$tmp"
		die "sha256 mismatch for $id@$version ($art_platform): expected $sha, got $actual"
	fi
	mv "$tmp" "$dest"
	log "ok      $id@$version ($art_platform) [downloaded]"
	fetched=$((fetched + 1))
done <<<"$rows"

log "verified $((fetched + reused)) artifacts ($fetched downloaded, $reused cached) in $CACHE_DIR"
