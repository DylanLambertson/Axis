// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The daemon host's side of the plain `exec` message (docs/design/daemon-host-hooks.md §4.1). Every call settles: on its
// reply, on a send failure, when the control channel closes, or after its own timeout plus a grace. Bound calls (`bind`),
// `hook` and `scratch-*` are not offered here (later slices).
import { execReply } from "./messages.js";
import type { Clock } from "./ports.js";

export type PtyExecFailure = "channel_closed" | "timeout" | "capacity" | "env_denied" | "bad_argv" | "bad_bind" | "spawn_failed" | "no_control";

/** The rejection of `exec`. Carries a code only: never the argv, the environment or any output. */
export class PtyExecError extends Error {
  constructor(readonly code: PtyExecFailure) {
    super(`pty exec failed: ${code}`);
    this.name = "PtyExecError";
  }
}

/** A plain exec: `repo` names the git directory and work tree the service emits as `--git-dir`/`--work-tree`. */
export interface PtyExecCall {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Only the service's allow-list (identity, `GIT_TERMINAL_PROMPT`, `LANG`, `LC_*`); anything else is `env_denied`. */
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutput: number;
  readonly repo: { readonly gitDir: string; readonly workTree: string };
}

export interface PtyExecOutcome {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface ExecCalls {
  exec(call: PtyExecCall): Promise<PtyExecOutcome>;
  /** A message from the control channel; anything that is not an exec reply to a pending call is ignored. */
  onMessage(raw: unknown): void;
  /** Rejects every pending call (the channel closed or the port is disposed). */
  failAll(code: PtyExecFailure): void;
}

interface Pending {
  readonly resolve: (o: PtyExecOutcome) => void;
  readonly reject: (e: PtyExecError) => void;
  readonly timer: unknown;
}

export function createExecCalls(o: {
  readonly send: (msg: unknown) => boolean;
  readonly closed: () => boolean;
  readonly clock: Clock;
  /** Added to each call's own `timeoutMs` (the service times the git itself and answers `timeout`). */
  readonly graceMs: number;
  readonly maxPending: number;
}): ExecCalls {
  const pending = new Map<string, Pending>();
  let seq = 0;
  const take = (req: string): Pending | undefined => {
    const p = pending.get(req);
    if (p === undefined) return undefined;
    pending.delete(req);
    o.clock.clearTimeout(p.timer);
    return p;
  };
  return {
    exec(call) {
      if (o.closed()) return Promise.reject(new PtyExecError("channel_closed"));
      if (pending.size >= o.maxPending) return Promise.reject(new PtyExecError("capacity"));
      const req = `x${++seq}`;
      return new Promise<PtyExecOutcome>((resolve, reject) => {
        const timer = o.clock.setTimeout(() => {
          if (pending.delete(req)) reject(new PtyExecError("timeout"));
        }, call.timeoutMs + o.graceMs);
        pending.set(req, { resolve, reject, timer });
        const msg = {
          t: "exec", req, argv: [...call.argv], cwd: call.cwd, env: { ...call.env },
          ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
          timeoutMs: call.timeoutMs, maxOutput: call.maxOutput, repo: { gitDir: call.repo.gitDir, workTree: call.repo.workTree },
        };
        if (!o.send(msg)) take(req)?.reject(new PtyExecError("channel_closed"));
      });
    },
    onMessage(raw) {
      const parsed = execReply.safeParse(raw);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.t === "exec-result") take(m.req)?.resolve({ code: m.code, signal: m.signal, stdout: m.stdout, stderr: m.stderr, truncated: m.truncated });
      else if (m.t === "exec-failed") take(m.req)?.reject(new PtyExecError(m.code));
    },
    failAll(code) {
      for (const req of [...pending.keys()]) take(req)?.reject(new PtyExecError(code));
    },
  };
}
