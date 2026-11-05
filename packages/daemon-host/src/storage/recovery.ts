// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditActions, type AuditLog, type InstanceLock } from "@axis/audit";
import type { Journal, JournalIdempotencyStore, RecoveryReport } from "@axis/journal";
import type { ReconcileReport } from "../ports/worktrees.js";

export const DEFAULT_RECONCILE_BUDGET_MS = 20_000;
/** What is kept of a reconcile report: bounded, so a misbehaving port cannot grow the host's memory. */
const MAX_ATTENTION = 1024;

export interface RecoveryOutcome {
  readonly journal: RecoveryReport;
  /** Idempotency keys an earlier boot left in progress, now `unknown: interrupted`. */
  readonly keysInterrupted: number;
  readonly reconcile: "skipped" | "ok" | "timeout" | "failed";
  readonly needsAttention: ReconcileReport["needsAttention"];
}

export interface RecoveryInput {
  readonly lock: InstanceLock;
  readonly journal: Journal;
  readonly idempotency: JournalIdempotencyStore;
  readonly audit: AuditLog;
  /** Compare git with the journal (worktrees port, ticket H8). Absent: skipped. */
  readonly reconcile?: ((signal: AbortSignal) => Promise<ReconcileReport>) | undefined;
  readonly reconcileBudgetMs: number;
  /** Aborted by `stop()`: the reconcile is told to stop and its result (and any audit write for it) is dropped. */
  readonly signal?: AbortSignal;
}

/**
 * Design section 3, step 9. `journal.recover(lock)` turns RUNNING runs into BLOCKED `INTERRUPTED_BY_RESTART` and
 * CREATING workspaces into FAILED (DMN-7), the store's `recover(lock)` makes keys an earlier boot left in progress
 * `unknown`, then `reconcile` runs under a time budget. A reconcile that fails or runs out of time is audited and never
 * aborts startup: the other workspaces are served. Both recoveries need the held lock, so a second host cannot run them.
 */
export async function runRecovery(input: RecoveryInput): Promise<RecoveryOutcome> {
  const journal = input.journal.recover(input.lock);
  const { interrupted } = input.idempotency.recover(input.lock);
  if (input.reconcile === undefined) {
    return { journal, keysInterrupted: interrupted, reconcile: "skipped", needsAttention: [] };
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted === true) cancel();
  let timer: NodeJS.Timeout | undefined;
  let status: "ok" | "timeout" | "failed" = "ok";
  let needsAttention: ReconcileReport["needsAttention"] = [];
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout"); // before the abort, which settles the "cancelled" branch of the race
        controller.abort();
      }, input.reconcileBudgetMs) as unknown as NodeJS.Timeout; // opaque handle under Code OSS's typings (ADR 0005)
    });
    const work = Promise.resolve().then(() => input.reconcile?.(controller.signal));
    work.catch(() => undefined); // an abandoned reconcile may still reject later
    const cancelled = new Promise<"cancelled">((resolve) => controller.signal.addEventListener("abort", () => resolve("cancelled"), { once: true }));
    const done = await Promise.race([work, timeout, cancelled]);
    if (input.signal?.aborted === true || done === "cancelled") status = "failed";
    else if (done === "timeout") status = "timeout";
    else if (done !== undefined) needsAttention = done.needsAttention.slice(0, MAX_ATTENTION);
  } catch {
    status = "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  input.signal?.removeEventListener("abort", cancel);
  if (input.signal?.aborted === true) return { journal, keysInterrupted: interrupted, reconcile: "failed", needsAttention: [] };
  if (status !== "ok" || needsAttention.length > 0) {
    input.audit.append({
      actor: "daemon",
      action: AuditActions.journalRecovery,
      target: "worktrees:reconcile",
      outcome: status === "ok" ? "success" : "failure",
      payload: { kind: "reconcile", reason: status, count: needsAttention.length },
    });
  }
  return { journal, keysInterrupted: interrupted, reconcile: status, needsAttention };
}
