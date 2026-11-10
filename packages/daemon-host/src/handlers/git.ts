// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Handler, HandlerContext } from "@axis/daemon";
import { GIT_CONTRACT, GIT_VERSION, gitCompareUrlRequestSchema, gitCompareUrlResponseSchema, gitPushPlanRequestSchema, type GitMethod } from "@axis/protocol";
import type { HandlerRegistrar } from "./anchor-guard.js";
import { createGitCommitHandler } from "./git-commit.js";
import { locate, mapError, requireUser, scanBase, workspaceFor, type GitHandlerDeps } from "./git-common.js";
import { gitFailure } from "./git-errors.js";
import { createGitPushContentHook, createGitPushHandler } from "./git-push.js";
import { pushPlanReply } from "./git-wire.js";

export type { GitHandlerDeps } from "./git-common.js";
export { createGitCommitHandler } from "./git-commit.js";
export { createGitPushContentHook, createGitPushHandler } from "./git-push.js";

/**
 * `axis.git/1` (design section 4.2): `pushPlan` (tier 1), `commit` (tier 2), `push` (tier 4) and `compareUrl` (tier 0), over
 * the `GitOperations` and `CommitPreparer` ports. Nothing here touches a path, git or a package. Who is calling comes from
 * `ctx.identity` only (the payload names a workspace and a remote, never an actor, a branch, a base commit, a worktree or
 * a URL: the host derives them from the journal and the repository's own configuration), and every error is a `DaemonError`
 * with a fixed text (`gitFailure`), never the text of whatever failed.
 */
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function createPushPlanHandler(deps: GitHandlerDeps): Handler {
  return async (context: HandlerContext, payload: never) => {
    requireUser(context);
    const request = gitPushPlanRequestSchema.safeParse(payload);
    if (!request.success) throw gitFailure("E_INVALID_ARGUMENT");
    const { workspaceId, remote, allowedBinaryPaths, allowedBinaryIds } = request.data;
    try {
      const first = workspaceFor(deps, workspaceId, "pushPlan", true);
      return await deps.mutex.run(
        first.projectId,
        async () => {
          const ws = workspaceFor(deps, workspaceId, "pushPlan", true);
          const worktree = await locate(deps, workspaceId);
          const target = await deps.ops.pushTarget({ workspaceId, worktree, remote });
          const facts = await deps.ops.planPush({
            workspaceId,
            worktree,
            remote,
            branch: ws.branch,
            baseSha: await scanBase(deps, ws, workspaceId, worktree, target),
            ...(allowedBinaryPaths === undefined ? {} : { allowedBinaryPaths }),
            ...(allowedBinaryIds === undefined ? {} : { allowedBinaryIds }),
          });
          // A plan the contract cannot carry is not shown: fail closed rather than cut it.
          const reply = pushPlanReply(facts, remote, ws.branch);
          if (reply === null) throw gitFailure("E_INTERNAL");
          return reply;
        },
        context.signal,
      );
    } catch (e) {
      throw mapError(deps, e, context.signal);
    }
  };
}

function createCompareUrlHandler(deps: GitHandlerDeps): Handler {
  return async (context: HandlerContext, payload: never) => {
    requireUser(context);
    const request = gitCompareUrlRequestSchema.safeParse(payload);
    if (!request.success) throw gitFailure("E_INVALID_ARGUMENT");
    const { workspaceId, remote } = request.data;
    try {
      const ws = workspaceFor(deps, workspaceId, "compareUrl", false);
      // The base is the caller's when it named one, else the workspace's own base ref from the journal (a short branch name).
      const base = request.data.base ?? ws.baseRef.replace(/^refs\/heads\//, "");
      if (!BASE_REF.test(base)) throw gitFailure("E_INVALID_ARGUMENT");
      const worktree = await locate(deps, workspaceId);
      const url = await deps.ops.compareUrl({ workspaceId, worktree, remote, base, head: ws.branch });
      const reply = gitCompareUrlResponseSchema.safeParse({ url });
      if (!reply.success) throw gitFailure("E_INTERNAL");
      return reply.data;
    } catch (e) {
      throw mapError(deps, e, context.signal);
    }
  };
}

/** The handlers by method name, as the registry assembly expects them. */
export function createGitHandlers(deps: GitHandlerDeps): Readonly<Record<GitMethod, Handler>> {
  return { pushPlan: createPushPlanHandler(deps), commit: createGitCommitHandler(deps), push: createGitPushHandler(deps), compareUrl: createCompareUrlHandler(deps) };
}

/**
 * Registers `axis.git/1` through the registrar (never the daemon), which guards the tier 4 `push` against a stalled anchor
 * on its own, with the push content hook. The product refuses to register `git.push` without a secret scanner and an
 * explicit mode (PSH-1, design 6.4): the git-ops default mode is `warn`, so a scanner without a mode, or a mode without a
 * scanner, is refused too. Nothing is registered when it throws.
 */
export function registerGitHandlers(registrar: HandlerRegistrar, deps: GitHandlerDeps): void {
  // The mode is the one of the operations the scan runs in (`createGitOperations` refuses a port without a scanner).
  if (deps.ops.scanMode !== "refuse" && deps.ops.scanMode !== "warn") {
    throw new Error("axis.git/1 cannot be registered without a secret scanner and its mode");
  }
  registrar.register(GIT_CONTRACT, GIT_VERSION, createGitHandlers(deps), { content: { push: createGitPushContentHook(deps) } });
}
