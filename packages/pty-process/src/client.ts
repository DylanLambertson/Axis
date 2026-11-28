// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { existsSync } from "node:fs";
import type { ForgeListRequest, ForgeReply } from "@axis/protocol";
import { createExecCalls, type PtyExecCall, type PtyExecOutcome } from "./exec-client.js";
import { createForgeCalls } from "./forge-client.js";
import { controlReply, relayInbound, type ControlReply, type RelayInbound, type RelayOutbound } from "./messages.js";
import { probeGroup, signalGroup, validPgid } from "./group.js";
import { systemClock, systemProcessOps, type Channel, type Clock, type Disposable, type ProcessOps, type PtyExit, type PtyHandle, type PtyPort, type PtySignal, type PtySpawn } from "./ports.js";

export type PtySpawnFailure = "timeout" | "channel_closed" | "capacity" | "env_denied" | "bad_group" | "spawn_failed" | "no_control" | "bad_bind" | "hook_changed" | "bad_argv" | "remote_refused" | "endpoint_unavailable";

/**
 * The rejection of `spawn`. Carries a code only: never the argv or the environment. `definitive` (DC-3a) is true only when no
 * process can appear for this request: the pty process answered `spawn-failed`, or the port refused before sending anything. A
 * timeout, or a channel that closed with the request in flight, is not definitive: a group may still exist (see `LateSpawn`).
 */
export class PtySpawnError extends Error {
  constructor(
    readonly code: PtySpawnFailure,
    readonly definitive = false,
  ) {
    super(`pty spawn failed: ${code}`);
    this.name = "PtySpawnError";
  }
}

export interface PtyProcessPortOptions {
  /** The control channel to the Axis pty process. */
  readonly channel: Channel;
  readonly ops?: ProcessOps;
  readonly clock?: Clock;
  /** Every spawn settles (resolves or rejects) within this many milliseconds. Default 10000. */
  readonly spawnTimeoutMs?: number;
  /** Spawns waiting for an answer. Default 64; execs waiting for an answer are bounded by the same number, separately. */
  readonly maxPending?: number;
  /** PV-M6: each endpoint relay message, parsed by the shared envelope schema (the daemon's relay answers it with `relay`). */
  readonly onRelay?: (msg: RelayInbound) => void;
  /**
   * Whether a process with this pid exists now (`undefined`: cannot tell). Default: `/proc/<pid>` on Linux, `undefined` elsewhere.
   * Used only for a group whose leader is known to have exited, before signalling its id directly (see `owned`).
   */
  readonly leaderPresent?: (pid: number) => boolean | undefined;
}

/**
 * H9-hooks S4: one `git push` of the pinned refspec as a terminal-bound run (the `push` message). The pty process builds the argv,
 * the pins and the environment; `env` carries only the exec allow-list (identity, `GIT_TERMINAL_PROMPT`, `LANG`, `LC_*`).
 */
export interface PtyPushCall {
  readonly runId: string;
  readonly repo: { readonly gitDir: string; readonly workTree: string };
  readonly remote: string;
  readonly refspec: string;
  /** git-ops' `pushUrlsDigest` of the push URLs it read; the pty process refuses (`remote_refused`) when its own read differs. */
  readonly pushUrls: string;
  readonly env: Readonly<Record<string, string>>;
  /** The configuration and ssh variables the host validated, `null` for unset; the pty process refuses a push whose own differ. */
  readonly expectEnv: Readonly<Record<"HOME" | "XDG_CONFIG_HOME" | "GIT_CONFIG" | "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM" | "GIT_CONFIG_NOSYSTEM" | "GIT_SSH" | "GIT_SSH_COMMAND" | "GIT_SSH_VARIANT" | "GIT_PROXY_COMMAND", string | null>>;
  readonly cols: number;
  readonly rows: number;
}

/** A `PtyHandle` that also names its terminal, so the entry can have main broker a data port for it (`grant`). */
export interface PtyProcessHandle extends PtyHandle {
  readonly terminalId: string;
}

/**
 * DC-3a: what became of a spawn after its promise rejected with `timeout`. `spawned`: the group exists; the port has already sent
 * its kill and tracks it, and the handle answers `groupAlive` until it is gone. `failed`: the pty process's definitive no-spawn.
 */
export type LateSpawn = { readonly kind: "spawned"; readonly handle: PtyProcessHandle } | { readonly kind: "failed"; readonly code: PtySpawnFailure };

/** Requests whose answer is still awaited after their timeout; past this the oldest is forgotten (its late group is then only killed). */
export const MAX_LATE_SPAWNS = 1024;

export interface PtyProcessPort extends PtyPort, Disposable {
  /** `onLate` (DC-3a) hears, once, the answer to this spawn that arrives after it timed out. */
  spawn(spec: PtySpawn, onLate?: (late: LateSpawn) => void): Promise<PtyProcessHandle>;
  /** DC-3a: ends every data connection's access to `terminalId` for good (terminals-contract.md section 5); false when closed. */
  revoke(terminalId: string): boolean;
  /** G-2: lets data connection `conn` (the name main gave the brokered port) attach to `terminalId`. Nothing else may. */
  grantTerminal(terminalId: string, conn: string): void;
  /**
   * A plain, bounded git command (`exec`, H9-hooks §4.1). Settles within `call.timeoutMs` plus `spawnTimeoutMs`, and when the
   * channel closes; rejects with a `PtyExecError` code only. The daemon host's `createPtyGitRunner` is its one caller.
   */
  exec(call: PtyExecCall): Promise<PtyExecOutcome>;
  /**
   * `git push` as a terminal-bound run (H9-hooks §5.2): settles like `spawn`, and the handle reports the exit status only (the
   * push's output goes to the terminal, never here). A refusal rejects with a `PtySpawnError` code (`bad_argv`, `env_denied`, ...).
   */
  push(call: PtyPushCall): Promise<PtyProcessHandle>;
  /**
   * The user's `gh pr list` for one vetted repository (`forge-list`, PV-D2). Resolves with the reply parsed by the shared schema
   * (`undefined` for a reply to this request that failed it); rejects with a `PtyForgeError` code only.
   */
  forgeList(request: ForgeListRequest): Promise<ForgeReply | undefined>;
  /** How many terminals the port still tracks (an exited terminal whose group is gone is forgotten). For diagnostics and tests. */
  trackedTerminals(): number;
  /** PV-M6: send the daemon's answer for the endpoint relay; false when the channel is closed. */
  relay(msg: RelayOutbound): boolean;
}

interface Pending {
  readonly resolve: (h: PtyProcessHandle) => void;
  readonly reject: (e: PtySpawnError) => void;
  readonly timer: unknown;
}

interface Term {
  readonly group: Extract<ControlReply, { t: "spawned" }>["group"];
  exit: PtyExit | undefined;
  jobEmpty: boolean;
  readonly exitListeners: Set<(e: PtyExit) => void>;
}

const SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);

/**
 * The daemon host's `PtyPort` over the control channel to the Axis pty process.
 * - Every `spawn` settles within `spawnTimeoutMs`, and also when the channel closes. A `spawned` that arrives after its
 *   spawn timed out (or for an unknown request) is an orphan: its group is killed at once.
 * - `groupAlive()` answers synchronously from the pgid the pty process reported (`kill(-pgid, 0)` from this process), so it
 *   works after the leader exited and after the pty process died. A job group (Windows) is alive until the pty process
 *   reports it empty. Anything unknown throws, which the contract counts as alive.
 * - Output never travels here: `onData` listeners are accepted and never called (the daemon sees status only).
 */
export function createPtyProcessPort(options: PtyProcessPortOptions): PtyProcessPort {
  const { channel } = options;
  const ops = options.ops ?? systemProcessOps;
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.spawnTimeoutMs ?? 10000;
  const maxPending = options.maxPending ?? 64;
  const pending = new Map<string, Pending>();
  const terms = new Map<string, Term>();
  /**
   * Timed-out requests, by `req`, and who hears their late answer. Insertion order is age. An entry whose answer never comes stays
   * until the channel closes or it is evicted as the oldest past `MAX_LATE_SPAWNS` (1024): stale entries cost memory only, within
   * that bound, and an evicted request's late group is still killed (only its tracking and its report are lost).
   */
  const late = new Map<string, ((l: LateSpawn) => void) | undefined>();
  let seq = 0;
  let closed = false;
  const execs = createExecCalls({ send: (m) => send(m), closed: () => closed, clock, graceMs: timeoutMs, maxPending });
  const forge = createForgeCalls({ send: (m) => send(m), closed: () => closed, clock, maxPending });

  const send = (msg: unknown): boolean => {
    if (closed) return false;
    try {
      channel.send(msg);
      return true;
    } catch {
      return false;
    }
  };

  const settleExit = (t: Term, exit: PtyExit): void => {
    if (t.exit !== undefined) return;
    t.exit = exit;
    for (const l of [...t.exitListeners]) {
      try {
        l(exit);
      } catch {
        /* a throwing listener must not stop the others */
      }
    }
  };

  const onMessage = (raw: unknown): void => {
    const parsed = controlReply.safeParse(raw);
    if (!parsed.success) {
      const relay = relayInbound.safeParse(raw);
      if (relay.success) return void options.onRelay?.(relay.data);
      return void (forge.onMessage(raw) || execs.onMessage(raw));
    }
    const m = parsed.data;
    if (m.t === "spawned") {
      const p = pending.get(m.req);
      if (p === undefined) {
        // Timed out or unknown: nobody owns this group. Its access is revoked first (defence in depth: no data connection can have
        // been granted it, and none can be after this), then the group is killed.
        send({ t: "revoke", term: m.term });
        send({ t: "kill", term: m.term, signal: "SIGKILL" });
        if (!late.has(m.req)) return;
        // Timed out: the group is still ours to watch until it is gone, and its spawn's owner is told (DC-3a).
        const listener = late.get(m.req);
        late.delete(m.req);
        const t: Term = { group: m.group, exit: undefined, jobEmpty: false, exitListeners: new Set() };
        prune();
        terms.set(m.term, t);
        return tell(listener, { kind: "spawned", handle: makeHandle(m.term, t) });
      }
      pending.delete(m.req);
      clock.clearTimeout(p.timer);
      const t: Term = { group: m.group, exit: undefined, jobEmpty: false, exitListeners: new Set() };
      prune();
      terms.set(m.term, t);
      p.resolve(makeHandle(m.term, t));
    } else if (m.t === "spawn-failed") {
      const p = pending.get(m.req);
      if (p === undefined) {
        if (!late.has(m.req)) return;
        const listener = late.get(m.req);
        late.delete(m.req);
        return tell(listener, { kind: "failed", code: m.code });
      }
      pending.delete(m.req);
      clock.clearTimeout(p.timer);
      p.reject(new PtySpawnError(m.code, true));
    } else if (m.t === "exit") {
      const t = terms.get(m.term);
      if (t !== undefined) settleExit(t, { exitCode: m.exitCode, signal: m.signal });
      prune();
    } else if (m.t === "group-empty") {
      const t = terms.get(m.term);
      if (t !== undefined) t.jobEmpty = true;
      prune();
    }
    // Any other reply (`input-refused`, or one a newer pty process adds) says nothing about the group: it must never mark it empty.
  };

  function tell(listener: ((l: LateSpawn) => void) | undefined, outcome: LateSpawn): void {
    try {
      listener?.(outcome);
    } catch {
      /* the kill and the tracking above stand */
    }
  }

  function makeHandle(term: string, t: Term): PtyProcessHandle {
    const forward = (msg: unknown): void => void send(msg);
    return {
      terminalId: term,
      write: (data) => forward({ t: "write", term, data }),
      resize: (cols, rows) => forward({ t: "resize", term, cols, rows }),
      kill(signal: PtySignal) {
        if (!SIGNALS.has(signal)) throw new Error("invalid signal");
        if (send({ t: "kill", term, signal })) return;
        // The pty process is gone: signal the group directly (POSIX only; a job cannot be reached from here).
        if (t.group.kind === "pgid" && owned(t)) signalGroup(ops, t.group.pgid, signal);
      },
      groupAlive() {
        if (t.group.kind === "job") return !t.jobEmpty;
        if (!validPgid(t.group.pgid)) return true;
        return probeGroup(ops, t.group.pgid) === "alive";
      },
      onData: () => ({ dispose: () => undefined }),
      onExit(listener) {
        if (t.exit !== undefined) {
          const e = t.exit;
          queueMicrotask(() => listener(e));
          return { dispose: () => undefined };
        }
        t.exitListeners.add(listener);
        return { dispose: () => void t.exitListeners.delete(listener) };
      },
    };
  }

  /** The pty process is gone or being shut down: end every group this port started that still lives (POSIX; a job cannot be reached from here). */
  const leaderPresent = options.leaderPresent ?? ((pid: number): boolean | undefined => (process.platform === "linux" ? existsSync(`/proc/${pid}`) : undefined));
  /**
   * DC-3a review 2: may this port still signal the group by its id? A group id is its leader's pid, which cannot be reused while the
   * leader lives. Once the leader is known to have exited, a process now holding that pid means the id may be another group's, and
   * an answer that cannot be had counts the same: not ours to signal. The pty process ends its own groups when its channel closes.
   */
  // Residual (DC-3c code review nit 5; terminal-trust-revocation.md 6.3): the /proc read and the signal are not atomic, so in the few
  // microseconds between them the pid could be reused as a new group id. Accepted: improbable, same user, and the pty process ends
  // its own groups when its control channel closes. A pidfd taken at spawn would close it (not built).
  const owned = (t: Term): boolean => {
    if (t.group.kind !== "pgid") return false;
    if (t.exit === undefined) return true;
    try {
      return leaderPresent(t.group.pgid) === false;
    } catch {
      return false;
    }
  };

  const killKnown = (): void => {
    for (const t of terms.values()) {
      if (t.group.kind !== "pgid" || !owned(t)) continue;
      try {
        signalGroup(ops, t.group.pgid, "SIGKILL");
      } catch {
        /* an unknown state stays visible through groupAlive */
      }
    }
  };

  /** Forgets terminals that exited and whose group is gone, so a long-lived daemon does not keep one entry per run. */
  const prune = (): void => {
    for (const [id, t] of terms) {
      if (t.exit === undefined) continue;
      let alive = true;
      try {
        alive = t.group.kind === "job" ? !t.jobEmpty : validPgid(t.group.pgid) ? probeGroup(ops, t.group.pgid) === "alive" : true;
      } catch {
        alive = true;
      }
      if (!alive) terms.delete(id);
    }
  };

  const failAll = (code: PtySpawnFailure): void => {
    for (const [req, p] of [...pending]) {
      pending.delete(req);
      clock.clearTimeout(p.timer);
      p.reject(new PtySpawnError(code));
    }
  };

  /**
   * Sends one terminal-starting message (`spawn` or `push`) and settles on its `spawned`/`spawn-failed`, a timeout or a close. A
   * timed-out request is remembered (bounded) so its late answer reaches `onLate` and its group is tracked.
   */
  const request = (build: (req: string) => Record<string, unknown>, onLate?: (l: LateSpawn) => void): Promise<PtyProcessHandle> => {
    if (closed) return Promise.reject(new PtySpawnError("channel_closed", true));
    if (pending.size >= maxPending) return Promise.reject(new PtySpawnError("capacity", true));
    const req = `r${++seq}`;
    return new Promise<PtyProcessHandle>((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        if (!pending.delete(req)) return;
        late.set(req, onLate);
        // Evict the oldest past the bound (see `late`): the map never grows past MAX_LATE_SPAWNS however many answers never come.
        for (const old of late.keys()) {
          if (late.size <= MAX_LATE_SPAWNS) break;
          late.delete(old);
        }
        reject(new PtySpawnError("timeout"));
      }, timeoutMs);
      pending.set(req, { resolve, reject, timer });
      const ok = send(build(req));
      if (!ok && pending.delete(req)) {
        clock.clearTimeout(timer);
        reject(new PtySpawnError("channel_closed"));
      }
    });
  };

  const subs = [
    channel.onMessage(onMessage),
    channel.onClose(() => {
      if (closed) return;
      closed = true;
      failAll("channel_closed");
      execs.failAll("channel_closed");
      forge.failAll("channel_closed");
      killKnown();
      late.clear(); // no answer can come any more; what was spawned stays unknown (not definitive) to its owner
      // The pty process is gone, so no `exit` will come. Say so with an unknown exit; the group probe still guards finalisation.
      for (const t of terms.values()) settleExit(t, { exitCode: null, signal: null });
    }),
  ];

  return {
    spawn: (spec: PtySpawn, onLate?: (l: LateSpawn) => void): Promise<PtyProcessHandle> =>
      request((req) => ({ t: "spawn", req, runId: spec.runId, argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env }, cols: spec.cols, rows: spec.rows, ...(spec.messagesEndpoint === undefined ? {} : { messagesEndpoint: { endpoint: spec.messagesEndpoint.endpoint, token: spec.messagesEndpoint.token } }) }), onLate),
    push: (call: PtyPushCall): Promise<PtyProcessHandle> =>
      request((req) => ({ t: "push", req, runId: call.runId, repo: { gitDir: call.repo.gitDir, workTree: call.repo.workTree }, remote: call.remote, refspec: call.refspec, pushUrls: call.pushUrls, env: { ...call.env }, expectEnv: { ...call.expectEnv }, cols: call.cols, rows: call.rows })),
    exec: (call) => execs.exec(call),
    forgeList: (request) => forge.list(request),
    trackedTerminals: () => terms.size,
    relay: (msg) => !closed && send(msg),
    grantTerminal(terminalId, conn) {
      send({ t: "grant", term: terminalId, conn });
    },
    revoke: (terminalId) => send({ t: "revoke", term: terminalId }),
    dispose() {
      if (!closed) {
        closed = true;
        failAll("channel_closed");
        execs.failAll("channel_closed");
        forge.failAll("channel_closed");
        killKnown();
        // DC-3a review S1: no `exit` can come any more (a replaced port, or a shutdown), so say so with an unknown exit, as a channel
        // close does: the owner ends its record, and never later signals a recorded group id that may since belong to someone else.
        for (const t of terms.values()) settleExit(t, { exitCode: null, signal: null });
      }
      subs.forEach((s) => s.dispose());
      terms.clear();
      late.clear();
    },
  };
}
