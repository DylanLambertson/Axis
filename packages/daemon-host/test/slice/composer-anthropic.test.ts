// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuditLog } from "@axis/audit";
import type { RunEvent } from "@axis/protocol";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import type { SliceComposerConfig } from "../../testing/slice-composer.js";
import { auditRows, createWorkspace, databaseBytes, disposeHosts, openStopped, type Workspace } from "../../testing/slice-helpers.js";
import { transcript } from "../../testing/test-client.js";
import { MODEL, mockAnthropic, sse, testKey, type MessagesReply, type MockAnthropic } from "../anthropic-server.js";
import { answer, approvalsOf, assertSpent, composerHost, eventsOf, getRun, pendingOf, settled, startRun, toolsOf, type ComposerHost } from "./composer-slice.js";

/**
 * Ticket C7, PRODUCT scenario 6 on the Anthropic connection (C6) in the CHILD-PROCESS host: the provider is listed with its stored
 * credential, a model is selected (the start's own models request), the change is asked for, approved or rejected, reviewed and
 * committed. The API is a loopback mock in this process (`anthropic-server.ts`); the host's `fetch` reaches only it, under the fixed
 * origin, so no request leaves the machine and no real key exists. Connecting a key over the wire is not built (C6 follow-up): the
 * fake vault holds it from the start.
 */
const SUITE_TIMEOUT_MS = 300_000;
const CONN = "anthropic-main";
const tool = (name: string, input: unknown): MessagesReply => ({ kind: "tool", name, input });
const text = (t: string): MessagesReply => ({ kind: "text", text: t });

/** A tool call whose streamed JSON never closes: the adapter must refuse it, not guess. */
function brokenToolStream(): string {
  return [
    sse("message_start", { type: "message_start", message: { id: "msg_c7", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 30, output_tokens: 1 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c7_1", name: "write_file", input: {} } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "broken.txt", "content": "x' } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

describe("composer slice (C7): scenario 6 on the Anthropic connection in the child-process host", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  let api: MockAnthropic;
  let h: ComposerHost;
  let ws: Workspace;
  let config: SliceComposerConfig;
  const key = testKey(7);
  const runs: string[] = [];
  const start = async (replies: MessagesReply[], prompt = "Make the change"): Promise<string> => {
    api.replies = replies;
    const runId = await startRun(h.client, ws.id, "none", { providerId: "anthropic", modelId: MODEL, prompt });
    runs.push(runId);
    return runId;
  };
  const requests = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: "request" }> => e.type === "request");

  before(async () => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-c7-ant-"));
    api = await mockAnthropic();
    config = { toolCaps: { inputBytesPerReply: 4 * 1024 }, anthropic: { connectionId: CONN, port: api.port, key } };
  });
  after(async () => {
    await disposeHosts();
    await api.close();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("1. connect, select the model, ask for a change, approve it, review and apply it", async () => {
    h = await composerHost(fx, scratch, "anthropic", config);
    type Listed = { providers: Array<{ providerId: string; connectionId: string; status: string; models: Array<{ modelId: string }>; credential?: { state: string; backend?: string } }> };
    const before = (await h.client.ok<Listed>("axis.providers", "list", {})).providers.find((p) => p.providerId === "anthropic");
    assert.deepEqual([before?.connectionId, before?.status, before?.credential?.state, before?.credential?.backend], [CONN, "unchecked", "stored", "gnome_libsecret"], "PRV-1: the stored credential is shown, never asked of the network by a list");
    assert.equal(api.seen.length, 0, "listing sent nothing");
    ws = await createWorkspace(h.client, h.projectId, "Anthropic slice");
    const runId = await start([tool("write_file", { path: "Makefile", content: "all:\n\ttrue\n" }), text("Added a Makefile.")]);
    const c = await answer(h, runId);
    assert.deepEqual([c.challenge.tier, c.challenge.nativeConfirmationRequired], [3, false]);
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason, run.providerId, run.modelId], ["REVIEWING", null, "anthropic", MODEL]);
    await assertSpent(h.client, c.challenge);
    const listed = (await h.client.ok<Listed>("axis.providers", "list", {})).providers.find((p) => p.providerId === "anthropic");
    assert.deepEqual([listed?.status, listed?.models.map((m) => m.modelId)], ["ready", [MODEL]], "the start's own models request recorded the list");
    const events = await eventsOf(h.client, runId);
    assert.deepEqual(requests(events).map((r) => [r.providerId, r.connectionId, r.modelId, r.destination]), [1, 2].map(() => ["anthropic", CONN, MODEL, "https://api.anthropic.com"]), "PRV-4: each request names where it went");
    assert.equal(approvalsOf(events)[0]?.preview?.protected, true);
    assert.ok(events.some((e) => e.type === "text" && e.text === "Added a Makefile."));
    const d = await h.client.ok<{ head: string; branch: string; treeHash: string; files: Array<{ displayPath: string; protectedPath: boolean }> }>("axis.review", "diff", { workspaceId: ws.id });
    assert.deepEqual(d.files.map((f) => [f.displayPath, f.protectedPath]), [["Makefile", true]]);
    await h.client.ok("axis.git", "commit", { workspaceId: ws.id, reviewedTreeHash: d.treeHash, expectedParent: d.head, expectedBranch: d.branch, message: "Add a Makefile" }, true);
    assert.equal(fx.git(ws.path, "show", "HEAD:Makefile"), "all:\n\ttrue\n", "applied: the reviewed change is committed");
  });

  test("2. reject: a denied write is never made and the model is told so; the run ends for review with nothing to apply", async () => {
    const runId = await start([tool("write_file", { path: ".envrc", content: "export A=1\n" }), text("Understood.")]);
    const c = await answer(h, runId, "deny");
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason], ["REVIEWING", null]);
    await assertSpent(h.client, c.challenge);
    const events = await eventsOf(h.client, runId);
    assert.deepEqual(approvalsOf(events).map((a) => a.state), ["requested", "denied"]);
    assert.deepEqual(toolsOf(events).map((t) => [t.tool, t.outcome, t.reason]), [["write_file", "error", "approval_declined"]]);
    assert.equal(existsSync(join(ws.path, ".envrc")), false);
    const last = JSON.parse(api.seen.filter((s) => s.path === "/v1/messages").at(-1)?.body ?? "{}") as { messages: Array<{ content: unknown }> };
    assert.match(JSON.stringify(last.messages.at(-1)?.content), /tool_result/, "the model got the refusal as the call's result");
  });

  test("3. hostile replies: an unknown tool, malformed tool JSON, the key echoed in a call, a call over the input cap", async () => {
    const unknown = await start([tool("format_disk", { all: true }), text("ok")]);
    assert.deepEqual([(await settled(h.client, unknown)).state], ["REVIEWING"]);
    assert.deepEqual(toolsOf(await eventsOf(h.client, unknown)).map((t) => [t.tool, t.outcome, t.reason]), [["format_disk", "error", "unknown_tool"]]);

    const broken = await start([{ kind: "raw", body: brokenToolStream() }]);
    const b = await settled(h.client, broken);
    assert.deepEqual([b.state, b.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"]);
    assert.deepEqual(toolsOf(await eventsOf(h.client, broken)), [], "a call that could not be parsed is never run");
    assert.equal(existsSync(join(ws.path, "broken.txt")), false);

    const echo = await start([tool("write_file", { path: "notes.txt", content: `remember ${key}` }), text("never")]);
    const e = await settled(h.client, echo);
    assert.deepEqual([e.state, e.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"], "credential_echo: nothing of that answer is shown or executed");
    assert.deepEqual(toolsOf(await eventsOf(h.client, echo)), []);
    assert.equal(existsSync(join(ws.path, "notes.txt")), false);

    const huge = await start([tool("write_file", { path: "huge.txt", content: "y".repeat(6 * 1024) })]);
    const g = await settled(h.client, huge);
    assert.deepEqual([g.state, g.reason], ["FAILED", "TOOL_INPUT_LIMIT"]);
    assert.equal(existsSync(join(ws.path, "huge.txt")), false);
  });

  test("4. kill while an approval waits, restart: BLOCKED with its stored activity, the challenge dead, nothing written", async () => {
    const runId = await start([tool("write_file", { path: ".envrc", content: "export B=2\n" })]);
    const pending = await pendingOf(h.client, runId);
    const before = await eventsOf(h.client, runId);
    h.client.close();
    h.sup.kill("SIGKILL");
    await h.sup.exited;
    const anchor = h.sup.anchor;
    h = await composerHost(fx, scratch, "anthropic", config, { root: dirname(h.sup.dataDir), key: h.sup.key, ...(anchor === null ? {} : { anchor }) });
    const run = await getRun(h.client, runId);
    assert.deepEqual([run.state, run.reason, run.live, run.providerId, run.modelId], ["BLOCKED", "INTERRUPTED_BY_RESTART", false, "anthropic", MODEL]);
    assert.deepEqual((await eventsOf(h.client, runId)).slice(0, before.length), before, "the activity shown before the kill reads back from the journal");
    await assertSpent(h.client, pending);
    assert.equal(existsSync(join(ws.path, ".envrc")), false);
  });

  test("5. stop: the key is nowhere the host keeps or shows anything; every request went to the fixed origin with the vault's key", async () => {
    h.client.close();
    if (process.platform === "win32") h.sup.shutdown();
    else h.sup.kill("SIGTERM");
    assert.equal((await h.sup.exited).code, 0);
    assert.ok(api.seen.length > 0);
    for (const s of api.seen) {
      assert.ok(["/v1/models", `/v1/models/${MODEL}`, "/v1/messages"].includes(s.path), s.path);
      assert.equal(s.key, key, "the key went only in its header, read from the vault");
    }
    const fetched = [...h.sup.stderr.matchAll(/slice\.fetch (\S+)/g)].map((m) => m[1]);
    assert.ok(fetched.every((p) => p !== undefined && p.startsWith("/v1/")), "the host asked for nothing else");
    const db = openStopped(h.sup.dataDir, join(scratch, "stopped"));
    try {
      assert.equal(new AuditLog(db).verify({ expectedHead: h.sup.anchor as { seq: number; hash: string } }).ok, true);
      const reads = auditRows(db).filter((r) => r.action === "provider.credential");
      assert.ok(reads.length > 0 && reads.every((r) => r.target === `connection:${CONN}` && r.outcome === "success"), "DMN-5: every key read is audited");
      const records = db.prepare("SELECT run_id FROM composer_runs WHERE provider_id = 'anthropic' AND model_id = ?").all(MODEL) as Array<{ run_id: string }>;
      assert.deepEqual(new Set(records.map((r) => r.run_id)), new Set(runs));
      const bytes = databaseBytes(join(scratch, "stopped"));
      for (const needle of [key, key.slice(8), Buffer.from(key).toString("base64")]) assert.equal(bytes.includes(needle), false, "a form of the key is in the database");
    } finally {
      db.close();
    }
    for (const t of [h.sup.stderr, ...transcript]) assert.equal(t.includes(key), false, "the key reached a response or the host's log");
    assert.equal(readFileSync(join(ws.path, "Makefile"), "utf8"), "all:\n\ttrue\n");
  });
});
