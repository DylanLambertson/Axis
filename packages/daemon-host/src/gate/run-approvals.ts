// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { ChallengeManager, ResolveResult } from "@axis/challenge";
import { COMPOSER_RUNS_CONTRACT, COMPOSER_RUNS_VERSION, runIdSchema, type Challenge } from "@axis/protocol";

/**
 * The approval of a composer tool call (DMN-3, docs/design/composer-runtime.md section 4). The broker asks its
 * `ApprovalHook`; `bindings/agent.ts` forwards the request here, and this file turns it into a challenge of the ONE
 * `ChallengeManager` that `createApprovals` built, so it is listed by `axis.approvals/1.pending` in the window that
 * started the run and answered by `axis.approvals/1.resolve`, like every other challenge.
 *
 * What makes it safe:
 * - The requester is the run (`agent:composer.<runId>` on the synthetic connection `run.<runId>`), never the user, and
 *   the challenge goes to the window that started the run. `resolve` is a user-only policy row, its handler refuses
 *   any other actor, and the manager refuses a non-user resolver and any other window. Nothing the run can reach
 *   resolves its own challenge.
 * - The grant the broker gets is built INSIDE `consume`'s action: it exists only after the user approved, for this run's
 *   requester and connection, for this exact call digest (the broker digest is the challenge's content digest), and it
 *   is spent once. The broker verifies it again (`approvedBy: "user"`, digest, expiry, replay).
 * - Every way out but an approval declines: a denial, an expiry (the manager's, or the wait's own deadline), a challenge
 *   burned by a digest mismatch, a cancelled call (the challenge is withdrawn), a full quota, a stalled anchor and a
 *   disposed host. A `destructive` or `privileged` call needs the native dialog (ticket C4) and is declined until then.
 * - Nothing here is handed to a handler: the composer service sees only the outcome.
 */

export interface RunApprovalInput {
  readonly runId: string;
  /** The window that started the run (its attested identity), the only one that can answer. */
  readonly windowId: string;
  readonly tool: string;
  /** The broker tier of the call (`read` < `write` < `network` < `destructive` < `privileged`). */
  readonly tier: string;
  /** The broker's digest of the canonical call (64 hex). */
  readonly digest: string;
  /** The broker's reasons (`tier:network`, `protected:github`): closed labels, shown in the listing summary. */
  readonly reasons: readonly string[];
}

/** What the broker's `ApprovalHook` must answer for an approved call (the shape `approvalGrantSchema` accepts). */
export interface RunApprovalGrant {
  readonly approved: true;
  readonly approvedBy: "user";
  readonly approvalId: string;
  readonly digest: string;
  readonly expiresAt: number;
}

export type RunApprovalOutcome =
  | { readonly kind: "granted"; readonly grant: RunApprovalGrant }
  | { readonly kind: "declined"; readonly state: "denied" | "expired" | "withdrawn" | "refused" };

export interface RunApprovals {
  /**
   * Ask the user. `onIssued` is called once with the challenge as listed, before the wait starts (the activity stream
   * shows it). Never throws: every failure is a decline.
   */
  request(input: RunApprovalInput, signal: AbortSignal, onIssued?: (challenge: Challenge) => void): Promise<RunApprovalOutcome>;
  /** `axis.approvals/1.resolve` answered a challenge (any challenge; ids that are not a run's are ignored). */
  settled(result: ResolveResult): void;
  /** A challenge ended without an answer (burned, withdrawn by its connection). */
  ended(challengeId: string): void;
  /** Calls waiting for the user. */
  waiting(): number;
  /** Decline every wait and refuse new ones. Idempotent. */
  dispose(): void;
}

export interface RunApprovalsCore {
  readonly manager: Pick<ChallengeManager, "issue" | "consume" | "withdraw">;
  /** The pending listing of `createApprovals` (what `axis.approvals/1.pending` returns). */
  readonly listing: { add(challenge: Challenge, windowId: string, connectionId: string): void; remove(challengeId: string): void };
  readonly now: () => number;
  /** The manager's challenge lifetime: a wait ends this long (plus a grace) after the challenge was issued. */
  readonly ttlMs: number;
  /** Lifetime of the grant the broker receives (it spends it at once). Default 30 s. */
  readonly grantTtlMs?: number;
  /** The anchor preflight of `createApprovals`: a stalled anchor declines before a challenge exists. */
  readonly preflight?: (tier: number) => void;
}

const ASKABLE: ReadonlySet<string> = new Set(["read", "write", "network"]);
const LABEL = /^[a-z][a-z0-9:._-]{0,63}$/;
const GRACE_MS = 1_000;
const TIER = 3;

type Ending = "approved" | "denied" | "expired" | "withdrawn";

/** The id the broker and its audit see: the manager's reference (SHA-256 of the challenge id), shortened. Never the id itself. */
export function approvalIdOf(challengeId: string): string {
  return `chl:${createHash("sha256").update(challengeId, "utf8").digest("hex").slice(0, 32)}`;
}

/** The listing summary, from closed labels only (APR-2: never from what the model chose). */
function summaryOf(tool: string, reasons: readonly string[]): string {
  const safe = reasons.filter((r) => LABEL.test(r)).slice(0, 8);
  return `Composer tool ${tool}${safe.length === 0 ? "" : ` (${safe.join(", ")})`}`.slice(0, 256);
}

export function createRunApprovals(core: RunApprovalsCore): RunApprovals {
  const waits = new Map<string, (ending: Ending) => void>();
  const grantTtl = core.grantTtlMs ?? 30_000;
  let disposed = false;

  const finish = (challengeId: string, ending: Ending): void => {
    const done = waits.get(challengeId);
    if (done === undefined) return;
    waits.delete(challengeId);
    done(ending);
  };

  async function request(input: RunApprovalInput, signal: AbortSignal, onIssued?: (challenge: Challenge) => void): Promise<RunApprovalOutcome> {
    const refused = { kind: "declined", state: "refused" } as const;
    if (disposed || !runIdSchema.safeParse(input.runId).success || !/^[0-9a-f]{64}$/.test(input.digest)) return refused;
    // Tier 4 and 5 need the native dialog, which a broker call cannot reach yet (ticket C4): fail closed.
    if (!ASKABLE.has(input.tier)) return refused;
    if (signal.aborted) return { kind: "declined", state: "withdrawn" };
    try {
      core.preflight?.(TIER);
    } catch {
      return refused;
    }
    const actor = `agent:composer.${input.runId}` as const;
    const connectionId = `run.${input.runId}`;
    const args = { runId: input.runId, tool: input.tool, digest: input.digest, tier: input.tier };
    const request = { contract: COMPOSER_RUNS_CONTRACT, version: COMPOSER_RUNS_VERSION, method: "toolCall", args, target: `run:${input.runId}` };
    let challenge: Challenge;
    try {
      challenge = core.manager.issue({
        ...request,
        contentDigest: input.digest,
        actor,
        connectionId,
        windowId: input.windowId,
        tier: TIER,
        targetSummary: summaryOf(input.tool, input.reasons),
      });
    } catch {
      return refused; // a full quota, a closed window id, an invalid request: nothing was issued
    }
    const id = challenge.challengeId;
    const ending = new Promise<Ending>((resolve) => {
      const timer = setTimeout(() => finish(id, "expired"), core.ttlMs + GRACE_MS) as unknown as NodeJS.Timeout;
      timer.unref();
      const onAbort = (): void => finish(id, "withdrawn");
      signal.addEventListener("abort", onAbort, { once: true });
      waits.set(id, (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(e);
      });
    });
    core.listing.add(challenge, input.windowId, connectionId);
    try {
      onIssued?.(challenge);
    } catch {
      // the activity stream is informational; a failing listener does not change the decision
    }
    if (signal.aborted) finish(id, "withdrawn");
    if (disposed) finish(id, "withdrawn");
    const end = await ending;
    core.listing.remove(id);
    if (end !== "approved") {
      if (end === "withdrawn" || end === "expired") {
        try {
          core.manager.withdraw(id, { actor, connectionId });
        } catch {
          // already ended or never ours: nothing left to withdraw
        }
      }
      return { kind: "declined", state: end };
    }
    if (signal.aborted) {
      try {
        core.manager.withdraw(id, { actor, connectionId });
      } catch {
        // nothing to withdraw
      }
      return { kind: "declined", state: "withdrawn" };
    }
    try {
      // Spent here, once, for this run's requester and connection and this exact call: the grant exists only inside the action.
      const grant = await core.manager.consume(id, { actor, connectionId }, { ...request, currentContentDigest: input.digest }, (): RunApprovalGrant => ({
        approved: true,
        approvedBy: "user",
        approvalId: approvalIdOf(id),
        digest: input.digest,
        expiresAt: Math.floor(core.now()) + grantTtl,
      }));
      return { kind: "granted", grant };
    } catch {
      return { kind: "declined", state: "expired" };
    }
  }

  return {
    request,
    settled(result) {
      if (!waits.has(result.challengeId)) return;
      // A run challenge is tier 3: approved means confirmed (no native step). Anything else ends it.
      if (result.state === "approved" && !result.nativeRequired) finish(result.challengeId, "approved");
      else if (result.state === "approved") return;
      else finish(result.challengeId, result.state);
    },
    ended(challengeId) {
      finish(challengeId, "expired");
    },
    waiting: () => waits.size,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...waits.keys()]) finish(id, "withdrawn");
    },
  };
}
