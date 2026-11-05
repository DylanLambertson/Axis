// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, type ChainHead, type DatabaseSync } from "../src/index.js";

function log(n: number): { db: DatabaseSync; log: AuditLog } {
  const db = openDatabase(":memory:");
  const l = new AuditLog(db, { now: () => new Date("2026-11-02T00:00:00.000Z") });
  for (let i = 1; i <= n; i++) l.append({ actor: "daemon", action: "policy.decision", target: `t:${i}`, outcome: "success", payload: { tier: 0 } });
  return { db, log: l };
}

/** Walk the whole log in slices, the way a caller that yields between them does. */
function sliced(l: AuditLog, limit: number, options: { expectedHead?: ChainHead } = {}) {
  let from: ChainHead | undefined;
  let slices = 0;
  for (;;) {
    const r = l.verify({ limit, ...(from === undefined ? {} : { from }), ...options });
    slices++;
    if (!r.ok || r.more !== true) return { result: r, slices };
    from = r.head as ChainHead;
  }
}

test("a limited verify stops after `limit` events and says more follow; the last slice has no `more`", () => {
  const { log: l } = log(10);
  const first = l.verify({ limit: 4 });
  assert.equal(first.ok, true);
  assert.ok(first.ok && first.more === true && first.head?.seq === 4 && first.count === 4);
  const exact = l.verify({ limit: 10 });
  assert.deepEqual(exact, l.verify(), "a limit equal to the length is the whole scan");
  assert.ok(first.ok);
  const resumed = l.verify({ from: first.head as ChainHead, limit: 100 });
  assert.deepEqual(resumed, l.verify());
});

test("slices cover every event once, and equal the unsliced result", () => {
  const { log: l } = log(25);
  for (const limit of [1, 3, 7, 25, 26]) {
    const { result, slices } = sliced(l, limit);
    assert.deepEqual(result, l.verify(), `limit ${limit}`);
    assert.equal(slices, Math.ceil(25 / limit), `limit ${limit}`);
  }
});

test("an edit in a later slice is found with the same first bad seq and reason as the full scan", () => {
  const { db, log: l } = log(20);
  db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");
  db.exec("UPDATE audit_events SET target = 'x:y' WHERE seq = 14");
  const full = l.verify();
  assert.equal(full.ok, false);
  const { result } = sliced(l, 5);
  assert.ok(!result.ok && full.ok === false && result.firstBadSeq === 14 && result.reason === full.reason);
});

test("expectedHead is compared by the slice that reaches the end, not by earlier ones", () => {
  const { db, log: l } = log(10);
  const head = l.head() as ChainHead;
  assert.equal(l.verify({ limit: 3, expectedHead: head }).ok, true, "an early slice is not 'truncated' against a head past it");
  assert.equal(sliced(l, 3, { expectedHead: head }).result.ok, true);
  db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");
  db.exec("DELETE FROM audit_events WHERE seq > 8");
  const cut = sliced(l, 3, { expectedHead: head }).result;
  assert.ok(!cut.ok && cut.reason === "truncated" && cut.firstBadSeq === 9);
});

test("a limit that is not a positive integer is refused", () => {
  const { log: l } = log(2);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => l.verify({ limit }), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT", String(limit));
  }
});

test("the limit is validated before anything else, even when `from` would fail first", () => {
  const { log: l } = log(2);
  assert.throws(() => l.verify({ from: { seq: 99, hash: "0".repeat(64) }, limit: 0 }), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT");
});

test("a missing start row with later rows present is a gap at that row; with nothing after it, a cut tail", () => {
  const { db, log: l } = log(10);
  const at5 = l.list({ afterSeq: 4, limit: 1 })[0] as { seq: number; hash: string };
  db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");
  db.exec("DELETE FROM audit_events WHERE seq = 5");
  assert.deepEqual(l.verify({ from: { seq: at5.seq, hash: at5.hash } }), { ok: false, firstBadSeq: 5, reason: "seq_gap", checked: 0 });
  db.exec("DELETE FROM audit_events WHERE seq > 3");
  assert.deepEqual(l.verify({ from: { seq: at5.seq, hash: at5.hash } }), { ok: false, firstBadSeq: 4, reason: "truncated", checked: 0 });
});
