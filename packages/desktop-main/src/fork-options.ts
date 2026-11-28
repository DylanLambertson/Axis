// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The options main passes to `utilityProcess.fork` for the daemon and the pty process (ADR 0003 D1 and D6; the overlay's
 * `axisMainSeam.ts` and `axisMainPty.ts` did the same inline). The entry path is main's own, never from a renderer.
 *
 * - `execArgv` is exactly `["--disable-sigusr1"]`. Node's bootstrap starts the inspector on a SIGUSR1 that arrives before any
 *   user code runs, so a check inside the entry cannot close that window; only this flag does. The daemon and pty entries
 *   accept exactly this `execArgv` and refuse anything else (audit C, `fix/credential-audit-c`).
 * - The environment is the caller's allow-listed one (`daemonEnvironment` for the daemon, the pty launch environment for the pty
 *   process), copied and frozen here, never main's own `process.env`.
 * - stdio is piped, so nothing reaches a terminal; main drains both pipes.
 *
 * [I] Electron's `utilityProcess.fork` documents `execArgv`; that the pinned version passes `--disable-sigusr1` to the child's Node
 * is checked in the second PR and again on the packaged build (a SIGUSR1 sent to the child at start leaves no inspector listening).
 */

export const UTILITY_EXEC_ARGV: readonly string[] = Object.freeze(["--disable-sigusr1"]);
export const UTILITY_SERVICE_NAMES = Object.freeze(["axis-daemon", "axis-pty"] as const);
export type UtilityServiceName = (typeof UTILITY_SERVICE_NAMES)[number];

export interface UtilityForkOptions {
  readonly serviceName: UtilityServiceName;
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: readonly string[];
  readonly stdio: "pipe";
}

/** Throws on an unknown service name or an environment value that is not a string. */
export function utilityForkOptions(serviceName: UtilityServiceName, env: Readonly<Record<string, string | undefined>>): UtilityForkOptions {
  if (!(UTILITY_SERVICE_NAMES as readonly string[]).includes(serviceName)) throw new Error("utilityForkOptions: unknown service");
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (typeof v !== "string" || k === "" || k.includes("=") || k.includes("\0") || v.includes("\0")) throw new Error("utilityForkOptions: bad environment entry");
    copy[k] = v;
  }
  return Object.freeze({ serviceName, env: Object.freeze(copy), execArgv: UTILITY_EXEC_ARGV, stdio: "pipe" as const });
}
