#!/usr/bin/env bash
# Reports the upstream footprint of the applied Axis changes in vendor/code-oss,
# the budget that ADR 0002 tracks:
#   - per patch block (shell, guardrails, copilot, security): patches, upstream files
#     touched, lines added and deleted in upstream files, added marker lines
#     (`--- Start Axis ---` / `--- End Axis ---`, included in "added"), and new
#     files created (from `git apply --numstat` of each patch);
#   - "shell-c2": the shell block as ADR 0002 criterion 2 counts it, excluding
#     product.json and resources/**;
#   - removals.txt and replace/: upstream files and lines affected;
#   - hooks: upstream files changed by post-apply hooks (allowed: lockfiles);
#   - the net total from `git diff --numstat` of the tree against the pinned
#     commit, which counts a line changed by two patches once.
# Overlay files are new and do not count against the upstream footprint.
#
# Exits non-zero and lists the paths as UNATTRIBUTED when a hook changed an
# upstream file outside the allow-list, or when the net diff holds a change not
# explained by a patch, removals.txt, replace/ or an allowed hook change.
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
		sed -n '2,21p' "$0"
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
# Flagged index entries hide their working-tree content from every check below.
tree_flagged_paths >"$work/flagged"
if [ -s "$work/flagged" ]; then
	printf 'Index entries marked skip-worktree or assume-unchanged:\n' >&2
	sed 's/^/  /' "$work/flagged" >&2
	die "the tree has index flags that hide changes from the footprint (set by a hook or by hand); remove the cause and rerun scripts/code-oss/apply.sh"
fi
if ! tree_matches_stamp; then
	die "$TREE_DIR has changed since apply.sh ran; rerun scripts/code-oss/apply.sh"
fi
prehook="$(stamp_get prehook-fingerprint)"
final="$(stamp_get fingerprint)"
[ -n "$prehook" ] || die "the stamp predates hook attribution; rerun scripts/code-oss/apply.sh"

# rows: block, patch, kind (upstream|new|marker), added (or marker count), deleted, path
: >"$work/rows"
while read -r name _; do
	block="$(patch_block "$name")"
	block="${block%% *}"
	printf '%s\t%s\t-\t0\t0\t-\n' "$block" "$name" >>"$work/rows"
	# Added marker lines per file. Hunk bodies are tracked by the line counts in
	# their "@@ -a,b +c,d @@" headers, so an added line that happens to start
	# with "++ " is never mistaken for a "+++ b/<path>" file header.
	awk -v b="$block" -v n="$name" '
		function count(r) { return index(r, ",") ? substr(r, index(r, ",") + 1) + 0 : 1 }
		old > 0 || new > 0 {
			c = substr($0, 1, 1)
			if (c == "+") { new--; if ($0 ~ /--- (Start|End) Axis ---/ && f != "") m[f]++ }
			else if (c == "-") old--
			else if (c != "\\") { old--; new-- }
			next
		}
		/^\+\+\+ / { f = substr($0, 5); sub(/\t.*$/, "", f); sub(/^b\//, "", f); next }
		/^@@ -/ { split($0, h, " "); old = count(h[2]); new = count(h[3]) }
		END { for (f in m) printf "%s\t%s\tmarker\t%d\t0\t%s\n", b, n, m[f], f }
	' "$PATCHES_DIR/$name" >>"$work/rows"
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
stamp_get hook >"$work/hooks"
{
	diff_rows removals "$work/removals"
	diff_rows replace "$work/replace"
	tree_git diff --numstat "$UPSTREAM_COMMIT" |
		awk -F'\t' 'BEGIN { OFS = "\t" } { a = ($1 == "-") ? 0 : $1; d = ($2 == "-") ? 0 : $2; print "total", "-", "upstream", a, d, $3 }'
} >>"$work/rows"

# Hook changes: the difference between the tree before and after the hooks,
# limited to files that exist at the pinned commit.
: >"$work/unattributed"
: >"$work/hook-allowed"
if [ "$prehook" != "$final" ]; then
	tree_git diff --numstat "$prehook" "$final" >"$work/hook-numstat"
	while IFS=$'\t' read -r added deleted path; do
		tree_git cat-file -e "$UPSTREAM_COMMIT:$path" 2>/dev/null || continue
		[ "$added" = - ] && added=0
		[ "$deleted" = - ] && deleted=0
		printf 'hooks\t-\tupstream\t%s\t%s\t%s\n' "$added" "$deleted" "$path" >>"$work/rows"
		if is_hook_allowed_path "$path"; then
			printf '%s\n' "$path" >>"$work/hook-allowed"
		else
			printf '%s (changed by a post-apply hook; hooks may change only: %s)\n' "$path" "$HOOK_ALLOWED_BASENAMES" >>"$work/unattributed"
		fi
	done <"$work/hook-numstat"
fi

# Every upstream change in the net diff must be explained.
{
	awk -F'\t' '$3 == "upstream" && $1 != "total" && $1 != "hooks" && $6 != "-" { print $6 }' "$work/rows"
	cat "$work/replace" "$work/hook-allowed"
} | sort -u >"$work/explained"
tree_git diff --name-only "$UPSTREAM_COMMIT" | while IFS= read -r path; do
	grep -Fqx -- "$path" "$work/explained" && continue
	covered=0
	while IFS= read -r r; do
		case "$path" in "$r" | "$r"/*) covered=1 && break ;; esac
	done <"$work/removals"
	[ "$covered" = 1 ] || printf '%s (not explained by a patch, removals.txt, replace/ or an allowed hook)\n' "$path"
done >>"$work/unattributed"

awk -F'\t' -v tsv="$tsv" -v removals="$(wc -l <"$work/removals" | tr -d ' ')" \
	-v replaced="$(wc -l <"$work/replace" | tr -d ' ')" -v hooks="$(wc -l <"$work/hooks" | tr -d ' ')" '
	BEGIN {
		order = "shell shell-c2 guardrails copilot security removals replace hooks total"
		n = split(order, names, " ")
		range["shell"] = "0001-0999"; range["shell-c2"] = "0001-0999*"; range["guardrails"] = "1000-1499"; range["copilot"] = "1500-1999"
		range["security"] = "2000-2999"
		range["removals"] = "removals.txt"; range["replace"] = "replace/"; range["hooks"] = "post-apply.d"
		range["total"] = "net vs pin"
	}
	{
		b = $1
		if ($2 != "-" && !((b, $2) in seenpatch)) { seenpatch[b, $2] = 1; patches[b]++ }
		if ($6 == "-") next
		c2 = (b == "shell" && $6 != "product.json" && $6 !~ /^resources\//)
		if ($3 == "marker") {
			markers[b] += $4
			if (c2) markers["shell-c2"] += $4
		} else if ($3 == "upstream") {
			if (!((b, $6) in seenfile)) { seenfile[b, $6] = 1; files[b]++; if (c2) files["shell-c2"]++ }
			added[b] += $4; deleted[b] += $5
			if (c2) { added["shell-c2"] += $4; deleted["shell-c2"] += $5 }
		} else if (!((b, $6) in seennew)) { seennew[b, $6] = 1; newfiles[b]++; if (c2) newfiles["shell-c2"]++ }
	}
	END {
		patches["shell-c2"] = (("shell" in patches) ? patches["shell"] : 0)
		patches["removals"] = removals " paths"; patches["replace"] = replaced " files"; patches["hooks"] = hooks " hooks"
		patches["total"] = "-"
		if (tsv) print "block\trange\tpatches\tupstream_files\tadded\tdeleted\tmarker_lines\tnew_files"
		else printf "%-11s %-13s %8s %15s %8s %8s %13s %10s\n", "block", "range", "patches", "upstream files", "added", "deleted", "marker lines", "new files"
		for (i = 1; i <= n; i++) {
			b = names[i]
			p = (b in patches) ? patches[b] : 0
			if (tsv) printf "%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\n", b, range[b], p, files[b], added[b], deleted[b], markers[b], newfiles[b]
			else printf "%-11s %-13s %8s %15d %8d %8d %13d %10d\n", b, range[b], p, files[b], added[b], deleted[b], markers[b], newfiles[b]
		}
		if (!tsv) print "* shell-c2: ADR 0002 criterion 2 count (shell block without product.json and resources/**)."
	}' "$work/rows"

if [ -s "$work/unattributed" ]; then
	printf 'UNATTRIBUTED upstream changes:\n' >&2
	sed 's/^/  /' "$work/unattributed" >&2
	die "the footprint has unattributed upstream changes (above); move them into a patch, removals.txt or replace/"
fi
