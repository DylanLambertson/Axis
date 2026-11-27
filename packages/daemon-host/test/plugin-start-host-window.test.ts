// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K2 K2-g4b (plugin-grant-contract.md section 8.4, condition 6): a plugin's run start is bound to its host window's lifetime as
// it was when the challenge was issued. The binding pins the epoch, `valid()` requires it alive (so resolve, detail and the spend
// refuse once it ended), the approval carries it, and the handler checks it with the plugin connection after every wait: at entry
// (after the daemon's awaited policy row), under the project mutex, and in the service's synchronous step (after the trust gate).
// Each wait is paused while the plugin connection closes, the host window's last connection closes, the window closes and reopens,
// or main sends window.gone: no run is ever created. The model list and engine.prepare waits are inside the real service, before
// its synchronous check: composer-plugin-start.test.ts covers them.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Identity } from "@axis/daemon";
import { randomBytes, randomUUID } from "node:crypto";
import { approvedStartOf, pluginRunStartChallenges } from "../src/gate/plugin-run-start.js";
import { createWindowLifetimes } from "../src/plugins/window-lifetimes.js";
import { createComposerRunsHandlers } from "../src/handlers/composer-runs.js";
import type { Client } from "./approvals-rig.js";
import { handlerRig, PLUGIN_ATT, reason, setup, until, verifier, type Row, type Setup } from "./plugin-start-rig.js";

const pending = async (user: Client): Promise<Row[]> => ((await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[]) ?? [];

/** Close every desktop session of w1 and wait until its lifetime has ended. */
async function closeHost(s: Setup, users: Client[]): Promise<void> {
  for (const c of [s.host, ...users]) c.port.close();
  await until(() => s.windows.current("w1") === undefined, "w1's last close");
}

test("issue: a host window with no open desktop session refuses the plugin's challenge; nothing is issued or counted", async (t) => {
  const s = await setup(t);
  const plugin = await s.connect(PLUGIN_ATT);
  await closeHost(s, []);
  const asked = await plugin.call("axis.runs", "start", s.body(), randomUUID());
  assert.equal(asked.error?.code, "E_POLICY_DENIED");
  const user = await s.connect("user#Uone#w1");
  assert.deepEqual(await pending(user), []);
  assert.equal(s.journal.pluginIssues.record("acme.board", "p1", s.clock.now()).ok, true, "the refused ask spent nothing of the hour");
});

test("the approval carries the host window and the epoch pinned at issue", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const approved = approvedStartOf(h.mint());
  assert.equal(approved?.hostWindowId, "w1");
  assert.equal(approved?.hostEpoch, s.windows.current("w1"));
});

for (const event of ["close and reopen", "window.gone"] as const) {
  test(`a pending challenge whose host window had a ${event} is ended: not listed, no detail, no resolve, no spend`, async (t) => {
    const s = await setup(t);
    const plugin = await s.connect(PLUGIN_ATT);
    const user = await s.connect("user#Uone#w1");
    const key = randomUUID();
    const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
    const digest = (await pending(user))[0]?.["digest"];
    if (event === "window.gone") s.windows.gone("w1"); // main saw the window reload: the old connections' closes come later
    else await closeHost(s, [user]);
    const viewer = await s.connect("user#Utwo#w1"); // the same window id, a new lifetime
    assert.notEqual(s.windows.current("w1"), undefined);
    assert.deepEqual(await pending(viewer), [], "not listed");
    assert.equal((await viewer.call("axis.approvals", "detail", { challengeId })).result?.["detail"], undefined, "no detail");
    const resolved = await viewer.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest });
    assert.notEqual(resolved.result?.["state"], "approved");
    const done = await plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
    assert.notEqual(done.ok, true);
    assert.equal(s.starts.length, 0);
  });
}

type Pause = "policy row" | "mutex wait" | "trust gate";
type Event = "plugin closes" | "host's last close" | "host closes and reopens" | "window.gone";
const PAUSES: Pause[] = ["policy row", "mutex wait", "trust gate"];
const EVENTS: Event[] = ["plugin closes", "host's last close", "host closes and reopens", "window.gone"];

async function startWith(t: TestContext, pause: Pause, event: Event): Promise<{ s: Setup; rows: Row[]; answer: Promise<{ ok?: boolean; error?: { code?: string } }> | undefined }> {
  const rows: Row[] = [];
  let armed = false;
  let fire: (() => Promise<void>) | undefined;
  let fired = false;
  const at = async (where: Pause): Promise<void> => {
    if (armed && where === pause) {
      armed = false;
      await (fire as () => Promise<void>)();
      fired = true;
    }
  };
  const s: Setup = await setup(t, {
    onAudit: (e) => {
      rows.push(e);
      if (e["action"] === "policy.decision" && (e["payload"] as Row)["decision"] === "allow" && e["actor"] === "plugin:acme.board") return at("policy row");
      return undefined;
    },
    admit: () => at("trust gate"),
  });
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  const key = randomUUID();
  const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
  const digest = (await pending(user))[0]?.["digest"];
  assert.equal((await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest })).result?.["state"], "approved");
  fire = async () => {
    if (event === "plugin closes") {
      const before = s.daemon.connectionCount;
      plugin.port.close();
      await until(() => s.daemon.connectionCount === before - 1, "the plugin's close");
    } else if (event === "window.gone") s.windows.gone("w1");
    else {
      await closeHost(s, [user]);
      if (event === "host closes and reopens") {
        await s.connect("user#Uthree#w1");
        assert.notEqual(s.windows.current("w1"), undefined);
      }
    }
  };
  let release: (() => void) | undefined;
  if (pause === "mutex wait") {
    let held: (() => void) | undefined;
    void s.mutex.run("p1", () => new Promise<void>((r) => (held = r)), new AbortController().signal);
    await until(() => held !== undefined, "the mutex held");
    release = held;
  }
  armed = pause !== "mutex wait";
  const marker = rows.length;
  const retry = plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
  // A closed plugin port never gets its answer: the call rejects, and the execute row below is what proves the outcome.
  if (event === "plugin closes") retry.catch(() => undefined);
  if (release !== undefined) {
    await until(() => rows.slice(marker).some((r) => r["action"] === "policy.decision"), "the retry reaches the handler");
    await new Promise((r) => setImmediate(r));
    await (fire as () => Promise<void>)();
    release();
  }
  if (event === "plugin closes" && pause === "policy row") {
    // The daemon itself stops a closed connection's request right after the awaited row (its guard), before any handler and with
    // no execute row: let the pipeline run on past the pause, then nothing may have started.
    await until(() => fired, "the pause");
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(rows.slice(marker).some((r) => r["action"] === "rpc.execute"), false, "the handler never ran");
  } else {
    // The handler is done when the daemon writes the request's execute row.
    await until(() => rows.slice(marker).some((r) => r["action"] === "rpc.execute"), "the retry's execute row");
  }
  return { s, rows: rows.slice(marker), answer: event === "plugin closes" ? undefined : retry };
}

for (const pause of PAUSES) {
  for (const event of EVENTS) {
    test(`paused at the ${pause}, the ${event}: no run is created`, async (t) => {
      const { s, rows, answer } = await startWith(t, pause, event);
      assert.equal(s.starts.length, 0, "no run");
      const execute = rows.find((r) => r["action"] === "rpc.execute");
      if (execute !== undefined) assert.notEqual((execute["payload"] as Row)["result"], "done", JSON.stringify(execute));
      if (answer !== undefined) {
        const m = (await answer) as { ok?: boolean; error?: { code?: string; details?: Row } };
        assert.equal(m.error?.code, "E_CONFLICT", JSON.stringify(m.error));
        assert.equal(reason(m), "host_window_closed");
      }
    });
  }
}

test("control: with nothing closing, each pause starts the run, so the cases above fail only on the close", async (t) => {
  for (const pause of PAUSES) {
    const rows: Row[] = [];
    const s = await setup(t, { onAudit: (e) => void rows.push(e) });
    const plugin = await s.connect(PLUGIN_ATT);
    const user = await s.connect("user#Uone#w1");
    const key = randomUUID();
    const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
    const digest = (await pending(user))[0]?.["digest"];
    await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest });
    const done = await plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
    assert.equal(done.ok, true, `${pause}: ${JSON.stringify(done.error)}`);
    assert.equal(s.starts.length, 1);
    assert.equal(typeof s.starts[0]?.hostAlive, "function");
  }
});

test("layer: the handler alone refuses a closed host window at entry and under the mutex, and a closed plugin connection", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; details?: Row }) => `${e.code}${e.details?.["reason"] === undefined ? "" : `:${String(e.details["reason"])}`}`);
  // An approval for another host window than the caller's is refused.
  const elsewhere = { ...asPlugin, hostWindowId: "w2" } as Identity;
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(elsewhere), s.body() as never))), "E_NOT_FOUND");
  // The plugin connection already closed.
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin, h.mint(), aborted.signal), s.body() as never))), "E_CANCELLED");
  // At entry: the pinned lifetime ended before the handler ran.
  const minted = h.mint();
  s.windows.gone("w1");
  await s.connect("user#Ufour#w1");
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin, minted), s.body() as never))), "E_CONFLICT:host_window_closed");
  // Under the mutex (the service here does not check): the lifetime ends while the start waits.
  let release!: () => void;
  const held = h.mutex.run("p1", () => new Promise<void>((r) => (release = r)), new AbortController().signal);
  const started = Promise.resolve(h.handlers.start(h.ctx(asPlugin), s.body() as never));
  await new Promise((r) => setImmediate(r));
  s.windows.gone("w1");
  release();
  await held;
  assert.equal(await code(started), "E_CONFLICT:host_window_closed");
  // The service is handed the same check.
  await s.connect("user#Ufive#w1");
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin), s.body() as never))), "ok");
  const alive = h.seen[0]?.hostAlive as () => boolean;
  assert.equal(alive(), true);
  s.windows.gone("w1");
  assert.equal(alive(), false);
  assert.equal(h.seen.length, 1);
});

test("layer: the check handed to the service also fails once the plugin connection closes; no lifetimes wired refuses a plugin start", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const connection = new AbortController();
  await h.handlers.start(h.ctx(asPlugin, h.mint(), connection.signal), s.body() as never);
  const alive = h.seen[0]?.hostAlive as () => boolean;
  assert.equal(alive(), true);
  connection.abort();
  assert.equal(alive(), false, "the plugin connection closed after the handler's own checks");
  // A composition that did not wire the host windows: a plugin start is refused before anything else.
  const { hostWindows: _unused, ...unwired } = { journal: s.journal, mutex: h.mutex, pluginStarts: s.journal, gate: { admit: async () => "ticket" } as never, service: { cancel: () => assert.fail("no"), get: () => assert.fail("no"), list: () => assert.fail("no"), events: () => assert.fail("no"), start: () => assert.fail("never reached") }, hostWindows: s.windows };
  const bare = createComposerRunsHandlers(unwired as never);
  await assert.rejects(Promise.resolve(bare.start(h.ctx(asPlugin), s.body() as never)), (e: unknown) => (e as { code?: string; details?: Row }).code === "E_NOT_FOUND" && (e as { details?: Row }).details?.["reason"] === undefined);
});

test("layer: an ended lifetime is refused at entry, without waiting for the project mutex", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const minted = h.mint();
  s.windows.gone("w1");
  let release: (() => void) | undefined;
  const held = h.mutex.run("p1", () => new Promise<void>((r) => (release = r)), new AbortController().signal);
  await until(() => release !== undefined, "the mutex held");
  let settled: string | undefined;
  void Promise.resolve(h.handlers.start(h.ctx(asPlugin, minted), s.body() as never)).then(
    () => (settled = "ok"),
    (e: { details?: Row }) => (settled = String(e.details?.["reason"])),
  );
  await until(() => settled !== undefined, "a refusal while the mutex is still held");
  assert.equal(settled, "host_window_closed");
  (release as () => void)();
  await held;
  assert.equal(h.seen.length, 0);
});

test("review K2-g4b N1: a lifetimes port that throws is a closed window, in the binding and in the handler", async (t) => {
  const s = await setup(t);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const throwing = { current: () => "pinned-epoch", alive: (): boolean => { throw new Error("lifetimes failed"); } };
  const binding = pluginRunStartChallenges(s.journal, s.journal.pluginIssues, () => 1, throwing).bind({ identity: asPlugin, actor: asPlugin.actor, contract: "axis.runs", method: "start", args: s.body() } as never, { target: "x", contentDigest: "e".repeat(64) });
  assert.ok(binding !== undefined, "issued: the epoch was there at issue");
  assert.equal(binding.valid(), false, "a throw in alive() is not a live window");
  const h = handlerRig(s);
  const handlers = createComposerRunsHandlers({ service: { cancel: () => assert.fail("no"), get: () => assert.fail("no"), list: () => assert.fail("no"), events: () => assert.fail("no"), start: () => assert.fail("never reached") }, gate: { admit: async () => "ticket" } as never, journal: s.journal, mutex: h.mutex, pluginStarts: s.journal, hostWindows: throwing });
  await assert.rejects(Promise.resolve(handlers.start(h.ctx(asPlugin, binding.approved), s.body() as never)), (e: unknown) => (e as { details?: Row }).details?.["reason"] === "host_window_closed");
});

test("review K2-g4b N2: an epoch that fell out of the ended ring is dead: the binding no longer holds", async (t) => {
  const s = await setup(t);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const windows = createWindowLifetimes({ randomBytes: (n) => randomBytes(n), endedRing: 1 });
  const desktop = (connection: string, windowId: string): Identity => ({ connectionId: connection.padEnd(22, "_"), windowId, actorId: "u", actor: "user", trusted: false, clientKind: "desktop" });
  windows.accepted(desktop("h", "w1"));
  const binding = pluginRunStartChallenges(s.journal, s.journal.pluginIssues, () => 1, windows).bind({ identity: asPlugin, actor: asPlugin.actor, contract: "axis.runs", method: "start", args: s.body() } as never, { target: "x", contentDigest: "e".repeat(64) });
  const pinned = approvedStartOf(binding?.approved)?.hostEpoch as string;
  assert.equal(binding?.valid(), true);
  windows.gone("w1");
  assert.equal(windows.status("w1", pinned), "ended");
  // Another window's ended epoch pushes w1's out of the one-entry ring: it is now unknown, and still dead.
  windows.accepted(desktop("o", "w9"));
  windows.gone("w9");
  assert.equal(windows.status("w1", pinned), "unknown");
  assert.equal(binding?.valid(), false);
  // A reopened w1 has a new epoch; the evicted one never comes back to life.
  windows.accepted(desktop("h2", "w1"));
  assert.equal(binding?.valid(), false);
});
