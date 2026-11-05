// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Policy } from "@axis/daemon";
import type { ReviewRound, ReviewService, RoundFile } from "../src/index.js";
import { files, gitUnavailable, reviewRig, sha256, uuid, type Client, type ReviewRig, type RigOptions } from "./review-rig.js";

const SKIP = gitUnavailable();
const allowAll: Policy = { evaluate: () => ({ effect: "allow" }) };

async function setup(t: TestContext, options: RigOptions = {}, actor = "user"): Promise<{ r: ReviewRig; c: Client }> {
  const r = await reviewRig(options);
  t.after(() => r.cleanup());
  return { r, c: await r.connect(actor) };
}

/** A round with scripted files, to drive one handler rule at a time without a repository's help. */
function fake(list: RoundFile[], seen: { hasCut: string[]; accepted: Array<[string, boolean]>; built: number } = { hasCut: [], accepted: [], built: 0 }, cut: (p: string) => boolean = () => false): (real: ReviewService) => ReviewService {
  return () => ({
    async open(): Promise<ReviewRound> {
      return {
        head: "a".repeat(40), branch: "axis/feat", files: list, skipped: [], skippedCount: 0,
        async hasCutLines(p) { seen.hasCut.push(p); return cut(p); },
        accept(p, o) { seen.accepted.push([p, o.acceptTruncated]); },
        async build() { seen.built++; return { reviewedTree: "c".repeat(40), head: "a".repeat(40), branch: "axis/feat", handle: {} as never }; },
      };
    },
  });
}
const file = (path: string, over: Partial<RoundFile> = {}): RoundFile => ({ path, status: "A", kind: "text", newMode: "100644", newOid: "b".repeat(40), unsafePath: false, protectedRules: [], warnings: [], ...over });

test("a path that holds U+FFFD is an unsafe row even if the review did not say so, and the tree is null", { skip: SKIP ?? false }, async (t) => {
  const seen = { hasCut: [] as string[], accepted: [] as Array<[string, boolean]>, built: 0 };
  const { r, c } = await setup(t, { review: fake([file("bad\uFFFDname.txt"), file("ok.txt")], seen) });
  const res = await c.call("diff", { workspaceId: r.workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const rows = files(res);
  assert.deepEqual(rows.map((f) => f["unsafePath"]), [true, false]);
  assert.equal(res.result?.["treeHash"], null);
  assert.deepEqual(seen.hasCut, ["ok.txt"], "no content is read for an unusable path");
  assert.equal(seen.built, 0);
  assert.equal(r.calls.recordReviewedTree, 0);
});

test("entries with equal path strings are folded into one unsafe row with one file id", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { review: fake([file("a\uFFFD.txt"), file("a\uFFFD.txt", { newOid: "d".repeat(40) }), file("z.txt")]) });
  const res = await c.call("diff", { workspaceId: r.workspaceId });
  const rows = files(res);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((f) => f["fileId"])).size, 2);
  assert.equal(rows[0]?.["unsafePath"], true);
  assert.equal(res.result?.["treeHash"], null);
  // Even equal strings with no replacement character are folded and marked unusable.
  const r2 = await setup(t, { review: fake([file("same.txt"), file("same.txt")]) });
  const res2 = await r2.c.call("diff", { workspaceId: r2.r.workspaceId });
  assert.deepEqual(files(res2).map((f) => f["unsafePath"]), [true]);
});

test("acceptTruncated reaches the review only for an acknowledged truncated file", { skip: SKIP ?? false }, async (t) => {
  const seen = { hasCut: [] as string[], accepted: [] as Array<[string, boolean]>, built: 0 };
  const list = [file("plain.txt"), file("cut.txt", { newOid: "e".repeat(40) }), file("cut2.txt", { newOid: "f".repeat(40) })];
  const { r, c } = await setup(t, { review: fake(list, seen, (p) => p.startsWith("cut")) });
  const id = (p: string) => sha256(p);
  const ackFor = async (p: string, oid: string) => ({ fileId: await id(p), contentId: await sha256(`100644 ${oid}`) });
  // Only one of two cut files acknowledged: nothing is accepted, nothing is built.
  const one = await c.call("diff", { workspaceId: r.workspaceId, acknowledged: [await ackFor("cut.txt", "e".repeat(40))] });
  assert.equal(one.result?.["treeHash"], null);
  assert.deepEqual(seen.accepted, []);
  assert.equal(seen.built, 0);
  // An acknowledgement of a file that is not cut changes nothing about it.
  const bogus = await ackFor("plain.txt", "b".repeat(40));
  const both = await c.call("diff", { workspaceId: r.workspaceId, acknowledged: [await ackFor("cut.txt", "e".repeat(40)), await ackFor("cut2.txt", "f".repeat(40)), bogus] });
  assert.equal(both.result?.["treeHash"], "c".repeat(40));
  assert.deepEqual(seen.accepted, [["plain.txt", false], ["cut.txt", true], ["cut2.txt", true]]);
  assert.equal(files(both)[0]?.["acknowledged"], false);
  assert.equal(r.acks.length, 2);
  assert.equal(seen.built, 1);
});

test("display strings are bounded and escaped; the raw path, mode and object id are not on the wire", { skip: SKIP ?? false }, async (t) => {
  const long = `${"d/".repeat(300)}evil‮g.txt\u0007`;
  const { r, c } = await setup(t, { review: fake([file(long, { warnings: ["w\u0007".repeat(80)], protectedRules: ["a", "b", "c", "d", "e", "f"], fileLevelReason: "r‮".repeat(200) })]) });
  const res = await c.call("diff", { workspaceId: r.workspaceId });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const [row] = files(res);
  assert.ok((row?.["displayPath"] as string).length <= 256);
  assert.doesNotMatch(JSON.stringify(res), /‮|\u0007/);
  assert.equal((row?.["protectedRules"] as unknown[]).length, 4);
  assert.equal(JSON.stringify(res).includes("b".repeat(40)), false);
  assert.equal(JSON.stringify(res).includes("100644"), false);
});

test("an agent is refused diff and complete by the policy table, before any handler or review runs", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, {}, "agent:planner");
  r.write("a.txt", "a\n");
  const run = r.newRun();
  const d = await c.call("diff", { workspaceId: r.workspaceId });
  const k = await c.call("complete", { runId: run }, uuid());
  for (const m of [d, k]) assert.equal(m.error?.code, "E_POLICY_DENIED");
  assert.deepEqual(r.calls, { recordReviewedTree: 0, transitionRun: 0, open: 0 });
  assert.equal(r.journal.getRun(run)?.state, "REVIEWING");
  assert.equal(r.trees.size, 0);
});

test("with a policy that would allow it, the handlers still refuse an agent principal", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t, { policy: allowAll }, "agent:planner");
  r.write("a.txt", "a\n");
  const run = r.newRun();
  const d = await c.call("diff", { workspaceId: r.workspaceId });
  const k = await c.call("complete", { runId: run }, uuid());
  for (const m of [d, k]) {
    assert.equal(m.ok, false);
    assert.equal(m.error?.code, "E_NOT_FOUND");
  }
  assert.deepEqual(r.calls, { recordReviewedTree: 0, transitionRun: 0, open: 0 });
  assert.equal(r.journal.getRun(run)?.state, "REVIEWING");
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.reviewedTreeHash, null);
  // The `daemon` actor is refused as well.
  const d2 = await (await r.connect("daemon")).call("complete", { runId: run }, uuid());
  assert.equal(d2.ok, false);
  assert.equal(r.journal.getRun(run)?.state, "REVIEWING");
});

test("complete moves a run in review to COMPLETED as the user, once", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const run = r.newRun();
  const key = uuid();
  const res = await c.call("complete", { runId: run }, key);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal((res.result?.["run"] as { state: string }).state, "COMPLETED");
  const last = r.journal.transitions("run", run).at(-1);
  assert.deepEqual([last?.from, last?.to, last?.actor], ["REVIEWING", "COMPLETED", "user"]);
  // The same key replays the stored answer; a new key finds the run already completed.
  const again = await c.call("complete", { runId: run }, key);
  assert.deepEqual(again.result, res.result);
  const fresh = await c.call("complete", { runId: run }, uuid());
  assert.equal(fresh.error?.code, "E_CONFLICT");
  assert.equal(r.calls.transitionRun, 1);
});

test("complete refuses a run that is not in review, an unknown run, and a missing key", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const running = r.newRun("RUNNING");
  const a = await c.call("complete", { runId: running }, uuid());
  assert.equal(a.error?.code, "E_CONFLICT");
  assert.equal(a.error?.details?.["reason"], "not_reviewing");
  assert.equal(r.journal.getRun(running)?.state, "RUNNING");
  const b = await c.call("complete", { runId: uuid() }, uuid());
  assert.equal(b.error?.code, "E_NOT_FOUND");
  const k = r.newRun();
  const noKey = await c.call("complete", { runId: k });
  assert.equal(noKey.ok, false);
  assert.equal(r.journal.getRun(k)?.state, "REVIEWING");
});

test("the file id is the hash of the whole path, so long paths that differ only at the end stay distinct", { skip: SKIP ?? false }, async (t) => {
  const prefix = "d/".repeat(300);
  const a = `${prefix}a.txt`;
  const b = `${prefix}b.txt`;
  const { r, c } = await setup(t, { review: fake([file(a), file(b)]) });
  const res = await c.call("diff", { workspaceId: r.workspaceId });
  const rows = files(res);
  assert.deepEqual(rows.map((f) => f["fileId"]), [await sha256(a), await sha256(b)]);
  assert.equal(rows[0]?.["displayPath"] === rows[1]?.["displayPath"], false, "the cut keeps the end of the path");
});
