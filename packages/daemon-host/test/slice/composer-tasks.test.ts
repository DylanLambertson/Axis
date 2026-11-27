// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { approvalRequiredDetailsSchema } from "@axis/protocol";
import type { MockReply } from "@axis/providers";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { PAGE_TOKEN, TASK_TOKEN, type SliceComposerConfig } from "../../testing/slice-composer.js";
import { confirmNative, createWorkspace, disposeHosts, type Workspace } from "../../testing/slice-helpers.js";
import { newKey, until } from "../../testing/test-client.js";
import { answer, approvalsOf, composerHost, eventsOf, pendingOf, settled, toolsOf, type ComposerHost } from "./composer-slice.js";

/**
 * PV-T1 through the COMPOSED host in a child process (`slice-host.ts`), on the mock provider, driven over the wire as the window
 * would. It proves the composition's wiring that the unit rigs build for themselves:
 * - A1: a worker's composer run gets the task tools and the page tools (`compose.ts`, the binding's `tasks` and `pages`), and
 *   an `update_task` over the user's revision asks the user at tier network (PV-T1 slice 3);
 * - A2: a confirmed Start of an untrusted task goes through the real `startWorkerComposer` and the project gate: the run is
 *   tainted before its first model call (its first write asks, the card lists `task_start`), and the task links the run and
 *   is `in_progress`.
 * Mutants: dropping the binding's `tasks` or `pages` wiring (the tools become unknown), the raise (the update is not asked),
 * the Start's taint receipt (the write runs unasked), and the Start's link and status.
 */
const SUITE_TIMEOUT_MS = 300_000;
const tool = (name: string, input: Record<string, string | number>): MockReply => ({ kind: "tool_use", name, input });

describe("composer slice: the task chain through the composed host (PV-T1)", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  let h: ComposerHost;
  let ws: Workspace;
  let worker: string;
  let taskId: string;
  const config: SliceComposerConfig = {
    scripts: {
      edit: [
        tool("list_tasks", {}),
        tool("update_task", { taskId: TASK_TOKEN, baseSeq: 1, title: "Fix it", body: "[s:started] the worker's text" }),
        tool("read_page", { pageId: PAGE_TOKEN }),
        { kind: "text", text: "Revised." },
      ],
      started: [tool("write_file", { path: "from-task.txt", content: "x\n" }), { kind: "text", text: "Stopped." }],
    },
  };

  before(() => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-tasks-"));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("A1. a worker's run has the task and page tools; update_task over the user's revision asks at tier network", async () => {
    h = await composerHost(fx, scratch, "tasks", config);
    ws = await createWorkspace(h.client, h.projectId, "Tasks slice");
    worker = (await h.client.ok<{ agent: { id: string } }>("axis.agents", "create", {
      projectId: h.projectId, name: "Planner", launch: { kind: "composer", connection: "mock-connection", modelId: "mock-model", mode: "agent" }, home: { existing: ws.id },
    }, true)).agent.id;
    taskId = (await h.client.ok<{ task: { taskId: string } }>("axis.tasks", "create", { projectId: h.projectId, title: "Fix it", body: "the user's text" }, true)).task.taskId;
    const pageId = (await h.client.ok<{ version: { meta: { pageId: string } } }>("axis.pages", "create", { projectId: h.projectId, title: "Notes", body: "the user's notes" }, true)).version.meta.pageId;
    assert.match(pageId, /^p[0-9a-f]{32}$/);
    const runId = (await h.client.ok<{ runId: string }>("axis.agents", "start", { agentId: worker, input: { prompt: `[s:edit] Revise task ${taskId}; see page ${pageId}.` } }, true)).runId;
    const { challenge } = await answer(h, runId);
    assert.deepEqual([challenge.tier, challenge.nativeConfirmationRequired], [3, false], "the raise: tier network asks in the window only");
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason], ["REVIEWING", null]);
    const events = await eventsOf(h.client, runId);
    assert.deepEqual(toolsOf(events).map((t) => [t.tool, t.outcome]), [["list_tasks", "ok"], ["update_task", "ok"], ["read_page", "ok"]], `the task and page tools are wired (not unknown_tool): ${JSON.stringify(toolsOf(events))}`);
    const card = approvalsOf(events).find((a) => a.state === "requested");
    assert.deepEqual([card?.tool, card?.preview?.tier, card?.preview?.taint], ["update_task", "network", undefined], "asked because the base is the user's, not because of taint");
    const got = await h.client.ok<{ task: { lastSeq: number; untrusted: boolean }; revision: { meta: { author: { kind: string } } } }>("axis.tasks", "get", { taskId });
    assert.deepEqual([got.task.lastSeq, got.task.untrusted, got.revision.meta.author.kind], [2, true, "agent"]);
  });

  test("A2. a confirmed Start of the untrusted task: the run is tainted before its first call, linked to the task, and the task is in_progress", async () => {
    const preview = await h.client.ok<{ seq: number; promptDigest: string; untrusted: boolean; prompt: string }>("axis.tasks", "startPreview", { taskId, worker });
    assert.deepEqual([preview.seq, preview.untrusted, preview.prompt.includes("[s:started]")], [2, true, true]);
    const request = { taskId, worker, seq: preview.seq, promptDigest: preview.promptDigest };
    const key = newKey();
    const asked = await h.client.call("axis.tasks", "start", request, key);
    const { challenge } = approvalRequiredDetailsSchema.parse(asked.error?.details);
    assert.deepEqual([challenge.tier, challenge.nativeConfirmationRequired], [4, true]);
    await until(() => h.sup.nativeConfirms.some((c) => c.challengeId === challenge.challengeId), "native.confirm");
    await h.client.ok("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
    await confirmNative(h.sup, h.client, challenge.challengeId);
    const started = await h.client.call("axis.tasks", "start", { ...request, approval: { challengeId: challenge.challengeId } }, key);
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const runId = (started.result as { kind: string; runId: string }).runId;
    assert.equal((started.result as { kind: string }).kind, "composer");

    const write = await pendingOf(h.client, runId);
    assert.equal(write.tier, 3, "a plain write asks: the run is tainted (an untainted run writes without asking)");
    const card = approvalsOf(await eventsOf(h.client, runId)).find((a) => a.state === "requested");
    assert.deepEqual(card?.preview?.taint?.sources.map((s) => [s.source, s.sender]), [["task_start", worker]], "the receipt names the Start and the worker that wrote the text");
    await answer(h, runId, "deny");
    await settled(h.client, runId);
    assert.equal(existsSync(join(ws.path, "from-task.txt")), false);

    const got = await h.client.ok<{ task: { status: string; links: Array<{ kind: string; target: string }> } }>("axis.tasks", "get", { taskId });
    assert.deepEqual([got.task.status, got.task.links], ["in_progress", [{ kind: "run", target: runId }]]);
  });
});
