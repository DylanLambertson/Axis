// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { composerRunsMethods, type Challenge, type ComposerRun, type RunEvent } from "@axis/protocol";
import type { GitFixture } from "../../testing/git-fixture.js";
import type { SliceComposerConfig } from "../../testing/slice-composer.js";
import { registerProject, startHost, trustWindow, type AuditRow } from "../../testing/slice-helpers.js";
import { TestClient, until } from "../../testing/test-client.js";
import type { TestSupervisor } from "../../testing/test-supervisor.js";

/** Helpers of the composer slice (ticket C7): the composed host in a child process, driven over the wire as a window would. */

export type Approval = Extract<RunEvent, { type: "approval" }>;
export type ToolEvent = Extract<RunEvent, { type: "tool" }>;

export interface ComposerHost {
  readonly sup: TestSupervisor;
  readonly client: TestClient;
  readonly projectId: string;
}

/** Start a host whose composer reads `config` (written to `<scratch>/<name>.json`), trust window `win-1`, register the fixture's repository. */
export async function composerHost(fx: GitFixture, scratch: string, name: string, config: SliceComposerConfig, over: Parameters<typeof startHost>[1] = {}): Promise<ComposerHost> {
  const file = join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify(config));
  const h = await startHost(fx, { composerConfig: file, ...over });
  const ready = await h.ready;
  assert.equal(ready["degraded"], undefined);
  trustWindow(h.sup);
  // A restarted host keeps its projects (registering again is a conflict).
  const projectId = over.root === undefined ? await registerProject(h.sup, fx.repo) : "";
  return { sup: h.sup, client: await TestClient.open(h.sup), projectId };
}

export const startRun = async (client: TestClient, workspaceId: string, tag: string, over: Record<string, unknown> = {}): Promise<string> =>
  (await client.ok<{ run: ComposerRun }>("axis.runs", "start", { workspaceId, mode: "agent", prompt: `[s:${tag}] Do the task`, providerId: "mock", modelId: "mock-model", ...over }, true)).run.runId;

export const getRun = async (client: TestClient, runId: string): Promise<ComposerRun> => (await client.ok<{ run: ComposerRun }>("axis.runs", "get", { runId })).run;

/** Every event of the run so far, every page checked against the `axis.runs/1.events` contract. */
export async function eventsOf(client: TestClient, runId: string): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for (let after = 0; ; ) {
    const page = await client.ok<unknown>("axis.runs", "events", { runId, afterSeq: after, limit: 200 });
    const parsed = composerRunsMethods.events.response.parse(page);
    all.push(...parsed.events);
    if (parsed.events.length === 0 || parsed.complete) return all;
    after = parsed.nextSeq;
  }
}

export const approvalsOf = (events: RunEvent[]): Approval[] => events.filter((e): e is Approval => e.type === "approval");
export const toolsOf = (events: RunEvent[]): ToolEvent[] => events.filter((e): e is ToolEvent => e.type === "tool");

/** Wait until the run is no longer live (it ended, or a restart left it BLOCKED). */
export async function settled(client: TestClient, runId: string): Promise<ComposerRun> {
  let run: ComposerRun | undefined;
  await until(async () => !(run = await getRun(client, runId)).live, `run ${runId} to end`, 6_000);
  return run as ComposerRun;
}

/** The run's one pending challenge, once the run waits for it. */
export async function pendingOf(client: TestClient, runId: string): Promise<Challenge> {
  // The pending list, not the run-wide "awaiting" flag: an answered challenge leaves the list at once, while the flag may
  // still be set by it (or set again by the next call) when it is read.
  let challenges: Challenge[] = [];
  let run: ComposerRun | undefined;
  await until(async () => (challenges = (await client.ok<{ challenges: Challenge[] }>("axis.approvals", "pending", {})).challenges).length > 0 || !(run = await getRun(client, runId)).live, "the approval to be asked", 6_000);
  assert.equal(challenges.length, 1, `one challenge is pending (the run is ${run?.state ?? "live"} ${run?.reason ?? ""}): ${challenges.length === 0 ? JSON.stringify(await eventsOf(client, runId)) : ""}`);
  return challenges[0] as Challenge;
}

/**
 * Answer the run's pending challenge as the user: approve or deny in the window, and for tier 4 confirm in the native dialog (the
 * supervisor's `native.result`; `beforeNative` runs between the two). Returns the challenge and, for tier 4, the dialog line main was
 * asked to show.
 */
export async function answer(h: ComposerHost, runId: string, decision: "approve" | "deny" = "approve", beforeNative?: () => Promise<void>): Promise<{ challenge: Challenge; dialog: string | undefined }> {
  const challenge = await pendingOf(h.client, runId);
  if (decision === "deny" || !challenge.nativeConfirmationRequired) {
    await h.client.ok("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision, digest: challenge.digest });
    return { challenge, dialog: undefined };
  }
  await until(() => h.sup.nativeConfirms.some((c) => c.challengeId === challenge.challengeId), "native.confirm", 6_000);
  const resolved = await h.client.ok<{ nativeRequired: boolean }>("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision, digest: challenge.digest });
  assert.equal(resolved.nativeRequired, true);
  // The window's approval alone runs nothing at tier 4: the run still waits for the native dialog.
  assert.equal((await getRun(h.client, runId)).awaitingApproval, true, "a tier 4 call waits for the native confirmation");
  await beforeNative?.();
  // Wait for THIS challenge's own answer in the run's events (review c7 S3): the run-wide "awaiting" flag is set again by the
  // next call's challenge, and a count of recent audit rows can lose an old confirmation as the new one enters.
  h.sup.answerNative(challenge.challengeId, true);
  await until(async () => approvalsOf(await eventsOf(h.client, runId)).some((a) => a.digest === challenge.digest && a.state !== "requested"), "the native confirmation to be taken", 6_000);
  return { challenge, dialog: h.sup.nativeConfirms.find((c) => c.challengeId === challenge.challengeId)?.summary };
}

/** A spent, withdrawn or unknown challenge can never be answered again (the approval was consumed once). */
export async function assertSpent(client: TestClient, c: Challenge): Promise<void> {
  const again = await client.call("axis.approvals", "resolve", { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  assert.equal(again.ok, false, "a challenge answered once cannot be answered again");
}

/** The audit rows of one composer run's challenges, by phase, in order. */
export const challengePhases = (rows: readonly AuditRow[], runId: string): string[] =>
  rows.filter((r) => r.action.startsWith("tier") && r.actor === `agent:composer.${runId}`).map((r) => String((JSON.parse(r.payload) as { phase?: string }).phase));
