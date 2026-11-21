// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuditLog } from "@axis/audit";
import type { Challenge, RunEvent } from "@axis/protocol";
import type { MockReply } from "@axis/providers";
import { canary, createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { NODE_TOKEN, type SliceComposerConfig } from "../../testing/slice-composer.js";
import { auditRows, createWorkspace, databaseBytes, disposeHosts, openStopped, type AuditRow, type Workspace } from "../../testing/slice-helpers.js";
import { newKey, transcript } from "../../testing/test-client.js";
import { answer, approvalsOf, assertSpent, composerHost, eventsOf, getRun, pendingOf, settled, startRun, toolsOf, type ComposerHost } from "./composer-slice.js";

/**
 * Ticket C7, PRODUCT scenario 1 on the mock provider: the composed host in a CHILD PROCESS (`slice-host.ts`), driven over the wire
 * as the window would. Real: the composer service and loop, the agent binding and broker, the approvals gate with the supervisor's
 * native dialog, the WT-2 guard over real git, the journal (records, budgets, stored activity), the audit chain, review and commit.
 * The provider is the scripted mock (`slice-composer.ts`); scenario 6 on the Anthropic API is `composer-anthropic.test.ts`.
 */
const SUITE_TIMEOUT_MS = 300_000;
const write = (path: string, content: string): MockReply => ({ kind: "tool_use", name: "write_file", input: { path, content } });
const read = (path: string): MockReply => ({ kind: "tool_use", name: "read_file", input: { path } });
const command = (code: string): MockReply => ({ kind: "tool_use", name: "run_command", input: { argv: [NODE_TOKEN, "-e", code] } });
const SUMMARY = "Added the feature and the Makefile, and ran the build step.";

describe("composer slice (C7): scenario 1 on the mock provider, hostile output, cancel, budget, WT-2, kill and restart", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  let h: ComposerHost;
  let ws: Workspace;
  let config: SliceComposerConfig;
  const secret = canary(31);
  /** Model text that holds a credential-shaped string: shown live, stored redacted (the stored copy is display-safe, J2). */
  const spoken = canary(53);
  /** In a long file the model reads: once within the redactor's first 16,384 characters, once past them. */
  const inFile = canary(61);
  const longText = "An ordinary line of a long project file.\n".repeat(1000); // about 41 KB
  const runs: Record<string, string> = {};
  const answered: Challenge[] = [];

  before(() => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-c7-mock-"));
    const hook = join(fx.repo, ".git", "hooks", "post-checkout");
    config = {
      budget: { maxRequests: 8 },
      toolCaps: { inputBytesPerReply: 4 * 1024 },
      scripts: {
        s1: [read("README.txt"), write("feature.txt", "feature\n"), write("Makefile", "all:\n\techo build\n"), command("require('node:fs').writeFileSync('built.txt', 'built')"), { kind: "text", text: SUMMARY }],
        hostile: [
          { kind: "tool_use", name: "delete_everything", input: { path: "README.txt" } },
          write("../outside.txt", "escape"),
          write(".envrc", `export TOKEN=${secret}\n`),
          { kind: "text", text: "Stopped." },
        ],
        ransecret: [write("notes.txt", `key ${secret}\n`), { kind: "text", text: "never" }],
        malformed: [{ kind: "malformed" }],
        long: [read("long.txt"), command("process.stdout.write('one ordinary line of build output\\n'.repeat(1200))"), { kind: "text", text: "Read it and ran it." }],
        headsecret: [read("head-secret.txt")],
        tailsecret: [read("tail-secret.txt")],
        huge: [write("huge.txt", "x".repeat(6 * 1024))],
        cancel: [write(".envrc", "never\n")],
        budget: Array.from({ length: 12 }, () => read("README.txt")),
        wt2: [command(`require('node:fs').writeFileSync(${JSON.stringify(hook)}, '#!/bin/sh\\n')`), write("after-drift.txt", "never\n")],
        kill: [{ kind: "tool_use", name: "write_file", input: { path: ".envrc", content: "never\n" }, text: `I found ${spoken} in the logs.` }],
        after: [{ kind: "text", text: "Nothing to change." }],
      },
    };
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  const typesOf = (events: RunEvent[]): string[] => events.map((e) => (e.type === "state" ? `state:${e.state}` : e.type === "tool" ? `tool:${e.tool}:${e.outcome}` : e.type === "approval" ? `approval:${e.tool}:${e.state}` : e.type));

  test("1. start, approve at the right tier, run: read, write, a protected write, a command, the summary", async () => {
    h = await composerHost(fx, scratch, "mock", config);
    const listed = await h.client.ok<{ providers: Array<{ providerId: string; status: string; models: Array<{ modelId: string }> }> }>("axis.providers", "list", {});
    assert.deepEqual(listed.providers.map((p) => [p.providerId, p.status, p.models.map((m) => m.modelId)]), [["mock", "ready", ["mock-model"]]]);
    ws = await createWorkspace(h.client, h.projectId, "Composer slice");
    const runId = (runs["s1"] = await startRun(h.client, ws.id, "s1"));
    const makefile = await answer(h, runId);
    assert.deepEqual([makefile.challenge.tier, makefile.challenge.nativeConfirmationRequired, makefile.dialog], [3, false, undefined], "a protected write is tier 3 (question 3 is open): the window only");
    assert.equal(makefile.challenge.targetSummary, "Composer tool write_file (protected:makefile)");
    assert.equal(readFileSync(join(ws.path, "feature.txt"), "utf8"), "feature\n", "a write below the approval floor ran without a question");
    assert.equal(existsSync(join(ws.path, "built.txt")), false, "the command did not run before its approval");
    const cmd = await answer(h, runId, "approve", async () => assert.equal(existsSync(join(ws.path, "built.txt")), false, "approved in the window only: not run"));
    assert.deepEqual([cmd.challenge.tier, cmd.challenge.nativeConfirmationRequired], [4, true], "a command is tier 4: the window and the native dialog");
    assert.match(cmd.dialog ?? "", /^axis\.runs\/1\.toolCall: run_command \(privileged\), program node[^,]*, identity [0-9a-f]{16}$/);
    answered.push(makefile.challenge, cmd.challenge);
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason, run.mode, run.providerId, run.modelId, run.usage?.requests], ["REVIEWING", null, "agent", "mock", "mock-model", 5]);
    for (const c of answered) await assertSpent(h.client, c);
    assert.equal((await h.client.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length, 0);

    const events = await eventsOf(h.client, runId);
    assert.deepEqual(typesOf(events).filter((t) => t.startsWith("tool:") || t.startsWith("approval:") || t.startsWith("state:")), [
      "state:RUNNING",
      "tool:read_file:ok",
      "tool:write_file:ok",
      "approval:write_file:requested", "approval:write_file:approved", "tool:write_file:ok",
      "approval:run_command:requested", "approval:run_command:approved", "tool:run_command:ok",
      "state:REVIEWING",
    ]);
    const requested = approvalsOf(events).filter((a) => a.state === "requested");
    assert.deepEqual(requested.map((a) => a.digest), answered.map((c) => c.digest), "each card is bound to its challenge's digest");
    assert.deepEqual(requested.map((a) => [a.preview?.tier, a.preview?.protected]), [["write", true], ["privileged", false]], "the Makefile write is flagged protected (WT-3)");
    assert.ok(requested.every((a) => a.preview?.taint === undefined), "IAC-T (PV-M0): a run that received nothing from anyone but the user carries no taint");
    assert.equal(requested[0]?.preview?.content?.head, "all:\n\techo build\n", "the card shows what will be written");
    const reqs = events.filter((e): e is Extract<RunEvent, { type: "request" }> => e.type === "request");
    assert.deepEqual(reqs.map((r) => [r.request, r.providerId, r.modelId]), [1, 2, 3, 4, 5].map((n) => [n, "mock", "mock-model"]), "PRV-4: every request is shown, on the run's provider");
    assert.ok(events.some((e) => e.type === "text" && e.text === SUMMARY), "the final summary");
    assert.equal(readFileSync(join(ws.path, "feature.txt"), "utf8"), "feature\n");
    assert.equal(readFileSync(join(ws.path, "built.txt"), "utf8"), "built", "the approved command ran in the worktree");
  });

  test("2. review the diff (the protected path first) and commit on the workspace branch", async () => {
    const d = await h.client.ok<{ head: string; branch: string; treeHash: string; files: Array<{ displayPath: string; protectedPath: boolean }> }>("axis.review", "diff", { workspaceId: ws.id });
    assert.deepEqual(d.files.map((f) => [f.displayPath, f.protectedPath]), [["Makefile", true], ["built.txt", false], ["feature.txt", false]]);
    const commit = await h.client.ok<{ commit: string }>("axis.git", "commit", { workspaceId: ws.id, reviewedTreeHash: d.treeHash, expectedParent: d.head, expectedBranch: d.branch, message: "Add the feature" }, true);
    assert.equal(fx.git(ws.path, "rev-parse", "HEAD").trim(), commit.commit);
    assert.equal(fx.git(ws.path, "log", "-1", "--format=%s").trim(), "Add the feature");
    assert.equal(fx.git(ws.path, "status", "--porcelain").trim(), "", "everything reviewed was committed");
  });

  test("2b. long tool results: a 41 KB file read and 41 KB of command output reach the model; a secret in either part still stops it", async () => {
    writeFileSync(join(ws.path, "long.txt"), longText);
    const runId = (runs["long"] = await startRun(h.client, ws.id, "long"));
    const { challenge } = await answer(h, runId);
    const run = await settled(h.client, runId);
    await assertSpent(h.client, challenge);
    assert.deepEqual([run.state, run.reason, run.usage?.requests], ["REVIEWING", null, 3], "a long legitimate result is not a secret");
    assert.deepEqual(toolsOf(await eventsOf(h.client, runId)).map((t) => [t.tool, t.outcome]), [["read_file", "ok"], ["run_command", "ok"]]);
    for (const [tag, at] of [["headsecret", 1000], ["tailsecret", 30_000]] as const) {
      writeFileSync(join(ws.path, `${tag.replace("secret", "-secret")}.txt`), `${longText.slice(0, at)}key ${inFile}\n${longText.slice(at)}`);
      const id = (runs[tag] = await startRun(h.client, ws.id, tag));
      const r = await settled(h.client, id);
      assert.deepEqual([r.state, r.reason], ["FAILED", "PROVIDER_SECRET_IN_REQUEST"], `${tag}: the outgoing scan reads the whole result`);
    }
  });

  test("3. hostile output: an unknown tool, a path outside the worktree, a secret in a protected write, a malformed reply, a huge call", async () => {
    const runId = (runs["hostile"] = await startRun(h.client, ws.id, "hostile"));
    const run = await settled(h.client, runId);
    // The secret-bearing write is declined before any question (a protected write is never approved blind, review c2 S1). The
    // declined call's input is withheld from the next request (C7-F1), so the run goes on: the outgoing scan, which refuses any
    // request that holds the secret, let all four through.
    assert.deepEqual([run.state, run.reason, run.usage?.requests], ["REVIEWING", null, 4]);
    const events = await eventsOf(h.client, runId);
    assert.deepEqual(toolsOf(events).map((t) => [t.tool, t.outcome, t.reason]), [["delete_everything", "error", "unknown_tool"], ["write_file", "error", "dotdot"], ["write_file", "error", "approval_declined"]], "no hostile call ran");
    assert.deepEqual(approvalsOf(events), [], "nothing was put to the user");
    assert.equal(h.sup.nativeConfirms.length, 2, "no dialog beyond the earlier commands");
    assert.equal(existsSync(join(dirname(ws.path), "outside.txt")), false);
    assert.equal(existsSync(join(ws.path, ".envrc")), false);
    assert.ok(!JSON.stringify(events).includes(secret), "the secret is in no event");

    // A call that RAN carries its input into the next request: the scan still refuses that request and the run ends.
    const ran = (runs["ransecret"] = await startRun(h.client, ws.id, "ransecret"));
    const r = await settled(h.client, ran);
    assert.deepEqual([r.state, r.reason, r.usage?.requests], ["FAILED", "PROVIDER_SECRET_IN_REQUEST", 1]);
    const ranEvents = await eventsOf(h.client, ran);
    assert.deepEqual(toolsOf(ranEvents).map((t) => [t.tool, t.outcome]), [["write_file", "ok"]], "an unprotected write runs without a question");
    assert.ok(!JSON.stringify(ranEvents).includes(secret), "the secret is in no event");
    rmSync(join(ws.path, "notes.txt"));

    const malformed = (runs["malformed"] = await startRun(h.client, ws.id, "malformed"));
    const bad = await settled(h.client, malformed);
    assert.deepEqual([bad.state, bad.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"]);
    const huge = (runs["huge"] = await startRun(h.client, ws.id, "huge"));
    const big = await settled(h.client, huge);
    assert.deepEqual([big.state, big.reason], ["FAILED", "TOOL_INPUT_LIMIT"]);
    assert.deepEqual(toolsOf(await eventsOf(h.client, huge)), [], "a reply over the cap runs none of its calls");
    assert.equal(existsSync(join(ws.path, "huge.txt")), false);
  });

  test("4. cancel while the approval is pending: CANCELLED, the challenge withdrawn and spent, nothing written", async () => {
    const runId = (runs["cancel"] = await startRun(h.client, ws.id, "cancel"));
    const c = await pendingOf(h.client, runId);
    const cancelled = await h.client.ok<{ run: { state: string } }>("axis.runs", "cancel", { runId }, newKey());
    assert.ok(["RUNNING", "CANCELLED"].includes(cancelled.run.state));
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason], ["CANCELLED", "USER_CANCELLED"]);
    await assertSpent(h.client, c);
    assert.equal((await h.client.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length, 0);
    assert.deepEqual(approvalsOf(await eventsOf(h.client, runId)).map((a) => a.state), ["requested", "withdrawn"]);
    assert.equal(existsSync(join(ws.path, ".envrc")), false);
  });

  test("5. budget exhaustion: the run's request budget ends it, nothing goes out past it", async () => {
    const runId = (runs["budget"] = await startRun(h.client, ws.id, "budget"));
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason], ["FAILED", "BUDGET_REQUESTS"]);
    const events = await eventsOf(h.client, runId);
    assert.equal(events.filter((e) => e.type === "request").length, 8, "exactly the budget's requests were sent");
    assert.equal(toolsOf(events).length, 8);
  });

  test("6. WT-2: a command that plants a hook in the common git dir halts the run before the next turn", async () => {
    const hook = join(fx.repo, ".git", "hooks", "post-checkout");
    const runId = (runs["wt2"] = await startRun(h.client, ws.id, "wt2"));
    const { challenge } = await answer(h, runId);
    const run = await settled(h.client, runId);
    assert.deepEqual([run.state, run.reason], ["FAILED", "GIT_DRIFT"]);
    assert.ok(existsSync(hook), "the command did run (the planted hook is there)");
    rmSync(hook);
    await assertSpent(h.client, challenge);
    assert.equal(existsSync(join(ws.path, "after-drift.txt")), false, "no turn ran after the drift");
    assert.equal((await eventsOf(h.client, runId)).filter((e) => e.type === "request").length, 1, "no request after the drift");
  });

  let killedEvents: RunEvent[] = [];
  test("7. kill and restart: the full run state is recovered from the journal, the old challenge is dead, the workspace works", async () => {
    const runId = (runs["kill"] = await startRun(h.client, ws.id, "kill"));
    const pendingBefore = await pendingOf(h.client, runId);
    killedEvents = await eventsOf(h.client, runId);
    const s1Before = await eventsOf(h.client, runs["s1"] as string);
    const restart = { root: dirname(h.sup.dataDir), key: h.sup.key };
    h.client.close();
    h.sup.kill("SIGKILL");
    await h.sup.exited;
    const anchor = h.sup.anchor;
    h = await composerHost(fx, scratch, "mock", config, { ...restart, ...(anchor === null ? {} : { anchor }) });
    const killed = await getRun(h.client, runId);
    assert.deepEqual([killed.state, killed.reason, killed.live, killed.awaitingApproval, killed.mode, killed.modelId], ["BLOCKED", "INTERRUPTED_BY_RESTART", false, false, "agent", "mock-model"]);
    const after = await eventsOf(h.client, runId);
    const said = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("");
    assert.ok(said(killedEvents).includes(spoken), "the live view shows the model's text as it came");
    assert.ok(!said(after).includes(spoken) && said(after).startsWith("I found "), "the stored copy read back after the restart is redacted");
    const shown = (events: RunEvent[]) => events.filter((e) => e.type !== "text");
    assert.deepEqual(shown(after).slice(0, shown(killedEvents).length), shown(killedEvents), "the stored activity is the activity shown before the kill");
    assert.deepEqual(await eventsOf(h.client, runs["s1"] as string), s1Before, "a finished run reads back whole, summary included");
    const s1 = await getRun(h.client, runs["s1"] as string);
    assert.deepEqual([s1.state, s1.usage?.requests], ["REVIEWING", 5]);
    await assertSpent(h.client, pendingBefore);
    assert.equal((await h.client.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length, 0);
    assert.equal(existsSync(join(ws.path, ".envrc")), false, "the unapproved write never happened");
    const next = await startRun(h.client, ws.id, "after");
    assert.equal((await settled(h.client, next)).state, "REVIEWING", "the workspace serves a new run after the restart");
    runs["after"] = next;
  });

  test("8. stop: the chain verifies, the journal holds the records and budgets, no secret anywhere", async () => {
    h.client.close();
    if (process.platform === "win32") h.sup.shutdown();
    else h.sup.kill("SIGTERM");
    assert.equal((await h.sup.exited).code, 0);
    const db = openStopped(h.sup.dataDir, join(scratch, "stopped"));
    try {
      assert.equal(new AuditLog(db).verify({ expectedHead: h.sup.anchor as { seq: number; hash: string } }).ok, true);
      const records = db.prepare("SELECT run_id, mode, provider_id, model_id FROM composer_runs").all() as Array<Record<string, string>>;
      assert.deepEqual(new Set(records.map((r) => r["run_id"])), new Set(Object.values(runs)));
      assert.ok(records.every((r) => r["mode"] === "agent" && r["provider_id"] === "mock" && r["model_id"] === "mock-model"));
      const budget = db.prepare("SELECT requests FROM composer_workspace_budgets WHERE workspace_id = ?").get(ws.id) as { requests: number };
      const perRun = db.prepare("SELECT SUM(budget_requests) AS n FROM composer_runs").get() as { n: number };
      // Every request of every run, the killed run's in-flight reservation included, is charged to the workspace (C10, J2).
      assert.equal(budget.requests, perRun.n, "the workspace total is the sum of its runs");
      assert.equal(budget.requests, 29, "s1 5, long 3, head and tail secret 1 each, hostile 4, ran secret 1, malformed 1, huge 1, cancel 1, budget 8, wt2 1, kill 1 (in flight at the kill), after 1");
      // DMN-3: each approval was authorised exactly once, and every later answer to it was refused (consumed once).
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM composer_runs WHERE tainted <> 0").get() as { n: number }).n, 0, "no run was tainted (no taint source exists on main yet)");
      const rows = auditRows(db);
      assert.equal(rows.filter((r) => r.action === "message.taint").length, 0);
      const phase = (r: AuditRow) => JSON.parse(r.payload) as { phase?: string; ref?: string };
      const authorised = rows.filter((r) => r.action === "tier4.execute" && phase(r).phase === "authorised").map((r) => phase(r).ref);
      assert.equal(authorised.length, 4, "the Makefile write and the three commands");
      assert.equal(new Set(authorised).size, 4, "no approval was authorised twice");
      for (const ref of authorised) {
        const at = rows.findIndex((r) => r.action === "tier4.execute" && phase(r).ref === ref);
        const later = rows.slice(at + 1).filter((r) => r.action === "tier4.challenge" && phase(r).ref === ref && phase(r).phase === "resolve");
        assert.ok(later.length > 0 && later.every((r) => r.outcome === "denied"), "a second answer was refused");
        const issued = rows.find((r) => r.action === "tier4.challenge" && phase(r).ref === ref && phase(r).phase === "issued");
        const native = rows.findIndex((r) => r.action === "tier4.challenge" && phase(r).ref === ref && phase(r).phase === "native");
        if ((JSON.parse(issued?.payload ?? "{}") as { tier?: number }).tier === 4) assert.ok(native >= 0 && native < at, "a tier 4 call was authorised only after the native confirmation");
        else assert.equal(native, -1, "a tier 3 call has no native step");
      }
      const bytes = databaseBytes(join(scratch, "stopped"));
      for (const needle of [secret, spoken, inFile]) assert.equal(bytes.includes(needle), false, "a secret is in the database");
    } finally {
      db.close();
    }
    for (const t of [h.sup.stderr, ...transcript]) for (const needle of [secret, inFile]) assert.equal(t.includes(needle), false, "the secret reached a response or the log");
  });
});
