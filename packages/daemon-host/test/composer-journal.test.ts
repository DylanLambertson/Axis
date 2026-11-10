// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AuditLog, Redactor, acquireInstanceLock, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { composerRunsMethods, type RunEvent } from "@axis/protocol";
import type { MockReply, RunBudgetLimits } from "@axis/providers";
import { AGENT_PAYLOAD_ALLOWLIST, createComposerService, fromActivityRecords, toActivityRecord, type ComposerService } from "../src/index.js";
import { composerRig, START, until, type ComposerRig } from "./composer-rig.js";

/**
 * Tickets J2 and C10 through the real service, broker, guarded mock and a journal in a database FILE: the process is
 * "killed" (the service is disposed, so it writes nothing more) and "restarted" (a new handle on the same file, the
 * journal's own recovery under the instance lock, a new service with nothing in memory).
 */

const say = (text: string): MockReply => ({ kind: "text", text });
// A fake credential in the env-secret shape the host redactor removes (low entropy, not a real secret).
const LEAK = "db_password=hunter2hunter2";

async function setup(t: TestContext, replies: MockReply[], over: { budget?: RunBudgetLimits; workspaceBudget?: RunBudgetLimits } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "axis-composer-j2-"));
  const c = await composerRig({ replies, dbPath: join(dir, "axis.db"), ...over });
  const opened: Array<{ close(): void }> = [];
  t.after(async () => {
    await c.cleanup();
    for (const x of opened) x.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Kill the current process's service, then start a new "process" on the same file. */
  const restart = async (current: ComposerService): Promise<{ service: ComposerService; journal: Journal }> => {
    current.dispose();
    await current.idle();
    const db = openDatabase(join(dir, "axis.db"));
    const journal = Journal.open(db, { audit: new AuditLog(db, { payloadAllowlist: AGENT_PAYLOAD_ALLOWLIST }) });
    const lock = acquireInstanceLock(dir);
    journal.recover(lock);
    lock.release();
    const service = createComposerService({
      journal, engine: c.agent, now: () => c.r.clock.now(), redactor: new Redactor(),
      ...(over.budget === undefined ? {} : { budget: over.budget }),
      ...(over.workspaceBudget === undefined ? {} : { workspaceBudget: over.workspaceBudget }),
    });
    service.recover();
    opened.push({ close: () => (service.dispose(), db.close()) });
    return { service, journal };
  };
  return { c, restart };
}

const done = (s: ComposerService, runId: string) => () => !s.get(runId).live;
async function runToEnd(c: ComposerRig, s: ComposerService, mode = "ask") {
  const { run } = await s.start(START(c.workspaceId, { mode }), new AbortController().signal);
  await until(done(s, run.runId));
  return s.get(run.runId);
}
const shape = (events: readonly RunEvent[]) => events.map(({ at: _at, ...e }) => e);

test("kill and restart: get and events answer from the journal, with secrets redacted and the request destinations kept", async (t) => {
  const { c, restart } = await setup(t, [say(`here it is: ${LEAK} and more`)]);
  const before = await runToEnd(c, c.service);
  assert.equal(before.state, "REVIEWING");
  const live = c.service.events(before.runId, 0, 200);
  assert.ok(live.events.some((e) => e.type === "text" && e.text.includes("hunter2")), "the live view is the model's text");

  const { service } = await restart(c.service);
  const after = service.get(before.runId);
  assert.deepEqual({ ...after }, { ...before }, "mode, provider, model, usage and the record are what they were");
  assert.notEqual(after.usage, null);
  const stored = service.events(before.runId, 0, 200);
  assert.ok(composerRunsMethods.events.response.safeParse(stored).success);
  assert.deepEqual([stored.available, stored.complete, stored.nextSeq], [true, true, live.nextSeq]);
  assert.equal(JSON.stringify(stored).includes("hunter2"), false, "no secret reached the journal");
  const redact = (e: RunEvent) => (e.type === "text" ? { ...e, text: new Redactor().redactString(e.text) } : e);
  assert.deepEqual(shape(stored.events), shape(live.events.map(redact)), "every event, in order, only the text redacted");
  assert.ok(stored.events.some((e) => e.type === "request" && e.destination.length > 0));
  // The cursor works across the restart.
  const tail = service.events(before.runId, 2, 2);
  assert.deepEqual(tail.events.map((e) => e.seq), [3, 4]);
  assert.equal(tail.complete, false);
});

test("C10: the workspace budget is seeded from the journal, so a restart cannot reset it; the run budget is asked first", async (t) => {
  const { c, restart } = await setup(t, [say("one"), say("two"), say("three")], { workspaceBudget: { maxRequests: 2 } });
  assert.equal((await runToEnd(c, c.service)).state, "REVIEWING");
  let next = await restart(c.service);
  assert.deepEqual(next.journal.composer.workspaceBudget(c.workspaceId).requests, 1);
  assert.equal((await runToEnd(c, next.service)).state, "REVIEWING");
  next = await restart(next.service);
  const wire = c.wire();
  const third = await runToEnd(c, next.service);
  assert.deepEqual([third.state, third.reason], ["FAILED", "BUDGET_WORKSPACE_REQUESTS"]);
  assert.equal(c.wire(), wire, "refused before the request was sent");
  assert.equal(next.journal.composer.workspaceBudget(c.workspaceId).requests, 2);
});

test("C10 order: a run budget that refuses ends the run on the run's reason, before the workspace is asked", async (t) => {
  const { c } = await setup(t, [say("one")], { budget: { maxRequests: 0 }, workspaceBudget: { maxRequests: 0 } });
  const run = await runToEnd(c, c.service);
  assert.deepEqual([run.state, run.reason], ["FAILED", "BUDGET_REQUESTS"]);
  assert.equal(c.wire(), 0);
  assert.equal(c.journal.composer.workspaceBudget(c.workspaceId).requests, 0, "a refused request charges nothing");
});

test("a request in flight when the process dies stays charged: the journal holds its reservation", async (t) => {
  const { c, restart } = await setup(t, [{ kind: "hang" }], { workspaceBudget: { maxTokens: 1_000_000 } });
  const { run } = await c.service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(() => c.wire() === 1);
  const charged = c.journal.composer.workspaceBudget(c.workspaceId);
  assert.ok(charged.tokens > 4096, "the reservation (input estimate plus output cap) is written before the request goes out");
  assert.deepEqual(c.journal.composer.get(run.runId)?.budget.tokens, charged.tokens);
  const { journal, service } = await restart(c.service);
  assert.equal(journal.getRun(run.runId)?.state, "BLOCKED");
  assert.deepEqual(journal.composer.workspaceBudget(c.workspaceId), charged, "nothing was released after the shutdown");
  assert.equal(service.get(run.runId).mode, "ask");
});

test("stored rows: every string is redacted (registered secrets too), an event that is no longer valid is not stored, a bad row is never read back", () => {
  const redactor = new Redactor();
  redactor.registerSecret("plain-registered-value");
  const at = "2026-11-10T00:00:00.000Z";
  const text: RunEvent = { type: "text", text: "the value plain-registered-value is here", seq: 1, at };
  const row = toActivityRecord(text, redactor);
  assert.ok(row !== undefined && !row.body.includes("plain-registered-value") && !row.body.includes("\"seq\""));
  const back = fromActivityRecords([row]);
  assert.equal(back.length, 1);
  assert.ok(back[0]?.type === "text" && back[0].text.includes("[REDACTED") && back[0].seq === 1);
  // A redaction that breaks the event's rules (a closed reason turned into a placeholder) stores nothing.
  const hostile = new Redactor();
  hostile.registerSecret("write_file");
  assert.equal(toActivityRecord({ type: "tool", tool: "write_file", outcome: "ok", reason: null, seq: 2, at }, hostile), undefined);
  const rows = [
    { seq: 3, at, type: "text" as const, body: "not json" },
    { seq: 4, at, type: "text" as const, body: JSON.stringify({ type: "tool", tool: "x", outcome: "ok", reason: null }) },
    { seq: 5, at, type: "text" as const, body: JSON.stringify({ type: "text", text: "\u0007bell" }) },
    { seq: 6, at, type: "text" as const, body: JSON.stringify({ type: "text", text: "fine", extra: 1 }) },
    { seq: 7, at, type: "text" as const, body: "[]" },
  ];
  assert.deepEqual(fromActivityRecords(rows), []);
  assert.throws(() => createComposerService({ journal: {} as never, engine: {} as never, now: () => 0, storedActivity: { maxRunRows: 0, maxRunBytes: 1, maxRows: 1, maxBytes: 1 } }), /activity bounds/);
});
