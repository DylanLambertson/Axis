// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PushedBases, loadPushedBases, savePushedBases, type BaseEntry } from "../src/index.js";

const T = (n: number) => String(n).padStart(64, "a");
const S = (n: number) => String(n).padStart(40, "b");
function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "axis-bases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a saved table loads back, oldest first, and no temporary file is left", async (t) => {
  const dir = scratch(t);
  const path = join(dir, "sub", "bases.json");
  const entries: BaseEntry[] = [["w1", T(1), S(1)], ["w2", T(2), S(2)]];
  await savePushedBases(path, entries);
  assert.deepEqual(loadPushedBases(path, 10), entries);
  assert.deepEqual(readdirSync(join(dir, "sub")), ["bases.json"]);
  await savePushedBases(path, [["w3", T(3), S(3)]]);
  assert.deepEqual(loadPushedBases(path, 10), [["w3", T(3), S(3)]], "a second save replaces the first");
});

test("a failed save keeps the old file and leaves no temporary file", async (t) => {
  const dir = scratch(t);
  const path = join(dir, "bases.json");
  await savePushedBases(path, [["w1", T(1), S(1)]]);
  // A directory where the file belongs makes the rename fail after the temporary file was written.
  const blocked = join(dir, "blocked.json");
  mkdirSync(blocked);
  await assert.rejects(savePushedBases(blocked, [["w1", T(1), S(1)]]));
  assert.deepEqual(readdirSync(dir).sort(), ["blocked.json", "bases.json"].sort());
  assert.deepEqual(loadPushedBases(path, 10), [["w1", T(1), S(1)]]);
  const huge: BaseEntry[] = [["w".repeat(200), T(1), S(1)]];
  for (let i = 0; i < 6000; i += 1) huge.push(["w".repeat(200), T(i), S(1)]);
  await assert.rejects(savePushedBases(path, huge), /too large/);
  assert.deepEqual(loadPushedBases(path, 10), [["w1", T(1), S(1)]], "an oversized table is not written");
});

test("load trusts nothing: missing, symlink, oversized, bad json, wrong version or any bad entry gives an empty table", (t) => {
  const dir = scratch(t);
  const path = join(dir, "b.json");
  assert.deepEqual(loadPushedBases(path, 5), []);
  const good = JSON.stringify({ v: 1, entries: [["w", T(1), S(1)]] });
  writeFileSync(path, good);
  assert.equal(loadPushedBases(path, 5).length, 1);
  const bad: unknown[] = [
    { v: 2, entries: [["w", T(1), S(1)]] },
    { entries: [] },
    { v: 1, entries: "x" },
    { v: 1, entries: [["w", T(1), S(1)], ["w", "short", S(1)]] },
    { v: 1, entries: [["w", T(1), "XYZ"]] },
    { v: 1, entries: [["w", T(1), S(1).toUpperCase()]] },
    { v: 1, entries: [["w\n", T(1), S(1)]] },
    { v: 1, entries: [["", T(1), S(1)]] },
    { v: 1, entries: [["w", T(1), S(1), "extra"]] },
    { v: 1, entries: [["w", 1, S(1)]] },
    [],
    null,
  ];
  for (const doc of bad) {
    writeFileSync(path, JSON.stringify(doc));
    assert.deepEqual(loadPushedBases(path, 5), [], JSON.stringify(doc));
  }
  writeFileSync(path, "{not json");
  assert.deepEqual(loadPushedBases(path, 5), []);
  writeFileSync(path, good + " ".repeat((1 << 20) + 1));
  assert.deepEqual(loadPushedBases(path, 5), [], "over the size bound");
  writeFileSync(path, good + " ".repeat(1 << 19));
  assert.equal(loadPushedBases(path, 5).length, 1, "under the size bound");
  const target = join(dir, "real.json");
  writeFileSync(target, good);
  const link = join(dir, "link.json");
  try {
    symlinkSync(target, link);
    assert.deepEqual(loadPushedBases(link, 5), [], "a symlink is not followed");
  } catch (e) {
    if ((e as { code?: string }).code !== "EPERM") throw e; // a platform without symlinks
  }
});

test("load keeps only the newest max entries", async (t) => {
  const dir = scratch(t);
  const path = join(dir, "b.json");
  await savePushedBases(path, [1, 2, 3, 4].map((n): BaseEntry => ["w", T(n), S(n)]));
  assert.deepEqual(loadPushedBases(path, 2).map((e) => e[1]), [T(3), T(4)]);
});

test("PushedBases starts from the loaded entries, stays bounded, and persists in call order", async () => {
  const saved: (readonly BaseEntry[])[] = [];
  const b = new PushedBases(2, [["w", T(1), S(1)], ["w", T(2), S(2)], ["w", T(3), S(3)]], async (e) => { saved.push(e); });
  assert.equal(b.size, 2);
  assert.equal(b.baseFor("w", T(1), "rec"), "rec", "the oldest loaded entry was dropped");
  assert.equal(b.baseFor("w", T(3), "rec"), S(3));
  b.record("w", T(4), S(4));
  await b.persist();
  assert.deepEqual(saved[0]?.map((e) => e[1]), [T(3), T(4)]);
  assert.equal(b.baseFor("w", T(4), "rec"), S(4));
  assert.equal(b.baseFor("other", T(4), "rec"), "rec", "another workspace does not share");
});

test("PushedBases never persists a malformed entry and does not load one", async () => {
  const saved: (readonly BaseEntry[])[] = [];
  const b = new PushedBases(5, [["w", "bad", S(1)]], async (e) => { saved.push(e); });
  assert.equal(b.size, 0);
  b.record("w", T(1), "not-a-sha");
  b.record("w", T(2), S(2));
  await b.persist();
  assert.deepEqual(saved[0]?.map((e) => e[1]), [T(2)]);
});

test("persist writes one at a time, in order, and a failed write rejects without stopping the next", async () => {
  let live = 0;
  let peak = 0;
  const order: number[] = [];
  let fail = true;
  const b = new PushedBases(5, [], async (e) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live -= 1;
    if (fail) { fail = false; throw new Error("disk"); }
    order.push(e.length);
  });
  b.record("w", T(1), S(1));
  const first = b.persist();
  b.record("w", T(2), S(2));
  const second = b.persist();
  await assert.rejects(first);
  await second;
  assert.equal(peak, 1);
  assert.deepEqual(order, [2], "the second write carries both entries");
  assert.equal(new PushedBases().persist() instanceof Promise, true, "no store: a resolved promise");
});
