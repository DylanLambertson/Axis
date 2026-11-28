// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-N0c-1 (docs/design/secret-broker.md §3.4, §3.5, gate lines 6 to 8 at daemon level): the backend's reads, its tolerant
// startup list, and the control client's `secrets.*` requests: timeouts, the limit of 8 outstanding, answers matched by id and
// op, malformed or oversized answers refused at once, closed errors only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SECRETS_OUTSTANDING, SECRETS_TIMEOUTS_MS } from "../src/control/client.js";
import { META, SECRET, secretsRig as rig } from "../testing/secrets-rig.js";
import { wait } from "./helpers.js";

const failed = (reason: string) => (e: Error & { code?: string; detail?: Record<string, unknown> }) =>
  e.code === "E_UNAVAILABLE" && e.message === "The secret broker did not complete the request" && e.detail?.["reason"] === reason && !e.message.includes(SECRET);

test("the defaults: 65 s for get and put, 10 s for the rest, at most 8 outstanding (§3.4)", () => {
  assert.deepEqual(SECRETS_TIMEOUTS_MS, { slow: 65_000, fast: 10_000 });
  assert.equal(MAX_SECRETS_OUTSTANDING, 8);
});

test("put, get, meta, list and remove round-trip; info maps main's report and an unavailable cipher to no protection", async () => {
  const r = rig();
  assert.deepEqual(await r.backend.info(), { id: "gnome_libsecret", protection: "os_protected", label: "GNOME libsecret" });
  r.main.info = { backend: "gnome_libsecret", protection: "os_protected", available: false };
  assert.deepEqual(await r.backend.info(), { id: "gnome_libsecret", protection: "none", label: "GNOME libsecret" });
  r.main.info = { backend: "gnome_libsecret", protection: "os_protected", available: true };
  assert.deepEqual(await r.backend.put("c1", SECRET, META), { id: "gnome_libsecret", protection: "os_protected" });
  assert.deepEqual(await r.backend.get("c1"), { secret: SECRET, meta: META });
  assert.deepEqual(await r.backend.meta("c1"), META);
  assert.deepEqual(await r.backend.list(), [{ name: "c1", meta: META }]);
  assert.equal(await r.backend.remove("c1"), true);
  assert.equal(await r.backend.remove("c1"), false);
  assert.equal(await r.backend.get("c1"), undefined);
  assert.equal(await r.backend.meta("c1"), undefined);
  assert.deepEqual(r.events, []);
});

test("main's closed errors are fixed failures: corrupt, failed; not_found is no entry", async () => {
  const r = rig();
  r.main.rawAnswer = (m) => (m.type === "secrets.get" ? { type: "secrets.result", requestId: m.requestId, ok: false, error: "corrupt" } : undefined);
  await assert.rejects(r.backend.get("c1"), failed("corrupt"));
  r.main.rawAnswer = (m) => ({ type: "secrets.result", requestId: m.requestId, ok: false, error: "failed" });
  await assert.rejects(r.backend.meta("c1"), failed("failed"));
  await assert.rejects(r.backend.remove("c1"), failed("failed"));
  await assert.rejects(r.backend.list(), failed("failed"));
  await assert.rejects(r.backend.info(), failed("failed"));
});

test("a hung get fails within the daemon's timeout and other names stay usable (gate 6)", async () => {
  const r = rig({ budgetMs: { get: 60_000 } }, 300);
  r.main.entries.set("c2", { secret: SECRET, meta: META });
  r.main.workMs = (op, name) => (op === "get" && name === "c1" ? Infinity : 0);
  const hung = r.backend.get("c1");
  const timedOut = assert.rejects(hung, failed("timeout"));
  assert.deepEqual(await r.backend.get("c2"), { secret: SECRET, meta: META }, "another connection is served meanwhile");
  await timedOut;
  assert.equal(r.client.stats().pending, 0, "the pending entry and its timer are gone");
});

test("a malformed answer, an answer for another op, or an oversized one fails at once, never as a partial value (gate 8)", async () => {
  const cases: Array<[string, (m: { requestId: string }) => unknown]> = [
    ["wrong op", (m) => ({ type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "meta", meta: META } })],
    ["extra field", (m) => ({ type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "get", secret: SECRET, meta: META, path: "/x" } })],
    ["bad meta", (m) => ({ type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "get", secret: SECRET, meta: { ...META, backend: "plain" } } })],
    ["oversized secret", (m) => ({ type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "get", secret: "x".repeat(4097), meta: META } })],
    ["both value and error", (m) => ({ type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "get", secret: SECRET, meta: META }, error: "failed" })],
    ["exception text", (m) => ({ type: "secrets.result", requestId: m.requestId, ok: false, error: "EACCES /home/u" })],
  ];
  for (const [label, raw] of cases) {
    const r = rig({}, 5_000); // a daemon timeout well after: the refusal must come from the answer itself
    r.main.rawAnswer = (m) => raw(m);
    const started = performance.now();
    await assert.rejects(r.backend.get("c1"), failed("invalid_answer"), label);
    assert.ok(performance.now() - started < 2_500, `${label}: refused at once, not by the timer`);
    assert.equal(r.client.stats().pending, 0, label);
  }
});

test("a late answer after a timeout is ignored and counted; its id is never reused", async () => {
  const r = rig({}, 150);
  let held: { requestId: string } | undefined;
  r.main.rawAnswer = (m) => {
    if (held === undefined) {
      held = m;
      return null;
    }
    return undefined;
  };
  await assert.rejects(r.backend.meta("c1"), failed("timeout"));
  r.b.send({ type: "secrets.result", requestId: held?.requestId, ok: true, value: { op: "meta", meta: META } });
  await wait(20);
  assert.equal(r.client.stats().ignoredAnswers, 1);
  assert.equal(await r.backend.meta("c1"), undefined);
  const ids = r.main.seen.map((m) => m.requestId);
  assert.equal(new Set(ids).size, ids.length, "every request has its own id");
});

test("at most 8 secrets requests are outstanding; a ninth fails at once and is never sent", async () => {
  const r = rig({ budgetMs: { meta: 60_000 }, maxOutstanding: 64 }, 2_000);
  r.main.workMs = (op) => (op === "meta" ? Infinity : 0);
  const held = Array.from({ length: MAX_SECRETS_OUTSTANDING }, (_, i) => r.backend.meta(`c${i}`));
  for (const p of held) p.catch(() => undefined);
  await wait(10);
  await assert.rejects(r.backend.meta("c99"), failed("busy"));
  assert.equal(r.main.seen.length, MAX_SECRETS_OUTSTANDING, "the ninth never left the daemon");
  await Promise.allSettled(held);
  assert.deepEqual(await r.backend.info(), { id: "gnome_libsecret", protection: "os_protected", label: "GNOME libsecret" }, "the slots come back after the timeouts");
});

test("a closed channel or a disposed client fails what waits and what comes later", async () => {
  const r = rig({ budgetMs: { meta: 60_000 } }, 60_000);
  r.main.workMs = () => Infinity;
  const waiting = r.backend.meta("c1");
  await wait(5);
  r.client.dispose();
  await assert.rejects(waiting, failed("closed"));
  await assert.rejects(r.backend.meta("c1"), failed("closed"));
});

test("the startup list is tolerant: a name the vault refuses is dropped and reported, the rest is kept (gate 8)", async () => {
  const r = rig();
  r.main.rawAnswer = (m) =>
    m.type === "secrets.list"
      ? { type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "list", entries: [{ name: "c1", meta: { ...META } }, { name: "Bad Name", meta: { ...META } }, { name: "x:y", meta: { ...META } }, { name: "integration:github", meta: { ...META } }] } }
      : undefined;
  assert.deepEqual(await r.backend.list(), [{ name: "c1", meta: { ...META } }, { name: "integration:github", meta: { ...META } }]);
  assert.deepEqual(r.events, [{ event: "secrets.list_name_dropped" }, { event: "secrets.list_name_dropped" }], "one closed event per dropped name, no name in it");
});

test("the startup list still refuses malformed metadata, an over-long name and more than 256 entries as a whole", async () => {
  const lists = [
    [{ name: "c1", meta: { ...META } }, { name: "c2", meta: { ...META, protection: "plain" } }],
    [{ name: "c1", meta: { ...META } }, { name: "c".repeat(101), meta: { ...META } }],
    Array.from({ length: 257 }, (_, i) => ({ name: `c${i}`, meta: { ...META } })),
  ];
  for (const entries of lists) {
    const r = rig({}, 5_000);
    r.main.rawAnswer = (m) => (m.type === "secrets.list" ? { type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "list", entries } } : undefined);
    await assert.rejects(r.backend.list(), failed("invalid_answer"));
  }
});
