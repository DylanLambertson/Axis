#!/usr/bin/env bash
# Shallow-fetches the pinned Code OSS commit from code-oss/upstream.json into
# vendor/code-oss (ignored by Git). Idempotent: a tree already at the pinned
# commit is left alone. Refuses to discard local modifications unless --force;
# changes made by apply.sh (matching its stamp) are not treated as local edits.
#
# Also checks that the manifest's "node" equals upstream's .nvmrc.
#
# Usage: scripts/code-oss/fetch.sh [--force]
set -euo pipefail

# shellcheck source=scripts/code-oss/lib.sh
. "$(dirname "$0")/lib.sh"

force=0
for arg in "$@"; do
	case "$arg" in
	--force) force=1 ;;
	-h | --help)
		sed -n '2,9p' "$0"
		exit 0
		;;
	*) die "unknown argument: $arg" ;;
	esac
done

load_manifest
SECONDS=0

# Fetches exactly the pinned commit plus its tag (depth 1) and checks that the
# tag still points at that commit.
fetch_pinned() {
	log "Fetching $UPSTREAM_COMMIT (tag $UPSTREAM_TAG) from $UPSTREAM_REPO"
	tree_git fetch --quiet --depth 1 --no-tags origin \
		"$UPSTREAM_COMMIT" "+refs/tags/$UPSTREAM_TAG:refs/tags/$UPSTREAM_TAG" ||
		die "git fetch of $UPSTREAM_COMMIT / tag $UPSTREAM_TAG failed"
	local tagged
	tagged="$(tree_git rev-parse -q --verify "refs/tags/$UPSTREAM_TAG^{commit}" || true)"
	[ "$tagged" = "$UPSTREAM_COMMIT" ] ||
		die "upstream tag $UPSTREAM_TAG points at '$tagged', not the pinned commit $UPSTREAM_COMMIT"
}

mkdir -p "$VENDOR_DIR"

if [ ! -e "$TREE_DIR" ]; then
	git -c init.defaultBranch=main init --quiet "$TREE_DIR"
	tree_git remote add origin "$UPSTREAM_REPO"
	rm -f "$STAMP_FILE"
	fetch_pinned
	tree_git -c advice.detachedHead=false checkout --quiet --detach "$UPSTREAM_COMMIT"
else
	[ -d "$TREE_DIR/.git" ] || die "$TREE_DIR exists but is not a Git checkout; move it away and rerun"
	origin="$(tree_git remote get-url origin 2>/dev/null || true)"
	if [ "$origin" != "$UPSTREAM_REPO" ]; then
		[ "$force" = 1 ] || die "$TREE_DIR has origin '$origin', manifest says '$UPSTREAM_REPO'; rerun with --force to switch"
		tree_git remote remove origin 2>/dev/null || true
		tree_git remote add origin "$UPSTREAM_REPO"
	fi
	head="$(tree_head)"
	if [ "$head" = "$UPSTREAM_COMMIT" ]; then
		if tree_is_dirty; then
			if tree_matches_stamp; then
				log "Pinned commit present with Axis patches/overlay applied"
			else
				log "Pinned commit present; tree has local modifications (left untouched; apply.sh will refuse without --force)"
			fi
		else
			log "Pinned commit already checked out; nothing to fetch"
		fi
	else
		if tree_is_dirty && ! tree_matches_stamp && [ "$force" != 1 ]; then
			die "$TREE_DIR has local modifications; rerun with --force to discard them"
		fi
		fetch_pinned
		rm -f "$STAMP_FILE"
		tree_git -c advice.detachedHead=false checkout --quiet --force --detach "$UPSTREAM_COMMIT"
		tree_git clean -fdq
	fi
fi

head="$(tree_head)"
[ "$head" = "$UPSTREAM_COMMIT" ] || die "HEAD is '$head', expected $UPSTREAM_COMMIT"

# The manifest's Node version must be the one upstream builds with.
nvmrc="$(tree_git show "$UPSTREAM_COMMIT:.nvmrc" 2>/dev/null | tr -d ' \t\r\n' || true)"
nvmrc="${nvmrc#v}"
[ "$nvmrc" = "$NODE_VERSION" ] ||
	die "manifest node $NODE_VERSION does not match upstream .nvmrc '$nvmrc' at $UPSTREAM_TAG; update code-oss/upstream.json (version and tarball pins)"
log "vendor/code-oss HEAD = $head ($UPSTREAM_TAG) in ${SECONDS}s"
