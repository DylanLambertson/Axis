// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * G-28: a packaged build refuses to start with a debugging switch (threat model EL-1: any local process could drive the window
 * through the DevTools protocol or main through the Node inspector). Main calls `debugFlagRefusals(process.argv, process.env, ...)`
 * first thing, before `ready`, and exits with `DEBUG_FLAG_EXIT` when the list is not empty. An unpackaged build is not checked:
 * `axis-shell-runbook.md` uses `--remote-debugging-port` with development builds only.
 *
 * This is one of three layers. The packaging step (OS-21) also turns off the Electron fuses `EnableNodeCliInspectArguments`,
 * `RunAsNode` and `EnableNodeOptionsEnvironmentVariable`, and the 1a/L33 gate launches the packaged build with the switches and
 * checks that nothing listens.
 *
 * Chromium reads a switch with a `--` or `-` prefix (and `/` on Windows), case-insensitively on Windows, and with or without
 * `=value`. Every form is refused here, on every platform, wherever it appears in `argv` (also after a `--`). The result names the
 * switch only, never its value.
 */

/** Switch names (lower case, no prefix) a packaged build refuses. */
export const REFUSED_SWITCHES: ReadonlySet<string> = new Set([
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
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
    const name = switchName(argv[i], options.platform);
    if (name !== undefined && REFUSED_SWITCHES.has(name)) found.add(`--${name}`);
  }
  for (const key of Object.keys(env)) {
    const k = options.platform === "win32" ? key.toUpperCase() : key;
    if (REFUSED_ENVIRONMENT.has(k) && env[key] !== undefined) found.add(k);
  }
  return Object.freeze([...found].sort());
}

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
