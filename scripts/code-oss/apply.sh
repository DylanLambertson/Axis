#!/usr/bin/env bash
# Resets vendor/code-oss to the pinned commit, then, in this order:
#   1. applies code-oss/patches/NNNN-*.patch in lexical order (number blocks:
#      0001-0999 shell, 1000-1999 guardrails, 2000-2999 security hardening);
#   2. deletes the paths listed in code-oss/removals.txt (each must exist);
#   3. copies code-oss/replace/** over existing upstream files (each target
#      must exist at the pinned commit, to catch upstream drift);
#   4. copies code-oss/overlay/** as new files (overwriting is refused);
#   5. runs the executables in code-oss/hooks/post-apply.d/ in lexical order,
#      inside vendor/code-oss.
# Writes vendor/code-oss.applied recording what was applied, a fingerprint of
# the resulting tree and "status complete". A failed run records "status
# incomplete", so the next run may still reset the tree it left behind, while
# build.sh, run.sh and footprint.sh refuse to use it.
#
# Refuses to discard modifications that apply.sh did not make unless --force.
#
# Usage: scripts/code-oss/apply.sh [--force]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

force=0
for arg in "$@"; do
	case "$arg" in
	--force) force=1 ;;
	-h | --help)
		sed -n '2,19p' "$0"
		exit 0
		;;
	*) die "unknown argument: $arg" ;;
	esac
done

load_manifest
[ -d "$TREE_DIR/.git" ] || die "$TREE_DIR is missing; run scripts/code-oss/fetch.sh first"
[ "$(tree_head)" = "$UPSTREAM_COMMIT" ] ||
	die "$TREE_DIR is at '$(tree_head)', not the pinned commit $UPSTREAM_COMMIT; run scripts/code-oss/fetch.sh first"

work="$(mktemp -d "${TMPDIR:-/tmp}/axis-code-oss-apply.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Rejects paths that could escape the tree or that the stamp format cannot hold.
check_rel_path() {
	case "$1" in
	'' | /* | ../* | */../* | */.. | .. | . | ./* | */./* | */.) die "unsafe path: '$1'" ;;
	.git | .git/*) die "path inside the tree's Git directory: '$1'" ;;
	esac
	case "$1" in
	*$'\n'* | *$'\r'* | *\\*) die "path contains a line break or backslash: '$1'" ;;
	esac
}

# True if any existing parent of REL inside the tree is a symlink or not a directory.
parent_escapes() {
	local parent="$TREE_DIR" rest="$1"
	while [ "${rest#*/}" != "$rest" ]; do
		parent="$parent/${rest%%/*}"
		rest="${rest#*/}"
		if [ -L "$parent" ] || { [ -e "$parent" ] && [ ! -d "$parent" ]; }; then
			return 0
		fi
	done
	return 1
}

# list_files DIR OUT: regular files under DIR (relative, sorted), excluding the
# top-level README.md and .DS_Store. Anything other than files and directories
# is rejected.
list_files() {
	: >"$2"
	[ -d "$1" ] || return 0
	local other
	other="$(cd "$1" && find . -mindepth 1 ! -type f ! -type d | head -n 1)"
	[ -z "$other" ] || die "$(basename "$1") may contain only regular files and directories: ${other#./}"
	(cd "$1" && find . -type f ! -name .DS_Store ! -path ./README.md) | sed 's|^\./||' | sort >"$2"
	local rel
	while IFS= read -r rel; do
		check_rel_path "$rel"
	done <"$2"
}

# --- Validate inputs before touching the tree --------------------------------

: >"$work/patches"
if [ -d "$PATCHES_DIR" ]; then
	for p in "$PATCHES_DIR"/*; do
		[ -e "$p" ] || [ -L "$p" ] || continue
		name="$(basename "$p")"
		[ "$name" = README.md ] && continue
		if [ ! -f "$p" ] || [ -L "$p" ]; then
			die "patch is not a regular file: $name"
		fi
		[[ "$name" =~ $PATCH_RE ]] || die "patch name '$name' does not match NNNN-short-name.patch"
		patch_block "$name" >/dev/null ||
			die "patch $name is outside the assigned number blocks ($PATCH_BLOCKS_HELP)"
		printf '%s\n' "$name" >>"$work/patches"
	done
fi
dup="$(cut -c1-4 "$work/patches" | uniq -d | head -n 1)"
[ -z "$dup" ] || die "more than one patch uses number $dup"

# removals.txt: one path per line; blank lines and lines starting with # are
# ignored; surrounding whitespace and a trailing / are dropped.
: >"$work/removals"
if [ -f "$REMOVALS_FILE" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		line="${line%$'\r'}"
		line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
		case "$line" in '' | '#'*) continue ;; esac
		while [ "${line%/}" != "$line" ]; do line="${line%/}"; done
		check_rel_path "$line"
		printf '%s\n' "$line" >>"$work/removals"
	done <"$REMOVALS_FILE"
fi
dup="$(sort "$work/removals" | uniq -d | head -n 1)"
[ -z "$dup" ] || die "removals.txt lists '$dup' more than once"

list_files "$REPLACE_DIR" "$work/replace"
list_files "$OVERLAY_DIR" "$work/overlay"

: >"$work/hooks"
if [ -d "$HOOKS_DIR" ]; then
	for h in "$HOOKS_DIR"/*; do
		[ -e "$h" ] || [ -L "$h" ] || continue
		name="$(basename "$h")"
		[ "$name" = README.md ] && continue
		if [ ! -f "$h" ] || [ -L "$h" ] || [ ! -x "$h" ]; then
			die "post-apply hook is not an executable regular file: $name"
		fi
		printf '%s\n' "$name" >>"$work/hooks"
	done
fi

# --- Reset to the pinned commit ----------------------------------------------

if tree_is_dirty && ! tree_matches_stamp; then
	[ "$force" = 1 ] ||
		die "$TREE_DIR has changes that apply.sh did not make; export them as a patch or rerun with --force to discard them"
	log "--force: discarding local modifications"
fi

# Overlay files from the previous run may be ignored by upstream's .gitignore,
# which git clean (without -x) keeps, so remove them explicitly.
stamp_get overlay >"$work/previous-overlay"
while IFS= read -r rel; do
	check_rel_path "$rel"
	rm -f "$TREE_DIR/$rel"
done <"$work/previous-overlay"
rm -f "$STAMP_FILE"

tree_git reset --quiet --hard "$UPSTREAM_COMMIT"
tree_git clean -fdq

# write_stamp STATUS: records what has been applied so far.
for f in applied-patches applied-removals applied-replace applied-overlay applied-hooks; do
	: >"$work/$f"
done
write_stamp() {
	local p
	{
		printf 'commit %s\n' "$UPSTREAM_COMMIT"
		printf 'tag %s\n' "$UPSTREAM_TAG"
		printf 'status %s\n' "$1"
		while IFS= read -r p; do
			printf 'patch %s %s\n' "$p" "$(sha256_of "$PATCHES_DIR/$p")"
		done <"$work/applied-patches"
		sed 's/^/removal /' "$work/applied-removals"
		sed 's/^/replace /' "$work/applied-replace"
		sed 's/^/overlay /' "$work/applied-overlay"
		while IFS= read -r p; do
			printf 'hook %s %s\n' "$p" "$(sha256_of "$HOOKS_DIR/$p")"
		done <"$work/applied-hooks"
		printf 'fingerprint %s\n' "$(tree_fingerprint)"
	} >"$work/stamp"
	mv "$work/stamp" "$STAMP_FILE"
}

# fail_incomplete MESSAGE: records the partial state, then exits.
fail_incomplete() {
	write_stamp incomplete
	die "$1; the tree is marked incomplete"
}

# report_paths FILE: prints the offending paths, indented, to stderr.
report_paths() {
	sed 's/^/  /' "$1" >&2
}

# --- 1. Patches --------------------------------------------------------------

while IFS= read -r name; do
	if ! tree_git apply --whitespace=nowarn "$PATCHES_DIR/$name" 2>"$work/apply.err"; then
		cat "$work/apply.err" >&2
		fail_incomplete "patch $name failed to apply; earlier patches remain applied"
	fi
	printf '%s\n' "$name" >>"$work/applied-patches"
	log "Applied $name"
done <"$work/patches"

# --- 2. Removals -------------------------------------------------------------

: >"$work/bad"
while IFS= read -r rel; do
	dest="$TREE_DIR/$rel"
	if { [ ! -e "$dest" ] && [ ! -L "$dest" ]; } || parent_escapes "$rel"; then
		printf '%s (missing)\n' "$rel" >>"$work/bad"
	elif ! tree_git cat-file -e "$UPSTREAM_COMMIT:$rel" 2>/dev/null && tree_git check-ignore -q -- "$rel"; then
		printf '%s (ignored build output, not upstream source)\n' "$rel" >>"$work/bad"
	fi
done <"$work/removals"
if [ -s "$work/bad" ]; then
	report_paths "$work/bad"
	fail_incomplete "removals.txt lists paths that cannot be removed (above); upstream may have moved them"
fi
while IFS= read -r rel; do
	rm -rf "${TREE_DIR:?}/$rel"
	printf '%s\n' "$rel" >>"$work/applied-removals"
done <"$work/removals"

# --- 3. Replacements (existing upstream files only) --------------------------

: >"$work/bad"
while IFS= read -r rel; do
	dest="$TREE_DIR/$rel"
	if ! tree_git cat-file -e "$UPSTREAM_COMMIT:$rel" 2>/dev/null; then
		printf '%s (not an upstream file at %s)\n' "$rel" "$UPSTREAM_TAG" >>"$work/bad"
	elif [ -L "$dest" ] || [ ! -f "$dest" ] || parent_escapes "$rel"; then
		printf '%s (no longer a regular file in the tree; removed or changed by a patch?)\n' "$rel" >>"$work/bad"
	fi
done <"$work/replace"
if [ -s "$work/bad" ]; then
	report_paths "$work/bad"
	fail_incomplete "replace/ holds files with no upstream counterpart (above); upstream may have moved them, or they belong in overlay/"
fi
while IFS= read -r rel; do
	cp "$REPLACE_DIR/$rel" "$TREE_DIR/$rel"
	printf '%s\n' "$rel" >>"$work/applied-replace"
done <"$work/replace"

# --- 4. Overlay (new files only) ---------------------------------------------

: >"$work/bad"
while IFS= read -r rel; do
	dest="$TREE_DIR/$rel"
	if [ -e "$dest" ] || [ -L "$dest" ] || parent_escapes "$rel"; then
		printf '%s\n' "$rel" >>"$work/bad"
	fi
done <"$work/overlay"
if [ -s "$work/bad" ]; then
	report_paths "$work/bad"
	fail_incomplete "overlay would overwrite or traverse existing paths (above); the overlay is for new files only, use replace/ or a patch for upstream files"
fi
while IFS= read -r rel; do
	mkdir -p "$(dirname "$TREE_DIR/$rel")"
	cp -p "$OVERLAY_DIR/$rel" "$TREE_DIR/$rel"
	printf '%s\n' "$rel" >>"$work/applied-overlay"
done <"$work/overlay"

# --- 5. Post-apply hooks -----------------------------------------------------

while IFS= read -r name; do
	log "Running post-apply hook $name"
	if ! (cd "$TREE_DIR" && AXIS_CODE_OSS_TREE="$TREE_DIR" AXIS_UPSTREAM_COMMIT="$UPSTREAM_COMMIT" \
		AXIS_UPSTREAM_TAG="$UPSTREAM_TAG" "$HOOKS_DIR/$name"); then
		fail_incomplete "post-apply hook $name failed"
	fi
	printf '%s\n' "$name" >>"$work/applied-hooks"
done <"$work/hooks"

write_stamp complete

count() { wc -l <"$work/$1" | tr -d ' '; }
log "Applied on $UPSTREAM_TAG ($UPSTREAM_COMMIT): $(count applied-patches) patch(es)," \
	"$(count applied-removals) removal(s), $(count applied-replace) replaced file(s)," \
	"$(count applied-overlay) overlay file(s), $(count applied-hooks) hook(s)"
