# shellcheck shell=bash
# shellcheck disable=SC2034 # variables are used by the scripts that source this file
# Shared helpers for the Code OSS build scripts. Source this file; do not run it.
#
# Paths are derived from the Axis repository root. AXIS_CODE_OSS_ROOT overrides
# the root; test.sh uses it to point the scripts at a temporary fake repository.
# AXIS_CODE_OSS_VENDOR_DIR and AXIS_CODE_OSS_TOOLS_DIR move vendor/ and .tools/
# elsewhere, which build.sh needs when the repository path contains whitespace.
# Relative values are taken relative to the current directory. AXIS_CODE_OSS_TEST=1
# (set by test.sh) additionally allows file:// upstream repositories.
# Written for bash 3.2 (the macOS system bash): no associative arrays, no mapfile.

export LC_ALL=C

abs_path() {
	case "$1" in
	/*) printf '%s\n' "$1" ;;
	*) printf '%s/%s\n' "$PWD" "$1" ;;
	esac
}

AXIS_ROOT="$(abs_path "${AXIS_CODE_OSS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}")"
MANIFEST="$AXIS_ROOT/code-oss/upstream.json"
PATCHES_DIR="$AXIS_ROOT/code-oss/patches"
OVERLAY_DIR="$AXIS_ROOT/code-oss/overlay"
REPLACE_DIR="$AXIS_ROOT/code-oss/replace"
REMOVALS_FILE="$AXIS_ROOT/code-oss/removals.txt"
HOOKS_DIR="$AXIS_ROOT/code-oss/hooks/post-apply.d"
VENDOR_DIR="$(abs_path "${AXIS_CODE_OSS_VENDOR_DIR:-$AXIS_ROOT/vendor}")"
TREE_DIR="$VENDOR_DIR/code-oss"
STAMP_FILE="$VENDOR_DIR/code-oss.applied"
TOOLS_DIR="$(abs_path "${AXIS_CODE_OSS_TOOLS_DIR:-$AXIS_ROOT/.tools}")"

COMMIT_RE='^[0-9a-f]{40}$'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
TAG_RE='^[A-Za-z0-9._-]+$'
SHA256_RE='^[0-9a-f]{64}$'
PATCH_RE='^[0-9]{4}-[a-z0-9][a-z0-9.-]*\.patch$'
# replace/ may hold only assets: anything under resources/, or images elsewhere.
REPLACE_IMAGE_RE='\.(png|svg|ico|icns|bmp|xpm|jpg|jpeg|gif|webp)$'
# Post-apply hooks may change only these upstream files (by basename).
HOOK_ALLOWED_BASENAMES='package-lock.json npm-shrinkwrap.json'
PATCH_BLOCKS_HELP='0001-0999 shell, 1000-1499 guardrails, 1500-1999 copilot, 2000-2999 security'

# patch_block NAME: prints "<block> <range>" for a NNNN-*.patch name, or fails
# when the number is outside the assigned blocks: the shell layer (ADR 0002
# decision 2), rebrand and licensing guardrails (decision 5), Copilot and agent
# host removal (decision 6), and security hardening (decision 7).
patch_block() {
	local n=$((10#${1:0:4}))
	if [ "$n" -ge 1 ] && [ "$n" -le 999 ]; then
		echo "shell 0001-0999"
	elif [ "$n" -ge 1000 ] && [ "$n" -le 1499 ]; then
		echo "guardrails 1000-1499"
	elif [ "$n" -ge 1500 ] && [ "$n" -le 1999 ]; then
		echo "copilot 1500-1999"
	elif [ "$n" -ge 2000 ] && [ "$n" -le 2999 ]; then
		echo "security 2000-2999"
	else
		return 1
	fi
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

log() {
	printf '==> %s\n' "$*" >&2
}

# Prints the string value of a top-level key in the flat manifest JSON.
manifest_get() {
	local key="$1" value count
	[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
	value="$(sed -n "s/^[[:space:]]*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\"[[:space:]]*,\{0,1\}[[:space:]]*\$/\1/p" "$MANIFEST")"
	count="$(printf '%s' "$value" | grep -c '' || true)"
	[ "$count" = "1" ] || die "manifest key \"$key\" must appear exactly once as a string in $MANIFEST"
	printf '%s\n' "$value"
}

# Sets UPSTREAM_REPO, UPSTREAM_TAG, UPSTREAM_COMMIT and NODE_VERSION, validated.
load_manifest() {
	UPSTREAM_REPO="$(manifest_get repository)"
	UPSTREAM_TAG="$(manifest_get tag)"
	UPSTREAM_COMMIT="$(manifest_get commit)"
	NODE_VERSION="$(manifest_get node)"
	case "$UPSTREAM_REPO" in
	https://*) ;;
	file://*) [ "${AXIS_CODE_OSS_TEST:-}" = 1 ] || die "file:// repositories are accepted only by test.sh (AXIS_CODE_OSS_TEST=1): $UPSTREAM_REPO" ;;
	*) die "manifest repository must be an https:// URL: $UPSTREAM_REPO" ;;
	esac
	[[ "$UPSTREAM_TAG" =~ $TAG_RE ]] || die "manifest tag is not a plain tag name: $UPSTREAM_TAG"
	[[ "$UPSTREAM_COMMIT" =~ $COMMIT_RE ]] || die "manifest commit is not a full 40-character SHA-1: $UPSTREAM_COMMIT"
	[[ "$NODE_VERSION" =~ $VERSION_RE ]] || die "manifest node is not MAJOR.MINOR.PATCH: $NODE_VERSION"
}

lowercase() {
	printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# check_rel_path PATH: dies unless PATH is a safe repository-relative path. It
# must not be absolute or contain empty, "." or ".." components; it may hold
# only printable ASCII without backslash or colon; and no component may be
# one that Git or a case-insensitive (APFS, HFS+, NTFS) filesystem treats as
# the Git directory: ".git" in any case, with trailing dots or spaces, or the
# 8.3 short name "git~1". Colons are refused, which also rules out NTFS
# alternate data streams such as ".git::$INDEX_ALLOCATION".
check_rel_path() {
	local rel="$1" rest comp lc
	case "$rel" in
	'' | /*) die "unsafe path: '$rel'" ;;
	*[![:print:]]* | *\\* | *:*) die "path may contain only printable ASCII without backslash or colon: '$rel'" ;;
	esac
	rest="$rel"
	while :; do
		comp="${rest%%/*}"
		case "$comp" in '' | . | ..) die "unsafe path: '$rel'" ;; esac
		lc="$(lowercase "$comp")"
		while :; do
			case "$lc" in
			*. | *' ') lc="${lc%?}" ;;
			*) break ;;
			esac
		done
		case "$lc" in
		.git | git~1) die "path component '$comp' names the Git directory: '$rel'" ;;
		esac
		[ "${rest#*/}" != "$rest" ] || break
		rest="${rest#*/}"
	done
}

# True if REL may be replaced wholesale through replace/.
is_replaceable_asset() {
	case "$1" in resources/*) return 0 ;; esac
	[[ "$(lowercase "$1")" =~ $REPLACE_IMAGE_RE ]]
}

# True if a post-apply hook may change the upstream file REL.
is_hook_allowed_path() {
	local base="${1##*/}" allowed
	for allowed in $HOOK_ALLOWED_BASENAMES; do
		[ "$base" = "$allowed" ] && return 0
	done
	return 1
}

tree_git() {
	git -C "$TREE_DIR" "$@"
}

tree_head() {
	tree_git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true
}

tree_is_dirty() {
	[ -n "$(tree_git status --porcelain --untracked-files=normal)" ]
}

# Tracked paths whose index entry is marked skip-worktree (tag S) or
# assume-unchanged (lowercase tag). Git then ignores their working-tree
# content, so status, diff, add -A and reset --hard all leave such an edit
# alone. Upstream paths contain no newlines, so a line-based list is enough.
tree_flagged_paths() {
	tree_git ls-files -v -z | tr '\0' '\n' | sed -n 's/^[a-zS] //p'
}

# Clears both flags on every tracked path, so local edits become visible again.
# Each flag needs its own pass: update-index applies only the last of the two.
clear_index_flags() {
	local flag
	for flag in --no-skip-worktree --no-assume-unchanged; do
		tree_flagged_paths | tr '\n' '\0' | tree_git update-index -z "$flag" --stdin ||
			die "could not clear index flags in $TREE_DIR"
	done
}

# Content hash of the whole working tree, including untracked files that are
# not ignored. Uses a throwaway copy of the index so the real index is untouched.
# The copy keeps the index's mtime (cp -p): Git re-hashes "racily clean" files
# modified in the same second the index was written only when it can compare
# against the real index timestamp.
tree_fingerprint() {
	local git_dir tmp_index tree_hash
	git_dir="$(tree_git rev-parse --absolute-git-dir)"
	tmp_index="$(mktemp "${TMPDIR:-/tmp}/axis-code-oss-index.XXXXXX")"
	if ! cp -p "$git_dir/index" "$tmp_index" ||
		! GIT_INDEX_FILE="$tmp_index" tree_git add -A ||
		! tree_hash="$(GIT_INDEX_FILE="$tmp_index" tree_git write-tree)"; then
		rm -f "$tmp_index"
		die "could not fingerprint $TREE_DIR"
	fi
	rm -f "$tmp_index"
	printf '%s\n' "$tree_hash"
}

stamp_get() {
	[ -f "$STAMP_FILE" ] || return 0
	sed -n "s/^$1 //p" "$STAMP_FILE"
}

# True when every local change in the tree was made by apply.sh, i.e. the tree
# still matches the fingerprint recorded in the stamp.
tree_matches_stamp() {
	[ -f "$STAMP_FILE" ] || return 1
	[ "$(stamp_get commit)" = "$(tree_head)" ] || return 1
	[ "$(stamp_get fingerprint)" = "$(tree_fingerprint)" ]
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

node_version_in() {
	local v
	v="$("$1/node" --version 2>/dev/null)" || return 1
	printf '%s\n' "${v#v}"
}

node_dist_name() {
	local os arch
	case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) die "unsupported OS for the Node.js tarball: $(uname -s)" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) die "unsupported CPU for the Node.js tarball: $(uname -m)" ;;
	esac
	printf 'node-v%s-%s-%s\n' "$NODE_VERSION" "$os" "$arch"
}

# pinned_node_sha256 NAME: prints the SHA-256 that the manifest pins for
# NAME.tar.gz (NAME is node-v<version>-<os>-<arch>) under the key
# "node-sha256-<os>-<arch>". Fails closed when the pin is missing or malformed.
pinned_node_sha256() {
	local key="node-sha256-${1#node-v"$NODE_VERSION"-}" value
	grep -q "\"$key\"" "$MANIFEST" ||
		die "no pinned SHA-256 for $1.tar.gz in $MANIFEST (key \"$key\"); refusing an unpinned toolchain"
	value="$(manifest_get "$key")"
	[[ "$value" =~ $SHA256_RE ]] || die "manifest key \"$key\" is not a lowercase 64-character SHA-256"
	printf '%s\n' "$value"
}

# verify_node_tarball NAME TARBALL SHASUMS: fails unless TARBALL matches the
# SHA-256 pinned in the manifest and the release's SHASUMS256.txt lists the
# same value (a cross-check that catches a wrong pin).
verify_node_tarball() {
	local pinned published actual
	pinned="$(pinned_node_sha256 "$1")" || exit 1
	actual="$(sha256_of "$2")"
	[ "$actual" = "$pinned" ] || die "checksum mismatch for $1.tar.gz: manifest pins $pinned, file is $actual"
	published="$(awk -v f="$1.tar.gz" '$2 == f { print $1 }' "$3")"
	[ "$published" = "$pinned" ] ||
		die "SHASUMS256.txt lists '$published' for $1.tar.gz, but the manifest pins $pinned"
}

# Downloads the official Node.js tarball into $TOOLS_DIR. The tarball must
# match the SHA-256 pinned in the manifest, cross-checked against the release's
# SHASUMS256.txt. Network: nodejs.org only.
download_node() {
	local name base stage
	name="$(node_dist_name)"
	pinned_node_sha256 "$name" >/dev/null
	base="https://nodejs.org/dist/v$NODE_VERSION"
	mkdir -p "$TOOLS_DIR"
	stage="$(mktemp -d "$TOOLS_DIR/.download.XXXXXX")"
	log "Downloading $name.tar.gz from $base"
	if ! curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$stage/SHASUMS256.txt" "$base/SHASUMS256.txt" ||
		! curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$stage/$name.tar.gz" "$base/$name.tar.gz"; then
		rm -rf "$stage"
		die "could not download Node.js $NODE_VERSION from $base"
	fi
	if ! (verify_node_tarball "$name" "$stage/$name.tar.gz" "$stage/SHASUMS256.txt"); then
		rm -rf "$stage"
		exit 1
	fi
	log "SHA-256 matches the manifest pin and SHASUMS256.txt: $(pinned_node_sha256 "$name")"
	mkdir "$stage/x"
	tar -xzf "$stage/$name.tar.gz" -C "$stage/x"
	[ -x "$stage/x/$name/bin/node" ] || {
		rm -rf "$stage"
		die "unexpected tarball layout: $name/bin/node missing"
	}
	rm -rf "${TOOLS_DIR:?}/$name"
	mv "$stage/x/$name" "$TOOLS_DIR/$name"
	rm -rf "$stage"
}

# Sets NODE_BIN_DIR to a directory holding exactly the manifest's Node version.
# Default: the checksum-pinned nodejs.org tarball in .tools/ (with "download",
# a missing tarball is fetched; otherwise that is an error). $NODE24_BIN (the
# directory holding node, or the binary) overrides it; it must report the same
# version, but its contents are not checksum-verified, so a warning is printed.
resolve_node() {
	local mode="${1:-}" dir v tools_dir
	if [ -n "${NODE24_BIN:-}" ]; then
		dir="$NODE24_BIN"
		[ -f "$dir" ] && dir="$(dirname "$dir")"
		v="$(node_version_in "$dir")" || die "NODE24_BIN is set but $dir/node does not run"
		[ "$v" = "$NODE_VERSION" ] || die "NODE24_BIN node is $v; the manifest pins Node $NODE_VERSION exactly"
		log "warning: using NODE24_BIN ($dir/node $v) instead of the checksum-pinned tarball; the toolchain is not verified"
		NODE_BIN_DIR="$dir"
		return 0
	fi
	tools_dir="$TOOLS_DIR/$(node_dist_name)/bin"
	if [ ! -x "$tools_dir/node" ]; then
		[ "$mode" = download ] || die "pinned Node.js $NODE_VERSION not found in $TOOLS_DIR; run scripts/code-oss/build.sh --toolchain-only or set NODE24_BIN"
		download_node
	fi
	v="$(node_version_in "$tools_dir")" || die "$tools_dir/node does not run"
	[ "$v" = "$NODE_VERSION" ] || die "$tools_dir/node is $v; the manifest pins Node $NODE_VERSION exactly"
	NODE_BIN_DIR="$tools_dir"
}

require_applied_tree() {
	[ -d "$TREE_DIR/.git" ] || die "$TREE_DIR is missing; run scripts/code-oss/fetch.sh"
	[ "$(tree_head)" = "$UPSTREAM_COMMIT" ] ||
		die "$TREE_DIR is not at the pinned commit $UPSTREAM_COMMIT; run fetch.sh and apply.sh"
	if [ "$(stamp_get commit)" != "$UPSTREAM_COMMIT" ] || [ "$(stamp_get status)" != complete ]; then
		die "patches and overlay are not (completely) applied for $UPSTREAM_COMMIT; run scripts/code-oss/apply.sh"
	fi
}

# Native addons are built by node-gyp through make, which splits include paths
# at whitespace, so the tree and toolchain paths must not contain any.
require_build_paths_without_whitespace() {
	local d
	for d in "$TREE_DIR" "$TOOLS_DIR"; do
		case "$d" in
		*[[:space:]]*)
			die "path contains whitespace, which breaks node-gyp native builds: '$d'. Set AXIS_CODE_OSS_VENDOR_DIR and AXIS_CODE_OSS_TOOLS_DIR to directories without whitespace (see docs/feasibility/code-oss-build.md)"
			;;
		esac
	done
}
