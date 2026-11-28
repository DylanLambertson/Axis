# Own shell: the terminal backend (OS-3p)

- **Status:** proposed, for a supply-chain and documentation review and a review of the build step before any code.
- **What it decides:** the pty process's terminal backend for the own shell. Slice 3.1 ships the pty process with a spawn that refuses ("no terminal backend"). OS-3p replaces that refusal with `node-pty`.
- **Related:**
  - `docs/design/own-shell-main-seam.md` (§6a lists this ticket's requirements; §3a is the hand-over the pty process runs);
  - `docs/design/pty-process.md` and `docs/design/pty-exec-node.md` (the pty service, which takes an injected `SpawnFn`);
  - ADR 0005 D4 (the dependency policy);
  - `docs/LICENSING.md` (third-party software);
  - `apps/desktop/scripts/notices.mjs` (the generated notices).
- **Facts below** were read from the registry and from the 1.1.0 tarball without running anything from it. The tarball was unpacked into an empty directory and its scripts were read, not executed. Anything not verified is marked **[unverified]**.

## 1. The choice and its alternatives

| Option | What it is | For | Against |
|---|---|---|---|
| **`node-pty`** (chosen) | The pty library behind the VS Code terminal, published by Microsoft, MIT | Mature, maintained, Node-API, Windows ConPTY support built in; two packages in all | A native module: a build step and prebuilt binaries to audit |
| A small helper of our own (`forkpty` in C) | A tiny process that owns the pty and talks to the pty process over a pipe | No Node ABI coupling; a few hundred lines | A separate build per OS and arch; Windows needs its own ConPTY implementation (there is no `forkpty` or `script` there); resize, flow control and exit codes are ours to get right |
| A repackaged fork (`@lydell/node-pty`, the `*-prebuilt-multiarch` forks) | Upstream code with prebuilt binaries for more platforms, Linux among them | No compiler on Linux | Each is one person's or one team's repackaging; the newest `@lydell/node-pty` is a beta; another publisher in the trust chain |
| Plain `child_process`, no pty | Pipes only | No native code | No TTY: shells drop prompts and line editing, full-screen programs break, no window-size signal, no job control. Not a terminal |

`node-pty` is the one terminal library already proven in this exact role, and its two-package tree is small enough to audit fully. The helper of our own stays the fallback if `node-pty`'s Electron build ever becomes untenable.

## 2. Where it lives, and the policy it meets

ADR 0005 D4 governs `packages/*`:

> **Runtime dependencies:** `zod` only, pinned exactly to **4.6.6** …
> **No other runtime dependency** without an ADR amendment.
> **Exact pins and a committed lockfile.** CI installs with `npm ci`; `--ignore-scripts` is used wherever install scripts are not needed.

So `node-pty` is a dependency of **`apps/desktop` only**, like React, Monaco and xterm.js, never of a package. `@axis/pty-process` stays free of it: its entry takes an injected `SpawnFn`, and `createNodePtySpawn` adapts any `node-pty`-shaped `spawn`. The pty process's entry bundle (`apps/desktop/pty/pty-entry.ts`) is the one file that loads it. esbuild keeps it external, because a native `.node` file cannot be bundled.

## 3. The pin

- **Version: `node-pty@1.1.0`**, published 2025-12-22. It is the newest non-prerelease (dist-tag `latest`), far past the 14-day minimum; no stable release has come out since. The `1.2.0` line is still beta (`1.2.0-beta.18`, 2026-10-23), so it is not taken.
- **Integrity:** `sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==`, recomputed from the packed file. Tarball `https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz`: 15.5 MB packed, 286 files.
- **Publisher:** `microsoft1es`; maintainers tyriar, alexr00 and microsoft1es. The registry signature is present; there are no provenance attestations.
- **Every new package** (the whole resolved tree):

| Package | Version | Licence | Install scripts |
|---|---|---|---|
| `node-pty` | 1.1.0 | MIT | `install`: `node scripts/prebuild.js \|\| node-gyp rebuild`; `postinstall`: `node scripts/post-install.js` |
| `node-addon-api` | 7.1.1 | MIT | none (headers only) |

- npm reports no advisory for either; OSV and the GitHub advisory database list none for `node-pty` [as of 2026-11-28].

## 4. What its install scripts would do, and why none of them runs

The repo installs with `npm ci --ignore-scripts`, so neither script runs. What they would do, read from the tarball:
- `scripts/prebuild.js` downloads nothing. It exits 0 when `prebuilds/<platform>-<arch>` exists in the package, and 1 otherwise, so npm falls back to `node-gyp rebuild`.
- `scripts/post-install.js` downloads nothing either. It cleans `build/Release` and, on Windows, copies the bundled ConPTY files (`conpty.dll`, `OpenConsole.exe`) next to the built module.

OS-3p does the equivalent of both itself, as an explicit, pinned build step (§5), never as an install script.

## 5. The native module for Electron 45.3.2

What the tarball ships:
- `prebuilds/darwin-arm64`, `darwin-x64`: `pty.node` and `spawn-helper`.
- `prebuilds/win32-x64`, `win32-arm64`: `pty.node`, `conpty.node`, `conpty_console_list.node`, `winpty.dll`, `winpty-agent.exe`, and `conpty/conpty.dll`, `conpty/OpenConsole.exe`.
- **No Linux prebuild.**

Every module is a pure Node-API build (`NODE_API_MODULE`, Node-API version 8, read from the Windows binaries; the macOS version number is [unverified]). Node-API is ABI-stable across Node versions; Electron's own documentation asks that native modules be rebuilt and does not state the Node-API case, so loading a Node-API prebuild in Electron 45.3.2 (which embeds Node 24.22.2) is [unverified] until a load test passes.

**The build design:**

| Platform | Source of the module | Toolchain | Pinned by |
|---|---|---|---|
| linux-x64 | Built from the tarball's source: `node-gyp rebuild --target=45.3.2 --dist-url=https://electronjs.org/headers` | `make`, `g++`, Python 3, libutil (glibc) | `node-gyp` as an exact dev dependency; the Electron headers fetched once and checked against Electron's `SHASUMS256.txt` (`node-v45.3.2-headers.tar.gz` = `34a9cbe0cb9851b657b676fef9ce3913d0bf9ff8fe29a84f405ad3836e612493`), then the build runs offline from that tarball |
| darwin-arm64, darwin-x64 | The tarball's prebuilds | none | A checked-in SHA-256 list of each prebuilt file; `spawn-helper` is stored without its execute bit (`-rw-r--r--`), so the step sets it |
| win32-x64 | The tarball's prebuilds, and the ConPTY files | none | The same SHA-256 list |

- The step is a script in `apps/desktop/scripts/` that the bundle (and CI) runs explicitly. It verifies every input's hash before it uses it. Without a toolchain on Linux, or with any hash mismatch, it **fails loudly**: there is no fallback download and no silent skip.
- `@electron/rebuild` was considered. It is 33 more packages (MIT, ISC, BlueOak-1.0.0, Apache-2.0), none with install scripts. It brings no safety over a pinned `node-gyp` plus pinned headers, so it is not used.
- Building every platform from source instead of using prebuilds would give one build path, but it needs Xcode on macOS and Visual Studio with Spectre-mitigated libraries on Windows. That waits for the packaged builds (OS-21).
- **Load test:** on each platform CI covers, the pty process loads the module inside Electron 45.3.2 and spawns a shell (§7). Until macOS and Windows have such a job, their prebuilds are verified by hash only, and that is recorded as [unverified] in the PR.

## 6. Notices

`THIRD-PARTY-NOTICES.txt` is generated from the lockfile (`scripts/notices.mjs`), and its test must keep passing with the new packages:
- `node-pty`: MIT, `LICENSE`, with three copyright lines (Christopher Jeffrey 2012-2015, Daniel Imms 2016, Microsoft Corporation 2018-present).
- `node-addon-api`: MIT, `LICENSE.md`.
- **Vendored inside `node-pty`:** winpty 0.4.4-dev (`deps/winpty/LICENSE`, MIT, Ryan Prichard), built into `winpty.dll` and `winpty-agent.exe`. The notices must include it, though the generator reads only each package's top-level licence today.
- **ConPTY binaries** (`conpty.dll`, `OpenConsole.exe`): the tarball has **no licence file for them**. They appear to come from Microsoft's Windows Terminal (MIT) [unverified]. The Windows build must not ship them until their licence is confirmed upstream and added to the notices.

## 7. CI and the smoke test

- **The desktop smoke job (ubuntu-24.04)** gains the build step (§5) before `npm run smoke`. The runner image has `make`, `g++` and Python; the job installs nothing more. A new smoke test (packaged-shaped layout: the app run from a copy of its bundle with the module beside `pty-entry.cjs`, never from `node_modules`):
  - a real pty spawns `/bin/sh` with its own explicit `cwd`, which is never the bundle directory;
  - output reaches the daemon through the control channel;
  - the shell ends when its terminal is closed.
- **macOS and Windows:** no desktop job exists yet. Until OS-21 adds one, those prebuilds are hash-checked in the build step only.
- **Packaging (OS-21):** `pty.node`, `spawn-helper`, the Windows DLLs and executables, and `conpty/` must be unpacked from `app.asar` (`asarUnpack`); `node-pty` itself rewrites `spawn-helper`'s path from `app.asar` to `app.asar.unpacked`.

## 8. What stays as it is

- The pty process's environment, its spawn checks (absolute `argv[0]` and `cwd`), the hand-over and the terminal grant are unchanged; `node-pty` only replaces the refusing spawn.
- A terminal still cannot be opened from the renderer until DC-3b (the data broker) and DC-3c (revocation routing) land: an installed backend enables nothing on its own.
