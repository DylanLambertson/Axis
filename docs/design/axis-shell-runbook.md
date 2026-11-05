# Axis Agent view shell: build and run

How to build the Code OSS tree with the Axis shell (ADR 0004 Phase 0 skeleton, `docs/design/axis-agent-shell.md` tasks A1 to A4 and A6 as built in Phase 0) and look at it, on macOS with one background launch and on Linux headless. Design: [`axis-agent-shell.md`](axis-agent-shell.md). What was measured: [`docs/feasibility/axis-shell-phase0.md`](../feasibility/axis-shell-phase0.md).

The shell has **no daemon**: the dashboard reads the worktrees git has on disk, and agent runs are either empty or a labelled sample set (`axis.preview.sampleRuns`).

## Rules that apply on every host

- Build paths must not contain whitespace (node-gyp). Everything below lives under `~/.cache/project-axis/<name>/`.
- Node is the pinned 24.22.1 tarball, checked against `code-oss/upstream.json` by the repository's own `download_node`. Never Homebrew or a system Node.
- On a shared host, run the heavy steps (`npm ci`, `compile`, packaging) under `flock ~/.cache/project-axis/build.lock`. `npm ci` peaks at about 8.3 GB of RSS.

## macOS: build once, then a quick look

Run from a checkout of the branch in a path without spaces (a `git worktree` is enough). Every path is absolute; `shell-mac` is just a name.

```bash
# 0. A space-free checkout of the branch
git -C ~/path/to/your/axis/clone fetch origin
git -C ~/path/to/your/axis/clone worktree add ~/.cache/project-axis/shell-mac/src origin/feat/axis-shell-a1
cd ~/.cache/project-axis/shell-mac/src

# 1. Environment for the Code OSS scripts
export AXIS_CODE_OSS_VENDOR_DIR=$HOME/.cache/project-axis/shell-mac/vendor
export AXIS_CODE_OSS_TOOLS_DIR=$HOME/.cache/project-axis/shell-mac/tools

# 2. Fetch the pinned Code OSS, fetch and verify the pinned Node, apply the series
scripts/code-oss/fetch.sh
scripts/code-oss/build.sh --toolchain-only   # apply.sh's hook needs Node first
scripts/code-oss/apply.sh

# 3. Build: npm ci, compile, Electron, built-in extensions (about 20 minutes cold)
scripts/code-oss/build.sh

# 4. A demo repository with three linked worktrees
scripts/code-oss/shell-demo-fixture.sh $HOME/.cache/project-axis/shell-mac/demo

# 5. A fresh profile that shows the sample runs
RUN=$HOME/.cache/project-axis/shell-mac/run
mkdir -p $RUN/user-data/User $RUN/extensions $RUN/shared-data
printf '{\n\t"axis.preview.sampleRuns": true\n}\n' > $RUN/user-data/User/settings.json
```

**Quick look, one background launch.** `open -g` starts the app without bringing it to the front. The development build needs the `VSCODE_DEV` environment and the tree as its first argument, which is what upstream `scripts/code.sh` passes:

```bash
TREE=$AXIS_CODE_OSS_VENDOR_DIR/code-oss
open -g -n -a "$TREE/.build/electron/Axis.app" \
  --env VSCODE_DEV=1 --env NODE_ENV=development --env VSCODE_CLI=1 \
  --env VSCODE_SKIP_BUILTIN_EXTENSIONS=GitHub.copilot-chat \
  --args "$TREE" --user-data-dir "$RUN/user-data" --extensions-dir "$RUN/extensions" \
  --shared-data-dir "$RUN/shared-data" --skip-welcome --disable-telemetry \
  "$HOME/.cache/project-axis/shell-mac/demo/demo-repo"
```

If `open` on that macOS version has no `--env`, the fallback is the repository launcher, which comes to the front: `AXIS_CODE_OSS_RUN_DIR=$RUN scripts/code-oss/run.sh $HOME/.cache/project-axis/shell-mac/demo/demo-repo &`.

What to look at (macOS shortcuts; on Windows and Linux replace `Ctrl+Cmd` with `Ctrl+Shift+Alt`):

| Try | Expect |
|---|---|
| Start | The dashboard: four rows (the local checkout, `fix-login`, `add-search` locked, `spike` detached); sample runs in the Agents column; focus on the first row |
| Arrow keys, Enter | Moves along the rows; Enter opens that workspace's view: header and Files tree. If you trusted the folder, a terminal opens in the panel with the worktree as its cwd; in Restricted Mode none opens by itself, and **New Terminal** opens one |
| In Files: Right on `src`, Down, Enter on `login.ts` | The IDE view opens at the file, focus in the editor |
| `Ctrl+Cmd+V` twice | Back to the workspace view with focus on `login.ts`; then the IDE view again with the editor and any unsaved change intact |
| `Ctrl+Cmd+0`, `Ctrl+Alt+Cmd+2` | The dashboard; then workspace 2 |
| Settings: `axis.view.mode` = `split` | Both halves side by side; `Ctrl+Cmd+V` moves focus between them; the agent half's header collapses either half; `F6` reaches a collapsed half |

Quit with `Cmd+Q`. To start again from a clean profile, delete `$RUN`.

This macOS sequence was written from the Linux run and upstream's launcher; it has **not** been run on a Mac in this change. The macOS checks still open are listed in the feasibility note.

## Linux: headless with screenshots

The Linux host has no display and no root, so Xvfb comes from a user-space sysroot (`docs/feasibility/linux-build-validation.md` §3 on `chore/linux-build-validation`). Xvfb runs `xkbcomp` from the compiled-in `/usr/bin`, which the host lacks; running Xvfb in a user and mount namespace whose `/usr/bin` is an overlay of the sysroot's `bin` over the host's fixes that without touching the host:

```bash
SYSROOT=$HOME/.cache/project-axis/lx-tools/sysroot
unshare -rm bash -c "
  mount -t overlay overlay -o lowerdir=$SYSROOT/usr/bin:/usr/bin /usr/bin
  export LD_LIBRARY_PATH=$SYSROOT/usr/lib/x86_64-linux-gnu
  exec $SYSROOT/usr/bin/Xvfb :101 -screen 0 1600x1000x24 -nolisten tcp -xkbdir /usr/share/X11/xkb
" &
```

Xvfb warns that it cannot create `/tmp/.X11-unix/X101` (the directory belongs to root); it still listens on the abstract socket `@/tmp/.X11-unix/X101`, which Electron uses.

Build as on macOS with `AXIS_CODE_OSS_VENDOR_DIR=$HOME/.cache/project-axis/shell-lx/vendor` and `AXIS_CODE_OSS_TOOLS_DIR=$HOME/.cache/project-axis/shell-lx/tools`, plus the sysroot variables of the Linux report (`CPATH`, `LIBRARY_PATH`, `PKG_CONFIG`). On this host the sysroot's `libX11.so` (and the Kerberos `.so` links) point at runtime libraries the sysroot does not hold, so the linker fell back to `libX11.a` and `native-keymap` failed to link; a directory of links to the host's runtime libraries, first in `LIBRARY_PATH`, fixed it without editing the shared sysroot.

Launch a throwaway profile with remote debugging, then drive it:

```bash
export DISPLAY=:101 LD_LIBRARY_PATH=$SYSROOT/usr/lib/x86_64-linux-gnu   # NSS, ALSA and Xss for Electron
RUN=$HOME/.cache/project-axis/shell-lx/run-smoke
rm -rf $RUN && mkdir -p $RUN/user-data/User
printf '{\n\t"axis.preview.sampleRuns": true,\n\t"security.workspace.trust.enabled": false\n}\n' > $RUN/user-data/User/settings.json
AXIS_CODE_OSS_RUN_DIR=$RUN scripts/code-oss/run.sh --remote-debugging-port=9333 --disable-gpu --skip-welcome \
  $HOME/.cache/project-axis/shell-lx/demo/demo-repo &
node test/axis-shell/smoke.mjs --port 9333 --out <screenshot dir> \
  --settings $RUN/user-data/User/settings.json --app-path $AXIS_CODE_OSS_VENDOR_DIR/code-oss
```

The profile turns workspace trust off so the demo repository counts as trusted and a terminal opens on first focus, as the smoke test expects; never do that in a profile you use.

**The DevTools port.** `--remote-debugging-port` lets any process of the same machine drive the window, read its contents and run code in it. Use it only with a development build, a throwaway profile and the demo repository, and stop the app when the run ends. Chromium binds the port to `127.0.0.1`; Electron ignores `--remote-debugging-address`, so asking for loopback on the command line changes nothing, and `smoke.mjs` instead checks that the port listens on loopback only (Linux, from `/proc/net`) and fails otherwise, including when it finds no listener at all (an app in another network namespace cannot be checked). A packaged Axis build must refuse the flag; that check does not exist yet and is tracked as G-28 in `docs/security/threat-model-phase1-controls.md`.

`smoke.mjs` drives the app with key events (the Windows and Linux shortcuts) and typed text in the editor and the command palette; it reads the page to assert what renders and where focus is, but never clicks or focuses anything by script. The one action that is not a key is the mode change: it writes `axis.view.mode` to the profile's settings file, as a user editing it would. It writes one PNG per step and `results.json`, and exits non-zero on the first failed step. `--app-path` turns on the check that the app's Node utility processes (the extension host among them) keep their pids across twenty toggles; without it that check is skipped.

## Unit tests

Inside the tree, after a compile:

```bash
cd $AXIS_CODE_OSS_VENDOR_DIR/code-oss
./scripts/test.sh --grep Axis          # Electron renderer; on this Linux host with DISPLAY=:101 and the sysroot LD_LIBRARY_PATH
```
