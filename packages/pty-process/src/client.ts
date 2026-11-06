// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { controlReply, type ControlReply } from "./messages.js";
import { probeGroup, signalGroup, validPgid } from "./group.js";
import { systemClock, systemProcessOps, type Channel, type Clock, type Disposable, type ProcessOps, type PtyExit, type PtyHandle, type PtyPort, type PtySignal, type PtySpawn } from "./ports.js";

export type PtySpawnFailure = "timeout" | "channel_closed" | "capacity" | "env_denied" | "bad_group" | "spawn_failed" | "no_control" | "bad_bind" | "hook_changed";

/** The rejection of `spawn`. Carries a code only: never the argv or the environment. */
export class PtySpawnError extends Error {
  constructor(readonly code: PtySpawnFailure) {
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
  /** Spawns waiting for an answer. Default 64. */
  readonly maxPending?: number;
}

/** A `PtyHandle` that also names its terminal, so the entry can have main broker a data port for it (`grant`). */
export interface PtyProcessHandle extends PtyHandle {
  readonly terminalId: string;
}

export interface PtyProcessPort extends PtyPort, Disposable {
  spawn(spec: PtySpawn): Promise<PtyProcessHandle>;
  /** G-2: lets data connection `conn` (the name main gave the brokered port) attach to `terminalId`. Nothing else may. */
  grant(terminalId: string, conn: string): void;
  /** How many terminals the port still tracks (an exited terminal whose group is gone is forgotten). For diagnostics and tests. */
  trackedTerminals(): number;
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
  let seq = 0;
  let closed = false;

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
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.t === "spawned") {
      const p = pending.get(m.req);
      if (p === undefined) {
        send({ t: "kill", term: m.term, signal: "SIGKILL" }); // timed out or unknown: nobody owns this group
        return;
      }
      pending.delete(m.req);
      clock.clearTimeout(p.timer);
      const t: Term = { group: m.group, exit: undefined, jobEmpty: false, exitListeners: new Set() };
      prune();
      terms.set(m.term, t);
      p.resolve(makeHandle(m.term, t));
    } else if (m.t === "spawn-failed") {
      const p = pending.get(m.req);
      if (p === undefined) return;
      pending.delete(m.req);
      clock.clearTimeout(p.timer);
      p.reject(new PtySpawnError(m.code));
    } else if (m.t === "exit") {
      const t = terms.get(m.term);
      if (t !== undefined) settleExit(t, { exitCode: m.exitCode, signal: m.signal });
      prune();
    } else {
      const t = terms.get(m.term);
      if (t !== undefined) t.jobEmpty = true;
      prune();
    }
  };

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
        if (t.group.kind === "pgid") signalGroup(ops, t.group.pgid, signal);
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
  const killKnown = (): void => {
    for (const t of terms.values()) {
      if (t.group.kind !== "pgid") continue;
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

  const subs = [
    channel.onMessage(onMessage),
    channel.onClose(() => {
      if (closed) return;
      closed = true;
      failAll("channel_closed");
      killKnown();
      // The pty process is gone, so no `exit` will come. Say so with an unknown exit; the group probe still guards finalisation.
      for (const t of terms.values()) settleExit(t, { exitCode: null, signal: null });
    }),
  ];

  return {
    spawn(spec: PtySpawn): Promise<PtyProcessHandle> {
      if (closed) return Promise.reject(new PtySpawnError("channel_closed"));
      if (pending.size >= maxPending) return Promise.reject(new PtySpawnError("capacity"));
      const req = `r${++seq}`;
      return new Promise<PtyProcessHandle>((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          if (pending.delete(req)) reject(new PtySpawnError("timeout"));
        }, timeoutMs);
        pending.set(req, { resolve, reject, timer });
        const ok = send({ t: "spawn", req, runId: spec.runId, argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env }, cols: spec.cols, rows: spec.rows });
        if (!ok && pending.delete(req)) {
          clock.clearTimeout(timer);
          reject(new PtySpawnError("channel_closed"));
        }
      });
    },
    trackedTerminals: () => terms.size,
    grant(terminalId, conn) {
      send({ t: "grant", term: terminalId, conn });
    },
    dispose() {
      if (!closed) {
        closed = true;
        failAll("channel_closed");
        killKnown();
      }
      subs.forEach((s) => s.dispose());
      terms.clear();
    },
  };
}
