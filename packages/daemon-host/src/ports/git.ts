// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { CommitInput, GitOpsDeps, WorktreeRef } from "@axis/git-ops";

/**
 * Everything `@axis/git-ops` takes (`GitOpsDeps`): ONE runner that routes by `req.context` (`daemon`: the node runner
 * with hooks off; `pty`: the control-channel runner of the Axis pty process), the two environments, `runHooks`, the
 * `isCliRunActive` and `assertNoDrift` guards, and the optional secret scanner. The host builds it once and the git
 * handlers pass it through unchanged.
 */
export type GitPort = GitOpsDeps;

/**
 * A refusal of a git operation as plain data: a code of the closed set, an optional closed `reason` and whether the branch
 * was already moved. Never git's text, a path or a ref: the handler maps the code and the reason, and nothing else.
 */
export class GitRefusal extends Error {
  constructor(
    readonly code: string,
    readonly reason?: string,
    /** The commit's branch update had already happened when this was raised (git-ops `updated`). */
    readonly updated: boolean = false,
  ) {
    super("git operation refused");
    this.name = "GitRefusal";
  }
}

/** One finding of the scan: names and positions only, never matched text. */
export interface PushFindingFacts {
  readonly rule: string;
  readonly path?: string;
  readonly line?: number;
  readonly commit?: string;
}

/** What `planPush` found, with the strings git and the scanner produced (the handler escapes them for the wire). */
export interface PushPlanFacts {
  readonly tip: string;
  readonly digest: string;
  readonly requiresConfirmation: boolean;
  readonly reasons: readonly string[];
  readonly findings: readonly PushFindingFacts[];
}

export interface PushCall {
  readonly workspaceId: string;
  readonly worktree: WorktreeRef;
  readonly remote: string;
  /** The workspace's own branch, from the journal. */
  readonly branch: string;
  /** The last commit Axis pushed (or the recorded base before the first push), from the journal. */
  readonly baseSha: string;
  readonly allowedBinaryPaths?: readonly string[];
}

/**
 * The git operations the handlers run, over the real `@axis/git-ops` (only `src/bindings/git.ts` imports it). Each call
 * completes the shared `GitPort` for its workspace (a CLI run in THAT workspace refuses it) and turns every failure into
 * a `GitRefusal`.
 */
export interface GitOperations {
  planPush(call: PushCall): Promise<PushPlanFacts>;
  /** Pushes the one scanned tip, or refuses `E_CONFLICT` `plan_changed` when the outgoing changes are not the confirmed plan. */
  executePush(call: PushCall, confirmed: { readonly tip: string; readonly digest: string }): Promise<void>;
  /** The commit of the reviewed tree. `assertFresh` refuses by throwing (G2). */
  executeCommit(call: { readonly workspaceId: string; readonly assertFresh: () => Promise<void> }, input: CommitInput): Promise<{ readonly commit: string; readonly tree: string }>;
  /** The compare URL of the named remote (its own URL, from the repository). */
  compareUrl(call: { readonly workspaceId: string; readonly worktree: WorktreeRef; readonly remote: string; readonly base: string; readonly head: string }): Promise<string>;
}
