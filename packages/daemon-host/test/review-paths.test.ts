// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { files, gitUnavailable, reviewRig } from "./review-rig.js";

const SKIP = gitUnavailable();

/** A file whose name is not valid UTF-8, made with a Buffer path (some file systems refuse one). */
function writeRaw(root: string, name: number[], body: string): boolean {
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from(name)]), body);
    return true;
  } catch {
    return false;
  }
}

test("non-UTF-8 paths are unsafe rows, equal decoded paths are one row, and no tree is returned", { skip: SKIP ?? false }, async (t) => {
  const r = await reviewRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  // 0xFF and 0xFE both decode to U+FFFD, so the two names are the same string to the host.
  if (!writeRaw(r.repo, [0x62, 0xff, 0x2e, 0x74, 0x78, 0x74], "one\n") || !writeRaw(r.repo, [0x62, 0xfe, 0x2e, 0x74, 0x78, 0x74], "two\n")) return t.skip("this file system refuses non-UTF-8 names");
  r.write("fine.txt", "fine\n");
  const res = await user.call("diff", { workspaceId: r.workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const rows = files(res);
  const bad = rows.filter((f) => f["unsafePath"] === true);
  assert.equal(bad.length, 1, "the two names are folded into one row");
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((f) => f["fileId"])).size, rows.length);
  assert.equal(bad[0]?.["displayPath"], "b\uFFFD.txt");
  assert.equal(res.result?.["treeHash"], null);
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
});
