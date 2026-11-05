#!/usr/bin/env bash
# Creates a small Git repository with three linked worktrees, for looking at
# the Axis Agent view by hand or from test/axis-shell/smoke.mjs. The worktrees
# are plain `git worktree add` worktrees, so the Phase 0 dashboard lists them
# as external (docs/design/axis-agent-shell.md section 5.2).
#
#   <dir>/demo-repo                 the local checkout (branch main)
#   <dir>/worktrees/fix-login       branch axis/fix-login, one modified file
#   <dir>/worktrees/add-search      branch axis/add-search, locked
#   <dir>/worktrees/spike           detached HEAD
#
# The directory must not exist yet, and its path must not contain whitespace.
# Commits use a fixed demo identity and dates, so the history is reproducible.
#
# Usage: scripts/code-oss/shell-demo-fixture.sh <dir>
set -euo pipefail

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

[ "$#" -eq 1 ] || die "usage: $0 <dir>"
case "$1" in
-h | --help)
	sed -n '2,15p' "$0"
	exit 0
	;;
esac
dir="$1"
[[ "$dir" =~ [[:space:]] ]] && die "path contains whitespace: $dir"
[ -e "$dir" ] && die "$dir already exists"
command -v git >/dev/null || die "git not found"

mkdir -p "$dir"
dir="$(cd "$dir" && pwd -P)"
repo="$dir/demo-repo"

export GIT_AUTHOR_NAME="Axis Demo" GIT_AUTHOR_EMAIL="demo@example.invalid"
export GIT_COMMITTER_NAME="Axis Demo" GIT_COMMITTER_EMAIL="demo@example.invalid"
export GIT_AUTHOR_DATE="2026-11-01T09:00:00Z" GIT_COMMITTER_DATE="2026-11-01T09:00:00Z"
g() { git -C "$repo" -c init.defaultBranch=main -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }

mkdir -p "$repo/src" "$repo/test"
git -c init.defaultBranch=main init --quiet "$repo"
cat >"$repo/README.md" <<'EOF'
# Demo service

A tiny sample project used to look at the Axis Agent view.
EOF
cat >"$repo/src/login.ts" <<'EOF'
export function login(user: string, password: string): boolean {
	return user.length > 0 && password.length >= 8;
}
EOF
cat >"$repo/src/search.ts" <<'EOF'
export function search(items: readonly string[], query: string): string[] {
	return items.filter(item => item.includes(query));
}
EOF
cat >"$repo/test/login.test.ts" <<'EOF'
import { login } from '../src/login';

if (!login('demo', 'correct-horse')) {
	throw new Error('login failed');
}
EOF
g add -A
g commit --quiet -m "Initial commit"

g worktree add --quiet -b axis/fix-login "$dir/worktrees/fix-login" main
g worktree add --quiet -b axis/add-search "$dir/worktrees/add-search" main
g worktree add --quiet --detach "$dir/worktrees/spike" main
g worktree lock --reason "demo lock" "$dir/worktrees/add-search"
printf '\n// TODO: rate-limit failed attempts\n' >>"$dir/worktrees/fix-login/src/login.ts"

printf 'Demo repository: %s\n' "$repo"
g worktree list
