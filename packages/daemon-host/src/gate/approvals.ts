// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  ApprovalError,
  type ActorId,
  type ApprovalContent,
  type ApprovalGate,
  type ApprovalInput,
  type ConfirmedAction as DaemonConfirmedAction,
} from "@axis/daemon";
import {
  ChallengeError,
  ChallengeManager,
  type ChallengeAuditSink,
  type ChallengeManagerOptions,
  type ResolveResult,
} from "@axis/challenge";
import type { Challenge, ChallengeReference, ResolveChallengeRequest } from "@axis/protocol";
import type { Logger } from "../log/logger.js";
import type { Clock } from "../ports/clock.js";
import { NativeBridge, type NativeControl, type NativeStats } from "./native-bridge.js";
import { PendingRegistry, shortenSummary } from "./pending-registry.js";

/**
 * Challenge manager, gate adapter and native bridge (ticket H5, design section 5.2). `createApprovals` builds the one
 * `ChallengeManager` (with a synchronous audit sink, and the host's monotonic clock for every deadline), the
 * `ApprovalGate` the daemon takes as `DaemonOptions.approvals`, and the narrow port the `axis.approvals/1` handlers
 * use. Nothing here hands the manager, a proof or a challenge id to a handler.
 *
 * The adapter follows `docs/packages.md` "Wiring the daemon" and "Adapter rules" and adds nothing to them: both
 * `args` and `requestDigest: input.digest` go to `issue` and `consume` (the manager computes its own digest and
 * refuses a mismatch); identity comes only from `input.identity`, `input.actor` and `input.connectionId`; the
 * approval is spent by `consume` before the action runs and exactly once; a `ChallengeError` becomes an
 * `ApprovalError` over a closed set of codes and its text is never forwarded (the daemon owns the wire answer); and
 * `withdraw` and `withdrawConnection` never throw.
 */
export type ChallengeLimits = Pick<
  ChallengeManagerOptions,
  "challengeTtlMs" | "confirmationTtlMs" | "maxOutstandingPerActor" | "maxOutstandingPerActorOverall" | "maxOutstandingPerWindow" | "maxOutstandingTotal"
>;

export interface ApprovalsDeps {
  /** Synchronous (see `createChallengeAuditSink`). */
  readonly audit: ChallengeAuditSink;
  readonly control: NativeControl;
  readonly clock: Pick<Clock, "now" | "monotonic">;
  readonly limits?: ChallengeLimits;
  readonly logger?: Logger;
}

/** What the `axis.approvals/1` handlers may do. The caller is the attested identity, never a payload value. */
export interface ApprovalsPort {
  resolve(caller: { readonly actor: string; readonly windowId: string }, request: ResolveChallengeRequest): ResolveResult;
  pending(windowId: string): Challenge[];
}

export interface ApprovalsStats {
  readonly pending: number;
  readonly native: NativeStats;
  readonly withdrawErrors: number;
}

export interface Approvals {
  readonly gate: ApprovalGate;
  readonly port: ApprovalsPort;
  stats(): ApprovalsStats;
  /** Cancel every native wait and forget every listing. Idempotent. */
  dispose(): void;
}

const GATE_CODES: ReadonlySet<string> = new Set(["E_POLICY_DENIED", "E_CONFLICT", "E_BACKPRESSURE", "E_INVALID_ARGUMENT"]);
type GateCode = "E_POLICY_DENIED" | "E_CONFLICT" | "E_BACKPRESSURE" | "E_INVALID_ARGUMENT";

/**
 * A `ChallengeError` as the gate must throw it. A refusal keeps one of four codes and nothing else; an action failure
 * (`detail.executed`) is thrown as it is (the daemon answers `E_INTERNAL` and frees the key, and its text never
 * reaches the wire); everything else is an opaque error, which the daemon also answers `E_INTERNAL`.
 */
function toGateError(error: unknown): Error {
  if (error instanceof ChallengeError) {
    if (error.detail["executed"] === true) return error;
    if (GATE_CODES.has(error.code)) return new ApprovalError(error.code as GateCode);
  }
  return new Error("approval failed");
}

export function createApprovals(deps: ApprovalsDeps): Approvals {
  const { clock } = deps;
  const manager = new ChallengeManager({
    audit: deps.audit,
    now: () => clock.now(),
    monotonic: () => clock.monotonic(),
    ...deps.limits,
  });
  const ttl = deps.limits?.challengeTtlMs ?? 60_000;
  const total = deps.limits?.maxOutstandingTotal ?? 128;
  const registry = new PendingRegistry({ monotonic: () => clock.monotonic(), ttlMs: ttl, cap: Math.min(total * 2, 131_072) });
  let withdrawErrors = 0;

  const bridge = new NativeBridge({
    control: deps.control,
    monotonic: () => clock.monotonic(),
    ttlMs: ttl,
    maxEntries: total,
    apply: (a) => {
      try {
        manager.confirmNative({ windowId: a.windowId }, { challengeId: a.challengeId, proof: a.proof, confirmed: a.confirmed });
      } finally {
        registry.remove(a.challengeId);
      }
    },
  });

  const forget = (challengeId: string): void => {
    registry.remove(challengeId);
    bridge.end(challengeId);
  };

  const quietWithdraw = (challengeId: string, caller: { actor: ActorId; connectionId: string }): void => {
    try {
      manager.withdraw(challengeId, caller);
      // Only the requester gets here: a bystander is refused (and counted) and ends nothing.
      forget(challengeId);
    } catch {
      withdrawErrors++;
    }
  };

  const gate: ApprovalGate = {
    issue(input: ApprovalInput, content: ApprovalContent): Challenge {
      let challenge: Challenge;
      try {
        challenge = manager.issue({
          contract: input.contract,
          version: input.contractVersion,
          method: input.method,
          args: input.args,
          requestDigest: input.digest,
          target: content.target,
          contentDigest: content.contentDigest,
          actor: input.actor,
          connectionId: input.connectionId,
          windowId: input.identity.windowId,
          tier: input.tier,
        });
      } catch (e) {
        throw toGateError(e);
      }
      const caller = { actor: input.actor, connectionId: input.connectionId };
      try {
        if (challenge.nativeConfirmationRequired) {
          // Once, right after issue and before the challenge reaches anyone: the proof goes to the supervisor only.
          const proof = manager.takeNativeProof(challenge.challengeId);
          if (proof === null) throw new Error("no native proof");
          bridge.start({
            challengeId: challenge.challengeId,
            proof,
            windowId: input.identity.windowId,
            connectionId: input.connectionId,
            summary: shortenSummary(challenge.targetSummary, 192),
          });
        }
        registry.add(challenge, input.identity.windowId, input.connectionId);
      } catch (e) {
        // The user can never be asked to approve something whose native step cannot be started.
        quietWithdraw(challenge.challengeId, caller);
        forget(challenge.challengeId);
        if (e instanceof Error && (e as { code?: unknown }).code === "E_BACKPRESSURE") throw new ApprovalError("E_BACKPRESSURE");
        throw new Error("native confirmation unavailable");
      }
      return challenge;
    },

    async execute<T>(
      input: ApprovalInput,
      approval: ChallengeReference,
      content: ApprovalContent,
      action: (confirmed: DaemonConfirmedAction) => Promise<T>,
    ): Promise<T> {
      try {
        const result = await manager.consume(
          approval.challengeId,
          { actor: input.actor, connectionId: input.connectionId },
          {
            contract: input.contract,
            version: input.contractVersion,
            method: input.method,
            args: input.args,
            requestDigest: input.digest,
            target: content.target,
            currentContentDigest: content.contentDigest,
          },
          (confirmed) => action(confirmed),
        );
        forget(approval.challengeId);
        return result;
      } catch (e) {
        // The approval was spent only when the action ran. Any other refusal (a bystander, a retry that came before
        // the native answer) leaves the challenge and its native wait as they were; expiry ends what is stale.
        if (e instanceof ChallengeError && e.detail["executed"] === true) forget(approval.challengeId);
        throw toGateError(e);
      }
    },

    withdraw(challengeId: string, caller: { readonly actor: ActorId; readonly connectionId: string }): unknown {
      quietWithdraw(challengeId, { actor: caller.actor, connectionId: caller.connectionId });
      return undefined;
    },

    withdrawConnection(connectionId: string): unknown {
      try {
        manager.withdrawConnection(connectionId);
      } catch {
        withdrawErrors++;
      }
      registry.removeConnection(connectionId);
      bridge.endConnection(connectionId);
      return undefined;
    },
  };

  const port: ApprovalsPort = {
    resolve(caller, request) {
      const result = manager.resolve(caller, request);
      if (result.state === "approved" && result.nativeRequired) bridge.userApproved(result.challengeId);
      else forget(result.challengeId);
      return result;
    },
    pending: (windowId) => registry.list(windowId),
  };

  let disposed = false;
  return {
    gate,
    port,
    stats: () => Object.freeze({ pending: registry.size, native: bridge.stats(), withdrawErrors }),
    dispose() {
      if (disposed) return;
      disposed = true;
      bridge.dispose();
      registry.clear();
    },
  };
}
