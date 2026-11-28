// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The options main passes to `utilityProcess.fork` for the daemon and the pty process (ADR 0003 D1 and D6; the overlay's
 * `axisMainSeam.ts` and `axisMainPty.ts` did the same inline). The entry path is main's own, never from a renderer.
 *
 * - `execArgv` is exactly `["--disable-sigusr1"]`, the one argument the daemon and pty entries accept (audit C). Measured on
 *   Electron 45.3.2, a utility process receives the flag but does not honour it: a SIGUSR1 still opens an inspector. So the
 *   control is the entries' own SIGUSR1 listener, installed as their first statement; the flag is kept because it costs
 *   nothing and holds wherever an entry runs under plain Node (`docs/design/own-shell-main-hardening.md` section 3, item 5).
 * - The environment is the caller's allow-listed one (`daemonEnvironment` for the daemon, the pty launch environment for the pty
 *   process), copied and frozen here, never main's own `process.env`. What is enforced here: every `NODE_*`, `ELECTRON_*`,
 *   `LD_*` and `DYLD_*` name is refused (case-insensitively: Windows environment names are), so `NODE_OPTIONS`, `NODE_PATH`,
 *   `NODE_EXTRA_CA_CERTS`, `ELECTRON_RUN_AS_NODE`, `LD_PRELOAD`, `LD_LIBRARY_PATH` and `DYLD_INSERT_LIBRARIES` can never
 *   reach a child.
 * - The working directory is main's choice, absolute (the child never inherits main's own).
 * - stdio is piped, so nothing reaches a terminal; main drains both pipes.
 */

export const UTILITY_EXEC_ARGV: readonly string[] = Object.freeze(["--disable-sigusr1"]);
export const UTILITY_SERVICE_NAMES = Object.freeze(["axis-daemon", "axis-pty"] as const);
export type UtilityServiceName = (typeof UTILITY_SERVICE_NAMES)[number];

export interface UtilityForkOptions {
  readonly serviceName: UtilityServiceName;
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: readonly string[];
  readonly stdio: "pipe";
  readonly cwd: string;
}

/** Environment names no child may get: Node's and Electron's own controls. */
export const REFUSED_CHILD_ENV = /^(NODE_|ELECTRON_|LD_|DYLD_)/i;

/** Throws on an unknown service name, a refused or malformed environment entry, or a relative working directory. */
export function utilityForkOptions(serviceName: UtilityServiceName, env: Readonly<Record<string, string | undefined>>, cwd: string, platform: "darwin" | "linux" | "win32"): UtilityForkOptions {
  if (!(UTILITY_SERVICE_NAMES as readonly string[]).includes(serviceName)) throw new Error("utilityForkOptions: unknown service");
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (typeof v !== "string" || k === "" || k.includes("=") || k.includes("\0") || v.includes("\0")) throw new Error("utilityForkOptions: bad environment entry");
    if (REFUSED_CHILD_ENV.test(k)) throw new Error("utilityForkOptions: a NODE_, ELECTRON_, LD_ or DYLD_ environment name is refused");
    copy[k] = v;
  }
  if (typeof cwd !== "string" || cwd.includes("\0") || !(platform === "win32" ? /^[A-Za-z]:\\/.test(cwd) : cwd.startsWith("/"))) throw new Error("utilityForkOptions: cwd must be an absolute path");
  return Object.freeze({ serviceName, env: Object.freeze(copy), execArgv: UTILITY_EXEC_ARGV, stdio: "pipe" as const, cwd });
}
