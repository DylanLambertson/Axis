// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, withTransaction } from "@axis/audit";
import { Journal, lastTransitionId, transitionsSince } from "@axis/journal";
import { eventBodySchema } from "@axis/protocol";
import { EVENT_ROWS_PER_TICK, createEventSources, type EventSourcesDeps } from "../src/events/sources.js";

const SHA = "b".repeat(40);
const KIND = "cli" as const;

function rig(over: Partial<EventSourcesDeps> = {}) {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const published: Array<{ body: Record<string, unknown>; windowId: string | undefined }> = [];
  const state = { subs: 1, windows: new Set<string>(), head: 0, stalled: false, pending: new Map<string, string[]>(), errors: [] as string[] };
  const hub = {
    publish: (body: unknown, audience?: { windowId?: string }) => (published.push({ body: body as Record<string, unknown>, windowId: audience?.windowId }), true),
    get subscriptionCount() {
      return state.subs;
    },
    windowsFor: () => new Set(state.windows),
  };
  const sources = createEventSources({
    hub,
    journal: { transitionsSince: (a, n) => transitionsSince(db, a, n), lastTransitionId: () => lastTransitionId(db) },
    auditHead: () => state.head,
    anchorStalled: () => state.stalled,
    pending: (w) => (state.pending.get(w) ?? []).map((challengeId) => ({ challengeId })),
    intervalMs: 0,
    onError: (r) => void state.errors.push(r),
    ...over,
  });
  const workspace = (name = "x") => {
    const ws = journal.createWorkspace({ projectId: "p", branch: `axis/${name}`, baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
    journal.transitionWorkspace(ws.id, "READY");
    return ws.id;
  };
  return { db, journal, published, state, sources, workspace };
}

test("SRC1 committed journal transitions after start become workspace and run hints in commit order; history is not replayed", () => {
  const r = rig();
  const old = r.workspace("old");
  const s2 = createEventSources({ ...depsOf(r), intervalMs: 0 });
  const ws = r.workspace("new");
  const run = r.journal.createRun({ workspaceId: ws, kind: KIND, createdBy: "user" }).value;
  r.journal.transitionRun(run.id, "RUNNING");
  s2.tick();
  assert.deepEqual(r.published.map((p) => p.body), [
    { topic: "workspaces", workspaceId: ws },
    { topic: "workspaces", workspaceId: ws },
    { topic: "runs", runId: run.id, state: "QUEUED" },
    { topic: "runs", runId: run.id, state: "RUNNING" },
  ]);
  assert.ok(!r.published.some((p) => p.body["workspaceId"] === old), "a transition before the sources started is not an event");
  for (const p of r.published) assert.equal(eventBodySchema.safeParse(p.body).success, true);
  r.published.length = 0;
  s2.tick();
  assert.equal(r.published.length, 0, "each row once");
});

function depsOf(r: ReturnType<typeof rig>): EventSourcesDeps {
  return {
    hub: {
      publish: (b: unknown, a?: { windowId?: string }) => (r.published.push({ body: b as Record<string, unknown>, windowId: a?.windowId }), true),
      get subscriptionCount() {
        return r.state.subs;
      },
      windowsFor: () => new Set(r.state.windows),
    },
    journal: { transitionsSince: (a, n) => transitionsSince(r.db, a, n), lastTransitionId: () => lastTransitionId(r.db) },
    auditHead: () => r.state.head,
    anchorStalled: () => r.state.stalled,
    pending: (w) => (r.state.pending.get(w) ?? []).map((challengeId) => ({ challengeId })),
  };
}

test("SRC2 with nobody subscribed the cursors move but nothing is published; a later subscriber gets only what follows", () => {
  const r = rig();
  r.state.subs = 0;
  r.workspace("quiet");
  r.state.head = 5;
  r.state.stalled = true;
  r.sources.tick();
  assert.equal(r.published.length, 0);
  r.state.subs = 1;
  r.sources.tick();
  assert.equal(r.published.length, 0, "the quiet period is not replayed");
  const ws = r.workspace("loud");
  r.sources.tick();
  assert.deepEqual(r.published.map((p) => p.body["workspaceId"]), [ws, ws]);
});

test("SRC3 a rolled-back transition is never seen, and the rows of one tick are bounded", () => {
  const r = rig();
  const ws = r.workspace("a");
  r.sources.tick();
  r.published.length = 0;
  const before = lastTransitionId(r.db);
  let wrote = false;
  assert.throws(() =>
    withTransaction(r.db, () => {
      r.journal.transitionWorkspace(ws, "REMOVING", { reason: "TEST" });
      wrote = lastTransitionId(r.db) > before;
      throw new Error("roll back");
    }),
  );
  assert.equal(wrote, true, "the row existed inside the transaction");
  r.sources.tick();
  assert.equal(r.published.length, 0, "nothing for a transition that did not commit");
  for (let i = 0; i < EVENT_ROWS_PER_TICK; i++) r.workspace(`w${i}`); // two rows each
  r.sources.tick();
  assert.equal(r.published.length, EVENT_ROWS_PER_TICK);
  r.sources.tick();
  assert.equal(r.published.length, 2 * EVENT_ROWS_PER_TICK, "the rest on the next tick, none lost");
});

test("SRC4 anchor and audit head: one hint per change, with the new value only", () => {
  const r = rig();
  r.sources.tick();
  assert.equal(r.published.length, 0);
  r.state.stalled = true;
  r.state.head = 7;
  r.sources.tick();
  r.sources.tick();
  r.state.stalled = false;
  r.sources.tick();
  assert.deepEqual(r.published.map((p) => p.body), [
    { topic: "anchor", stalled: true },
    { topic: "audit", headSeq: 7 },
    { topic: "anchor", stalled: false },
  ]);
});

test("SRC5 approvals: scoped to the window, on first sighting and on every change of its open set, never with an id", () => {
  const r = rig();
  r.state.windows = new Set(["win-a"]);
  r.state.pending.set("win-a", ["c1"]);
  r.state.pending.set("win-b", ["c9"]);
  r.sources.tick();
  r.sources.tick();
  r.state.pending.set("win-a", ["c1", "c2"]);
  r.sources.tick();
  r.state.pending.set("win-a", ["c2", "c1"]); // the same set
  r.sources.tick();
  r.state.pending.set("win-a", []);
  r.sources.tick();
  assert.deepEqual(r.published, [
    { body: { topic: "approvals" }, windowId: "win-a" },
    { body: { topic: "approvals" }, windowId: "win-a" },
    { body: { topic: "approvals" }, windowId: "win-a" },
  ]);
  assert.ok(!JSON.stringify(r.published).includes("c1"), "no challenge id leaves the source");
  r.state.windows = new Set();
  r.sources.tick();
  r.state.windows = new Set(["win-a"]);
  r.sources.tick();
  assert.equal(r.published.length, 4, "a window that comes back is a first sighting again");
});

test("SRC6 a failing source is reported by a fixed reason and does not stop the others; an unknown run state is left out", () => {
  const r = rig();
  const s = createEventSources({ ...depsOf(r), intervalMs: 0, anchorStalled: () => { throw new Error("/secret/path"); }, onError: (x) => void r.state.errors.push(x) });
  r.state.head = 3;
  r.db.prepare("INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, actor, ts) VALUES ('run', 'r-1', NULL, 'WEIRD', NULL, 'daemon', 'x')").run();
  s.tick();
  assert.ok(r.state.errors.length >= 1 && r.state.errors.every((e) => e === "events_source"), "fixed reason only");
  assert.deepEqual(r.published.map((p) => p.body), [{ topic: "runs", runId: "r-1" }, { topic: "audit", headSeq: 3 }]);
});
