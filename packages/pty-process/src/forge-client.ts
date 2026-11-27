// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The daemon host's side of the `forge-list` message (ticket PV-D2 slice 2, docs/design/forge-pr-list.md §1, §7). The request is
// checked against the shared schema before it is sent; the reply is checked against the shared reply schema before it is handed
// on. Every call settles: on its reply, on a send failure, when the control channel closes, or after its own bound.
import { forgeListRequestSchema, forgeReplySchema, type ForgeListRequest, type ForgeReply } from "@axis/protocol";
import type { Clock } from "./ports.js";

export type PtyForgeFailure = "channel_closed" | "timeout" | "capacity" | "bad_request";

/** The rejection of `forgeList`. Carries a code only: never the repository, the request id or any output. */
export class PtyForgeError extends Error {
  constructor(readonly code: PtyForgeFailure) {
    super(`pty forge-list failed: ${code}`);
    this.name = "PtyForgeError";
  }
}

/**
 * The bound on one call: the service's own version step (5 s) and list call (20 s), each killed at its bound, plus a grace for
 * the reply to travel. The service answers `timeout` itself well before this.
 */
export const FORGE_CALL_TIMEOUT_MS = 35_000;

export interface ForgeCalls {
  /** Resolves with the parsed reply, or with `undefined` when a reply to this request failed the reply schema. */
  list(request: ForgeListRequest): Promise<ForgeReply | undefined>;
  /** A message from the control channel. True when it was a forge reply to a pending call (consumed). */
  onMessage(raw: unknown): boolean;
  failAll(code: PtyForgeFailure): void;
}

interface Pending {
  readonly resolve: (r: ForgeReply | undefined) => void;
  readonly reject: (e: PtyForgeError) => void;
  readonly timer: unknown;
}

const REPLY_TYPES: ReadonlySet<unknown> = new Set(["forge-result", "forge-failed"]);

/** The `req` of something shaped like a forge reply, read without trusting it (a getter that throws is no reply). */
function replyReq(raw: unknown): string | undefined {
  try {
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as { t?: unknown; req?: unknown };
    return REPLY_TYPES.has(r.t) && typeof r.req === "string" ? r.req : undefined;
  } catch {
    return undefined;
  }
}

export function createForgeCalls(o: {
  readonly send: (msg: unknown) => boolean;
  readonly closed: () => boolean;
  readonly clock: Clock;
  readonly timeoutMs?: number;
  readonly maxPending: number;
}): ForgeCalls {
  const pending = new Map<string, Pending>();
  const bound = o.timeoutMs ?? FORGE_CALL_TIMEOUT_MS;
  const take = (req: string): Pending | undefined => {
    const p = pending.get(req);
    if (p === undefined) return undefined;
    pending.delete(req);
    o.clock.clearTimeout(p.timer);
    return p;
  };
  return {
    list(request) {
      let checked: ReturnType<typeof forgeListRequestSchema.safeParse>;
      try {
        checked = forgeListRequestSchema.safeParse(request);
      } catch {
        return Promise.reject(new PtyForgeError("bad_request"));
      }
      // A request id already waiting is refused, so one reply can never settle two calls.
      if (!checked.success || pending.has(checked.data.req)) return Promise.reject(new PtyForgeError("bad_request"));
      if (o.closed()) return Promise.reject(new PtyForgeError("channel_closed"));
      if (pending.size >= o.maxPending) return Promise.reject(new PtyForgeError("capacity"));
      const m = checked.data;
      return new Promise<ForgeReply | undefined>((resolve, reject) => {
        const timer = o.clock.setTimeout(() => {
          if (pending.delete(m.req)) reject(new PtyForgeError("timeout"));
        }, bound);
        pending.set(m.req, { resolve, reject, timer });
        // Exactly the five schema fields: nothing else the caller's object held is sent.
        if (!o.send({ t: "forge-list", req: m.req, host: m.host, owner: m.owner, repo: m.repo })) take(m.req)?.reject(new PtyForgeError("channel_closed"));
      });
    },
    onMessage(raw) {
      const req = replyReq(raw);
      if (req === undefined) return false;
      const p = take(req);
      if (p === undefined) return true; // a forge reply nobody waits for (timed out, or never asked): dropped
      let parsed: ReturnType<typeof forgeReplySchema.safeParse>;
      try {
        parsed = forgeReplySchema.safeParse(raw);
      } catch {
        p.resolve(undefined);
        return true;
      }
      p.resolve(parsed.success && parsed.data.req === req ? parsed.data : undefined);
      return true;
    },
    failAll(code) {
      for (const req of [...pending.keys()]) take(req)?.reject(new PtyForgeError(code));
    },
  };
}
