#!/usr/bin/env bash
# Reports the upstream footprint of the applied Axis changes in vendor/code-oss,
# the budget that ADR 0002 tracks:
#   - per patch block (shell, guardrails, security): patches, upstream files
#     touched, lines added and deleted in upstream files, and new files created
#     (from `git apply --numstat` of each patch);
#   - removals.txt and replace/: upstream files and lines affected;
#   - the net total from `git diff --numstat` of the tree against the pinned
#     commit. It covers every tracked upstream file, including changes made by
#     post-apply hooks, and counts a line changed by two patches once.
# Overlay files are new and do not count against the upstream footprint.
#
# Usage: scripts/code-oss/footprint.sh [--tsv]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

tsv=0
for arg in "$@"; do
	case "$arg" in
	--tsv) tsv=1 ;;
	-h | --help)
		sed -n '2,13p' "$0"
		exit 0
		;;
	*) die "unknown argument: $arg" ;;
	esac
done

load_manifest
require_applied_tree

work="$(mktemp -d "${TMPDIR:-/tmp}/axis-code-oss-footprint.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The stamp must describe the current patch series, or the numbers are stale.
stamp_get patch >"$work/stamp-patches"
: >"$work/current-patches"
for p in "$PATCHES_DIR"/[0-9]*.patch; do
	[ -f "$p" ] || continue
	printf '%s %s\n' "$(basename "$p")" "$(sha256_of "$p")" >>"$work/current-patches"
done
cmp -s "$work/stamp-patches" "$work/current-patches" ||
	die "code-oss/patches differs from what apply.sh last applied; rerun scripts/code-oss/apply.sh"
if ! tree_matches_stamp; then
	die "$TREE_DIR has changed since apply.sh ran; rerun scripts/code-oss/apply.sh"
fi

# rows: block, patch, kind (upstream|new), added, deleted, path
: >"$work/rows"
while read -r name _; do
	block="$(patch_block "$name")"
	block="${block%% *}"
	printf '%s\t%s\t-\t0\t0\t-\n' "$block" "$name" >>"$work/rows"
	tree_git apply --numstat "$PATCHES_DIR/$name" >"$work/numstat"
	while IFS=$'\t' read -r added deleted path; do
		[ "$added" = - ] && added=0
		[ "$deleted" = - ] && deleted=0
		if tree_git cat-file -e "$UPSTREAM_COMMIT:$path" 2>/dev/null; then kind=upstream; else kind=new; fi
		printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$block" "$name" "$kind" "$added" "$deleted" "$path" >>"$work/rows"
	done <"$work/numstat"
done <"$work/stamp-patches"

# diff_rows LABEL PATHFILE: numstat rows for the listed paths against the pin.
diff_rows() {
	local rel
	while IFS= read -r rel; do
		tree_git diff --numstat "$UPSTREAM_COMMIT" -- "$rel" |
			awk -F'\t' -v b="$1" 'BEGIN { OFS = "\t" } { a = ($1 == "-") ? 0 : $1; d = ($2 == "-") ? 0 : $2; print b, "-", "upstream", a, d, $3 }'
	done <"$2"
}
stamp_get removal >"$work/removals"
stamp_get replace >"$work/replace"
{
	diff_rows removals "$work/removals"
	diff_rows replace "$work/replace"
	tree_git diff --numstat "$UPSTREAM_COMMIT" |
		awk -F'\t' 'BEGIN { OFS = "\t" } { a = ($1 == "-") ? 0 : $1; d = ($2 == "-") ? 0 : $2; print "total", "-", "upstream", a, d, $3 }'
} >>"$work/rows"

awk -F'\t' -v tsv="$tsv" -v removals="$(wc -l <"$work/removals" | tr -d ' ')" \
	-v replaced="$(wc -l <"$work/replace" | tr -d ' ')" '
	BEGIN {
		order = "shell guardrails security removals replace total"
		n = split(order, names, " ")
		range["shell"] = "0001-0999"; range["guardrails"] = "1000-1999"; range["security"] = "2000-2999"
		range["removals"] = "removals.txt"; range["replace"] = "replace/"; range["total"] = "net vs pin"
	}
	{
		b = $1
		if ($2 != "-" && !((b, $2) in seenpatch)) { seenpatch[b, $2] = 1; patches[b]++ }
		if ($6 == "-") next
		if ($3 == "upstream") {
			if (!((b, $6) in seenfile)) { seenfile[b, $6] = 1; files[b]++ }
			added[b] += $4; deleted[b] += $5
		} else if (!((b, $6) in seennew)) { seennew[b, $6] = 1; newfiles[b]++ }
	}
	END {
		patches["removals"] = removals " paths"; patches["replace"] = replaced " files"; patches["total"] = "-"
		if (tsv) print "block\trange\tpatches\tupstream_files\tadded\tdeleted\tnew_files"
		else printf "%-11s %-13s %8s %15s %8s %8s %10s\n", "block", "range", "patches", "upstream files", "added", "deleted", "new files"
		for (i = 1; i <= n; i++) {
			b = names[i]
			p = (b in patches) ? patches[b] : 0
			if (tsv) printf "%s\t%s\t%s\t%d\t%d\t%d\t%d\n", b, range[b], p, files[b], added[b], deleted[b], newfiles[b]
			else printf "%-11s %-13s %8s %15d %8d %8d %10d\n", b, range[b], p, files[b], added[b], deleted[b], newfiles[b]
		}
	}' "$work/rows"
