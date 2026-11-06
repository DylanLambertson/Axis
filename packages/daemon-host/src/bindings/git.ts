// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError } from "@axis/daemon";
import {
  GitOpsError,
  ScanIncomplete,
  compareUrl,
  createNodeRunner,
  daemonGitFor,
  executeCommit,
  executePush,
  planPush,
  type Env,
  type GitOpsDeps,
  type GitRunner,
  type GitRunRequest,
  type GitRunResult,
  type WorktreeRef,
} from "@axis/git-ops";
import { SecretScanError, type SecretScanner } from "@axis/secret-scan";
import { GitRefusal, type GitOperations, type GitPort, type PushCall } from "../ports/git.js";
import type { RunsService } from "../ports/runs.js";
import { pushTargetKey, type SshHostResolver } from "./push-target.js";

/**
 * The assembly of `GitOpsDeps` over the real `@axis/git-ops` (ticket H9, design section 2.1: with `worktrees.ts` and the
 * review bindings, the files that import a package) and the git operations the handlers run (`GitOperations`).
 *
 * The one runner routes by `req.context`: `daemon` goes to the node runner, built over the host's single absolute `gitPath`
 * (no lookup, hooks off: git-ops guards that itself); `pty` goes to `ptyRunner`, the runner of the Axis pty process, and an
 * absent one refuses with `E_UNAVAILABLE`. A context that is neither is refused too. The daemon process therefore never
 * spawns a pty-context command (commit-tree and push run where the credentials and signing are), whatever a caller asks.
 *
 * DECISION B2 (OPEN, ticket H9-hooks): a bound commit runs NO repository hook in the daemon. `commit-tree` and the
 * compare-and-swap `update-ref` run none, `runHooks` only affects push (`--no-verify`), and the host side that runs
 * `pre-commit` and `commit-msg` in the pty process is not built. Nothing here records "made without hooks".
 */
export interface GitBindingDeps {
  /** The ONE absolute git path of `HostServices.gitPath`: never looked up again. */
  readonly gitPath: string;
  /** `daemon`: the GIT-ENV-1 source environment. `pty`: the PTY-5 environment (credentials, signing). Copies the host owns. */
  readonly env: { readonly daemon: Env; readonly pty: Env };
  readonly platform: NodeJS.Platform;
  /** `axis.git.runHooks`: only push is affected (see above). */
  readonly runHooks: boolean;
  /**
   * The PSH-1 scanner of `@axis/secret-scan`, REQUIRED: its `scan` and its `mode` are taken from this one value, so a
   * scanner can never be paired with the weaker default mode of git-ops (`warn`) by leaving one out.
   */
  readonly scanner: SecretScanner;
  /** The runner of the Axis pty process (the control-channel runner). Absent: every pty-context command is refused. */
  readonly ptyRunner?: GitRunner;
  /** `assertNoDrift` of the worktrees binding (`WorktreesBinding.assertNoDrift`) for the worktree path. */
  readonly assertNoDrift: (worktree: WorktreeRef) => Promise<void>;
  /** A CLI run outside the supervisor's knowledge (default: none). The workspace's own runs are asked per call. */
  readonly isCliRunActive?: (worktree: WorktreeRef) => boolean | Promise<boolean>;
  /** Registered worktrees, re-read on each lookup (see `NodeRunnerOptions.excludeDirs`). */
  readonly excludeDirs?: () => readonly string[];
  readonly emptyHooksDir?: string;
  readonly fileExists?: (path: string) => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
}

function unavailable(): Promise<GitRunResult> {
  return Promise.reject(new GitOpsError("E_UNAVAILABLE", "The git runner for this context is not available."));
}

/**
 * git-ops turns whatever the drift check throws into `E_UNAVAILABLE` (it cannot know the reason is safe). The worktrees binding
 * refuses with the closed `git_drift`: that one is passed on as a conflict with the reason, so the client can send the user to the
 * acknowledgement instead of "try again". Anything else is left as it was.
 */
function driftAsRefusal(check: (worktree: WorktreeRef) => Promise<void>): (worktree: WorktreeRef) => Promise<void> {
  return async (worktree) => {
    try {
      await check(worktree);
    } catch (e) {
      if (e instanceof DaemonError && e.details?.["reason"] === "git_drift") {
        throw new GitOpsError("E_CONFLICT", "The repository's git configuration changed.", { reason: "git_drift" });
      }
      throw e;
    }
  };
}

/**
 * `refuse` mode: a scanner that could not cover the text (too large, out of time or work) throws a `SecretScanError`. git-ops
 * would call that a failure (`E_UNAVAILABLE`); it is an incomplete scan, which the push refuses as `scan_incomplete` and
 * `pushPlan` shows. A scanner failure of its own (`internal`) and every other throw stay failures.
 */
function incompleteAsScan(scan: SecretScanner["scan"]): SecretScanner["scan"] {
  return async (text, meta) => {
    try {
      return await scan(text, meta);
    } catch (e) {
      if (e instanceof SecretScanError && e.code !== "internal") throw new ScanIncomplete();
      throw e;
    }
  };
}

export function createGitPort(deps: GitBindingDeps): GitPort {
  if (typeof deps.scanner?.scan !== "function" || (deps.scanner.mode !== "refuse" && deps.scanner.mode !== "warn")) {
    throw new TypeError("the git port needs a secret scanner with a mode");
  }
  const daemonRunner = createNodeRunner({
    gitPath: deps.gitPath,
    env: deps.env.daemon,
    ...(deps.excludeDirs === undefined ? {} : { excludeDirs: deps.excludeDirs }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  const runner: GitRunner = {
    run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context === "daemon") return daemonRunner.run(req);
      if (req.context === "pty") return deps.ptyRunner === undefined ? unavailable() : deps.ptyRunner.run(req);
      return unavailable();
    },
  };
  const port: GitOpsDeps = {
    runner,
    env: { daemon: deps.env.daemon, pty: deps.env.pty },
    runHooks: deps.runHooks,
    isCliRunActive: deps.isCliRunActive ?? (() => false),
    assertNoDrift: driftAsRefusal(deps.assertNoDrift),
    scanner: incompleteAsScan(deps.scanner.scan),
    scanMode: deps.scanner.mode,
    platform: deps.platform,
    ...(deps.emptyHooksDir === undefined ? {} : { emptyHooksDir: deps.emptyHooksDir }),
    ...(deps.fileExists === undefined ? {} : { fileExists: deps.fileExists }),
  };
  return port;
}

/** What leaves this file for a failure: a code, a closed reason and whether the branch moved. Never the package's text. */
function refuse(e: unknown): never {
  if (e instanceof GitRefusal) throw e;
  if (e instanceof GitOpsError) {
    const reason = e.details?.["reason"];
    throw new GitRefusal(e.code, typeof reason === "string" ? reason : undefined, e.details?.["updated"] === true);
  }
  throw new GitRefusal("E_UNAVAILABLE");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return refuse(e);
  }
}

export interface GitOperationsDeps {
  readonly git: GitPort;
  /** The supervisor's live view: a run in THIS workspace refuses commit and push. A throw counts as active. */
  readonly runs: Pick<RunsService, "hasActiveRun">;
  /** Extra hosts for compare URLs (GitHub Enterprise). github.com is always allowed. */
  readonly allowedHosts?: readonly string[];
  /**
   * Resolves an ssh host or alias of a push URL to where it connects (H9-base), so the scan base is keyed by the real
   * destination. Absent: the host is keyed as written (an alias edited behind the same name is then not seen). Present: a
   * resolver that throws or answers badly refuses the scan base.
   */
  readonly resolveSshHost?: SshHostResolver;
}

export function createGitOperations(deps: GitOperationsDeps): GitOperations {
  // The scan runs inside git-ops with THIS port: git-ops finds nothing when `scanner` is absent and defaults to `warn`, so a
  // port without both is refused here, where the scan is, rather than checked on a copy somewhere else (PSH-1).
  const scanMode = deps.git.scanMode;
  if (typeof deps.git.scanner !== "function" || (scanMode !== "refuse" && scanMode !== "warn")) {
    throw new TypeError("the git operations need a port with a secret scanner and its mode");
  }
  const runActive = (workspaceId: string): boolean => {
    try {
      return deps.runs.hasActiveRun(workspaceId);
    } catch {
      return true; // fail closed
    }
  };
  const forWorkspace = (workspaceId: string, assertFresh?: () => Promise<void>): GitOpsDeps => ({
    ...deps.git,
    isCliRunActive: async (w) => runActive(workspaceId) || (await deps.git.isCliRunActive(w)),
    ...(assertFresh === undefined ? {} : { assertReviewFresh: assertFresh }),
  });
  const pushInput = (call: PushCall) => ({
    worktree: call.worktree,
    remote: call.remote,
    branch: call.branch,
    baseSha: call.baseSha,
    ...(call.allowedBinaryPaths === undefined ? {} : { allowedBinaryPaths: call.allowedBinaryPaths }),
  });
  return {
    scanMode,
    pushTarget: (call) =>
      guarded(async () => {
        const git = await daemonGitFor(call.worktree, deps.git);
        const urls = await git(["remote", "get-url", "--push", "--all", "--", call.remote]);
        const list = urls.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
        if (urls.code !== 0 || list.length === 0) throw new GitRefusal("E_INVALID_ARGUMENT");
        return pushTargetKey(list, call.worktree.workTree, deps.resolveSshHost);
      }),
    planPush: (call) =>
      guarded(async () => {
        // `reportBlocked`: a scan that blocks the push comes back as `blocked` (with the binary paths), not as a bare refusal.
        const plan = await planPush(forWorkspace(call.workspaceId), { ...pushInput(call), reportBlocked: true });
        return {
          ...(plan.blocked === undefined ? {} : { blocked: { reason: plan.blocked.reason, binaryPaths: [...plan.blocked.unlistedBinaryPaths] } }),
          tip: plan.tip,
          digest: plan.digest,
          requiresConfirmation: plan.requiresConfirmation,
          reasons: [...plan.reasons],
          findings: plan.findings.map((f) => ({
            rule: f.rule,
            ...(f.path === undefined ? {} : { path: f.path }),
            ...(f.line === undefined ? {} : { line: f.line }),
            ...(f.commit === undefined ? {} : { commit: f.commit }),
          })),
        };
      }),
    // `confirmed: true` is what the spent tier 4 approval says: the user confirmed the challenge of THIS plan. The plan the
    // approval covered is passed back, so a push whose tip or findings changed since is `plan_changed`.
    executePush: (call, confirmed) =>
      guarded(() => executePush(forWorkspace(call.workspaceId), pushInput(call), { confirmed: true, confirmedPlan: { tip: confirmed.tip, digest: confirmed.digest } })),
    executeCommit: (call, input) => guarded(() => executeCommit(forWorkspace(call.workspaceId, call.assertFresh), input)),
    compareUrl: (call) =>
      guarded(async () => {
        const git = await daemonGitFor(call.worktree, deps.git);
        const url = await git(["remote", "get-url", "--", call.remote]);
        if (url.code !== 0 || url.stdout.trim() === "") throw new GitRefusal("E_INVALID_ARGUMENT");
        return compareUrl({
          remoteUrl: url.stdout.trim(),
          base: call.base,
          head: call.head,
          ...(deps.allowedHosts === undefined ? {} : { allowedHosts: deps.allowedHosts }),
        });
      }),
  };
}
