// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-4: argv-only commands with a timeout, an output cap, a process-group kill and a record of why they ended.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isPlainAbsolute } from "@axis/pty-policy";
import { BrokerError, invalid } from "./errors.js";
import { assertEnv } from "./env.js";

export type EndReason = "exit" | "signal" | "timeout" | "output-cap" | "aborted" | "spawn-error";

export interface CommandSpec {
  /** `argv[0]` is an absolute path (resolve a bare name first with `resolveExecutable`); there is no shell. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Combined stdout and stderr bytes kept; one more byte kills the group. */
  readonly maxOutputBytes: number;
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface RunRecord {
  readonly endedBy: EndReason;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly truncated: boolean;
  /** The process group (or process) was signalled because of a limit or an abort. */
  readonly killed: boolean;
  /** Processes were still alive in the group after the main one exited and were killed. */
  readonly strayKilled: boolean;
  /** The pipes did not close after the kill and were destroyed. */
  readonly streamsDestroyed: boolean;
  /** The main process was still running when the runner gave up waiting (its slot stays held until it exits). */
  readonly unkillable: boolean;
  readonly errorCode?: string;
}

export type SpawnFn = typeof nodeSpawn;
export interface RunnerOptions {
  readonly spawn?: SpawnFn;
  readonly platform?: NodeJS.Platform;
  readonly maxConcurrent?: number;
  /** Time between SIGTERM and SIGKILL, and the wait for the pipes after an exit. */
  readonly killGraceMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputCap?: number;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<RunRecord>;
  /** SIGKILL every live process group. For the host's shutdown path; the runner installs no process hook. */
  killAll(): number;
  readonly active: number;
}

const MAX_ARGS = 1024;
const MAX_ARG = 32_768;
const MAX_ARGV_TOTAL = 131_072;
const MAX_STDIN = 8 * 1024 * 1024;

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function option(v: unknown, def: number, lo: number, hi: number): number {
  if (v === undefined) return def;
  if (!intIn(v, lo, hi)) throw invalid("invalid-command", "a runner option is not valid");
  return v;
}

function validate(spec: CommandSpec, platform: NodeJS.Platform, maxTimeout: number, maxCap: number): void {
  const bad = (): never => {
    throw invalid("invalid-command", "the command is not valid");
  };
  if (spec === null || typeof spec !== "object" || !Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.length > MAX_ARGS) return bad();
  let total = 0;
  for (const a of spec.argv) {
    if (typeof a !== "string" || a.includes("\0") || a.length > MAX_ARG) return bad();
    total += a.length + 1;
  }
  if (total > MAX_ARGV_TOTAL || !isPlainAbsolute(spec.argv[0] as string, platform)) return bad();
  if (typeof spec.cwd !== "string" || !isPlainAbsolute(spec.cwd, platform)) return bad();
  if (!intIn(spec.timeoutMs, 1, maxTimeout) || !intIn(spec.maxOutputBytes, 1, maxCap)) return bad(); // NaN, Infinity and fractions all fail here
  if (spec.stdin !== undefined && (!(spec.stdin instanceof Uint8Array) || spec.stdin.length > MAX_STDIN)) return bad();
  assertEnv(spec.env);
}

export function createCommandRunner(options: RunnerOptions = {}): CommandRunner {
  const spawnFn = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const posix = platform !== "win32";
  const maxConcurrent = option(options.maxConcurrent, 4, 1, 256);
  const graceMs = option(options.killGraceMs, 2000, 1, 60_000);
  const maxTimeout = option(options.maxTimeoutMs, 600_000, 1, 3_600_000);
  const maxCap = option(options.maxOutputCap, 16 * 1024 * 1024, 1, 256 * 1024 * 1024);
  // A slot is held from spawn until the main process has exited, not until the caller's promise settles.
  const live = new Set<ChildProcess>();

  const signalGroup = (child: ChildProcess, sig: NodeJS.Signals): boolean => {
    try {
      if (posix && child.pid !== undefined) process.kill(-child.pid, sig);
      else child.kill(sig);
      return true;
    } catch {
      return false;
    }
  };
  const groupAlive = (child: ChildProcess): boolean => {
    if (!posix || child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: unknown } | null)?.code === "EPERM";
    }
  };

  function exec(spec: CommandSpec): Promise<RunRecord> {
    return new Promise<RunRecord>((resolve) => {
      const started = performance.now();
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let kept = 0;
      let reason: EndReason | undefined;
      let truncated = false;
      let killed = false;
      let strayKilled = false;
      let streamsDestroyed = false;
      let unkillable = false;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let errorCode: string | undefined;
      let exited = false;
      let settled = false;
      const timers = new Set<NodeJS.Timeout>();
      const after = (ms: number, fn: () => void): NodeJS.Timeout => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        // A timer armed after the run settled (the unkillable path) would never be cleared by `finish`.
        if (settled) clearTimeout(t);
        else timers.add(t);
        return t;
      };

      if (spec.signal?.aborted === true) {
        resolve(record("aborted"));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawnFn(spec.argv[0] as string, spec.argv.slice(1), {
          cwd: spec.cwd, env: { ...spec.env }, shell: false, detached: posix, windowsHide: true,
          stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        resolve(record("spawn-error", typeof code === "string" ? code : "SPAWN"));
        return;
      }
      live.add(child);

      function record(endedBy: EndReason, code?: string): RunRecord {
        return {
          endedBy, exitCode, signal: exitSignal, durationMs: Math.round(performance.now() - started),
          stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated, killed, strayKilled, streamsDestroyed, unkillable,
          ...(code === undefined ? {} : { errorCode: code }),
        };
      }
      const onAbort = (): void => end("aborted");
      function finish(): void {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        timers.clear();
        spec.signal?.removeEventListener("abort", onAbort);
        resolve(record(reason ?? (exitSignal !== null ? "signal" : "exit"), errorCode));
      }
      function end(why: EndReason): void {
        if (reason !== undefined || exited) return;
        reason = why;
        killed = true;
        signalGroup(child, "SIGTERM");
        after(graceMs, () => {
          if (!exited) signalGroup(child, "SIGKILL");
        });
        // If the main process cannot be killed, stop waiting but keep its slot: it is released on exit only.
        after(graceMs * 3, () => {
          if (!exited) {
            unkillable = true;
            child.stdout?.destroy();
            child.stderr?.destroy();
            streamsDestroyed = true;
            finish();
          }
        });
      }

      const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
        if (reason === "output-cap") return;
        const room = spec.maxOutputBytes - kept;
        if (chunk.length > room) {
          if (room > 0) sink.push(chunk.subarray(0, room));
          kept = spec.maxOutputBytes;
          truncated = true;
          end("output-cap");
          return;
        }
        sink.push(chunk);
        kept += chunk.length;
      };
      child.stdout?.on("data", collect(out));
      child.stderr?.on("data", collect(err));
      child.stdout?.on("error", () => undefined);
      child.stderr?.on("error", () => undefined);
      child.stdin?.on("error", () => undefined);
      if (spec.stdin !== undefined) child.stdin?.end(Buffer.from(spec.stdin));

      child.on("error", (e: Error) => {
        // Only a failed spawn reaches here with no pid; a late error on a running child is ignored.
        if (child.pid !== undefined) return;
        const code = (e as { code?: unknown }).code;
        errorCode = typeof code === "string" ? code : "SPAWN";
        exited = true;
        live.delete(child);
        reason = "spawn-error";
        finish();
      });
      child.on("exit", (code, sig) => {
        exited = true;
        live.delete(child);
        exitCode = code;
        exitSignal = sig;
        // The run is over: nothing it started may outlive it. Probe first, so a clean exit records no stray kill.
        if (groupAlive(child)) {
          strayKilled = signalGroup(child, "SIGKILL");
        }
        // The pipes can stay open if a process outside the group holds them.
        after(graceMs, () => {
          if (!settled) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            streamsDestroyed = true;
            finish();
          }
        });
      });
      child.on("close", () => finish());

      spec.signal?.addEventListener("abort", onAbort, { once: true });
      if ((spec.signal as AbortSignal | undefined)?.aborted === true) end("aborted");
      after(spec.timeoutMs, () => end("timeout"));
    });
  }

  return {
    async run(spec) {
      validate(spec, platform, maxTimeout, maxCap);
      if (live.size >= maxConcurrent) throw new BrokerError("E_BACKPRESSURE", "too-many-processes", "too many commands are running");
      return exec(spec);
    },
    killAll() {
      let n = 0;
      for (const c of live) if (signalGroup(c, "SIGKILL")) n++;
      return n;
    },
    get active() {
      return live.size;
    },
  };
}
