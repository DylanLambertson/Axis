// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * G-28: a packaged build refuses to start with a debugging switch (threat model EL-1: any local process could drive the window
 * through the DevTools protocol or main through the Node inspector). Main calls `debugFlagRefusals(process.argv, process.env, ...)`
 * as its first statement and exits with `DEBUG_FLAG_EXIT` when the list is not empty. An unpackaged build is not checked:
 * `axis-shell-runbook.md` uses `--remote-debugging-port` with development builds only.
 *
 * **This module does not close G-28. It is the third layer, and it mostly detects after the fact.** Only the packaging fuses (OS-21:
 * `EnableNodeCliInspectArguments`, `RunAsNode` and `EnableNodeOptionsEnvironmentVariable` off) and the 1a/L33 launch test (the
 * packaged build started with each switch, nothing may listen) close it:
 * - `ELECTRON_RUN_AS_NODE` makes the binary a plain Node: main never runs.
 * - `NODE_OPTIONS` is applied at Node's bootstrap, before main's first statement.
 * - `--inspect` listens before main's first statement (measured on Electron 45.3.2), and `--inspect-brk`, `--inspect-wait` and
 *   `--inspect-brk-node` pause before any user code, so a debugger attaches before this check can run.
 * - What it does refuse in time is Chromium's: `--remote-debugging-port` listens only at `ready` (measured), after this check.
 *
 * A packaged build takes an ALLOW-LIST of switches: any switch not in `PACKAGED_ALLOWED_SWITCHES` is refused, so a debugging
 * switch a later Chromium, Node or Electron adds is refused by default. `REFUSED_SWITCHES` names the known debugging switches;
 * none may ever join the allow-list (a test pins that).
 *
 * Chromium reads a switch with a `--` or `-` prefix (and `/` on Windows), case-insensitively on Windows, and with or without
 * `=value`. Every form is judged here, on every platform, wherever it appears in `argv` (also after a `--`). The result names the
 * switch only, never its value.
 */

/**
 * The switches a packaged build accepts (lower case, no prefix): the Linux display switches users pass. Decided and refused:
 * `--no-sandbox` (an AppImage on a host without unprivileged user namespaces needs it; the renderer sandbox is not optional, so
 * such a host uses the distribution package or enables the namespaces) and Squirrel's `--squirrel-*` (no installer is chosen yet;
 * OS-21 adds exactly the switches of the one it picks, with its reason). A protocol or file launch passes a positional argument,
 * which is never judged.
 */
export const PACKAGED_ALLOWED_SWITCHES: ReadonlySet<string> = new Set(["ozone-platform", "ozone-platform-hint"]);

/** Known debugging switch names (lower case, no prefix). Never allowed in a packaged build. */
export const REFUSED_SWITCHES: ReadonlySet<string> = new Set([
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-debugging-targets",
  "remote-allow-origins",
  "auto-open-devtools-for-tabs",
  "inspect",
  "inspect-brk",
  "inspect-brk-node",
  "inspect-port",
  "inspect-wait",
  "inspect-publish-uid",
  "debug",
  "debug-brk",
  "debug-port",
  "js-flags",
]);

/** Environment names a packaged build refuses: either one turns main into a plain Node or loads code into it. */
export const REFUSED_ENVIRONMENT: ReadonlySet<string> = new Set(["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]);

/** `EX_USAGE`. */
export const DEBUG_FLAG_EXIT = 64;

const MAX_ARGS = 4096;

/** The refused switch and environment names present, sorted and unique; empty when the build may start. */
export function debugFlagRefusals(argv: readonly unknown[], env: Readonly<Record<string, string | undefined>>, options: { readonly packaged: boolean; readonly platform: string }): readonly string[] {
  if (!options.packaged) return Object.freeze([]);
  const found = new Set<string>();
  if (!Array.isArray(argv) || argv.length > MAX_ARGS) return Object.freeze(["argv"]);
  // argv[0] is the executable.
  for (let i = 1; i < argv.length; i++) {
    // LaunchServices may still pass `-psn_<n>_<n>` on a macOS Finder launch (a quarantined first launch). It is not a switch.
    if (options.platform === "darwin" && typeof argv[i] === "string" && MAC_PSN.test(argv[i] as string)) continue;
    const name = switchName(argv[i], options.platform);
    if (name !== undefined && (REFUSED_SWITCHES.has(name) || !PACKAGED_ALLOWED_SWITCHES.has(name))) found.add(`--${shown(name)}`);
  }
  for (const key of Object.keys(env)) {
    const k = options.platform === "win32" ? key.toUpperCase() : key;
    if (REFUSED_ENVIRONMENT.has(k) && env[key] !== undefined) found.add(k);
  }
  return Object.freeze([...found].sort());
}

/** A refused name as the log shows it: a known debugging switch by name; any other name is caller text and is never echoed. */
const shown = (name: string): string => (REFUSED_SWITCHES.has(name) ? name : "(unknown)");

const MAC_PSN = /^-psn_\d{1,10}_\d{1,10}$/;

/** The lower-case name of a switch argument, or undefined when the argument is not a switch. */
export function switchName(arg: unknown, platform: string): string | undefined {
  if (typeof arg !== "string") return undefined;
  let rest: string;
  if (arg.startsWith("--")) rest = arg.slice(2);
  else if (arg.startsWith("-")) rest = arg.slice(1);
  else if (platform === "win32" && arg.startsWith("/")) rest = arg.slice(1);
  else return undefined;
  const eq = rest.indexOf("=");
  const name = (eq === -1 ? rest : rest.slice(0, eq)).trim().toLowerCase();
  return name === "" ? undefined : name;
}
