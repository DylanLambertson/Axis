#!/usr/bin/env bash
# Copyright (c) 2026 Dylan Lambertson. All rights reserved.
# Creates a Git repository with every kind of change the Changes view lists
# (docs/design/axis-shell-a5.md, manual test), for looking at it by hand.
#
#   <dir>/changes-repo          staged (modified, added, deleted, renamed),
#                               not staged (modified, deleted), a file both
#                               staged and changed again, untracked files,
#                               and untracked files with hostile names
#                               (newline, right-to-left override, zero-width,
#                               escape sequence, very long, a name that spells
#                               another state)
#   <dir>/conflict              a linked worktree with a merge conflict
#
# The directory must not exist yet, and its path must not contain whitespace.
# The hostile names need a file system that allows them (not Windows).
# Commits use a fixed demo identity and dates, so the history is reproducible.
#
# Usage: scripts/code-oss/changes-fixture.sh <dir>
set -euo pipefail

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

[ "$#" -eq 1 ] || die "usage: $0 <dir>"
case "$1" in
-h | --help)
	sed -n '2,19p' "$0"
	exit 0
	;;
esac
dir="$1"
[[ "$dir" =~ [[:space:]] ]] && die "path contains whitespace: $dir"
[ -e "$dir" ] && die "$dir already exists"
command -v git >/dev/null || die "git not found"

mkdir -p "$dir"
dir="$(cd "$dir" && pwd -P)"
repo="$dir/changes-repo"

export GIT_AUTHOR_NAME="Axis Demo" GIT_AUTHOR_EMAIL="demo@example.invalid"
export GIT_COMMITTER_NAME="Axis Demo" GIT_COMMITTER_EMAIL="demo@example.invalid"
export GIT_AUTHOR_DATE="2026-11-01T09:00:00Z" GIT_COMMITTER_DATE="2026-11-01T09:00:00Z"
g() { git -C "$repo" -c init.defaultBranch=main -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }

mkdir -p "$repo/src" "$repo/test"
git -c init.defaultBranch=main init --quiet "$repo"
printf '# Changes fixture\n\nOne line.\n' >"$repo/README.md"
printf 'export const app = 1;\n' >"$repo/src/app.ts"
printf 'export const old = 1;\n' >"$repo/src/old.ts"
printf 'export const gone = 1;\n' >"$repo/src/gone.ts"
printf 'export const shared = 1;\n' >"$repo/src/shared.ts"
printf 'test("a", () => {});\n' >"$repo/test/a.test.ts"
g add -A
g commit --quiet -m "Initial commit"

# A conflict, in its own worktree so the main checkout stays clean of it.
g worktree add --quiet -b fixture/conflict "$dir/conflict" main
printf 'export const shared = 2;\n' >"$dir/conflict/src/shared.ts"
git -C "$dir/conflict" -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --quiet -am "Change shared on the branch"
printf 'export const shared = 3;\n' >"$repo/src/shared.ts"
g commit --quiet -am "Change shared on main"
git -C "$dir/conflict" -c core.hooksPath=/dev/null merge --quiet main >/dev/null 2>&1 || true

# Staged.
printf 'export const app = 2;\n' >"$repo/src/app.ts"
mkdir -p "$repo/docs" "$repo/lib"
printf '# New page\n' >"$repo/docs/new.md"
g add src/app.ts docs/new.md
g rm --quiet src/gone.ts
g mv src/old.ts lib/renamed.ts
# Changed again after staging: listed as staged and as not staged.
printf 'export const app = 3;\n' >"$repo/src/app.ts"

# Not staged.
printf '# Changes fixture\n\nTwo lines.\nNow three.\n' >"$repo/README.md"
rm "$repo/test/a.test.ts"

# Untracked, plain and hostile.
printf 'notes\n' >"$repo/notes.txt"
printf 'x\n' >"$repo/line"$'\n'"break.txt"
printf 'x\n' >"$repo/invoice"$'\xe2\x80\xae'"fdp.exe"
printf 'x\n' >"$repo/zero"$'\xe2\x80\x8b'"width.ts"
printf 'x\n' >"$repo/esc"$'\x1b'"[31mred.ts"
printf 'x\n' >"$repo/Staged, Modified: spoof.ts"
printf 'x\n' >"$repo/$(printf 'n%.0s' $(seq 1 200)).ts"

printf 'Changes fixture: %s\n' "$repo"
printf 'Conflict worktree: %s\n' "$dir/conflict"
g status --short
