// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { ChallengeManager, ResolveResult } from "@axis/challenge";
import { COMPOSER_RUNS_CONTRACT, COMPOSER_RUNS_VERSION, runIdSchema, type ApprovalPreview, type Challenge } from "@axis/protocol";
import { NATIVE_SUMMARY_MAX, nativeSummary } from "./summary.js";

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
 *   disposed host.
 * - A `destructive` or `privileged` call (ticket C4) is a tier 4 challenge: after the user approves it in the window, the
 *   native dialog must confirm it too (`confirmed`), and only then is it consumed. The tier is recorded at issue (the
 *   manager's answer must match it, or the challenge is withdrawn) and checked again by every answer that can lead to the
 *   consume (`settled`, `confirmed`): a tier 4 wait reaches the consume only through the native confirmation after the
 *   user's approval, a tier 3 wait never takes a native answer. Without a native port, or
 *   when the dialog cannot be started, the call is declined (fail closed). The dialog shows a one-line summary built
 *   here from values the daemon derived (the action, the closed tool name, the tier, the protected flag, the byte count
 *   and a SHA-256 prefix; for a command, its program's base name and the first digits of its identity), never the content
 *   head or anything else the model wrote (APR-2); the head stays on the
 *   approval card, matched by digest. A cancelled run ends the dialog's wait; a late answer is ignored.
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
  /** The C8 preview of the call. Only its protected flag, byte count and SHA-256 reach the native dialog, never its head. */
  readonly preview?: ApprovalPreview;
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
  /** The native dialog's answer was applied (`ChallengeManager.confirmNative`'s result); ids that are not a run's are ignored. */
  confirmed(result: ResolveResult): void;
  /** A challenge ended without an answer (burned, withdrawn by its connection, a native wait lost). */
  ended(challengeId: string): void;
  /** Calls waiting for the user. */
  waiting(): number;
  /** Decline every wait and refuse new ones. Idempotent. */
  dispose(): void;
}

/** The native bridge as a run challenge uses it (`gate/native-bridge.ts`). */
export interface RunNativePort {
  reserve(windowId: string): { release(): void } | undefined;
  start(
    request: { challengeId: string; proof: string; windowId: string; connectionId: string; actor: string; summary: string },
    reservation: { release(): void },
  ): Promise<void>;
  /** Cancel the wait (the control request is aborted; a later answer is ignored). */
  end(challengeId: string): void;
}

export interface RunApprovalsCore {
  readonly manager: Pick<ChallengeManager, "issue" | "consume" | "withdraw" | "takeNativeProof">;
  /** The native dialog for tier 4. Absent: a `destructive` or `privileged` call is declined. */
  readonly native?: RunNativePort;
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

/** The challenge tier of each broker tier: the native dialog for `destructive` and `privileged` (daemon tiers 4 and 5 both need it). */
const TIERS: ReadonlyMap<string, 3 | 4> = new Map([["read", 3], ["write", 3], ["network", 3], ["destructive", 4], ["privileged", 4]]);
const LABEL = /^[a-z][a-z0-9:._-]{0,63}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const GRACE_MS = 1_000;
/** A program's base name as the native dialog may show it. */
const PROGRAM_NAME = /^[A-Za-z0-9._+-]{1,32}$/;
const ACTION = `${COMPOSER_RUNS_CONTRACT}/${COMPOSER_RUNS_VERSION}.toolCall`;

type Ending = "approved" | "denied" | "expired" | "withdrawn" | "refused";

interface Wait {
  readonly tier: 3 | 4;
  readonly done: (ending: Ending) => void;
  /** Tier 4: the user approved in the window (the native answer is still needed). */
  userApproved: boolean;
}

/** The id the broker and its audit see: the manager's reference (SHA-256 of the challenge id), shortened. Never the id itself. */
export function approvalIdOf(challengeId: string): string {
  return `chl:${createHash("sha256").update(challengeId, "utf8").digest("hex").slice(0, 32)}`;
}

/** The listing summary, from closed labels only (APR-2: never from what the model chose). */
function summaryOf(tool: string, reasons: readonly string[]): string {
  const safe = reasons.filter((r) => LABEL.test(r)).slice(0, 8);
  return `Composer tool ${tool}${safe.length === 0 ? "" : ` (${safe.join(", ")})`}`.slice(0, 256);
}

/**
 * The native dialog's detail, from values the daemon derived only (APR-2): the closed tool name, the broker tier, whether a
 * protected path is written, the byte count and the first 16 hex digits of the SHA-256. Never the head, a path or a reason
 * text. `nativeSummary` bounds the whole line.
 */
export function runNativeDetail(input: Pick<RunApprovalInput, "tool" | "tier" | "preview">): string | undefined {
  if (!TOOL.test(input.tool) || !TIERS.has(input.tier)) return undefined;
  const p = input.preview;
  const parts = [`${input.tool} (${input.tier}${p?.protected === true ? ", protected path" : ""})`];
  const c = p?.content;
  if (c != null && Number.isSafeInteger(c.bytes) && c.bytes >= 0 && /^[0-9a-f]{64}$/.test(c.sha256)) parts.push(`${c.bytes} bytes, SHA-256 ${c.sha256.slice(0, 16)}`);
  // C3, command identity: which program (the base name of the real path the broker pinned, from a closed character set,
  // else a fixed word) and the first 16 digits of the identity the approval card shows in full. A command with no
  // identity is never put to the native dialog (the line could not tell it from another command).
  const cmd = p?.command;
  if (input.tool === "run_command" && (cmd == null || !/^[0-9a-f]{64}$/.test(cmd.identity))) return undefined;
  if (cmd != null && /^[0-9a-f]{64}$/.test(cmd.identity)) {
    const base = cmd.program.split(/[\\/]/).pop() ?? "";
    parts.push(`program ${PROGRAM_NAME.test(base) ? base : "(unnamed)"}, identity ${cmd.identity.slice(0, 16)}`);
  }
  return parts.join(", ");
}

export function createRunApprovals(core: RunApprovalsCore): RunApprovals {
  const waits = new Map<string, Wait>();
  const grantTtl = core.grantTtlMs ?? 30_000;
  let disposed = false;

  const finish = (challengeId: string, ending: Ending): void => {
    const wait = waits.get(challengeId);
    if (wait === undefined) return;
    waits.delete(challengeId);
    wait.done(ending);
  };

  async function request(input: RunApprovalInput, signal: AbortSignal, onIssued?: (challenge: Challenge) => void): Promise<RunApprovalOutcome> {
    const refused = { kind: "declined", state: "refused" } as const;
    if (disposed || !runIdSchema.safeParse(input.runId).success || !/^[0-9a-f]{64}$/.test(input.digest)) return refused;
    const tier = TIERS.get(input.tier);
    if (tier === undefined) return refused;
    const native = tier === 4 ? core.native : undefined;
    // A tier 4 call with no native dialog to ask cannot be approved: fail closed.
    if (tier === 4 && native === undefined) return refused;
    // A command whose dialog line cannot name it (no identity) is not asked about at all: nothing is issued (C3).
    if (input.tool === "run_command" && runNativeDetail(input) === undefined) return refused;
    if (signal.aborted) return { kind: "declined", state: "withdrawn" };
    try {
      core.preflight?.(tier);
    } catch {
      return refused;
    }
    // A native wait is reserved BEFORE the challenge exists, so a full bridge refuses with nothing issued.
    const reservation = native?.reserve(input.windowId);
    if (native !== undefined && reservation === undefined) return refused;
    const actor = `agent:composer.${input.runId}` as const;
    const connectionId = `run.${input.runId}`;
    const caller = { actor, connectionId };
    const args = { runId: input.runId, tool: input.tool, digest: input.digest, tier: input.tier };
    const request = { contract: COMPOSER_RUNS_CONTRACT, version: COMPOSER_RUNS_VERSION, method: "toolCall", args, target: `run:${input.runId}` };
    const quietWithdraw = (id: string): void => {
      try {
        core.manager.withdraw(id, caller);
      } catch {
        // already ended or never ours: nothing left to withdraw
      }
    };
    let challenge: Challenge;
    try {
      challenge = core.manager.issue({ ...request, contentDigest: input.digest, actor, connectionId, windowId: input.windowId, tier, targetSummary: summaryOf(input.tool, input.reasons) });
    } catch {
      reservation?.release();
      return refused; // a full quota, a closed window id, an invalid request: nothing was issued
    }
    const id = challenge.challengeId;
    // The tier recorded at issue: the manager must have issued exactly it, with the native step exactly when it is 4.
    if (challenge.tier !== tier || challenge.nativeConfirmationRequired !== (tier === 4)) {
      reservation?.release();
      quietWithdraw(id);
      return refused;
    }
    const wait: Wait = { tier, done: () => undefined, userApproved: false };
    const ending = new Promise<Ending>((resolve) => {
      const timer = setTimeout(() => finish(id, "expired"), core.ttlMs + GRACE_MS) as unknown as NodeJS.Timeout;
      timer.unref();
      const onAbort = (): void => finish(id, "withdrawn");
      signal.addEventListener("abort", onAbort, { once: true });
      (wait as { done: (e: Ending) => void }).done = (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(e);
      };
      waits.set(id, wait);
    });
    if (native !== undefined) {
      try {
        const detail = runNativeDetail(input);
        // Once, before the challenge reaches anyone: the proof goes to the supervisor only.
        const proof = core.manager.takeNativeProof(id);
        if (proof === null) throw new Error("no native proof");
        // The detail is daemon-derived only, so it may use the whole line: the protected label is never cut off.
        const summary = nativeSummary(ACTION, challenge.targetSummary, detail, NATIVE_SUMMARY_MAX - ACTION.length - 2);
        await native.start({ challengeId: id, proof, windowId: input.windowId, connectionId, actor, summary }, reservation as { release(): void });
      } catch {
        // The user is never asked for a call whose dialog could not open.
        reservation?.release();
        finish(id, "refused");
      }
    }
    if (waits.has(id)) {
      core.listing.add(challenge, input.windowId, connectionId);
      try {
        onIssued?.(challenge);
      } catch {
        // the activity stream is informational; a failing listener does not change the decision
      }
    }
    if (signal.aborted || disposed) finish(id, "withdrawn");
    const end = await ending;
    core.listing.remove(id);
    // Every way out but a consumed approval ends the dialog's wait (a cancelled run closes it; a late answer is ignored).
    const close = (state: Exclude<Ending, "approved">): RunApprovalOutcome => {
      native?.end(id);
      if (state !== "denied") quietWithdraw(id);
      return { kind: "declined", state };
    };
    if (end !== "approved") return close(end);
    if (signal.aborted) return close("withdrawn");
    try {
      // Spent here, once, for this run's requester and connection and this exact call: the grant exists only inside the action.
      const grant = await core.manager.consume(id, caller, { ...request, currentContentDigest: input.digest }, (): RunApprovalGrant => ({
        approved: true,
        approvedBy: "user",
        approvalId: approvalIdOf(id),
        digest: input.digest,
        expiresAt: Math.floor(core.now()) + grantTtl,
      }));
      native?.end(id);
      return { kind: "granted", grant };
    } catch {
      native?.end(id);
      return { kind: "declined", state: "expired" };
    }
  }

  return {
    request,
    settled(result) {
      const wait = waits.get(result.challengeId);
      if (wait === undefined) return;
      if (result.state !== "approved") return finish(result.challengeId, result.state);
      // The user's approval in the window. Tier 3 has no native step; tier 4 still waits for the dialog.
      if (wait.tier === 3) return finish(result.challengeId, result.nativeRequired ? "refused" : "approved");
      if (!result.nativeRequired) return finish(result.challengeId, "refused");
      wait.userApproved = true;
    },
    confirmed(result) {
      const wait = waits.get(result.challengeId);
      if (wait === undefined) return;
      if (result.state !== "approved") return finish(result.challengeId, result.state);
      // A native confirmation counts only for a tier 4 wait the user already approved in the window.
      if (wait.tier !== 4 || !wait.userApproved) return finish(result.challengeId, "refused");
      finish(result.challengeId, "approved");
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
