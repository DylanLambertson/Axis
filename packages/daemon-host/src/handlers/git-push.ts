// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type ApprovalContentHook, type Handler, type HandlerContext } from "@axis/daemon";
import { gitPushRequestSchema, type GitRequest } from "@axis/protocol";
import type { PushCall } from "../ports/git.js";
import { gitFailure } from "./git-errors.js";
import { locate, mapError, scanBase, requireUser, runActive, workspaceFor, type GitHandlerDeps } from "./git-common.js";

/** Both read the plan's inputs from the JOURNAL, inside the lock: the branch is the workspace's, the base its last pushed sha. */
async function pushCall(deps: GitHandlerDeps, id: string, method: string, request: GitRequest<"push">) {
  const ws = workspaceFor(deps, id, method, true);
  const worktree = await locate(deps, id);
  // Read under the lock, before the plan: the base is of where the push goes now. A URL changed after this read and before git
  // runs is not covered, and that is also what the drift gate (`assertNoDrift`) is for.
  const target = await deps.ops.pushTarget({ workspaceId: id, worktree, remote: request.remote });
  const call: PushCall = {
    workspaceId: id,
    worktree,
    remote: request.remote,
    branch: ws.branch,
    baseSha: await scanBase(deps, ws, id, worktree, target),
    ...(request.allowedBinaryPaths === undefined ? {} : { allowedBinaryPaths: request.allowedBinaryPaths }),
    ...(request.allowedBinaryIds === undefined ? {} : { allowedBinaryIds: request.allowedBinaryIds }),
  };
  return { ws, call, target };
}

/**
 * The approval content hook of `push` (design section 6.4). The target is `workspace:<id>`, never a path. The anchor is
 * asked FIRST (a stalled anchor does no scan and issues no challenge), then, under the project mutex, the plan is made
 * (`planPush`: the scan included) and its digest is the content digest: a challenge is bound to the exact tip and findings
 * the user saw, at issue and again at the spend. A plan that is not the `confirmedPlan` of the request is refused
 * `E_CONFLICT` `plan_changed` BEFORE a challenge is issued. Every refusal here is a closed `DaemonError`; one a
 * `GitRefusal` caused (a scanner that refuses or cannot decide) is mapped, never forwarded.
 */
export function createGitPushContentHook(deps: GitHandlerDeps): ApprovalContentHook {
  // The anchor and run checks below are each also made by the gate, the registrar guard and git-ops: defence in depth, so a
  // refusal costs no scan and no challenge.
  return (context, payload: never) => {
    if (context.identity.actor !== "user") throw gitFailure("E_NOT_FOUND");
    deps.anchors.check(4);
    const request = gitPushRequestSchema.safeParse(payload);
    if (!request.success) throw gitFailure("E_INVALID_ARGUMENT");
    const { workspaceId, confirmedPlan } = request.data;
    const first = workspaceFor(deps, workspaceId, "push", true);
    return {
      target: `workspace:${first.id}`,
      withLock: <T>(fn: (contentDigest: string) => Promise<T>): Promise<T> =>
        deps.mutex.run(
          first.projectId,
          async () => {
            let digest: string;
            try {
              deps.anchors.check(4);
              const { ws, call } = await pushCall(deps, workspaceId, "push", request.data);
              if (ws.projectId !== first.projectId) throw gitFailure("E_NOT_FOUND");
              if (runActive(deps, workspaceId)) throw gitFailure("E_CONFLICT");
              const plan = await deps.ops.planPush(call);
              // A blocked plan (refuse-mode finding, incomplete scan, unlisted binary path, unreadable message) is refused with its closed
              // reason before a challenge exists; no confirmation could make it pushable.
              if (plan.blocked !== undefined) throw gitFailure("E_CONFLICT", plan.blocked.reason);
              if (plan.tip !== confirmedPlan.tip || plan.digest !== confirmedPlan.digest) throw gitFailure("E_CONFLICT", "plan_changed");
              digest = plan.digest;
            } catch (e) {
              throw mapError(deps, e, context.signal);
            }
            return fn(digest);
          },
          context.signal,
        ),
    };
  };
}

/**
 * `axis.git/1.push` (tier 4: always a challenge with native confirmation). It runs inside a spent approval and inside the
 * hook's lock (the mutex is re-entrant for the call chain), and pushes only the tip of the `confirmedPlan`: `executePush`
 * plans again and refuses `plan_changed` unless the tip and the scan result are the confirmed ones.
 *
 * After the push succeeded the tip is recorded as the workspace's last pushed sha (the next push's scan base). That write
 * is bookkeeping: if it fails the push still happened, so the reply is still the success (reported through
 * `onBookkeepingError`) and the next scan covers a larger range, never a smaller one. A handler that threw here would free
 * the idempotency key of a push that went out.
 */
export function createGitPushHandler(deps: GitHandlerDeps): Handler {
  return async (context: HandlerContext, payload: never) => {
    requireUser(context);
    // An approved method runs inside a spent approval: the daemon guarantees it, and a handler that finds otherwise stops.
    if (context.approved === undefined) throw new DaemonError("E_INTERNAL", "The git operation failed.");
    const request = gitPushRequestSchema.safeParse(payload);
    if (!request.success) throw gitFailure("E_INVALID_ARGUMENT");
    const { workspaceId, confirmedPlan } = request.data;
    const { signal } = context;
    try {
      const first = workspaceFor(deps, workspaceId, "push", true);
      return await deps.mutex.run(
        first.projectId,
        async () => {
          const { ws, call, target } = await pushCall(deps, workspaceId, "push", request.data);
          if (ws.projectId !== first.projectId) throw gitFailure("E_NOT_FOUND");
          if (runActive(deps, workspaceId)) throw gitFailure("E_CONFLICT");
          if (signal.aborted) throw gitFailure("E_CANCELLED");
          await deps.ops.executePush(call, confirmedPlan);
          // Known pushed to THIS destination now (before the journal write, which can fail without undoing the push).
          deps.bases.record(workspaceId, target, confirmedPlan.tip);
          // Both writes can fail without undoing the push: a failed one is reported and the push still succeeds.
          for (const write of [() => deps.bases.persist(), async () => deps.journal.recordPushed(workspaceId, confirmedPlan.tip, "user")]) {
            try {
              await write();
            } catch (e) {
              try {
                deps.onBookkeepingError?.(e);
              } catch {
                // A reporter that throws must not turn a push that went out into a failure.
              }
            }
          }
          return { remote: request.data.remote, branch: ws.branch, tip: confirmedPlan.tip };
        },
        signal,
      );
    } catch (e) {
      throw mapError(deps, e, signal);
    }
  };
}
