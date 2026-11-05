// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
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
import { PendingRegistry } from "./pending-registry.js";
import { nativeSummary } from "./summary.js";

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
  /**
   * Native waits at once (an integer from 1 to 32, default 16, at most the manager's total). Each holds a slot of the
   * control client, which is shared with `trust.check`, `anchor.get` and `settings.get`, so keep it well below its `maxPending` (64).
   */
  readonly nativeWaitLimit?: number;
  /** Native waits of one window at once: an integer from 1 to `nativeWaitLimit` (default half of it, rounded up). */
  readonly nativeWaitPerWindow?: number;
  /**
   * Called with the final tier first thing in `issue` (before any challenge, quota or dialog) and in `execute` (before
   * the spend, so a refusal costs nothing and a retry keeps its approval). Synchronous only: a function that returns a
   * promise is refused, because a rejection would be ignored. Whatever it throws reaches the daemon unchanged. The
   * host composition (H12) passes `anchorPreflight(services.anchors)` here (from ticket H4): a `DaemonError` `E_UNAVAILABLE` from it is
   * answered as that closed error, before anything is issued or spent.
   */
  readonly preflight?: (tier: number) => void;
  /**
   * What a content hook knows about the target in words (a workspace name, a plan or finding summary), for the native
   * dialog. Display text only; an unsafe or empty answer, or a throw, falls back to the challenge's target summary.
   */
  readonly describe?: (input: ApprovalInput, content: ApprovalContent) => string | undefined;
  /**
   * Mints the opaque capability of a destructive library call (design section 5.2: for worktrees `markDiscardConfirmed`,
   * see `gate/worktrees-confirm.ts`). Called INSIDE the approval action, after the approval was spent, with the
   * content the user confirmed; the result is handed to the handler as `ctx.approved.capability`. A throw fails the
   * action (the approval is already spent). Absent, or `undefined` for a method that needs none: no capability.
   */
  readonly capability?: (input: ApprovalInput, content: ApprovalContent) => unknown;
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

const TERMINAL: ReadonlySet<string> = new Set(["DENIED", "EXPIRED", "BURNED", "CONSUMED"]);
const GATE_CODES: ReadonlySet<string> = new Set(["E_POLICY_DENIED", "E_CONFLICT", "E_BACKPRESSURE", "E_INVALID_ARGUMENT"]);
type GateCode = "E_POLICY_DENIED" | "E_CONFLICT" | "E_BACKPRESSURE" | "E_INVALID_ARGUMENT";

/**
 * A `ChallengeError` as the gate must throw it. A refusal keeps one of four codes and nothing else; an action failure
 * (`detail.executed`) is thrown as it is (the daemon answers `E_INTERNAL`; whether the key is freed or kept
 * unknown depends on whether the action itself succeeded, and its text never reaches the wire); everything else is an opaque error, which the daemon also answers `E_INTERNAL`.
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
  const waitLimit = deps.nativeWaitLimit ?? 16;
  const perWindow = deps.nativeWaitPerWindow;
  const validInt = (n: number, max: number): boolean => Number.isInteger(n) && n >= 1 && n <= max;
  if (!validInt(waitLimit, 32)) throw new AxisError("E_INVALID_ARGUMENT", "Invalid nativeWaitLimit");
  if (perWindow !== undefined && !validInt(perWindow, waitLimit)) throw new AxisError("E_INVALID_ARGUMENT", "Invalid nativeWaitPerWindow");
  const ttl = deps.limits?.challengeTtlMs ?? 60_000;
  const total = deps.limits?.maxOutstandingTotal ?? 128;
  const registry = new PendingRegistry({ monotonic: () => clock.monotonic(), ttlMs: ttl, cap: Math.min(total * 2, 131_072) });
  let withdrawErrors = 0;

  const bridge = new NativeBridge({
    control: deps.control,
    monotonic: () => clock.monotonic(),
    ttlMs: ttl,
    maxEntries: Math.min(waitLimit, total),
    ...(perWindow === undefined ? {} : { maxPerWindow: Math.min(perWindow, waitLimit, total) }),
    onLost: (l) => quietWithdraw(l.challengeId, { actor: l.actor as ActorId, connectionId: l.connectionId }),
    apply: (a) => {
      try {
        manager.confirmNative({ windowId: a.windowId }, { challengeId: a.challengeId, proof: a.proof, confirmed: a.confirmed });
      } finally {
        registry.remove(a.challengeId);
      }
    },
  });

  /** The synchronous preflight only: an async one would be ignored (fail open), so a promise is refused. */
  const preflight = (tier: number): void => {
    if (deps.preflight === undefined) return;
    const result: unknown = deps.preflight(tier);
    if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
      Promise.resolve(result).catch(() => undefined);
      throw new AxisError("E_INTERNAL", "The preflight check must be synchronous", { reason: "preflight_async" });
    }
  };

  // Challenges whose connection closed while `issue` waited for the native request: not listed, not withdrawn twice.
  const gone = new Set<string>();
  const inflight = new Map<string, string>();

  const describe = (input: ApprovalInput, content: ApprovalContent): string | undefined => {
    try {
      const text = deps.describe?.(input, content);
      return typeof text === "string" ? text : undefined;
    } catch {
      return undefined;
    }
  };

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
    async issue(input: ApprovalInput, content: ApprovalContent): Promise<Challenge> {
      preflight(input.tier);
      // A native wait is reserved BEFORE the challenge exists, so a full bridge refuses with no challenge, no audit row
      // and no quota used (a withdrawn challenge would keep counting against its window for the whole TTL).
      let reservation: { release(): void } | undefined;
      if (input.tier >= 4) {
        reservation = bridge.reserve(input.identity.windowId);
        if (reservation === undefined) throw new ApprovalError("E_BACKPRESSURE");
      }
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
        reservation?.release();
        throw toGateError(e);
      }
      const caller = { actor: input.actor, connectionId: input.connectionId };
      inflight.set(challenge.challengeId, input.connectionId);
      try {
        if (challenge.nativeConfirmationRequired) {
          // Once, right after issue and before the challenge reaches anyone: the proof goes to the supervisor only.
          const proof = manager.takeNativeProof(challenge.challengeId);
          if (proof === null) throw new Error("no native proof");
          await bridge.start({
            challengeId: challenge.challengeId,
            proof,
            windowId: input.identity.windowId,
            connectionId: input.connectionId,
            actor: input.actor,
            summary: nativeSummary(`${input.contract}/${input.contractVersion}.${input.method}`, challenge.targetSummary, describe(input, content)),
          }, reservation);
        }
        // The connection may have closed during the wait: `withdrawConnection` already ended the challenge.
        if (gone.has(challenge.challengeId)) {
          bridge.end(challenge.challengeId);
        } else {
          registry.add(challenge, input.identity.windowId, input.connectionId);
        }
      } catch (e) {
        reservation?.release();
        // The user is never asked to approve something whose native dialog could not be started (a closed channel, no
        // free control slot, a full bridge): the challenge ends here and nobody has seen it.
        quietWithdraw(challenge.challengeId, caller);
        forget(challenge.challengeId);
        if (e instanceof Error && (e as { code?: unknown }).code === "E_BACKPRESSURE") throw new ApprovalError("E_BACKPRESSURE");
        throw new Error("native confirmation unavailable");
      } finally {
        inflight.delete(challenge.challengeId);
      }
      return challenge;
    },

    async execute<T>(
      input: ApprovalInput,
      approval: ChallengeReference,
      content: ApprovalContent,
      action: (confirmed: DaemonConfirmedAction) => Promise<T>,
    ): Promise<T> {
      preflight(input.tier);
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
          (confirmed) => {
            const capability = deps.capability?.(input, content);
            return action(capability === undefined ? confirmed : { ...confirmed, capability });
          },
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
      // Ended already by its connection closing during `issue`: nothing to withdraw, and no audit row for it.
      if (gone.delete(challengeId)) return undefined;
      quietWithdraw(challengeId, { actor: caller.actor, connectionId: caller.connectionId });
      return undefined;
    },

    withdrawConnection(connectionId: string): unknown {
      try {
        manager.withdrawConnection(connectionId);
      } catch {
        withdrawErrors++;
      }
      for (const [id, conn] of inflight) {
        if (conn === connectionId) {
          gone.add(id);
          if (gone.size > 256) gone.delete(gone.values().next().value as string);
        }
      }
      registry.removeConnection(connectionId);
      bridge.endConnection(connectionId);
      return undefined;
    },
  };

  const port: ApprovalsPort = {
    resolve(caller, request) {
      let result: ResolveResult;
      try {
        result = manager.resolve(caller, request);
      } catch (e) {
        // A burn (a digest that no longer matches) ends the challenge: close its dialog and its listing. A refusal
        // that names a live state (a second approve while the dialog is open) leaves both alone.
        const state = e instanceof ChallengeError ? e.detail["state"] : undefined;
        if (e instanceof ChallengeError && e.code === "E_CONFLICT" && (state === undefined || TERMINAL.has(String(state)))) {
          forget(request.challengeId);
        }
        throw e;
      }
      if (result.state === "approved" && result.nativeRequired) {
        // Approved by the user: no longer a prompt to answer, though the dialog is still awaited.
        registry.remove(result.challengeId);
        bridge.userApproved(result.challengeId);
      } else forget(result.challengeId);
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
