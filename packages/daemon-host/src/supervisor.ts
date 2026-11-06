// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { outboundMessageSchema, type OutboundMessage } from "./control/messages.js";
import { base64url, signMainAttestation, type HmacSha256, type MainIdentity } from "./main/attest-sign.js";

/**
 * The parent side of the daemon host (ticket X1, design `docs/design/daemon-host-entry.md`): spawn the fixed entry, send `init`,
 * watch it, restart it under a bounded policy, and stop it with a `shutdown` message before any kill. It runs in Electron main
 * through the overlay seam (`vs/axis/code/electron-main/axisMainSeam.ts`), so this file imports no `electron`, no `@axis/*`
 * package and no Node module: only the control message schemas. It is injected with everything that touches the world (the child,
 * timers, the monotonic clock, random bytes), so it is tested without Electron, a process or a real timer.
 *
 * Exit codes (the numbers of `exit-codes.ts`, held equal by `supervisor.test.ts`):
 * - 75 (another daemon holds the data directory), 78 (the configuration or the data directory was refused, or a required port is
 *   missing) and 79 (degraded, asked to stop): NEVER restarted. Starting again cannot succeed and would only repeat the refusal.
 * - Anything else while not stopping (1, 70, 0 without a request, another code, a signal, no `ready` in time): restarted with
 *   exponential backoff, at most `maxRestarts` times in `windowMs`; one more is `failed` with reason `crash_loop` and stays down.
 * - A stop that was requested: never restarted, whatever the code.
 * A run that stayed `ready` for `stableMs` forgets earlier crashes.
 *
 * What main does NOT do here (no answer is a refusal on the host side, design 6.3): anchor storage, native confirmation, trust
 * checks and settings. `onRequest` is where main plugs them in (`main/answers.ts`, ticket X1c); without it every request goes
 * unanswered, so the host runs degraded or refuses (a missing `anchor.get` answer is degraded mode, a missing `native.result` is a
 * declined dialog).
 *
 * The attestation key (ticket X1b, `docs/design/main-answers.md` section 2): the supervisor keeps a copy of the current
 * generation's key bytes from the spawn until that child exits, a spawn fails, it fails or it stops, and zeroes it then. It never
 * hands the key out: `connect(identity, port)` signs here and posts the `connect` message with the one transferred port.
 */

/** The exit codes the supervisor treats specially (equal to `EXIT` in `exit-codes.ts`; a test holds them equal). */
export const SUPERVISED_EXIT = Object.freeze({ OK: 0, UNSETTLED: 1, INTERNAL: 70, LOCK_HELD: 75, BAD_CONFIG: 78, DEGRADED: 79 } as const);

export type SupervisorState = "idle" | "starting" | "running" | "backoff" | "stopping" | "stopped" | "failed";

/** Why the supervisor is `failed`: a closed set, never text from the child. */
export type FailureReason = "lock_held" | "bad_config" | "degraded" | "crash_loop";

export interface DaemonChild {
  /** `transfer` carries the one port of a `connect` (Electron `MessagePortMain`); absent for every other message. */
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  /** Terminate now (no graceful path). */
  kill(): unknown;
  onMessage(handler: (message: unknown) => void): () => void;
  /** `code` is null when the child was ended by a signal. */
  onExit(handler: (code: number | null) => void): () => void;
}

export interface SupervisorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The part of `HostConfig` main decides; the attestation key is made here, per spawn. */
export interface SupervisedConfig {
  readonly dataDir: string;
  readonly worktreeRoot: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly devDiagnostics: boolean;
}

export interface RestartPolicy {
  /** Restarts allowed inside `windowMs` (default 5). */
  readonly maxRestarts: number;
  readonly windowMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A run that was `ready` this long forgets earlier crashes. */
  readonly stableMs: number;
  /** No `ready` within this long after the spawn is a crash (the child is killed). */
  readonly readyTimeoutMs: number;
  /** After `shutdown` is posted, kill once this long has passed without an exit. */
  readonly stopGraceMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = Object.freeze({
  maxRestarts: 5,
  windowMs: 600_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  stableMs: 60_000,
  readyTimeoutMs: 60_000,
  // The host's own shutdown is drain 10 s, settle 2 s, flush 5 s and the final anchor 1.5 s (design 8).
  stopGraceMs: 20_000,
});

/** Closed event names: the log of the supervisor never carries text from the child. */
export type SupervisorEvent = "spawned" | "ready" | "degraded" | "exited" | "restart_scheduled" | "failed" | "stopping" | "stopped" | "invalid_message" | "unanswered_request" | "fatal_reported";

export interface DaemonSupervisorOptions {
  /** Starts the FIXED entry (never a path from a renderer). */
  readonly spawn: () => DaemonChild;
  readonly config: SupervisedConfig;
  /** `n` random bytes, from a CSPRNG (the seam passes `crypto.randomBytes`). */
  readonly randomBytes: (n: number) => Uint8Array;
  readonly timers: SupervisorTimers;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly policy?: Partial<RestartPolicy>;
  readonly onEvent?: (event: SupervisorEvent, fields: { readonly code?: number | null; readonly reason?: string; readonly count?: number }) => void;
  /** Answers the host's requests (anchor, native confirm, trust, settings). Absent or silent: no answer, which the host treats as a refusal. */
  readonly onRequest?: (message: OutboundMessage, reply: (message: unknown) => void) => void;
  readonly onStateChange?: (state: SupervisorState, reason: FailureReason | undefined) => void;
  /** HMAC-SHA256 for signing connects (the seam passes `crypto.createHmac`). Absent: `connect` always refuses. */
  readonly hmacSha256?: HmacSha256;
  /** Wall-clock milliseconds for `issuedAt` (the daemon judges freshness on its wall clock). Default `Date.now`. */
  readonly wallNow?: () => number;
}

/** The names main lets through to the daemon (design 3, step 2: nothing a renderer can influence). `NODE_OPTIONS` is never one. */
export const DAEMON_ENV_ALLOW = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_RUNTIME_DIR", "PATHEXT", "WINDIR", "COMSPEC", "USERNAME", "HOMEDRIVE", "HOMEPATH"] as const);

/** The environment of the daemon process: the allow-listed names of `source` that are strings, nothing else. */
export function daemonEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DAEMON_ENV_ALLOW) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/**
 * Whether main starts the daemon at all. Until the pty process (B9) and the run snapshotter (GIT-SNAP-1) exist the daemon refuses to
 * start (exit 78) in every build, so a packaged app does not spawn it: the extra process and its error lines would give a user
 * nothing. Unpackaged builds do, which exercises `fork`, `init` and the refusal. REMOVE the condition in the change that wires the
 * real ports (and X1c must land before or with it: docs/design/daemon-host-plan.md).
 */
export const shouldStartDaemon = (isPackaged: boolean): boolean => !isPackaged;

export interface AxisDataRoots {
  readonly dataDir: string;
  readonly worktreeRoot: string;
}

const isAbsoluteFor = (platform: SupervisedConfig["platform"], p: string): boolean =>
  platform === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/");

/**
 * Where the daemon keeps its database and the managed worktrees (design D-3, ADR 0004 decision 7), per platform and NOT under
 * Electron's `userData` (Linux: the config directory; Windows: Roaming AppData, which a domain profile syncs; and it follows
 * `--user-data-dir`):
 * - macOS `<home>/Library/Application Support/Axis`;
 * - Linux `$XDG_DATA_HOME/Axis`, default `<home>/.local/share/Axis` (a relative or empty `XDG_DATA_HOME` is ignored, as the XDG spec says);
 * - Windows `%LOCALAPPDATA%\Axis`, default `<home>\AppData\Local\Axis`.
 * `dataDir` is `<base>/daemon` and `worktreeRoot` is `<base>/worktrees`, so both share one anchor. Pure: `env` and `home` come in.
 */
export function axisDataRoots(platform: SupervisedConfig["platform"], env: Readonly<Record<string, string | undefined>>, home: string): AxisDataRoots {
  const sep = platform === "win32" ? "\\" : "/";
  const clean = (p: string): string => p.replace(/[\\/]+$/, "");
  const usable = (v: string | undefined): v is string => typeof v === "string" && v !== "" && !v.includes("\0") && isAbsoluteFor(platform, v);
  let base: string;
  if (platform === "darwin") base = `${clean(home)}/Library/Application Support/Axis`;
  else if (platform === "win32") base = `${clean(usable(env["LOCALAPPDATA"]) ? (env["LOCALAPPDATA"] as string) : `${clean(home)}\\AppData\\Local`)}\\Axis`;
  else base = `${clean(usable(env["XDG_DATA_HOME"]) ? (env["XDG_DATA_HOME"] as string) : `${clean(home)}/.local/share`)}/Axis`;
  return { dataDir: `${base}${sep}daemon`, worktreeRoot: `${base}${sep}worktrees` };
}

const KEY_BYTES = 32;
const MIN_DISTINCT = 16;
const KEY_TRIES = 8;

export class DaemonSupervisor {
  readonly #o: DaemonSupervisorOptions;
  readonly #policy: RestartPolicy;
  #state: SupervisorState = "idle";
  #failure: FailureReason | undefined;
  #child: DaemonChild | undefined;
  #generation = 0;
  #offs: Array<() => void> = [];
  #readyTimer: unknown;
  #backoffTimer: unknown;
  #stopTimer: unknown;
  #stopWaiters: Array<() => void> = [];
  #crashes: number[] = [];
  #readyAt: number | undefined;
  #sentReady = false;
  #unansweredLogged = 0;
  /** The current generation's key bytes; zeroed and dropped when that child is gone. */
  #key: Uint8Array | undefined;

  constructor(options: DaemonSupervisorOptions) {
    this.#o = options;
    this.#policy = { ...DEFAULT_RESTART_POLICY, ...options.policy };
  }

  state(): SupervisorState {
    return this.#state;
  }

  failure(): FailureReason | undefined {
    return this.#failure;
  }

  /** Spawn the host once. A second call, or a call after a stop or a failure, does nothing (no restart on request). */
  start(): void {
    if (this.#state !== "idle") return;
    this.#spawn();
  }

  /**
   * Stop on app quit: post `shutdown`, wait for the exit, kill after `stopGraceMs`. Resolves when the child is gone (or there was none).
   * A restart waiting in backoff is cancelled. Safe to call again; every call resolves.
   */
  shutdown(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "failed" || this.#state === "idle") {
      if (this.#state === "idle") this.#set("stopped");
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#stopWaiters.push(resolve);
      if (this.#state === "stopping") return;
      this.#set("stopping");
      this.#emit("stopping", {});
      this.#clearTimers();
      const child = this.#child;
      if (child === undefined) {
        this.#finishStop();
        return;
      }
      try {
        child.postMessage({ type: "shutdown" });
      } catch {
        // a closed channel: the kill below ends it
      }
      this.#stopTimer = this.#o.timers.set(() => this.#killNow(), this.#policy.stopGraceMs);
    });
  }

  /**
   * Broker one renderer connection (ticket X1b): sign `identity` with the current generation's key and post `connect` with the
   * one port. `false` (and nothing posted) unless the host is `running` (it sent `ready`; a degraded host is running) and a MAC
   * function was given. The caller closes the port on `false`. Never throws.
   */
  connect(identity: MainIdentity, port: unknown): boolean {
    const child = this.#child;
    const key = this.#key;
    const hmac = this.#o.hmacSha256;
    if (this.#state !== "running" || child === undefined || key === undefined || hmac === undefined) return false;
    try {
      const attestation = signMainAttestation(hmac, key, identity, (this.#o.wallNow ?? Date.now)());
      child.postMessage({ type: "connect", attestation }, [port]);
      return true;
    } catch {
      return false;
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  #dropKey(): void {
    this.#key?.fill(0);
    this.#key = undefined;
  }

  #spawn(): void {
    const generation = ++this.#generation;
    this.#sentReady = false;
    this.#readyAt = undefined;
    this.#set("starting");
    // The key first: a source that cannot give random bytes must not even fork a host (it is a counted crash).
    this.#dropKey();
    let keyBytes: Uint8Array;
    try {
      keyBytes = this.#freshKey();
    } catch {
      this.#onCrash(null, generation);
      return;
    }
    const key = base64url(keyBytes);
    let child: DaemonChild;
    try {
      child = this.#o.spawn();
    } catch {
      // A spawn that throws is a crash (counted), not a reason to stay silent.
      keyBytes.fill(0);
      this.#onCrash(null, generation);
      return;
    }
    this.#key = keyBytes;
    this.#child = child;
    this.#offs.push(child.onMessage((m) => this.#onMessage(m, generation)));
    this.#offs.push(child.onExit((code) => this.#onExit(code, generation)));
    this.#emit("spawned", {});
    this.#readyTimer = this.#o.timers.set(() => {
      // No `ready` in time: kill; the exit is then handled as a crash.
      if (generation === this.#generation && this.#state === "starting") this.#killNow();
    }, this.#policy.readyTimeoutMs);
    try {
      child.postMessage({ type: "init", config: { ...this.#o.config, attestationKey: key } });
    } catch {
      this.#killNow();
    }
  }

  #freshKey(): Uint8Array {
    for (let i = 0; i < KEY_TRIES; i++) {
      const bytes = this.#o.randomBytes(KEY_BYTES);
      // A copy: the source's buffer is not ours to keep or zero.
      if (bytes.length === KEY_BYTES && new Set(bytes).size >= MIN_DISTINCT) return new Uint8Array(bytes);
    }
    // A source that cannot give random bytes must not start a host.
    throw new Error("no random key");
  }

  #onMessage(raw: unknown, generation: number): void {
    if (generation !== this.#generation) return; // a stale child
    const parsed = outboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#emit("invalid_message", {});
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case "ready":
        if (this.#sentReady || this.#state !== "starting") return;
        this.#sentReady = true;
        this.#readyAt = this.#o.now();
        if (this.#readyTimer !== undefined) this.#o.timers.clear(this.#readyTimer);
        this.#readyTimer = undefined;
        this.#set("running");
        this.#emit(m.degraded === undefined ? "ready" : "degraded", m.degraded === undefined ? {} : { reason: m.degraded });
        return;
      case "fatal":
        this.#emit("fatal_reported", { reason: m.reason ?? m.code });
        return;
      case "log":
        return;
      default: {
        const child = this.#child;
        const reply = (message: unknown): void => {
          if (generation !== this.#generation || child === undefined) return;
          try {
            child.postMessage(message);
          } catch {
            // closed
          }
        };
        if (this.#o.onRequest === undefined) {
          if (this.#unansweredLogged++ < 16) this.#emit("unanswered_request", { reason: m.type });
          return;
        }
        try {
          this.#o.onRequest(m, reply);
        } catch {
          // a failing handler is no answer
        }
      }
    }
  }

  #onExit(code: number | null, generation: number): void {
    if (generation !== this.#generation) return;
    this.#clearTimers();
    for (const off of this.#offs.splice(0)) off();
    this.#child = undefined;
    this.#dropKey();
    this.#emit("exited", { code });
    if (this.#state === "stopping") {
      this.#finishStop();
      return;
    }
    if (code === SUPERVISED_EXIT.LOCK_HELD) return this.#fail("lock_held");
    if (code === SUPERVISED_EXIT.BAD_CONFIG) return this.#fail("bad_config");
    if (code === SUPERVISED_EXIT.DEGRADED) return this.#fail("degraded");
    this.#onCrash(code, generation);
  }

  #onCrash(code: number | null, generation: number): void {
    if (generation !== this.#generation) return;
    const now = this.#o.now();
    if (this.#readyAt !== undefined && now - this.#readyAt >= this.#policy.stableMs) this.#crashes = [];
    this.#crashes = this.#crashes.filter((t) => now - t < this.#policy.windowMs);
    this.#crashes.push(now);
    // `crashes.length` includes this one: the first crash is the first restart.
    if (this.#crashes.length > this.#policy.maxRestarts) return this.#fail("crash_loop");
    const delay = Math.min(this.#policy.maxDelayMs, this.#policy.baseDelayMs * 2 ** (this.#crashes.length - 1));
    this.#set("backoff");
    this.#emit("restart_scheduled", { code, count: this.#crashes.length });
    this.#backoffTimer = this.#o.timers.set(() => {
      this.#backoffTimer = undefined;
      if (this.#state === "backoff") this.#spawn();
    }, delay);
  }

  #fail(reason: FailureReason): void {
    this.#dropKey();
    this.#failure = reason;
    this.#clearTimers();
    this.#set("failed");
    this.#emit("failed", { reason });
  }

  #killNow(): void {
    const child = this.#child;
    if (child === undefined) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
    if (this.#state === "stopping") {
      // A child that does not report its exit after the kill must not hold the app open: the stop is over.
      for (const off of this.#offs.splice(0)) off();
      this.#child = undefined;
      this.#dropKey();
      this.#generation++;
      this.#finishStop();
    }
  }

  #finishStop(): void {
    this.#dropKey();
    this.#clearTimers();
    this.#set("stopped");
    this.#emit("stopped", {});
    for (const resolve of this.#stopWaiters.splice(0)) resolve();
  }

  #clearTimers(): void {
    for (const t of [this.#readyTimer, this.#backoffTimer, this.#stopTimer]) if (t !== undefined) this.#o.timers.clear(t);
    this.#readyTimer = this.#backoffTimer = this.#stopTimer = undefined;
  }

  #set(state: SupervisorState): void {
    this.#state = state;
    try {
      this.#o.onStateChange?.(state, this.#failure);
    } catch {
      // an observer never changes the state machine
    }
  }

  #emit(event: SupervisorEvent, fields: { code?: number | null; reason?: string; count?: number }): void {
    try {
      this.#o.onEvent?.(event, fields);
    } catch {
      // as above
    }
  }
}
