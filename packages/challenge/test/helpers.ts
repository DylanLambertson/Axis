// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Challenge } from "@axis/protocol";
import { ChallengeError, ChallengeManager, type ChallengeAuditEvent } from "../src/index.js";

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const CONTENT = sha("dirty file bytes v1");
export const CHANGED = sha("dirty file bytes v2");
export const CONTRACT = "axis.worktrees";
export const ARGS = { id: "ws-1", deleteBranch: false };
export const CONN = "conn-1";
export const CALLER = { actor: "user", connectionId: CONN } as const;
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

/** What the daemon holds after issuing: the renderer-visible challenge, plus the proof it fetched separately. */
export interface IssuedChallenge {
  readonly challenge: Challenge;
  readonly nativeProof: string | null;
}

export function issue(m: ChallengeManager, over: Partial<Parameters<ChallengeManager["issue"]>[0]> = {}): IssuedChallenge {
  const challenge = m.issue({ contract: CONTRACT, version: 1, method: "discard", target: "workspace:ws-1", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN, ...over });
  return { challenge, nativeProof: m.takeNativeProof(challenge.challengeId) };
}

/** Resolves and natively confirms; returns the challenge id to hand to `consume`. */
export function approve(m: ChallengeManager, i: IssuedChallenge): string {
  const r = m.resolve(...resolveArgs(i));
  assert.equal(r.state, "approved");
  if (!r.nativeRequired) return i.challenge.challengeId;
  assert.ok(i.nativeProof);
  const n = m.confirmNative({ windowId: WIN }, { challengeId: i.challenge.challengeId, proof: i.nativeProof, confirmed: true });
  assert.equal(n.state, "approved");
  return i.challenge.challengeId;
}

/** Arguments for `manager.resolve(...resolveArgs(issued))`: the attested caller, then the renderer's params. */
export const resolveArgs = (i: IssuedChallenge, over: Record<string, unknown> = {}) => {
  const { actor, windowId, ...params } = { actor: "user", windowId: WIN, ...over };
  return [{ actor, windowId }, { challengeId: i.challenge.challengeId, decision: "approve", digest: i.challenge.digest, ...params }] as unknown as Parameters<ChallengeManager["resolve"]>;
};

export const run = { contract: CONTRACT, version: 1, method: "discard", target: "workspace:ws-1", args: ARGS, currentContentDigest: CONTENT };
export const internal = (executed: boolean) => (e: unknown) =>
  e instanceof ChallengeError && e.code === "E_INTERNAL" && e.detail["executed"] === executed;
export const code = (c: string) => (e: unknown) => e instanceof ChallengeError && e.code === c;
