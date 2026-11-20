// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `readNewBlob` (ticket RV-CONTENT): the bytes of the snapshot tree's entry, read raw from the object store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRunRequest, GitRunResult } from "@axis/git-ops";
import { ReviewSession } from "../src/index.js";
import { fixture, refusal } from "./fixture.js";

const BYTES = Buffer.from([0x61, 0xff, 0x00, 0x1b, 0x5b, 0x6d, 0xc3, 0xa9, 0x0a]);
const WHOLE = { wholeUpTo: 1024, prefix: 1024 };

test("the new side's exact bytes come from the snapshot entry, not from the work tree", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.write("raw.bin", BYTES);
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  // Changed after the snapshot: the read still returns what the review would commit.
  writeFileSync(join(f.repo, "raw.bin"), "later\n");
  const blob = await s.readNewBlob("raw.bin", WHOLE);
  assert.deepEqual([Buffer.from(blob.bytes).equals(BYTES), blob.size, blob.complete], [true, BYTES.length, true]);
  const read = f.seen.filter((r) => r.argv.includes("cat-file") && r.argv.includes("blob")).at(-1);
  assert.equal(read?.raw, true, "asked for bytes, not decoded text");
  assert.equal(read?.argv.at(-1), s.files.find((x) => x.path === "raw.bin")?.newOid);
});

test("a deleted file, a submodule and an unknown path have nothing to read", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.git("rm", "-q", "keep.txt");
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  assert.equal((await refusal(s.readNewBlob("keep.txt", WHOLE))).code, "E_INVALID_ARGUMENT");
  assert.equal((await refusal(s.readNewBlob("nope.txt", WHOLE))).code, "E_NOT_FOUND");
});

test("the size decides the read: a whole small object, else only a prefix, and the runner is asked for no more", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.write("raw.bin", BYTES);
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  const reads = (): { maxOutput?: number }[] => f.seen.filter((r) => r.argv.includes("cat-file") && r.argv.includes("blob"));
  const cut = await s.readNewBlob("raw.bin", { wholeUpTo: BYTES.length - 1, prefix: 3 });
  assert.deepEqual([Buffer.from(cut.bytes).equals(BYTES.subarray(0, 3)), cut.size, cut.complete], [true, BYTES.length, false]);
  assert.equal(reads().at(-1)?.maxOutput, 3, "a large object: the runner keeps only the prefix");
  const whole = await s.readNewBlob("raw.bin", { wholeUpTo: BYTES.length, prefix: 3 });
  assert.deepEqual([whole.complete, whole.bytes.length, reads().at(-1)?.maxOutput], [true, BYTES.length, BYTES.length]);
  const tiny = await s.readNewBlob("raw.bin", { wholeUpTo: 0, prefix: 1000 });
  assert.deepEqual([tiny.complete, tiny.bytes.length], [true, BYTES.length], "a prefix as long as the object is the whole object");
  for (const bad of [{ wholeUpTo: -1, prefix: 3 }, { wholeUpTo: 3, prefix: 1.5 }, undefined]) {
    assert.equal((await refusal(s.readNewBlob("raw.bin", bad as never))).code, "E_INVALID_ARGUMENT");
  }
});

test("a runner that returns decoded text instead of bytes, a short read, or more than it was asked for is refused", async (t) => {
  for (const [name, change] of [
    ["not raw", (r: GitRunResult): GitRunResult => ({ ...r, raw: false })],
    ["short", (r: GitRunResult): GitRunResult => ({ ...r, stdout: r.stdout.slice(1) })],
    ["cut by the runner's own limit", (r: GitRunResult): GitRunResult => ({ ...r, stdout: r.stdout.slice(0, 3), truncated: true })],
    ["ignored the cap", (r: GitRunResult): GitRunResult => ({ ...r, stdout: r.stdout + "x", truncated: false })],
    ["cut at exactly its size", (r: GitRunResult): GitRunResult => ({ ...r, truncated: true })],
  ] as const) {
    let arm = false;
    const f = fixture({
      git: {
        runner: {
          run: async (req: GitRunRequest) => {
            const { createNodeRunner } = await import("@axis/git-ops");
            const r = await createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run(req);
            return arm && req.raw === true ? change(r) : r;
          },
        },
      },
    });
    t.after(() => f.cleanup());
    f.write("raw.bin", BYTES);
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    arm = true;
    assert.equal((await refusal(s.readNewBlob("raw.bin", { wholeUpTo: 1024, prefix: 1024 }))).code, "E_UNAVAILABLE", name);
    // A prefix read that the runner cut at exactly the planned length is what was asked for.
    if (name === "ignored the cap") assert.equal((await refusal(s.readNewBlob("raw.bin", { wholeUpTo: 0, prefix: 4 }))).code, "E_UNAVAILABLE", name);
  }
});

test("a size that is too small never makes a cut read look whole", async (t) => {
  let arm = false;
  const f = fixture({
    git: {
      runner: {
        run: async (req: GitRunRequest) => {
          const { createNodeRunner } = await import("@axis/git-ops");
          const r = await createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run(req);
          // The object store lies about the size: 3 bytes for a 9-byte object. The read itself is real.
          return arm && req.argv.includes("-s") ? { ...r, stdout: "3\n" } : r;
        },
      },
    },
  });
  t.after(() => f.cleanup());
  f.write("raw.bin", BYTES);
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  arm = true;
  assert.equal((await refusal(s.readNewBlob("raw.bin", { wholeUpTo: 1024, prefix: 1024 }))).code, "E_UNAVAILABLE");
});
