// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ChallengeError, ChallengeManager, type ChallengeAuditEvent, type ConfirmationToken, type IssuedChallenge } from "../src/index.js";

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const CONTENT = sha("dirty file bytes v1");
export const CHANGED = sha("dirty file bytes v2");
export const WIN = "window-1";

export function setup(options: { ttl?: number; confirmTtl?: number; perActor?: number; total?: number } = {}) {
  const events: ChallengeAuditEvent[] = [];
  const clock = { t: 1_000_000, skew: 0 };
  let failNext: ((e: ChallengeAuditEvent) => boolean) | undefined;
  const manager = new ChallengeManager({
    audit: {
      append(e) {
        if (failNext?.(e)) throw new Error("sink down");
        events.push(e);
      },
    },
    now: () => clock.t + clock.skew,
    monotonic: () => clock.t,
    ...(options.ttl ? { challengeTtlMs: options.ttl } : {}),
    ...(options.confirmTtl ? { confirmationTtlMs: options.confirmTtl } : {}),
    ...(options.perActor ? { maxOutstandingPerActor: options.perActor } : {}),
    ...(options.total ? { maxOutstandingTotal: options.total } : {}),
  });
  return { manager, events, clock, failWhen: (f: ((e: ChallengeAuditEvent) => boolean) | undefined) => (failNext = f) };
}

export function issue(m: ChallengeManager, over: Partial<Parameters<ChallengeManager["issue"]>[0]> = {}): IssuedChallenge {
  return m.issue({ op: "worktree.discard", target: "workspace:ws-1", contentDigest: CONTENT, actor: "user", windowId: WIN, ...over });
}

export function approve(m: ChallengeManager, i: IssuedChallenge): ConfirmationToken {
  const r = m.resolve({ challengeId: i.challenge.challengeId, decision: "approve", digest: i.challenge.digest, actor: "user", windowId: WIN });
  assert.equal(r.state, "approved");
  if (r.token) return r.token;
  assert.ok(i.nativeProof);
  const n = m.confirmNative({ challengeId: i.challenge.challengeId, proof: i.nativeProof, confirmed: true, windowId: WIN });
  assert.ok(n.token);
  return n.token;
}

export const resolveArgs = (i: IssuedChallenge, over: Record<string, unknown> = {}) =>
  ({ challengeId: i.challenge.challengeId, decision: "approve", digest: i.challenge.digest, actor: "user", windowId: WIN, ...over }) as Parameters<ChallengeManager["resolve"]>[0];

export const run = { op: "worktree.discard", target: "workspace:ws-1", currentContentDigest: CONTENT };
export const internal = (executed: boolean) => (e: unknown) =>
  e instanceof ChallengeError && e.code === "E_INTERNAL" && e.detail["executed"] === executed;
export const code = (c: string) => (e: unknown) => e instanceof ChallengeError && e.code === c;
