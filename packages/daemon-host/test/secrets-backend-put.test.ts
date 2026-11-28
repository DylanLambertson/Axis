// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-N0c-1 (docs/design/secret-broker.md §3.4, §6.1): a `put` that failed or timed out is "unknown", because main's late
// operation may still write the record. The daemon's backend reconciles with ONE `get` that main orders behind the late `put`
// (one operation per name), never retries, and never claims a store it cannot see. Its own requests for one name leave in the
// order they were made, so a rollback `remove` is never sent before the `put` (and its reconciliation) it undoes has settled.
// Tested with delayed writes in the fake main, not inferred from timer settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { META, SECRET, secretsRig as rig } from "../testing/secrets-rig.js";

const OLD = "test-credential-value-0000";

test("a put main answers late lands, and the backend's one reconciling get, ordered behind it, reports where it landed", async () => {
  const r = rig();
  r.main.workMs = (op) => (op === "put" ? 250 : 0); // past main's 100 ms budget: answered `failed`, then written at 250 ms
  const wrote = await r.backend.put("c1", SECRET, META);
  assert.deepEqual(wrote, { id: "gnome_libsecret", protection: "os_protected" });
  assert.deepEqual(r.ops(), ["put:c1", "get:c1"], "one put, then exactly one reconciling get");
  assert.deepEqual(r.main.started.map((s) => s.op), ["put", "get"], "main ran the get only after the late put settled");
  assert.equal(r.main.entries.get("c1")?.secret, SECRET);
  assert.deepEqual(r.events, [{ event: "secrets.put_landed_late" }]);
});

test("a put that failed without writing is reported failed after the reconciling get, and a rotation keeps the old secret", async () => {
  const r = rig();
  r.main.entries.set("c1", { secret: OLD, meta: { ...META } }); // the same storedAt: only the secret tells them apart
  r.main.failWork = (op) => op === "put";
  await assert.rejects(r.backend.put("c1", SECRET, META), { code: "E_UNAVAILABLE", message: "The secret broker did not complete the request" });
  assert.deepEqual(r.ops(), ["put:c1", "get:c1"]);
  assert.equal(r.main.entries.get("c1")?.secret, OLD, "nothing removed: the previous secret of the rotation stays");
  assert.deepEqual(r.events, [{ event: "secrets.put_absent" }]);
});

test("a stored copy with the same secret but another storedAt is not this put: reported failed", async () => {
  const r = rig();
  r.main.entries.set("c1", { secret: SECRET, meta: { ...META, storedAt: 1 } });
  r.main.failWork = (op) => op === "put";
  await assert.rejects(r.backend.put("c1", SECRET, META), { code: "E_UNAVAILABLE" });
  assert.deepEqual(r.events, [{ event: "secrets.put_absent" }]);
});

test("a stored copy with the same secret and storedAt but another label or consent is not this put either", async () => {
  for (const stored of [{ ...META, label: "Work key" }, { ...META, weakConsent: true }]) {
    const r = rig();
    r.main.entries.set("c1", { secret: SECRET, meta: stored });
    r.main.failWork = (op) => op === "put";
    await assert.rejects(r.backend.put("c1", SECRET, META), { code: "E_UNAVAILABLE" });
    assert.deepEqual(r.events, [{ event: "secrets.put_absent" }], JSON.stringify(stored));
  }
});

test("a late landing is reported where the record says it landed, not where the put asked (the vault then rolls it back)", async () => {
  const r = rig();
  r.main.workMs = (op) => (op === "put" ? 250 : 0);
  r.main.readProtection = () => "none"; // main reads the protection from the ciphertext it wrote (handoff H-6)
  assert.deepEqual(await r.backend.put("c1", SECRET, META), { id: "gnome_libsecret", protection: "none" });
});

test("main refuses a put whose backend or protection is not where it would write, and writes nothing (handoff H-4)", async () => {
  for (const info of [{ backend: "kwallet6", protection: "os_protected" }, { backend: "gnome_libsecret", protection: "ephemeral" }] as const) {
    const r = rig();
    r.main.info = { ...info, available: true };
    await assert.rejects(r.backend.put("c1", SECRET, META), (e: Error & { detail?: Record<string, unknown> }) => e.detail?.["reason"] === "refused");
    assert.equal(r.main.entries.has("c1"), false, JSON.stringify(info));
    assert.deepEqual(r.ops(), ["put:c1"], "certain: no reconciling get");
  }
});

test("a put cut off by dispose AFTER it was sent is unknown, not certain: put_unknown, and main may still have written it (SF-3)", async () => {
  const r = rig({ budgetMs: { put: 60_000 } }, 60_000);
  r.main.workMs = (op) => (op === "put" ? 200 : 0);
  const put = r.backend.put("c1", SECRET, META);
  const outcome = assert.rejects(put, (e: Error & { detail?: Record<string, unknown> }) => e.detail?.["reason"] === "unknown");
  await new Promise((res) => setTimeout(res, 20));
  r.client.dispose();
  await outcome;
  assert.deepEqual(r.events, [{ event: "secrets.put_unknown" }]);
  assert.deepEqual(r.ops(), ["put:c1"], "the reconciling get could not leave a disposed client");
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.main.entries.get("c1")?.secret, SECRET, "main did write it: exactly why it was unknown");
});

test("a put refused before it left the daemon is certain: no reconciling get, no event, and the error carries no extra field", async () => {
  const r = rig();
  const e = await r.backend.put("Not A Name", SECRET, META).then(
    () => assert.fail("refused"),
    (err: Error & { detail?: Record<string, unknown> }) => err,
  );
  assert.equal(e.message, "The secret broker did not complete the request");
  assert.deepEqual(Object.keys(e).sort(), ["code", "detail", "name"], "no `certain` or `sent` field on the error the vault sees");
  assert.deepEqual(e.detail, { reason: "failed" });
  assert.deepEqual(r.ops(), []);
  assert.deepEqual(r.events, []);
});

test("a name that is an Object.prototype key round-trips (the per-name state is a Map)", async () => {
  const r = rig();
  for (const name of ["constructor", "tostring", "hasownproperty"]) {
    assert.deepEqual(await r.backend.put(name, SECRET, META), { id: "gnome_libsecret", protection: "os_protected" });
    assert.deepEqual(await r.backend.get(name), { secret: SECRET, meta: { ...META } });
    assert.equal(await r.backend.remove(name), true);
  }
});

test("a put the daemon never sent (8 already outstanding) is certain: refused as busy, with no reconciling get", async () => {
  const r = rig({ budgetMs: { meta: 60_000 }, maxOutstanding: 64 }, 1_500);
  r.main.workMs = (op) => (op === "meta" ? Infinity : 0);
  const held = Array.from({ length: 8 }, (_, i) => r.backend.meta(`m${i}`));
  for (const p of held) p.catch(() => undefined);
  await new Promise((res) => setTimeout(res, 10));
  await assert.rejects(r.backend.put("c1", SECRET, META), (e: Error & { detail?: Record<string, unknown> }) => e.detail?.["reason"] === "busy");
  assert.equal(r.ops().filter((o) => o.endsWith(":c1")).length, 0, "neither the put nor a get for it left the daemon");
  assert.deepEqual(r.events, []);
  await Promise.allSettled(held);
});

test("a put that hangs stays unknown: the reconciling get gives up behind it, nothing is retried, and the put is reported failed", async () => {
  const r = rig();
  r.main.workMs = (op) => (op === "put" ? Infinity : 0);
  await assert.rejects(r.backend.put("c1", SECRET, META), (e: Error & { detail?: Record<string, unknown> }) => e.message === "The secret broker did not complete the request" && e.detail?.["reason"] === "unknown");
  assert.deepEqual(r.ops(), ["put:c1", "get:c1"], "no retry loop: one put and one get");
  assert.deepEqual(r.main.started.map((s) => s.op), ["put"], "the get never ran: main held the name for the hung put");
  assert.deepEqual(r.events, [{ event: "secrets.put_unknown" }]);
  assert.equal(r.client.stats().pending, 0, "nothing left waiting in the daemon");
});

test("silence from main on a put (the daemon's own timeout) is unknown too, and is reconciled the same way", async () => {
  const r = rig();
  r.main.rawAnswer = (m) => (m.type === "secrets.put" ? null : undefined); // main writes, but its answer never arrives
  const wrote = await r.backend.put("c1", SECRET, META);
  assert.deepEqual(wrote, { id: "gnome_libsecret", protection: "os_protected" });
  assert.deepEqual(r.ops(), ["put:c1", "get:c1"]);
  assert.deepEqual(r.events, [{ event: "secrets.put_landed_late" }]);
});

test("a refused put (weak or unavailable backend) is certain: no reconciling get", async () => {
  const r = rig();
  r.main.info = { backend: "basic_text", protection: "none", available: true };
  await assert.rejects(r.backend.put("c1", SECRET, META), (e: Error & { detail?: Record<string, unknown> }) => e.detail?.["reason"] === "refused");
  assert.deepEqual(r.ops(), ["put:c1"]);
  assert.deepEqual(r.events, []);
});

test("same name: a remove asked for while a late put is unsettled leaves only after the put and its reconciliation", async () => {
  const r = rig();
  r.main.workMs = (op) => (op === "put" ? 250 : 0);
  const put = r.backend.put("c1", SECRET, META);
  const remove = r.backend.remove("c1"); // the vault's rollback, asked for at once
  const other = r.backend.get("c2"); // another name is not held up
  assert.equal(await other, undefined);
  assert.deepEqual(r.ops(), ["put:c1", "get:c2"], "the remove has not left yet");
  await put;
  assert.equal(await remove, true, "the remove ran after the put landed, and removed it");
  assert.deepEqual(r.ops(), ["put:c1", "get:c2", "get:c1", "remove:c1"]);
  assert.equal(r.main.entries.has("c1"), false, "no late put lands after the remove");
});

test("same name: a failed put does not block the next request for that name, which still leaves after it", async () => {
  const r = rig();
  r.main.failWork = (op, name) => op === "put" && name === "c1";
  const put = r.backend.put("c1", SECRET, META);
  const meta = r.backend.meta("c1");
  await assert.rejects(put);
  assert.equal(await meta, undefined);
  assert.deepEqual(r.ops(), ["put:c1", "get:c1", "meta:c1"]);
});
