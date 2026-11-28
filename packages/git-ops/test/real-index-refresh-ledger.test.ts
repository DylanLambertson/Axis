// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-0b (RR-98): the post-commit index refresh records the lock it holds, so a crash leaves a lock the startup sweep can prove
// was Axis's. The lock is held open and never written (git edits a private copy), so its identity never changes: it is
// recorded ONCE, right after the O_EXCL open, with its dev, inode and ctime, and the record is cleared once the lock is gone.
// Real repositories. Mutants: no record at the open, a record taken from another file, no clear, a refresh that goes on when
// the record cannot be written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { refreshIndex, type IndexLockLedger } from "../src/index.js";
import { commitOnTop, indexBytes, indexPath } from "./indexFixture.js";
import { fixture, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
type Rec = Parameters<IndexLockLedger["record"]>[0];
type Call = { readonly op: "record"; readonly rec: Rec } | { readonly op: "clear"; readonly path: string };

function ledger(over: Partial<IndexLockLedger> = {}): { ledger: IndexLockLedger; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ledger: {
      record: (rec) => void calls.push({ op: "record", rec: { ...rec } }),
      clear: (p) => void calls.push({ op: "clear", path: p }),
      ...over,
    },
  };
}
const lockOf = (f: Fixture): string => `${indexPath(f)}.lock`;
const copies = (f: Fixture): string[] => readdirSync(f.wt.gitDir).filter((n) => n.startsWith("index.axis-"));

test("a refresh records the lock once, at the open, as the very file held until the rename (dev, inode, ctime), and clears it after", { skip: !posix }, async () => {
  const f = fixture();
  const l = ledger();
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const seen: { at: string; dev: bigint; ino: bigint; ctimeNs: bigint }[] = [];
  const look = (at: string) => () => {
    const st = lstatSync(lockOf(f), { bigint: true });
    seen.push({ at, dev: st.dev, ino: st.ino, ctimeNs: st.ctimeNs });
  };
  const r = await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next, { afterLock: look("afterLock"), beforeRename: look("beforeRename") });
  assert.deepEqual(r, { refreshed: 1 });
  assert.deepEqual(l.calls.map((c) => c.op), ["record", "clear"], "kills a missing record or clear, and a second record");
  const [rec, clear] = l.calls as [Extract<Call, { op: "record" }>, Extract<Call, { op: "clear" }>];
  assert.equal(rec.rec.path, lockOf(f));
  assert.equal(clear.path, lockOf(f));
  for (const s of seen) assert.deepEqual({ dev: rec.rec.dev, ino: rec.rec.ino, ctimeNs: rec.rec.ctimeNs }, { dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs }, `${s.at}: the lock is unchanged and is the recorded file (kills a record of another file or time)`);
  assert.equal(seen.length, 2);
});

test("a refresh that stops after taking the lock clears the record", { skip: !posix }, async () => {
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
  writeFileSync(lockOf(f), "someone else's\n");
  assert.deepEqual(await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next, { wait: async () => undefined }), { skipped: "locked" });
  assert.deepEqual(l.calls, [], "kills a clear of a lock Axis never took");
});

test("a record that cannot be written stops the refresh: the lock is removed, no copy is made, the index is byte-identical", { skip: !posix }, async () => {
  const f = fixture();
  const l = ledger({ record: () => { throw new Error("the journal is read-only"); } });
  const { old, next } = commitOnTop(f, { "a.txt": "axis\n" });
  const before = indexBytes(f);
  assert.deepEqual(await refreshIndex({ ...f.deps, indexLockLedger: l.ledger }, f.wt, old, next), { skipped: "failed" }, "kills a refresh that goes on unrecorded");
  assert.deepEqual(indexBytes(f), before);
  assert.equal(existsSync(lockOf(f)), false);
  assert.deepEqual(copies(f), []);
});
