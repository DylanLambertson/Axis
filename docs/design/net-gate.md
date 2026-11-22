# NET-GATE: no listener in a desktop run, no debugging ports

Gates 1a/L29 and L33, residual RR-19 (`docs/security/threat-model-phase1-residual-register.md`), threat rows NET-1 and G-28, companion to `docs/design/web-host-entry.md` (W1) and `docs/design/daemon-host-entry.md` (X1).

The gate has two halves. The static half runs on every CI run. The packaged half needs a packaged desktop build and has **not** been run.

## Verified now (static, no build needed)

`scripts/code-oss/net-gate.mjs`, tested by `test/code-oss/net-gate.test.mjs` (CI runs `test/code-oss/*.test.mjs`):

- **Overlay sources** (`code-oss/overlay/src`, every `.ts`, `.js` and variant file, test files and test directories included, parsed with the TypeScript parser). This is an allowlist for loading code: a non-relative import, export-from, `import()` or `require` is refused unless its module is in `ALLOWED_BARE` (`assert`, `crypto`, `electron`, `fs`, `os`, `path`, `url`, `util`, `vscode`) or named for that one file in `FILE_ALLOW` (`node-pty` for the pty process entry, `child_process` for one disk test). So `net`, `http`, `https`, `http2`, `tls`, `dgram`, `dns`, `inspector`, `cluster`, `worker_threads` and any server package (`ws`, `express`, ...) are refused until someone names them after review. A relative specifier naming the web host, the reh server, the daemon-host index or the upstream IPC socket server is refused. Also refused: a computed module name, any use of `require`, `createRequire`, `getBuiltinModule` or `binding`, a call to `listen`, `createServer` or `startWebHost` (also as `s["listen"]()`), a call of a member chosen at run time (`s[name]()`, with one reviewed file in `ELEMENT_CALL_ALLOW`), and a string that names `--inspect*`, `--debug*` or `remote-debugging` (case-insensitive, `+` concatenations joined so `"--insp" + "ect"` is seen). Symbolic links and an empty or missing tree fail the check.
- **Patch series** (`code-oss/patches`): the diff is parsed by its hunk counts, so only the header lines before a hunk are skipped (an added line that begins `++` is content), and a hunk header that does not parse fails the check. Each added line gets the same rules as text: loader routes, bare imports off the allowlist, the web host names, listener calls, computed member calls and debugging flags. `FLAG_REFUSAL_PATCHES` is the one allow-list, for a future patch whose purpose is to refuse the flags; it is empty.
- **Web host guards** (`packages/daemon-host/src`): the web host configuration still requires `enabled: z.literal(true)` and has no default configuration object, and no file outside `src/web` names `startWebHost` or imports from a `/web/` path.
- This adds to the staged-package rules in `scripts/code-oss/web-rules.mjs` (one listener file, the bundle graph walk).

What the scan proves, and what it does not. It reads source text and it is a list of known constructs, not a proof.

- **Refused (each has a test):** loading any module off the allowlist; `require`, `createRequire`, `getBuiltinModule`, `binding`; `eval` (direct or `(0, eval)`); `Function` as a call, `new` or any value (aliases); `x.constructor.constructor`; `Reflect.get`, `apply`, `construct`, `getOwnPropertyDescriptor`; any reference to `listen`, `createServer`, `startWebHost` (call, `.call`/`.apply` target, bracket reference, destructuring); a call of a member chosen at run time; `String.fromCharCode` and `fromCodePoint`; a string, template or `+` chain naming `--inspect*`, `--debug*` or `remote-debugging` (case-insensitive, template substitutions and `+` joined).
- **Not detected (pinned by a test, so a change is deliberate):** a flag assembled from variables, `concat`, `replace`, `join`, or run-time input; code reached through a host object the scan has no name for. These are covered only by the packaged check, and only for the four flags it tries.
- **Patch lines** get the same rules as text on the raw line: strings are not blanked, because that needs a tokenizer that tells a regex literal like `/'/` from a division, and a wrong guess hides code. The cost is a possible false positive on a string that holds a bare word such as `eval` or `Function`; a comment line is exempt. A `+` line outside a hunk is reported, and a hunk header that does not parse fails.
- It does not prove that upstream Code OSS code, or an extension, opens no listener (that is the packaged half). The web host starts only for an explicit `enabled: true` configuration that nothing in the product passes yet (W1b).

Run it with `node scripts/code-oss/net-gate.mjs`.

## Not verified: only when a packaged build runs

`scripts/code-oss/check-net-packaged.mjs --app <executable> [--record <file>]` (or `AXIS_PACKAGED_APP`). It launches the build with a private profile and `--disable-extensions`, then:

1. **Plain run:** no listening socket in the app's process tree (`/proc` on Linux, `lsof` elsewhere).
2. **Each of `--remote-debugging-port`, `--inspect`, `--inspect-brk`, `--inspect-extensions`** with a free port: nothing accepts a connection on that port.

Exit 0 only when every check ran and passed; 1 for a failure; 2 when there is no build (it prints `needs a packaged build`) or the host cannot list sockets. A skip never satisfies the gate. `--record` writes the outcome as JSON, to be copied into the release evidence. The script's logic is tested against fake builds (a clean one, one that honours a flag, one that always listens, one that exits) and its parsers on fixed text; the real packaged run is not.

Scope limits, stated so they are not read as more than they are:

- Extensions are disabled for the strict check. RR-19 records that the pinned extension set opened a loopback listener on a Linux run (GitLens), so extension-owned listeners are out of this gate; a run with the pinned set needs its own record.
- A "no listener" result is a snapshot after a settle time (default 8 s), not a proof about every later moment.
- The CLI messaging endpoint (PV-M6) is a Unix socket the pty process opens only for a CLI run whose spawn asks for one (off by default, inert until PV-G4). An idle packaged run never opens it, so this gate does not exercise it; it lists TCP only either way. What keeps the endpoint off TCP is its source rules (`scripts/code-oss/web-rules.mjs` rule 1, the whitelist in `endpoint-ast.mjs`) and its own runtime check, not this gate. **Gate line (PV-M6 slice 2):** `packages/pty-process/src/endpoint-host.ts` must refuse a non-absolute or numeric listen path at run time, before it touches the file system or listens (Node reads a numeric string given to `listen()` as a TCP port, and the source rule cannot rule out a numeric `join` result): test "review: only an absolute path is ever listened on: a relative or numeric directory opens nothing (a numeric string would be a TCP port)" in `packages/pty-process/test/endpoint-host.test.ts`.
- The flag checks use the port the flag names. A build that honours a flag on another port is not seen. Only the four flags above and only TCP are tried (not `--remote-debugging-pipe`, `--inspect-port`, `--js-flags=--inspect`, UDP or unix sockets). The whole process group is killed after every launch, also when the leader already exited (tested with a child that outlives its leader). An app that exits during a flag run counts as refusing; the plain run fails closed when the app does not stay up.
- The static check runs through its test in CI (`test/code-oss/*.test.mjs`); it has no separate CI step.

## Open: refusing the flags needs a Code OSS patch (not done)

The static scan proves Axis code does not enable a debugging port. It does not make the packaged build refuse `--remote-debugging-port` or `--inspect*`: upstream parses and forwards them (`src/vs/platform/environment/node/argv.ts` lists `inspect`, `inspect-brk`, `inspect-extensions` and others; `src/vs/code/node/cli.ts` adds `--inspect-brk` and `--remote-debugging-port` for `--debug`), and Electron and Chromium act on `--remote-debugging-port` before any script runs. Refusing needs a change beyond the overlay: an early check in the upstream main entry (a security-block patch, `2xxx`) and the Electron fuse that disables the Node CLI inspect arguments in packaging. Both are Code OSS patch or build work and are reported to the plan owner instead of done here. When that patch exists it goes in `FLAG_REFUSAL_PATCHES` and the packaged check is what proves it: until the check passes on a build, RR-19 stays open.
