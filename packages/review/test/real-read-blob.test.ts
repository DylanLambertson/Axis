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

test("the new side's exact bytes come from the snapshot entry, not from the work tree", async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.write("raw.bin", BYTES);
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  // Changed after the snapshot: the read still returns what the review would commit.
  writeFileSync(join(f.repo, "raw.bin"), "later\n");
  const blob = await s.readNewBlob("raw.bin");
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
  assert.equal((await refusal(s.readNewBlob("keep.txt"))).code, "E_INVALID_ARGUMENT");
  assert.equal((await refusal(s.readNewBlob("nope.txt"))).code, "E_NOT_FOUND");
});

test("a runner that returns decoded text instead of bytes, or a short read, is refused; a cut read is marked incomplete", async (t) => {
  for (const [name, change, expect] of [
    ["not raw", (r: GitRunResult): GitRunResult => ({ ...r, raw: false }), "E_UNAVAILABLE"],
    ["short", (r: GitRunResult): GitRunResult => ({ ...r, stdout: r.stdout.slice(1) }), "E_UNAVAILABLE"],
    ["cut", (r: GitRunResult): GitRunResult => ({ ...r, stdout: r.stdout.slice(0, 3), truncated: true }), "incomplete"],
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
    if (expect === "incomplete") {
      const blob = await s.readNewBlob("raw.bin");
      assert.deepEqual([blob.complete, blob.bytes.length, blob.size], [false, 3, BYTES.length], name);
    } else {
      assert.equal((await refusal(s.readNewBlob("raw.bin"))).code, expect, name);
    }
  }
});
