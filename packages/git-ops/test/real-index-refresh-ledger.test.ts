// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-0b (RR-98): the post-commit index refresh records the lock it holds, so a crash leaves a lock the startup sweep can prove
// was Axis's. Recorded right after the O_EXCL open, recorded AGAIN after git's update-index rewrote the lock (git writes
// through `index.lock.lock` and renames it over the lock: a new inode), and cleared once the lock is gone. Real repositories.
// Mutants: no record at the open, no record after the edit (the sweep would then miss the lock git rewrote), no clear, a
// refresh that goes on when the record cannot be written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { refreshIndex, type IndexLockLedger } from "../src/index.js";
import { commitOnTop, indexBytes, indexPath } from "./indexFixture.js";
import { fixture, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
type Call = { readonly op: "record"; readonly path: string; readonly ino: bigint; readonly dev: bigint } | { readonly op: "clear"; readonly path: string };

function ledger(over: Partial<IndexLockLedger> = {}): { ledger: IndexLockLedger; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ledger: {
      record: (l) => void calls.push({ op: "record", path: l.path, ino: l.ino, dev: l.dev }),
      clear: (p) => void calls.push({ op: "clear", path: p }),
      ...over,
    },
  };
}
const lockOf = (f: Fixture): string => `${indexPath(f)}.lock`;

test("a refresh records the lock at the open, records it again with git's NEW inode after the edit, and clears it after the rename", { skip: !posix }, async () => {
  const f = fixture();
  const l = ledger();
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  assert.deepEqual(await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next), { refreshed: 1 });
  assert.deepEqual(l.calls.map((c) => [c.op, c.path]), [["record", lockOf(f)], ["record", lockOf(f)], ["clear", lockOf(f)]], "kills a missing record or clear");
  const [first, second] = l.calls as [Extract<Call, { op: "record" }>, Extract<Call, { op: "record" }>];
  assert.notEqual(second.ino, first.ino, "git rewrote the lock: a new inode (kills recording only at the open)");
  assert.equal(BigInt(statSync(indexPath(f), { bigint: true }).ino), second.ino, "the second record is the file that became the index");
});

test("a refresh that stops after taking the lock clears the record; with nothing to write it never re-records", { skip: !posix }, async () => {
  const f = fixture();
  const l = ledger();
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const moved = await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next, { afterLock: () => void f.git("update-ref", "refs/heads/axis/feat", old) });
  assert.deepEqual(moved, { skipped: "head_moved" });
  assert.deepEqual(l.calls.map((c) => c.op), ["record", "clear"]);
  assert.equal(existsSync(lockOf(f)), false);
});

test("a held lock is not Axis's: nothing is recorded or cleared for it", { skip: !posix }, async () => {
  const f = fixture();
  const l = ledger();
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(lockOf(f), "someone else's\n");
  assert.deepEqual(await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next, { wait: async () => undefined }), { skipped: "locked" });
  assert.deepEqual(l.calls, [], "kills a clear of a lock Axis never took");
});

test("a record that cannot be written stops the refresh: the lock is removed and the index is byte-identical", { skip: !posix }, async () => {
  const f = fixture();
  const l = ledger({ record: () => { throw new Error("the journal is read-only"); } });
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const before = indexBytes(f);
  assert.deepEqual(await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next), { skipped: "failed" }, "kills a refresh that goes on unrecorded");
  assert.deepEqual(indexBytes(f), before);
  assert.equal(existsSync(lockOf(f)), false);
});
