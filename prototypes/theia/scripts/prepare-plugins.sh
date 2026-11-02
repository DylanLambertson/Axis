#!/usr/bin/env bash
# Prepares the plugins/ directory of the Theia prototype:
#   1. test/extension-matrix/fetch.sh downloads and sha256-verifies the pinned
#      Open VSX extensions for this platform (core tier);
#   2. the VS Code built-ins listed in builtins.json are downloaded into
#      .vsix-cache/ and checked against their pinned sha256;
#   3. every verified VSIX is unpacked into plugins/<id>/ (data only: nothing
#      in the archives is executed by this script).
# Usage: prepare-plugins.sh [--only id1,id2,...] [--no-builtins] [--no-matrix]
set -euo pipefail

proto_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$proto_dir/../.." && pwd)"
matrix_dir="$repo_dir/test/extension-matrix"
# shellcheck source-path=SCRIPTDIR source=../../../test/extension-matrix/lib.sh
source "$matrix_dir/lib.sh"

builtins_manifest="$proto_dir/builtins.json"
builtins_cache="$proto_dir/.vsix-cache"
plugins_dir="$proto_dir/plugins"

only=""
with_builtins=1
with_matrix=1
while (($# > 0)); do
	case "$1" in
	--only)
		(($# >= 2)) || die "--only needs a value"
		only=",$2,"
		shift 2
		;;
	--no-builtins)
		with_builtins=0
		shift
		;;
	--no-matrix)
		with_matrix=0
		shift
		;;
	*) die "unknown argument: $1" ;;
	esac
done

require_cmd jq curl unzip
platform="$(detect_platform)"

wanted() {
	[[ -z "$only" || "$only" == *",$1,"* ]]
}

unpack() {
	local id="$1" file="$2" dest="$plugins_dir/$1"
	[[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "unsafe extension id: $id"
	# Refuse archives with absolute or parent-relative entry names.
	if unzip -Z1 "$file" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
		die "$id: archive contains unsafe paths"
	fi
	rm -rf "$dest"
	mkdir -p "$dest"
	unzip -q "$file" -d "$dest"
	[[ -f "$dest/extension/package.json" ]] || die "$id: no extension/package.json in $file"
	log "unpacked $id"
}

mkdir -p "$plugins_dir"

if ((with_matrix)); then
	bash "$matrix_dir/fetch.sh" --platform "$platform" --tier core
	while IFS=$'\t' read -r id version art_platform _url _sha; do
		wanted "$id" || continue
		unpack "$id" "$(artifact_file "$id" "$version" "$art_platform")"
	done < <(select_artifacts "$platform" core)
fi

if ((with_builtins)); then
	mkdir -p "$builtins_cache"
	while IFS=$'\t' read -r id url sha; do
		wanted "$id" || continue
		[[ "$url" == https://github.com/eclipse-theia/vscode-builtin-extensions/releases/download/* ]] ||
			die "$id: unexpected url $url"
		file="$builtins_cache/$id.vsix"
		if [[ ! -f "$file" || "$(sha256_of "$file")" != "$sha" ]]; then
			curl -fsSL --retry 2 -o "$file.part" "$url"
			mv "$file.part" "$file"
		fi
		actual="$(sha256_of "$file")"
		if [[ "$actual" != "$sha" ]]; then
			rm -f "$file"
			die "$id: sha256 mismatch (expected $sha, got $actual)"
		fi
		log "ok      $id (builtin 1.108.2)"
		unpack "$id" "$file"
	done < <(jq -r '.extensions[] | [.id, .url, .sha256] | @tsv' "$builtins_manifest")
fi

log "plugins ready in $plugins_dir"
