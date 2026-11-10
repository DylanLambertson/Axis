// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// WT-3 in diff review (ticket C11): the closed flag, protected files first, and the flag in the acknowledgement binding.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { brokerProtectedPaths } from "../src/bindings/review-protected.js";
import type { ReviewRound, ReviewService, RoundFile } from "../src/index.js";
import { files, gitUnavailable, reviewRig, sha256, type Client, type ReviewRig } from "./review-rig.js";

const SKIP = gitUnavailable();
const OID = "e".repeat(40);

async function setup(t: TestContext, review: (real: ReviewService) => ReviewService): Promise<{ r: ReviewRig; c: Client }> {
  const r = await reviewRig({ review });
  t.after(() => r.cleanup());
  return { r, c: await r.connect("user") };
}

function fake(list: RoundFile[], seen: { accepted: Array<[string, boolean]> } = { accepted: [] }): (real: ReviewService) => ReviewService {
  return () => ({
    async open(): Promise<ReviewRound> {
      return {
        head: "a".repeat(40), branch: "axis/feat", files: list, skipped: [], skippedCount: 0,
        async hasCutLines(p) { return p.startsWith("cut"); },
        accept(p, o) { seen.accepted.push([p, o.acceptTruncated]); },
        async build() { return { reviewedTree: "c".repeat(40), head: "a".repeat(40), branch: "axis/feat", handle: {} as never }; },
      };
    },
  });
}
const file = (path: string, over: Partial<RoundFile> = {}): RoundFile => ({ path, status: "A", kind: "text", newMode: "100644", newOid: "b".repeat(40), unsafePath: false, protectedRules: [], warnings: [], ...over });

test("protected files are flagged and listed first; the review's order is kept inside each group", { skip: SKIP ?? false }, async (t) => {
  const list = [file("a.txt"), file("b.txt", { protectedRules: ["Makefile"] }), file("c.txt"), file("d.txt", { protectedRules: ["matcher-error"] }), file("e.txt")];
  const { r, c } = await setup(t, fake(list));
  const res = await c.call("diff", { workspaceId: r.workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const rows = files(res);
  assert.deepEqual(rows.map((f) => f["protectedPath"]), [true, true, false, false, false]);
  assert.deepEqual(rows.map((f) => f["fileId"]), await Promise.all(["b.txt", "d.txt", "a.txt", "c.txt", "e.txt"].map((p) => sha256(p))));
  assert.deepEqual(rows[1]?.["protectedRules"], ["matcher-error"], "a matcher that threw counts as protected");
});

test("the flag is part of what an acknowledgement names: it does not carry to a response without the flag", { skip: SKIP ?? false }, async (t) => {
  const seen = { accepted: [] as Array<[string, boolean]> };
  const flagged = await setup(t, fake([file("cut.yml", { newOid: OID, protectedRules: ["ci"] })], seen));
  const id = await sha256("cut.yml");
  const plain = await sha256(`100644 ${OID}`);
  const protectedId = await sha256(`100644 ${OID} protected`);
  const first = await flagged.c.call("diff", { workspaceId: flagged.r.workspaceId });
  const row = files(first)[0];
  assert.equal(row?.["contentId"], protectedId, "a protected cut file is acknowledged as protected");
  assert.equal(first.result?.["treeHash"], null);
  // The acknowledgement a client would have made for the same file shown WITHOUT the flag does not apply.
  const dropped = await flagged.c.call("diff", { workspaceId: flagged.r.workspaceId, acknowledged: [{ fileId: id, contentId: plain }] });
  assert.equal(files(dropped)[0]?.["acknowledged"], false);
  assert.equal(dropped.result?.["treeHash"], null);
  assert.deepEqual(seen.accepted, []);
  const ok = await flagged.c.call("diff", { workspaceId: flagged.r.workspaceId, acknowledged: [{ fileId: id, contentId: protectedId }] });
  assert.equal(files(ok)[0]?.["acknowledged"], true);
  assert.equal(ok.result?.["treeHash"], "c".repeat(40));
  assert.deepEqual(seen.accepted, [["cut.yml", true]]);

  // The other way: an acknowledgement made while the file was protected does not apply once the flag is gone.
  const gone = await setup(t, fake([file("cut.yml", { newOid: OID })], seen));
  const after = await gone.c.call("diff", { workspaceId: gone.r.workspaceId, acknowledged: [{ fileId: id, contentId: protectedId }] });
  assert.equal(files(after)[0]?.["contentId"], plain);
  assert.equal(files(after)[0]?.["acknowledged"], false);
  assert.equal(after.result?.["treeHash"], null);
});

test("the broker matcher flags the spellings the broker gates, and nothing else", () => {
  const hit = (p: string): boolean => brokerProtectedPaths.match(p).length > 0;
  for (const p of [
    ".github/workflows/ci.yml", ".GitHub/Workflows/CI.yml", ".github./workflows/x.yml", ".github /x", "sub/Makefile", "SUB/MAKEFILE.", "a/b/package.json", ".vscode/tasks.json",
    "x.code-workspace", ".git/hooks/pre-commit", "sub/.GIT/config", ".h​usky/pre-commit", ".github\\workflows\\x.yml", "./.github/x", "a//.npmrc", "Ｍakefile",
  ]) assert.equal(hit(p), true, p);
  for (const p of ["src/index.ts", "docs/makefile/readme.md", "docs/github/x.md", "README.md", "a/package.json.bak"]) assert.equal(hit(p), false, p);
  assert.equal(brokerProtectedPaths.match(".git/config")[0]?.rule, ".git");
});

test("end to end with real git and no matcher given: a workflow, a hook and a Makefile written in the worktree lead the reply", { skip: SKIP ?? false }, async (t) => {
  const r = await reviewRig();
  t.after(() => r.cleanup());
  const c = await r.connect("user");
  r.write("a-first.txt", "plain\n");
  r.write("sub/Makefile", "all:\n");
  r.write("z-last.txt", "plain\n");
  r.write(".GitHub/workflows/ci.yml", "on: push\n");
  const res = await c.call("diff", { workspaceId: r.workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const rows = files(res);
  assert.deepEqual(rows.map((f) => [f["displayPath"], f["protectedPath"]]), [[".GitHub/workflows/ci.yml", true], ["sub/Makefile", true], ["a-first.txt", false], ["z-last.txt", false]]);
  assert.deepEqual(rows[0]?.["protectedRules"], [".github"]);
});
