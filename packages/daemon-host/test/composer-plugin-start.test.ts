// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1e-a (ADR 0008 decision 6, rules 1 and 2): a run a plugin starts is recorded as the plugin's and is tainted inside its
// own creation, before its activity opens and before any model call. The runs handler still refuses plugins (K1e-b opens it).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HandlerContext, Identity } from "@axis/daemon";
import { createRunTaint } from "../src/composer/taint.js";
import { createComposerRunsHandlers } from "../src/handlers/composer-runs.js";
import { composerRig, START, until, type ComposerRig, type ComposerRigOptions } from "./composer-rig.js";

type Row = Record<string, unknown>;
const PLUGIN = { kind: "plugin", pluginId: "acme.board", generation: 2 } as const;
/** The grant re-check a plugin start must carry (PV-K1e-b): here always holding. */
const OK = (): boolean => true;

async function setup(t: TestContext, over: Partial<ComposerRigOptions> = {}, seen?: { at: Array<{ wire: number; activity: number; runId: string }> }): Promise<ComposerRig> {
  let rig: ComposerRig | undefined;
  const c = await composerRig({
    replies: [{ kind: "text", text: "ok" }],
    taintAtStart: (runId, receipt) => {
      const r = rig as ComposerRig;
      seen?.at.push({ wire: r.wire(), activity: Number((r.db.prepare("SELECT activity_rows FROM composer_runs WHERE run_id = ?").get(runId) as Row)["activity_rows"]), runId });
      createRunTaint({ runId, store: r.journal.composer, audit: r.audit, now: () => 1_700_000_000_000 }).receive(receipt);
    },
    ...over,
  });
  rig = c;
  t.after(() => c.cleanup());
  return c;
}
const ended = (c: ComposerRig, runId: string) => () => ["REVIEWING", "FAILED", "CANCELLED"].includes(c.service.get(runId).state) && !c.service.get(runId).live;
/** Who created the run: the actor of its first transition (to QUEUED). */
const runRow = (c: ComposerRig, runId: string): Row => ({ created_by: (c.db.prepare("SELECT actor FROM state_transitions WHERE entity = 'run' AND entity_id = ? AND to_state = 'QUEUED'").get(runId) as Row)["actor"] });

test("a plugin-started run is created by plugin:<id>, never the user: its creation transition names the plugin", async (t) => {
  const c = await setup(t);
  const { run } = await c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal);
  await until(ended(c, run.runId));
  assert.equal(runRow(c, run.runId)["created_by"], "plugin:acme.board");
  const actors = (c.db.prepare("SELECT actor FROM state_transitions WHERE entity = 'run' AND entity_id = ?").all(run.runId) as Row[]).map((r) => r["actor"]);
  assert.ok(!actors.includes("user"), `no transition of this run is the user's: ${actors.join(",")}`);
});

test("taint first: the run is marked and audited before its activity opens and before any model call", async (t) => {
  const seen = { at: [] as Array<{ wire: number; activity: number; runId: string }> };
  const c = await setup(t, {}, seen);
  const { run } = await c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal);
  assert.deepEqual(seen.at, [{ wire: 0, activity: 0, runId: run.runId }], "inside creation: no provider request, no activity row");
  assert.equal(c.journal.composer.tainted(run.runId), true);
  const taint = c.audit.list().filter((e) => e.action === "message.taint");
  assert.equal(taint.length, 1);
  assert.deepEqual(taint[0]?.payload, { runId: run.runId, source: "plugin_output", sourceId: run.runId, senderKind: "plugin", hop: 1 });
  await until(ended(c, run.runId));
  assert.ok(c.wire() >= 1, "the model was asked only after");
});

test("a failing taint store refuses the start with nothing created: no run, no record, no audit row, no provider call", async (t) => {
  const c = await setup(t, { taintAtStart: () => { throw new Error("store down"); } });
  const before = { runs: Number((c.db.prepare("SELECT count(*) AS n FROM agent_runs").get() as Row)["n"]), audit: c.audit.list().length };
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal), (e: unknown) => (e as { code?: string; details?: { reason?: string } }).code === "E_UNAVAILABLE" && (e as { details?: { reason?: string } }).details?.reason === "taint_unrecorded");
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM agent_runs").get() as Row)["n"]), before.runs);
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM composer_runs").get() as Row)["n"]), 0);
  assert.equal(c.audit.list().length, before.audit);
  assert.equal(c.wire(), 0);
});

test("a taint whose audit row fails also creates nothing (the mark and its row commit with the run or not at all)", async (t) => {
  let rig: ComposerRig | undefined;
  const c = await setup(t, {
    taintAtStart: (runId, receipt) =>
      createRunTaint({ runId, store: (rig as ComposerRig).journal.composer, audit: { append: () => { throw new Error("audit down"); } }, now: () => 1 }).receive(receipt),
  });
  rig = c;
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal));
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM composer_runs").get() as Row)["n"]), 0);
});

test("without taintAtStart, a plugin start is refused before anything is created; a user start is unchanged", async (t) => {
  const c = await setup(t, { taintAtStart: undefined as never });
  const none = await composerRig({ replies: [{ kind: "text", text: "ok" }] });
  t.after(() => none.cleanup());
  await assert.rejects(none.service.start({ ...START(none.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal), (e: unknown) => (e as { details?: { reason?: string } }).details?.reason === "plugin_starts_unavailable");
  const { run } = await none.service.start(START(none.workspaceId), new AbortController().signal);
  await until(ended(none, run.runId));
  assert.equal(runRow(none, run.runId)["created_by"], "user");
  assert.equal(none.journal.composer.tainted(run.runId), false, "a user start is not tainted");
  assert.equal(none.audit.list().filter((e) => e.action === "message.taint").length, 0);
  void c;
});

test("a malformed initiator is refused: a bad plugin id, a missing or zero generation, an unknown kind, extra user fields", async (t) => {
  const c = await setup(t);
  for (const bad of [{ kind: "plugin", pluginId: "Acme", generation: 1 }, { kind: "plugin", pluginId: "acme", generation: 0 }, { kind: "plugin", pluginId: "acme" }, { kind: "agent", pluginId: "acme", generation: 1 }, { kind: "user", pluginId: "acme" }, null, "plugin:acme"]) {
    // Refused first: an unknown provider would answer E_NOT_FOUND if the initiator were checked any later.
    await assert.rejects(c.service.start({ ...START(c.workspaceId, { providerId: "nope" }), initiator: bad as never }, new AbortController().signal), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT", JSON.stringify(bad));
  }
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM agent_runs").get() as Row)["n"]), 0);
});

test("still inert: the axis.runs/1 handler refuses a plugin before the service, and a spoofed initiator field in a request is refused", async (t) => {
  const c = await setup(t);
  let started = 0;
  const service = { ...c.service, start: async (...a: Parameters<typeof c.service.start>) => (started++, c.service.start(...a)) };
  const handlers = createComposerRunsHandlers({ service: service as never, journal: c.journal, mutex: c.mutex, gate: { admit: async () => "ticket" } } as never);
  const plugin = { connectionId: "A".repeat(22), windowId: "p7", actorId: "plugin:acme.board", actor: "plugin:acme.board", workspaceId: "proj", trusted: false, clientKind: "plugin", hostWindowId: "w3" } as Identity;
  const ctx = (identity: Identity) => ({ identity, signal: new AbortController().signal, requestId: "r", correlationId: "k" }) as unknown as HandlerContext;
  await assert.rejects(Promise.resolve().then(() => handlers.start(ctx(plugin), { ...START(c.workspaceId) } as never)), (e: unknown) => (e as { code?: string }).code === "E_NOT_FOUND");
  assert.equal(started, 0);
  const { composerRunsMethods } = await import("@axis/protocol");
  const spoof = composerRunsMethods.start.request.safeParse({ workspaceId: c.workspaceId, mode: "edit", prompt: "x", providerId: "mock", modelId: "mock-model", initiator: PLUGIN });
  assert.equal(spoof.success, false, "the wire schema has no initiator field: a request cannot name one");
});

test("review K1e-a F1: the initiator is read once: a getter that answers differently on a later read cannot change the creator", async (t) => {
  const c = await setup(t);
  let reads = 0;
  const flip = {
    kind: "plugin",
    generation: 2,
    get pluginId(): string {
      reads += 1;
      return reads === 1 ? "acme.board" : "other.plugin";
    },
  };
  const { run } = await c.service.start({ ...START(c.workspaceId), initiator: flip as never, recheck: OK }, new AbortController().signal);
  await until(ended(c, run.runId));
  assert.equal(runRow(c, run.runId)["created_by"], "plugin:acme.board", "the id that was checked is the id that was recorded");
  assert.equal(reads, 1, "the field was read once");
});

test("review K1e-a F2: a taint hook that returns a promise is refused: nothing is created and the provider is never called", async (t) => {
  const c = await setup(t, { taintAtStart: (() => Promise.resolve()) as never });
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal), (e: unknown) => (e as { code?: string }).code === "E_UNAVAILABLE");
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM composer_runs").get() as Row)["n"]), 0, "no run record");
  assert.equal(c.wire(), 0, "no provider call");
});

test("review K1e-a N1: an initiator built on a prototype (an inherited kind) is not the user: refused, nothing created", async (t) => {
  const c = await setup(t);
  const sneaky = Object.create({ kind: "user" }) as Record<string, unknown>;
  sneaky["pluginId"] = "acme.board";
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: sneaky as never }, new AbortController().signal), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT");
  const thrower = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: thrower as never }, new AbortController().signal), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT", "a throwing property access is a malformed initiator");
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM composer_runs").get() as Row)["n"]), 0);
});

test("review K1e-a N2: a taint hook that returns without marking the run is refused: the run must be tainted before the creation commits", async (t) => {
  const c = await setup(t, { taintAtStart: () => undefined });
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal), (e: unknown) => (e as { code?: string }).code === "E_UNAVAILABLE");
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM composer_runs").get() as Row)["n"]), 0, "no run record");
  assert.equal(c.wire(), 0, "no provider call");
});

test("review K1e-a N3: a taint hook that returns a rejected promise is refused without an unhandled rejection", async (t) => {
  const seen: unknown[] = [];
  const on = (e: unknown) => void seen.push(e);
  process.on("unhandledRejection", on);
  t.after(() => void process.off("unhandledRejection", on));
  const c = await setup(t, { taintAtStart: (() => Promise.reject(new Error("late"))) as never });
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: OK }, new AbortController().signal), (e: unknown) => (e as { code?: string }).code === "E_UNAVAILABLE");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [], "no unhandled rejection");
});

test("PV-K1e-b: a plugin start must carry the grant re-check; one that fails refuses the start with nothing created", async (t) => {
  const c = await setup(t);
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN }, new AbortController().signal), (e: unknown) => (e as { details?: { reason?: string } }).details?.reason === "plugin_starts_unavailable");
  let asked = 0;
  await assert.rejects(c.service.start({ ...START(c.workspaceId), initiator: PLUGIN, recheck: () => (asked++, false) }, new AbortController().signal), (e: unknown) => (e as { code?: string; details?: { reason?: string } }).code === "E_CONFLICT" && (e as { details?: { reason?: string } }).details?.reason === "grant_changed");
  assert.equal(asked, 1, "asked once, in the creation step");
  assert.equal(Number((c.db.prepare("SELECT count(*) AS n FROM agent_runs").get() as Row)["n"]), 0);
  assert.equal(c.wire(), 0);
  // A user start with a re-check that holds is unchanged; one that fails is refused the same way.
  const { run } = await c.service.start({ ...START(c.workspaceId), initiator: { kind: "user" }, recheck: OK }, new AbortController().signal);
  assert.equal(runRow(c, run.runId)["created_by"], "user");
});
