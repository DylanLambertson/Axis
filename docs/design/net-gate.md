# NET-GATE: no listener in a desktop run, no debugging ports

Gates 1a/L29 and L33, residual RR-19 (`docs/security/threat-model-phase1-residual-register.md`), threat rows NET-1 and G-28, companion to `docs/design/web-host-entry.md` (W1) and `docs/design/daemon-host-entry.md` (X1).

The gate has two halves. The static half runs on every CI run. The packaged half needs a packaged desktop build and has **not** been run.

## Verified now (static, no build needed)

`scripts/code-oss/net-gate.mjs`, tested by `test/code-oss/net-gate.test.mjs` (CI runs `test/code-oss/*.test.mjs`):

- **Overlay sources** (`code-oss/overlay/src`, test files excluded, parsed with the TypeScript parser): refused are an import, export-from, `import()` or `require` of `net`, `http`, `https`, `http2`, `tls`, `dgram`, `dns`, `inspector` (with or without `node:`), a module name that is computed, a specifier naming the web host, the reh server or the daemon-host index, a call to `listen`, `createServer` or `startWebHost`, and any string naming `--inspect*`, `--debug*` or `remote-debugging`. Symbolic links and an empty or missing tree fail the check.
- **Patch series** (`code-oss/patches`): no line a patch adds may contain the same constructs. `FLAG_REFUSAL_PATCHES` is the one allow-list, for a future patch whose purpose is to refuse the flags; it is empty.
- **Web host guards** (`packages/daemon-host/src`): the web host configuration still requires `enabled: z.literal(true)` and has no default configuration object, and no file outside `src/web` names `startWebHost` or imports from a `/web/` path.
- This adds to the staged-package rules in `scripts/code-oss/web-rules.mjs` (one listener file, the bundle graph walk), which already keep the listener out of every desktop bundle. Together they say: no Axis-owned desktop code path can start a listener, and the web host starts only for an explicit `enabled: true` configuration that nothing in the product passes yet (W1b).

Run it with `node scripts/code-oss/net-gate.mjs`.

## Not verified: only when a packaged build runs

`scripts/code-oss/check-net-packaged.mjs --app <executable> [--record <file>]` (or `AXIS_PACKAGED_APP`). It launches the build with a private profile and `--disable-extensions`, then:

1. **Plain run:** no listening socket in the app's process tree (`/proc` on Linux, `lsof` elsewhere).
2. **Each of `--remote-debugging-port`, `--inspect`, `--inspect-brk`, `--inspect-extensions`** with a free port: nothing accepts a connection on that port.

Exit 0 only when every check ran and passed; 1 for a failure; 2 when there is no build (it prints `needs a packaged build`) or the host cannot list sockets. A skip never satisfies the gate. `--record` writes the outcome as JSON, to be copied into the release evidence. The script's logic is tested against fake builds (a clean one, one that honours a flag, one that always listens, one that exits) and its parsers on fixed text; the real packaged run is not.

Scope limits, stated so they are not read as more than they are:

- Extensions are disabled for the strict check. RR-19 records that the pinned extension set opened a loopback listener on a Linux run (GitLens), so extension-owned listeners are out of this gate; a run with the pinned set needs its own record.
- A "no listener" result is a snapshot after a settle time (default 8 s), not a proof about every later moment.
- The flag checks use the port the flag names. A build that honours a flag on another port is not seen.

## Open: refusing the flags needs a Code OSS patch (not done)

The static scan proves Axis code does not enable a debugging port. It does not make the packaged build refuse `--remote-debugging-port` or `--inspect*`: upstream parses and forwards them (`src/vs/platform/environment/node/argv.ts` lists `inspect`, `inspect-brk`, `inspect-extensions` and others; `src/vs/code/node/cli.ts` adds `--inspect-brk` and `--remote-debugging-port` for `--debug`), and Electron and Chromium act on `--remote-debugging-port` before any script runs. Refusing needs a change beyond the overlay: an early check in the upstream main entry (a security-block patch, `2xxx`) and the Electron fuse that disables the Node CLI inspect arguments in packaging. Both are Code OSS patch or build work and are reported to the plan owner instead of done here. When that patch exists it goes in `FLAG_REFUSAL_PATCHES` and the packaged check is what proves it: until the check passes on a build, RR-19 stays open.
