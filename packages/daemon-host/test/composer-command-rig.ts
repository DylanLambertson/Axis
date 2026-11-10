// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import type { TestContext } from "node:test";
import type { Challenge, RunEvent } from "@axis/protocol";
import type { MockReply } from "@axis/providers";
import { allEvents, composerRig, type ComposerRig, type ComposerRigOptions } from "./composer-rig.js";

// Helpers of the C3 tests: `run_command` through the real composer, broker, runner, approvals and native bridge.

export const posix = process.platform !== "win32";
/** node itself, by its real path: a native program on every platform (a launcher, so `privileged`). */
export const NODE = realpathSync(process.execPath);

export const command = (argv: readonly string[], extra: Record<string, unknown> = {}): MockReply => ({ kind: "tool_use", name: "run_command", input: { argv: [...argv], ...extra } });
/** `node -e <code> [args...]`. */
export const nodeRun = (code: string, ...args: string[]): MockReply => command([NODE, "-e", code, ...args]);

type Approval = Extract<RunEvent, { type: "approval" }>;
type Tool = Extract<RunEvent, { type: "tool" }>;
export const approvalsOf = (c: ComposerRig, runId: string): Approval[] => allEvents(c, runId).filter((e): e is Approval => e.type === "approval");
export const toolsOf = (c: ComposerRig, runId: string): Tool[] => allEvents(c, runId).filter((e): e is Tool => e.type === "tool");

/** A recording snapshotter (WT-2 port): `verdict` decides each `after`, `failBefore` refuses the baseline. */
export function fakeSnapshotter(o: { verdict?: () => boolean | "throw"; failBefore?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    before: async (ctx: { runId: string }) => {
      calls.push(`before:${ctx.runId}`);
      if (o.failBefore === true) throw new Error("no baseline");
    },
    after: async (ctx: { runId: string }) => {
      calls.push(`after:${ctx.runId}`);
      const v = o.verdict?.() ?? false;
      if (v === "throw") throw new Error("cannot judge");
      return { drift: v };
    },
  };
}

/** Wait on timers (a child process needs real time), bounded by a count, never asserting a duration. */
export async function eventually(pred: () => boolean, tries = 1500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("condition not reached");
}

export async function commandRig(t: TestContext, options: Partial<ComposerRigOptions>): Promise<ComposerRig> {
  const c = await composerRig({ replies: [], ...options });
  t.after(() => c.cleanup());
  return c;
}

export const pending = async (c: ComposerRig): Promise<Challenge[]> => (await c.user.call("axis.approvals", "pending", {})).result?.["challenges"] as Challenge[];

/**
 * Answer the run's one pending command: approve it in the window AND in the native dialog (tier 4). Returns the challenge
 * and the `native.confirm` message the supervisor got (its `summary` is the dialog line).
 */
export async function approveCommand(c: ComposerRig, runId: string, confirm = true): Promise<{ challenge: Challenge; sent: Record<string, unknown> }> {
  await eventually(() => c.service.get(runId).awaitingApproval || !c.service.get(runId).live);
  return answerPending(c, confirm);
}

/** Answer the one pending challenge in the window and in the native dialog. */
export async function answerPending(c: ComposerRig, confirm = true): Promise<{ challenge: Challenge; sent: Record<string, unknown> }> {
  let [challenge] = await pending(c);
  for (let i = 0; i < 1500 && challenge === undefined; i++) {
    await new Promise((res) => setTimeout(res, 10));
    [challenge] = await pending(c);
  }
  if (challenge === undefined) throw new Error("no challenge");
  await eventually(() => c.r.nativeConfirms().some((m) => m["challengeId"] === challenge.challengeId));
  const sent = c.r.nativeConfirms().find((m) => m["challengeId"] === challenge.challengeId) as Record<string, unknown>;
  await c.user.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
  c.r.answer(challenge.challengeId, String(sent["proof"]), confirm);
  return { challenge, sent };
}

/** An executable `#!` script run by node, or false where this system cannot run one (the case is then skipped). */
export function nodeScript(path: string, body: string): boolean {
  if (!posix || NODE.length > 120) return false;
  writeFileSync(path, `#!${NODE}\n${body}\n`);
  chmodSync(path, 0o755);
  return true;
}
