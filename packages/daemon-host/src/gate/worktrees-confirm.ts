// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ApprovalContent, ApprovalInput } from "@axis/daemon";
import { markDiscardConfirmed } from "@axis/worktrees/daemon-confirm";
import type { ApprovalsDeps } from "./approvals.js";

/**
 * The confirmation inputs of the worktree calls that discard data (design section 5.2, `docs/packages.md` "Calling
 * `@axis/worktrees` from the daemon"). This is the one file that may import `@axis/worktrees/daemon-confirm`: a
 * handler can never make the token that lets `finalise` or `remove` delete a dirty workspace.
 *
 * `worktreesCapability` runs inside the gate's approval action, AFTER the approval was spent, and binds the token to
 * what the user confirmed: the workspace named by `content.target`, the operation (the method) and the fingerprint
 * the content hook computed under the lock (`content.contentDigest`). The token lives 30 seconds on a monotonic
 * clock and the first `finalise` or `remove` that accepts it spends it. A method that discards nothing (anything
 * but `finalise` and `remove` of `axis.worktrees/1`) gets none, and a request whose `id` disagrees with its approved
 * target is refused (the action fails; the approval is already spent).
 */
const TARGET = /^workspace:([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function worktreesCapability(input: ApprovalInput, content: ApprovalContent): unknown {
  if (input.contract !== "axis.worktrees" || input.contractVersion !== 1) return undefined;
  if (input.method !== "remove" && input.method !== "finalise") return undefined;
  const id = TARGET.exec(content.target)?.[1];
  const args = input.args;
  const named = typeof args === "object" && args !== null && !Array.isArray(args) ? args["id"] : undefined;
  if (id === undefined || named !== id || !DIGEST.test(content.contentDigest)) {
    throw new Error("the approved target does not match the request");
  }
  return markDiscardConfirmed({ workspaceId: id, op: input.method, fingerprint: content.contentDigest });
}

const NOTES_MAX = 64;

/**
 * Remembers, per (target, content digest), the one line the content hook wrote about what would be discarded, so the
 * native dialog can show it (`createApprovals` `describe`). Bounded: the oldest note goes first. A note is looked up
 * only by the exact digest the challenge was issued with, so a stale note is never shown for different content.
 */
export class PreviewNotes {
  readonly #notes = new Map<string, string>();

  record = (target: string, contentDigest: string, text: string): void => {
    const k = `${target}|${contentDigest}`;
    this.#notes.delete(k);
    this.#notes.set(k, text);
    if (this.#notes.size > NOTES_MAX) this.#notes.delete(this.#notes.keys().next().value as string);
  };

  describe = (_input: ApprovalInput, content: ApprovalContent): string | undefined => this.#notes.get(`${content.target}|${content.contentDigest}`);
}

export interface WorktreesApprovalWiring {
  /** Spread into `createApprovals`: the capability minter, the dialog text and (when given) the preflight. */
  readonly approvals: Pick<ApprovalsDeps, "capability" | "describe" | "preflight">;
  /** Pass to `createWorktreeContentHooks` as `onPreview`. */
  readonly onPreview: PreviewNotes["record"];
}

/**
 * Everything the worktrees binding adds to `createApprovals`. `preflight` is the stall check seam (the anchor check
 * of ticket H4: refuse tier 3 and above while the supervisor withholds acknowledgements); it is passed through
 * unchanged and defaults to none. It must be synchronous (the gate refuses a promise).
 */
export function createWorktreesApprovalWiring(options: { readonly preflight?: (tier: number) => void } = {}): WorktreesApprovalWiring {
  const notes = new PreviewNotes();
  return {
    approvals: {
      capability: worktreesCapability,
      describe: notes.describe,
      ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
    },
    onPreview: notes.record,
  };
}
