// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Lock guard review 2 (N3, N4), real repositories:
// - a copy that fails half-way is removed by Axis itself (no reliance on libuv), but a file planted at the copy's name (EEXIST)
//   is not Axis's and stays;
// - the `.lock` git's child leaves beside the private copy when it is killed is removed;
// - an all-zero trailing checksum is accepted only when the original index had one too, or `index.skipHash` is set.
// Mutants: no removal after a failed copy, a removal that ignores EEXIST, no removal of the copy's lock, a zero checksum always
// accepted, a zero checksum accepted only by the config (or only by the original).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { refreshIndex } from "../src/index.js";
import { commitOnTop, entries, headEntries, indexBytes, indexPath } from "./indexFixture.js";
import { fixture, stage, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";
const copies = (f: Fixture): string[] => readdirSync(f.wt.gitDir).filter((n) => n.startsWith("index.axis-"));
const enospc = (): Error => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
const zeroTrailer = (path: string, n: number): void => {
  const bytes = readFileSync(path);
  bytes.fill(0, bytes.length - n);
  writeFileSync(path, bytes);
};
const trailerIsZero = (f: Fixture): boolean => indexBytes(f).subarray(-20).every((b) => b === 0);

test("N4: a copy that fails half-way (ENOSPC) leaves no index.axis-* behind, and the index and the lock are as before", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  const before = indexBytes(f);
  const r = await refreshIndex(f.deps, f.wt, old, next, {
    copy: async (from, to) => {
      writeFileSync(to, readFileSync(from).subarray(0, 20));
      throw enospc();
    },
  });
  assert.deepEqual(r, { skipped: "failed" });
  assert.deepEqual(indexBytes(f), before);
  assert.deepEqual(copies(f), [], "kills relying on the copy call to clean up after itself");
  assert.equal(existsSync(`${indexPath(f)}.lock`), false);
});

test("N4: a file already at the copy's name (EEXIST) is not Axis's and is kept", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  let planted = "";
  const r = await refreshIndex(f.deps, f.wt, old, next, {
    copy: async (_from, to) => {
      planted = to;
      writeFileSync(to, "not Axis's\n");
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    },
  });
  assert.deepEqual(r, { skipped: "failed" });
  assert.equal(readFileSync(planted, "utf8"), "not Axis's\n", "kills removing a file Axis did not create");
});

test("N4: the lock git's child leaves beside the private copy is removed", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next, { afterUpdate: (result) => writeFileSync(`${result}.lock`, "a killed git's lock\n") });
  assert.deepEqual(r, { refreshed: 1 });
  assert.deepEqual(copies(f), [], "kills leaving index.axis-*.lock");
});

test("N3: a zero checksum on the result is refused when the original index had a real one and index.skipHash is not set", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  const before = indexBytes(f);
  const r = await refreshIndex(f.deps, f.wt, old, next, { afterUpdate: (result) => zeroTrailer(result, 20) });
  assert.deepEqual(r, { skipped: "failed" }, "kills accepting any zero checksum");
  assert.deepEqual(indexBytes(f), before);
  assert.deepEqual(copies(f), []);
});

test("N3: with index.skipHash set, git's own zero checksum is accepted although the original index had a real one", { skip: !posix }, async () => {
  const f = fixture();
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  assert.equal(trailerIsZero(f), false);
  f.git("config", "index.skipHash", "true");
  const r = await refreshIndex(f.deps, f.wt, old, next);
  assert.deepEqual(r, { refreshed: 1 }, "kills accepting a zero checksum only when the original had one");
  assert.equal(trailerIsZero(f), true, "git wrote the zero checksum itself");
  assert.deepEqual(entries(f), headEntries(f));
});

test("N3: a zero checksum is accepted when the original index had one too (index.skipHash since turned off)", { skip: !posix }, async () => {
  const f = fixture();
  f.git("config", "index.skipHash", "true");
  stage(f, "c.txt", "c\n");
  f.git("commit", "-q", "-m", "c");
  assert.equal(trailerIsZero(f), true, "the original index has a zero checksum");
  f.git("config", "index.skipHash", "false");
  const { old, next } = commitOnTop(f, { "b.txt": "b\n" });
  const r = await refreshIndex(f.deps, f.wt, old, next, { afterUpdate: (result) => zeroTrailer(result, 20) });
  assert.deepEqual(r, { refreshed: 1 }, "kills accepting a zero checksum only by the config");
  assert.deepEqual(entries(f), headEntries(f));
});
