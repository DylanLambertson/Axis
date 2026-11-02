#!/usr/bin/env bash
# Self-contained tests for fetch.sh, apply.sh and the shared helpers. A local
# temporary Git repository stands in for upstream; nothing touches the network
# or the real vendor/ directory.
#
# Usage: scripts/code-oss/test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/axis-code-oss-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# Hermetic Git: ignore user/system config, fixed throwaway identity.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset NODE24_BIN AXIS_CODE_OSS_VENDOR_DIR AXIS_CODE_OSS_TOOLS_DIR
# Test mode: lets the manifest point at the file:// fake upstream.
export AXIS_CODE_OSS_TEST=1

passed=0
failed=0
status=0
root=""
tree=""
stamp=""

ok() {
	passed=$((passed + 1))
	printf 'ok %d - %s\n' "$((passed + failed))" "$1"
}

not_ok() {
	failed=$((failed + 1))
	printf 'not ok %d - %s\n' "$((passed + failed))" "$1"
	sed 's/^/    # /' "$tmp/out"
}

run() {
	set +e
	"$@" >"$tmp/out" 2>&1
	status=$?
	set -e
}

# check DESCRIPTION CONDITION...: passes when the condition command succeeds.
check() {
	local desc="$1"
	shift
	if "$@"; then ok "$desc"; else not_ok "$desc"; fi
}

expect_success() {
	local desc="$1"
	shift
	run "$@"
	if [ "$status" -eq 0 ]; then ok "$desc"; else not_ok "$desc (exit $status)"; fi
}

# expect_failure DESCRIPTION PATTERN CMD...: CMD must fail and print PATTERN.
expect_failure() {
	local desc="$1" pattern="$2"
	shift 2
	run "$@"
	if [ "$status" -ne 0 ] && grep -q -- "$pattern" "$tmp/out"; then
		ok "$desc"
	else
		not_ok "$desc (exit $status, wanted failure matching '$pattern')"
	fi
}

output_has() { grep -q -- "$1" "$tmp/out"; }
file_is() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }

# --- Fake upstream -----------------------------------------------------------

up="$tmp/upstream"
git -c init.defaultBranch=main init -q "$up"
mkdir -p "$up/src" "$up/extensions/copilot" "$up/resources"
printf 'upstream readme\n' >"$up/README.md"
printf 'copilot a\n' >"$up/extensions/copilot/a.txt"
printf 'copilot b\n' >"$up/extensions/copilot/b.txt"
printf 'upstream icon\n' >"$up/resources/icon.txt"
printf 'agent host\n' >"$up/src/agent.txt"
printf '{ "nameShort": "Code - OSS" }\n' >"$up/product.json"
printf '24.22.1\n' >"$up/.nvmrc"
printf 'lock v1\n' >"$up/package-lock.json"
printf 'ignored/\n' >"$up/.gitignore"
printf 'line 1\nline 2\nline 3\nline 4\nline 5\n' >"$up/src/app.txt"
git -C "$up" add -A
git -C "$up" commit -qm "release 1"
git -C "$up" tag -a v1.0.0 -m v1.0.0
c1="$(git -C "$up" rev-parse HEAD)"
printf 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n' >"$up/src/app.txt"
git -C "$up" commit -qam "release 2"
git -C "$up" tag v2.0.0
c2="$(git -C "$up" rev-parse HEAD)"
printf 'unreleased\n' >"$up/src/next.txt"
git -C "$up" add -A
git -C "$up" commit -qm "unreleased work"
git -C "$up" config uploadpack.allowAnySHA1InWant true

# Patches generated against release 1: 0002 only applies on top of 0001.
scratch="$tmp/scratch"
git clone -q "$up" "$scratch"
git -C "$scratch" -c advice.detachedHead=false checkout -q "$c1"
printf 'line 1\nline 2 (0001)\nline 3\nline 4\nline 5\n' >"$scratch/src/app.txt"
git -C "$scratch" diff >"$tmp/0001-first.patch"
git -C "$scratch" commit -qam p1
printf 'line 1\nline 2 (0001) (0002)\nline 3\nline 4\nline 5\n' >"$scratch/src/app.txt"
git -C "$scratch" diff >"$tmp/0002-second.patch"
git -C "$scratch" -c advice.detachedHead=false checkout -q -f "$c1"
printf 'line 1\nline 2\nline 3 (broken)\nline 4\nline 5\n' >"$scratch/src/app.txt"
git -C "$scratch" diff >"$tmp/broken.patch"
sed 's/^ line 4$/ line four/' "$tmp/broken.patch" >"$tmp/0003-broken.patch"
git -C "$scratch" -c advice.detachedHead=false checkout -q -f "$c1"
printf 'upstream readme (guardrail)\n' >"$scratch/README.md"
git -C "$scratch" diff >"$tmp/1000-guard.patch"
git -C "$scratch" -c advice.detachedHead=false checkout -q -f "$c1"
printf '// --- Start Axis ---\n++ not a file header\n{ "nameShort": "Axis" }\n// --- End Axis ---\n' >"$scratch/product.json"
git -C "$scratch" diff >"$tmp/0003-product-identity.patch"
git -C "$scratch" -c advice.detachedHead=false checkout -q -f "$c1"
printf 'agent host (stubbed)\n' >"$scratch/src/agent.txt"
git -C "$scratch" diff >"$tmp/1500-agent-host.patch"
git -C "$scratch" -c advice.detachedHead=false checkout -q -f "$c1"
cat >"$tmp/2000-harden.patch" <<'PATCH'
diff --git a/src/harden.txt b/src/harden.txt
new file mode 100644
--- /dev/null
+++ b/src/harden.txt
@@ -0,0 +1 @@
+hardened
PATCH

# --- Axis root under test ----------------------------------------------------

new_root() {
	export AXIS_CODE_OSS_ROOT="$tmp/$1"
	mkdir -p "$AXIS_CODE_OSS_ROOT/code-oss/patches" "$AXIS_CODE_OSS_ROOT/code-oss/overlay"
	printf '# format notes\n' >"$AXIS_CODE_OSS_ROOT/code-oss/patches/README.md"
	printf '# format notes\n' >"$AXIS_CODE_OSS_ROOT/code-oss/overlay/README.md"
	root="$AXIS_CODE_OSS_ROOT"
	tree="$root/vendor/code-oss"
	stamp="$root/vendor/code-oss.applied"
}

write_manifest() {
	cat >"$root/code-oss/upstream.json" <<EOF
{
  "repository": "file://$up",
  "tag": "$2",
  "commit": "$1",
  "node": "24.22.1"
}
EOF
}

fetch() { "$here/fetch.sh" "$@"; }
apply() { "$here/apply.sh" "$@"; }
head_of() { git -C "$tree" rev-parse HEAD; }

# --- Helpers -----------------------------------------------------------------

new_root lib

# --- Pinned Node tarball checksums -------------------------------------------

new_root nodepin
printf 'fake node tarball\n' >"$tmp/fake.tar.gz"
# shellcheck source=scripts/code-oss/lib.sh
fake_sha="$(. "$here/lib.sh" && sha256_of "$tmp/fake.tar.gz")"
other_sha="$(printf '%064d' 0)"
# shellcheck source=scripts/code-oss/lib.sh
dist="$(. "$here/lib.sh" && NODE_VERSION=24.22.1 node_dist_name)"
# pin_manifest PIN: writes a manifest pinning PIN (or nothing, if empty) for this OS/CPU.
pin_manifest() {
	{
		printf '{\n  "repository": "file://%s",\n  "tag": "v1.0.0",\n  "commit": "%s",\n  "node": "24.22.1"' "$up" "$c1"
		[ -z "$1" ] || printf ',\n  "node-sha256-%s": "%s"' "${dist#node-v24.22.1-}" "$1"
		printf '\n}\n'
	} >"$root/code-oss/upstream.json"
}
# verify SHASUMS_VALUE: runs verify_node_tarball on the fake tarball.
verify() {
	printf '%s  %s.tar.gz\n' "$1" "$dist" >"$tmp/SHASUMS256.txt"
	(
		# shellcheck source=scripts/code-oss/lib.sh
		. "$here/lib.sh"
		load_manifest
		verify_node_tarball "$dist" "$tmp/fake.tar.gz" "$tmp/SHASUMS256.txt"
	)
}
pin_manifest "$fake_sha"
expect_success "a tarball matching the pin and SHASUMS256.txt is accepted" verify "$fake_sha"
pin_manifest "$other_sha"
expect_failure "a tarball that does not match the pin is rejected" "checksum mismatch" verify "$other_sha"
pin_manifest "$fake_sha"
expect_failure "a pin that SHASUMS256.txt contradicts is rejected" "SHASUMS256.txt lists" verify "$other_sha"
pin_manifest ""
expect_failure "a missing pin fails closed" "refusing an unpinned toolchain" verify "$fake_sha"
pin_manifest "ABC123"
expect_failure "a malformed pin fails closed" "not a lowercase 64-character SHA-256" verify "$fake_sha"
check "the repository manifest pins darwin-x64, darwin-arm64 and linux-x64" \
	test "$(grep -cE '"node-sha256-(darwin-x64|darwin-arm64|linux-x64)": "[0-9a-f]{64}"' "$here/../../code-oss/upstream.json")" = 3

# --- Manifest validation -----------------------------------------------------

new_root badmanifest
write_manifest "abc123" v1.0.0
expect_failure "fetch rejects a manifest commit that is not a full SHA" "full 40-character" fetch
write_manifest "$c2" v1.0.0
expect_failure "fetch rejects a tag that does not point at the pinned commit" "points at" fetch

# --- fetch.sh ----------------------------------------------------------------

new_root main
write_manifest "$c1" v1.0.0
expect_success "fetch clones the pinned commit" fetch
check "HEAD equals the pinned commit (not the upstream tip)" \
	test "$(head_of)" = "$c1" -a "$(git -C "$up" rev-parse HEAD)" != "$c1"
check "checkout is shallow" test "$(git -C "$tree" rev-parse --is-shallow-repository)" = true
expect_success "fetch is idempotent" fetch
check "second fetch reports nothing to fetch" output_has "nothing to fetch"

# --- apply.sh: empty series ----------------------------------------------------

expect_success "apply with an empty series succeeds" apply
check "stamp records the commit" grep -qx "commit $c1" "$stamp"
check "tree is clean after an empty apply" test -z "$(git -C "$tree" status --porcelain)"

# --- apply.sh: patch order -----------------------------------------------------

cp "$tmp/0002-second.patch" "$tmp/0001-first.patch" "$root/code-oss/patches/"
expect_success "apply applies patches in lexical order" apply
check "patched file reflects 0001 then 0002" file_is "$tree/src/app.txt" "$(printf 'line 1\nline 2 (0001) (0002)\nline 3\nline 4\nline 5')"
check "stamp lists patches in order" \
	test "$(sed -n 's/^patch \([^ ]*\) .*/\1/p' "$stamp" | tr '\n' ' ')" = "0001-first.patch 0002-second.patch "
fp1="$(sed -n 's/^fingerprint //p' "$stamp")"
expect_success "apply is idempotent" apply
check "re-apply yields the same tree fingerprint" test "$(sed -n 's/^fingerprint //p' "$stamp")" = "$fp1"
expect_success "fetch accepts a tree whose changes come from apply.sh" fetch
check "fetch recognises the applied state" output_has "patches/overlay applied"

# --- apply.sh: protection of manual edits --------------------------------------

printf 'manual edit\n' >>"$tree/README.md"
expect_failure "apply refuses to discard manual edits" "did not make" apply
check "manual edit is preserved after refusal" grep -q "manual edit" "$tree/README.md"
expect_success "apply --force discards manual edits" apply --force
check "manual edit is gone after --force" file_is "$tree/README.md" "upstream readme"

# --- apply.sh: patch validation and failure ------------------------------------

printf 'x\n' >"$root/code-oss/patches/1-bad.patch"
expect_failure "apply rejects a badly named patch" "1-bad.patch" apply
rm "$root/code-oss/patches/1-bad.patch"
cp "$tmp/0002-second.patch" "$root/code-oss/patches/0002-duplicate.patch"
expect_failure "apply rejects duplicate patch numbers" "number 0002" apply
rm "$root/code-oss/patches/0002-duplicate.patch"
cp "$tmp/0003-broken.patch" "$root/code-oss/patches/"
expect_failure "apply fails loudly, naming the failing patch" "patch 0003-broken.patch failed" apply
check "a failed apply marks the stamp incomplete" grep -qx "status incomplete" "$stamp"
check "incomplete stamp lists only the patches that applied" \
	test "$(grep -c '^patch ' "$stamp")" = 2
rm "$root/code-oss/patches/0003-broken.patch"
expect_success "apply recovers once the failing patch is removed" apply
check "a successful apply marks the stamp complete" grep -qx "status complete" "$stamp"

# --- apply.sh: overlay -----------------------------------------------------------

mkdir -p "$root/code-oss/overlay/src/axis" "$root/code-oss/overlay/ignored"
printf 'axis file\n' >"$root/code-oss/overlay/src/axis/shell.txt"
printf 'axis ignored\n' >"$root/code-oss/overlay/ignored/cache.txt"
expect_success "apply copies new overlay files" apply
check "overlay file is in the tree" file_is "$tree/src/axis/shell.txt" "axis file"
check "overlay README.md is not copied over upstream README.md" file_is "$tree/README.md" "upstream readme"
check "stamp lists overlay files" grep -qx "overlay src/axis/shell.txt" "$stamp"
expect_success "apply is idempotent with an overlay" apply

printf 'replacement\n' >"$root/code-oss/overlay/src/app.txt"
expect_failure "apply refuses an overlay file that collides with upstream" "src/app.txt" apply
check "collision message explains the overlay rule" output_has "new files only"
check "upstream file is not overwritten by the overlay" grep -q "(0002)" "$tree/src/app.txt"
check "an overlay collision marks the stamp incomplete" grep -qx "status incomplete" "$stamp"
rm "$root/code-oss/overlay/src/app.txt"

ln -s ../../../../README.md "$root/code-oss/overlay/src/axis/link.txt"
expect_failure "apply refuses symlinks in the overlay" "only regular files" apply
rm "$root/code-oss/overlay/src/axis/link.txt"

rm -r "$root/code-oss/overlay/ignored" "$root/code-oss/overlay/src/axis"
expect_success "apply after removing overlay files" apply
check "removed overlay file is gone from the tree" test ! -e "$tree/src/axis/shell.txt"
check "removed overlay file ignored by upstream is gone too" test ! -e "$tree/ignored/cache.txt"

# --- fetch.sh: moving the pin ---------------------------------------------------

write_manifest "$c2" v2.0.0
expect_success "fetch moves an applied tree to a new pin without --force" fetch
check "HEAD equals the new pin" test "$(head_of)" = "$c2"
check "moving the pin removes the stale stamp" test ! -e "$stamp"
check "moving the pin discards applied patches" file_is "$tree/src/app.txt" "$(printf 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6')"

write_manifest "$c1" v1.0.0
printf 'manual edit\n' >>"$tree/README.md"
expect_failure "fetch refuses to move the pin over manual edits" "local modifications" fetch
check "refused fetch leaves HEAD and edits alone" \
	test "$(head_of)" = "$c2" -a -n "$(grep 'manual edit' "$tree/README.md")"
expect_success "fetch --force moves the pin over manual edits" fetch --force
check "forced fetch is at the pinned commit with a clean tree" \
	test "$(head_of)" = "$c1" -a -z "$(git -C "$tree" status --porcelain)"

# --- Git directory variants in overlay, replace/ and removals.txt ----------------

new_root gitdir
write_manifest "$c1" v1.0.0
expect_success "fetch for the Git-directory tests" fetch
# Each variant must be refused before the tree is touched, in all three inputs.
# ".git::$INDEX_ALLOCATION" is an NTFS alternate data stream name, not a variable.
# shellcheck disable=SC2016
for variant in .GIT a/.git .Git. ".git " "a/.git. ." GIT~1 'a/.git::$INDEX_ALLOCATION'; do
	for kind in overlay replace removals; do
		rm -rf "$root/code-oss/overlay" "$root/code-oss/replace" "$root/code-oss/removals.txt"
		mkdir -p "$root/code-oss/overlay" "$root/code-oss/replace"
		case "$kind" in
		overlay | replace)
			mkdir -p "$root/code-oss/$kind/$variant/hooks"
			printf '#!/bin/sh\n' >"$root/code-oss/$kind/$variant/hooks/post-checkout.png"
			chmod +x "$root/code-oss/$kind/$variant/hooks/post-checkout.png"
			;;
		removals) printf '%s\n' "$variant" >"$root/code-oss/removals.txt" ;;
		esac
		run apply
		if [ "$status" -ne 0 ] && { output_has "names the Git directory" || output_has "printable ASCII without backslash or colon"; } &&
			[ -d "$tree/.git" ] && [ ! -e "$tree/.git/hooks/post-checkout.png" ]; then
			ok "apply refuses '$variant' in $kind"
		else
			not_ok "apply refuses '$variant' in $kind (exit $status)"
		fi
	done
done
rm -rf "$root/code-oss/overlay" "$root/code-oss/replace" "$root/code-oss/removals.txt"
mkdir -p "$root/code-oss/overlay/src/.github" "$root/code-oss/overlay/src/git"
printf 'ok\n' >"$root/code-oss/overlay/src/.github/x.txt"
printf 'ok\n' >"$root/code-oss/overlay/src/git/x.txt"
expect_success "apply still accepts names that only resemble .git (.github, git)" apply
printf 'x\n' >"$root/code-oss/overlay/src/caf$(printf '\303\251').txt"
expect_failure "apply refuses non-ASCII overlay paths" "printable ASCII" apply
rm -rf "$root/code-oss/overlay/src"

# --- Manifest and toolchain rules ------------------------------------------------

new_root rules
write_manifest "$c1" v1.0.0
expect_failure "file:// upstreams are refused outside test mode" "accepted only by test.sh" env AXIS_CODE_OSS_TEST= "$here/fetch.sh"
sed 's/"node": "24.22.1"/"node": "24.23.0"/' "$root/code-oss/upstream.json" >"$tmp/m.json"
mv "$tmp/m.json" "$root/code-oss/upstream.json"
expect_failure "fetch refuses a manifest node version that differs from upstream .nvmrc" "does not match upstream .nvmrc '24.22.1'" fetch
write_manifest "$c1" v1.0.0
mkdir -p "$tmp/node-exact" "$tmp/node-newer"
printf '#!/bin/sh\necho v24.22.1\n' >"$tmp/node-exact/node"
printf '#!/bin/sh\necho v24.22.2\n' >"$tmp/node-newer/node"
chmod +x "$tmp/node-exact/node" "$tmp/node-newer/node"
resolve_with() {
	(
		# shellcheck source=scripts/code-oss/lib.sh
		. "$here/lib.sh"
		load_manifest
		NODE24_BIN="$1" resolve_node
		echo "resolved $NODE_BIN_DIR"
	)
}
expect_success "NODE24_BIN with exactly the pinned version is accepted" resolve_with "$tmp/node-exact"
check "NODE24_BIN use warns that the toolchain is not checksum-verified" output_has "not verified"
expect_failure "NODE24_BIN with another version is refused" "pins Node 24.22.1 exactly" resolve_with "$tmp/node-newer"
expect_failure "without NODE24_BIN and no pinned tarball, resolution fails without downloading" \
	"pinned Node.js 24.22.1 not found" resolve_with ""
(cd "$tmp" && AXIS_CODE_OSS_VENDOR_DIR=rel-vendor "$here/fetch.sh") >"$tmp/out" 2>&1 && status=0 || status=$?
check "a relative AXIS_CODE_OSS_VENDOR_DIR is resolved against the current directory" \
	test "$status" -eq 0 -a "$(git -C "$tmp/rel-vendor/code-oss" rev-parse HEAD 2>/dev/null)" = "$c1"

# --- Paths with whitespace and relocated vendor directory ----------------------

new_root "with space"
write_manifest "$c1" v1.0.0
expect_success "fetch works under a path containing a space" fetch
expect_success "apply works under a path containing a space" apply
expect_failure "build refuses a tree path containing whitespace before any download" \
	"breaks node-gyp" "$here/build.sh"
check "the refused build created no tools directory" test ! -e "$root/.tools"

export AXIS_CODE_OSS_VENDOR_DIR="$tmp/relocated/vendor"
expect_success "fetch honours AXIS_CODE_OSS_VENDOR_DIR" fetch
check "relocated tree is at the pinned commit" \
	test "$(git -C "$AXIS_CODE_OSS_VENDOR_DIR/code-oss" rev-parse HEAD)" = "$c1"
expect_success "apply honours AXIS_CODE_OSS_VENDOR_DIR" apply
check "relocated stamp is written next to the relocated tree" test -f "$AXIS_CODE_OSS_VENDOR_DIR/code-oss.applied"
unset AXIS_CODE_OSS_VENDOR_DIR

# --- Patch number blocks -------------------------------------------------------

new_root m3
write_manifest "$c1" v1.0.0
expect_success "fetch for the M3 layout tests" fetch
patches="$root/code-oss/patches"
cp "$tmp/0001-first.patch" "$tmp/0002-second.patch" "$tmp/0003-product-identity.patch" "$tmp/1000-guard.patch" \
	"$tmp/1500-agent-host.patch" \
	"$tmp/2000-harden.patch" "$patches/"
printf 'x\n' >"$patches/3000-unassigned.patch"
expect_failure "apply rejects a patch number above the assigned blocks" "outside the assigned number blocks" apply
rm "$patches/3000-unassigned.patch"
printf 'x\n' >"$patches/0000-zero.patch"
expect_failure "apply rejects patch number 0000" "outside the assigned number blocks" apply
rm "$patches/0000-zero.patch"
expect_success "apply accepts patches in the shell, guardrail, copilot and security blocks" apply
check "guardrail, copilot and security patches are applied" \
	test "$(cat "$tree/README.md")" = "upstream readme (guardrail)" -a "$(cat "$tree/src/harden.txt")" = hardened \
	-a "$(cat "$tree/src/agent.txt")" = "agent host (stubbed)"

# --- removals.txt ----------------------------------------------------------------

removals="$root/code-oss/removals.txt"
printf '# Copilot (decision 6)\n\n  extensions/copilot/  \n' >"$removals"
expect_success "apply deletes paths listed in removals.txt" apply
check "listed directory is removed" test ! -e "$tree/extensions/copilot"
check "stamp records the removal" grep -qx "removal extensions/copilot" "$stamp"
expect_success "apply with removals is idempotent" apply
printf 'extensions/missing\n' >>"$removals"
expect_failure "apply fails when a listed removal is missing" "extensions/missing (missing)" apply
check "a failed removal marks the stamp incomplete" grep -qx "status incomplete" "$stamp"
printf '# Copilot (decision 6)\nextensions/copilot\nignored/out.txt\n' >"$removals"
mkdir -p "$tree/ignored"
printf 'build output\n' >"$tree/ignored/out.txt"
expect_failure "apply refuses to remove ignored build output" "ignored build output" apply
check "ignored build output is left alone" test -f "$tree/ignored/out.txt"
printf 'extensions/copilot\n../outside\n' >"$removals"
expect_failure "apply rejects a removal path that escapes the tree" "unsafe path" apply
printf '.git\n' >"$removals"
expect_failure "apply rejects removing the Git directory" "Git directory" apply
printf 'extensions/copilot\n' >"$removals"

# --- replace/ ------------------------------------------------------------------

replace="$root/code-oss/replace"
mkdir -p "$replace/resources"
printf '# format notes\n' >"$replace/README.md"
printf 'axis icon\n' >"$replace/resources/icon.txt"
expect_success "apply copies replace/ files over upstream files" apply
check "replaced file has the Axis content" file_is "$tree/resources/icon.txt" "axis icon"
check "replace/README.md is not copied" file_is "$tree/README.md" "upstream readme (guardrail)"
check "stamp records the replaced path" grep -qx "replace resources/icon.txt" "$stamp"
printf 'new\n' >"$replace/resources/new-icon.txt"
expect_failure "apply refuses a replacement with no upstream file" "resources/new-icon.txt (not an upstream file" apply
rm "$replace/resources/new-icon.txt"
printf 'extensions/copilot\nresources/icon.txt\n' >"$removals"
expect_failure "apply refuses to replace a file that removals.txt deleted" "no longer a regular file" apply
printf 'extensions/copilot\n' >"$removals"
mkdir -p "$replace/src"
printf 'x\n' >"$replace/src/app.txt"
expect_failure "apply refuses to replace a source file (assets only)" "replace/src/app.txt is not an asset" apply
rm "$replace/src/app.txt"
printf 'x\n' >"$replace/src/harden.png"
expect_failure "apply refuses to replace an image with no upstream file" "src/harden.png (not an upstream file" apply
rm -r "$replace/src"
printf 'overlay\n' >"$root/code-oss/overlay/resources-icon-collision.txt"
mkdir -p "$root/code-oss/overlay/resources"
mv "$root/code-oss/overlay/resources-icon-collision.txt" "$root/code-oss/overlay/resources/icon.txt"
expect_failure "overlay still refuses an upstream path that replace/ also covers" "new files only" apply
rm -r "$root/code-oss/overlay/resources"

# --- Post-apply hooks ----------------------------------------------------------

hooks="$root/code-oss/hooks/post-apply.d"
mkdir -p "$hooks"
printf '# format notes\n' >"$hooks/README.md"
cat >"$hooks/20-second" <<'HOOK'
#!/bin/sh
printf 'second\n' >>hook.log
HOOK
cat >"$hooks/10-first" <<'HOOK'
#!/bin/sh
printf 'first %s %s\n' "$(pwd -P)" "$AXIS_UPSTREAM_COMMIT" >>hook.log
HOOK
chmod +x "$hooks/10-first" "$hooks/20-second"
expect_success "apply runs post-apply hooks" apply
check "hooks run in lexical order inside the tree with the pinned commit in the environment" \
	test "$(cat "$tree/hook.log")" = "$(printf 'first %s %s\nsecond' "$(cd "$tree" && pwd -P)" "$c1")"
check "stamp records the hooks" test "$(grep -c '^hook ' "$stamp")" = 2
expect_success "apply with hooks is idempotent" apply
check "hook output is regenerated, not appended to" test "$(grep -c '' "$tree/hook.log")" = 2
printf '#!/bin/sh\nexit 0\n' >"$hooks/30-not-executable"
expect_failure "apply rejects a hook that is not executable" "not an executable regular file: 30-not-executable" apply
printf '#!/bin/sh\nexit 3\n' >"$hooks/30-not-executable"
mv "$hooks/30-not-executable" "$hooks/30-fails"
chmod +x "$hooks/30-fails"
expect_failure "apply fails loudly when a hook fails" "post-apply hook 30-fails failed" apply
check "a failed hook marks the stamp incomplete" grep -qx "status incomplete" "$stamp"
rm "$hooks/30-fails"
expect_success "apply recovers after the failing hook is removed" apply

mkdir -p "$tmp/fake-node"
printf '#!/bin/sh\necho v24.22.1\n' >"$tmp/fake-node/node"
chmod +x "$tmp/fake-node/node"
cat >"$hooks/40-node" <<'HOOK'
#!/bin/sh
printf '%s %s\n' "${AXIS_NODE_BIN_DIR:-unset}" "$(command -v node)" >node.txt
HOOK
chmod +x "$hooks/40-node"
NODE24_BIN="$tmp/fake-node" run apply
check "hooks get the resolved Node 24 on PATH and in AXIS_NODE_BIN_DIR" \
	test "$status" -eq 0 -a "$(cat "$tree/node.txt" 2>/dev/null)" = "$tmp/fake-node $tmp/fake-node/node"
printf '#!/bin/sh\necho v25.9.0\n' >"$tmp/fake-node/node"
NODE24_BIN="$tmp/fake-node" run apply
check "hooks run without Node when only an unsuitable one is configured" \
	test "$status" -eq 0 -a "$(cut -d' ' -f1 "$tree/node.txt" 2>/dev/null)" = unset
rm "$hooks/40-node"
expect_success "apply after removing the Node hook" apply

# --- footprint.sh ------------------------------------------------------------------

cat >"$hooks/50-lock" <<'HOOK'
#!/bin/sh
printf 'lock v2\n' >package-lock.json
HOOK
chmod +x "$hooks/50-lock"
expect_success "apply runs a lockfile-regenerating hook" apply
footprint() { "$here/footprint.sh" "$@"; }
expect_success "footprint reports on the applied tree" footprint --tsv
row() { grep -Fqx "$(printf '%s\t' "$@" | sed 's/\t$//')" "$tmp/out"; }
check "footprint: shell block (3 patches, 2 upstream files, +6 -3, 2 marker lines; '++ ' line is not a header)" \
	row shell 0001-0999 3 2 6 3 2 0
check "footprint: criterion-2 shell count excludes product.json" \
	row shell-c2 '0001-0999*' 3 1 2 2 0 0
check "footprint: guardrails block (1 patch, 1 upstream file, +1 -1)" \
	row guardrails 1000-1499 1 1 1 1 0 0
check "footprint: copilot block is reported separately (1 patch, 1 upstream file, +1 -1)" \
	row copilot 1500-1999 1 1 1 1 0 0
check "footprint: security block (1 patch, new file only)" \
	row security 2000-2999 1 0 0 0 0 1
check "footprint: removals (1 path, 2 upstream files, -2)" \
	row removals removals.txt "1 paths" 2 0 2 0 0
check "footprint: replace (1 file, +1 -1)" \
	row replace replace/ "1 files" 1 1 1 0 0
check "footprint: lockfile changes by hooks are attributed to the hooks row" \
	row hooks post-apply.d "3 hooks" 1 1 1 0 0
check "footprint: net total against the pin (8 files, +9 -8)" \
	row total "net vs pin" - 8 9 8 0 0
expect_success "footprint prints a readable table by default" footprint
check "readable table has a header" output_has "upstream files"
cp "$tmp/0003-broken.patch" "$patches/"
expect_failure "footprint refuses a stale apply" "rerun scripts/code-oss/apply.sh" footprint
rm "$patches/0003-broken.patch"
cat >"$hooks/60-edit-source" <<'HOOK'
#!/bin/sh
printf 'edited by a hook\n' >>README.md
HOOK
chmod +x "$hooks/60-edit-source"
expect_success "apply runs a hook that edits upstream source" apply
expect_failure "footprint flags a hook edit to upstream source as UNATTRIBUTED" "README.md (changed by a post-apply hook" footprint
check "the UNATTRIBUTED report names the problem" output_has "UNATTRIBUTED upstream changes"
rm "$hooks/60-edit-source"
expect_success "apply after removing the source-editing hook" apply
expect_success "footprint passes again" footprint
no_index_flags() { ! git -C "$tree" ls-files -v | grep -q '^[a-zS] '; }
hidden_edit_gone() { ! grep -q hidden "$tree/src/app.txt"; }
for flag in skip-worktree assume-unchanged; do
	cat >"$hooks/70-hide" <<HOOK
#!/bin/sh
git update-index --$flag src/app.txt
printf 'hidden\n' >>src/app.txt
HOOK
	chmod +x "$hooks/70-hide"
	expect_success "apply runs a hook that hides an edit behind --$flag" apply
	expect_failure "footprint refuses a tree with a --$flag index entry" "index flags that hide changes" footprint
	check "the --$flag report names the path" output_has "src/app.txt"
	rm "$hooks/70-hide"
	expect_failure "apply clears --$flag and then sees the hidden edit as a local modification" \
		"changes that apply.sh did not make" apply
	check "apply cleared the --$flag flag" no_index_flags
	expect_success "apply --force discards the edit that --$flag hid" apply --force
	check "the edit hidden by --$flag is gone" hidden_edit_gone
	expect_success "footprint passes after the --$flag hook is removed" footprint
done
git -C "$tree" update-index --skip-worktree src/app.txt
printf 'hidden\n' >>"$tree/src/app.txt"
expect_success "fetch runs on a tree with a hand-set --skip-worktree flag" fetch
check "fetch reports the hidden edit as a local modification" output_has "local modifications"
check "fetch cleared the hand-set flag" no_index_flags
expect_success "apply --force restores the tree after the hand-set flag" apply --force
printf 'manual\n' >>"$tree/src/app.txt"
expect_failure "footprint refuses a tree edited after apply" "changed since apply.sh ran" footprint

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
