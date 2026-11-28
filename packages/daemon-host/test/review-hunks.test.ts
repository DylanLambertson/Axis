// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-2: axis.review/1.hunks and build over real repositories, through the composed daemon, as the client sees them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { pluginDenied } from "../src/policy/plugin-rules.js";
import { WEB_ALLOWED } from "../src/policy/rule-table-policy.js";
import { ReviewRefusal, type ReviewService } from "../src/ports/review.js";
import { gitUnavailable, reviewRig, sha256, type Client, type Msg, type ReviewRig, type RigOptions } from "./review-rig.js";

const SKIP = gitUnavailable();
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const TWO = BASE.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
const WIDTH = 1024;

async function setup(t: TestContext, options: RigOptions = {}): Promise<{ r: ReviewRig; user: Client }> {
  const r = await reviewRig(options);
  t.after(() => r.cleanup());
  r.write("a.txt", BASE);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "a");
  return { r, user: await r.connect() };
}
type Hunk = { id: string; truncated: boolean; lines: Array<{ kind: string; text: string; eol: string; truncated: boolean }> };
const hunks = async (user: Client, r: ReviewRig, path: string, workspaceId = r.workspaceId) => user.call("hunks", { workspaceId, fileId: await sha256(path) });
const hunksOf = (m: Msg): Hunk[] => (m.result?.["hunks"] ?? []) as Hunk[];
const build = (user: Client, workspaceId: string, head: string, selection: unknown[]) => user.call("build", { workspaceId, head, selection });
const blob = (r: ReviewRig, tree: string, path: string): string => r.git("cat-file", "blob", `${tree}:${path}`);
const refused = (m: Msg, code: string, reason?: string): void => {
  assert.equal(m.ok, false, JSON.stringify(m.result));
  assert.equal(m.error?.code, code, JSON.stringify(m.error));
  assert.equal(m.error?.details?.["reason"], reason, JSON.stringify(m.error));
};
async function look(user: Client, r: ReviewRig, path: string) {
  const res = await hunks(user, r, path);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return { head: res.result?.["head"] as string, fileId: res.result?.["fileId"] as string, versionId: res.result?.["versionId"] as string, hunks: hunksOf(res), res };
}

test("hunks: a two-hunk file, its version id over both sides, and HEAD; nothing is recorded", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  const v = await look(user, r, "a.txt");
  assert.equal(v.hunks.length, 2);
  assert.equal(v.head, r.git("rev-parse", "HEAD").trim());
  const oldOid = r.git("rev-parse", "HEAD:a.txt").trim();
  const newOid = r.git("hash-object", "a.txt").trim();
  const expected = createHash("sha256").update(JSON.stringify(["axis.review.version/1", "100644", oldOid, "100644", newOid, null, false]), "utf8").digest("hex");
  assert.equal(v.versionId, expected);
  assert.deepEqual(v.hunks[0]?.lines.filter((l) => l.kind !== " ").map((l) => `${l.kind}${l.text}`), ["-l2", "+L2"]);
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
});

test("hunks: an unchanged file is not in the round, and an agent cannot ask", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  refused(await hunks(user, r, "keep.txt"), "E_NOT_FOUND", "file_not_found");
  const agent = await r.connect("agent:planner");
  refused(await hunks(agent, r, "a.txt"), "E_POLICY_DENIED");
  refused(await build(agent, r.workspaceId, "a".repeat(40), [{ fileId: await sha256("a.txt"), versionId: "d".repeat(64), whole: true }]), "E_POLICY_DENIED");
});

test("hunks and build: with a policy that would allow it, the handlers still refuse an agent and open nothing", { skip: SKIP ?? false }, async (t) => {
  const { r } = await setup(t, { policy: { evaluate: () => ({ effect: "allow" }) } });
  r.write("a.txt", TWO);
  const agent = await r.connect("agent:planner");
  refused(await hunks(agent, r, "a.txt"), "E_NOT_FOUND");
  refused(await build(agent, r.workspaceId, "a".repeat(40), [{ fileId: await sha256("a.txt"), versionId: "d".repeat(64), whole: true }]), "E_NOT_FOUND");
  assert.equal(r.calls.open, 0);
});

test("hunks: whole-file reasons come from the closed set (added, binary)", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("new.txt", "fresh\n");
  r.write("bin.dat", Buffer.from([0, 1, 2, 0, 3]));
  assert.equal((await hunks(user, r, "new.txt")).result?.["fileLevelReason"], "added");
  r.git("add", "bin.dat");
  r.git("commit", "-q", "-m", "bin");
  r.write("bin.dat", Buffer.from([0, 9, 9, 0, 3]));
  assert.equal((await hunks(user, r, "bin.dat")).result?.["fileLevelReason"], "binary");
});

test("build: one hunk of two is in the tree, the other file is untouched, and the tree is registered like a diff tree", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  r.write("other.txt", "other\n");
  const v = await look(user, r, "a.txt");
  const res = await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, hunkIds: [v.hunks[0]?.id] }]);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const tree = res.result?.["treeHash"] as string;
  assert.equal(blob(r, tree, "a.txt"), BASE.replace("l2\n", "L2\n"));
  assert.throws(() => r.git("cat-file", "-e", `${tree}:other.txt`), "an unselected file is not in the tree");
  assert.deepEqual(res.result?.["selection"], [{ fileId: v.fileId, versionId: v.versionId, hunkIds: [v.hunks[0]?.id] }]);
  assert.equal(res.result?.["branch"], "axis/feat");
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.reviewedTreeHash, tree);
  assert.equal(r.trees.lookupReviewedTree(r.workspaceId, tree).parent, v.head);
  // The worktree, the index and HEAD are untouched.
  assert.equal(r.git("status", "--porcelain").trimEnd(), " M a.txt\n?? other.txt");
  // A tree built for this workspace is nothing to another one.
  const other = r.newWorkspace();
  assert.throws(() => r.trees.lookupReviewedTree(other, tree), (e: unknown) => (e as { details?: { reason?: string } }).details?.reason === "stale");
});

test("build: every hunk selected comes back whole and commits the mode change with it", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  r.git("config", "core.fileMode", "true");
  (await import("node:fs")).chmodSync(`${r.repo}/a.txt`, 0o755);
  const v = await look(user, r, "a.txt");
  const res = await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, hunkIds: v.hunks.map((h) => h.id) }]);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(res.result?.["selection"], [{ fileId: v.fileId, versionId: v.versionId, whole: true }]);
  const tree = res.result?.["treeHash"] as string;
  assert.equal(blob(r, tree, "a.txt"), TWO);
  if (process.platform !== "win32") assert.match(r.git("ls-tree", tree, "a.txt"), /^100755 /);
});

test("build: a whole-file + of one file of two", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  r.write("b.txt", "b\n");
  const v = await look(user, r, "b.txt");
  const res = await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, whole: true }]);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const tree = res.result?.["treeHash"] as string;
  assert.equal(blob(r, tree, "b.txt"), "b\n");
  assert.equal(blob(r, tree, "a.txt"), BASE, "the unselected file keeps its HEAD content");
});

test("build: a version the user did not see is stale; an exact revert is the same version", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  const v = await look(user, r, "a.txt");
  const sel = [{ fileId: v.fileId, versionId: v.versionId, hunkIds: [v.hunks[0]?.id] }];
  r.write("a.txt", `${TWO}more\n`);
  refused(await build(user, r.workspaceId, v.head, sel), "E_CONFLICT", "selection_stale");
  (await import("node:fs")).chmodSync(`${r.repo}/a.txt`, 0o755);
  r.git("config", "core.fileMode", "true");
  r.write("a.txt", TWO);
  if (process.platform !== "win32") refused(await build(user, r.workspaceId, v.head, sel), "E_CONFLICT", "selection_stale");
  (await import("node:fs")).chmodSync(`${r.repo}/a.txt`, 0o644);
  const again = await build(user, r.workspaceId, v.head, sel);
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(r.calls.recordReviewedTree, 1, "only the build that was not refused is recorded");
});

test("build: a file replaced by a symlink is another version", { skip: SKIP ?? (process.platform === "win32") }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  const v = await look(user, r, "a.txt");
  const fs = await import("node:fs");
  fs.rmSync(`${r.repo}/a.txt`);
  fs.symlinkSync("keep.txt", `${r.repo}/a.txt`);
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, whole: true }]), "E_CONFLICT", "selection_stale");
});

test("build: a forged hunk id is stale, an unknown file is not found, a moved HEAD and a foreign branch are refused", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("a.txt", TWO);
  const v = await look(user, r, "a.txt");
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, hunkIds: ["0:0000000000000000"] }]), "E_CONFLICT", "selection_stale");
  refused(await build(user, r.workspaceId, v.head, [{ fileId: await sha256("keep.txt"), versionId: v.versionId, whole: true }]), "E_NOT_FOUND", "file_not_found");
  refused(await build(user, r.workspaceId, "f".repeat(40), [{ fileId: v.fileId, versionId: v.versionId, whole: true }]), "E_CONFLICT", "head_moved");
  r.git("checkout", "-q", "-b", "axis/other");
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, whole: true }]), "E_CONFLICT", "not_head");
  r.git("checkout", "-q", "--detach");
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, whole: true }]), "E_CONFLICT", "not_head");
  assert.equal(r.calls.recordReviewedTree, 0);
});

test("build: a cut hunk needs its acknowledgement; with it the tree holds the exact bytes and one audit event is written", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  // The REV-1 bare-CR case: a final line of exactly the width plus a CR, with an earlier edit so the hunk is a partial choice.
  r.write("a.txt", BASE.replace("l2\n", "L2\n").replace("l20\n", `${"x".repeat(WIDTH)}\r`));
  const v = await look(user, r, "a.txt");
  const cut = v.hunks.find((h) => h.truncated);
  assert.ok(cut, "the final-line hunk is cut");
  const sel = (acked: boolean) => [{ fileId: v.fileId, versionId: v.versionId, hunkIds: [cut.id], ...(acked ? { acknowledgedHunkIds: [cut.id] } : {}) }];
  refused(await build(user, r.workspaceId, v.head, sel(false)), "E_CONFLICT", "truncated_hunk");
  assert.equal(r.acks.length, 0);
  const res = await build(user, r.workspaceId, v.head, sel(true));
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(blob(r, res.result?.["treeHash"] as string, "a.txt"), BASE.replace("l20\n", `${"x".repeat(WIDTH)}\r`));
  assert.deepEqual(r.acks.map((a) => [a.action, a.fileId]), [["review.acknowledge", v.fileId]]);
  assert.deepEqual(Object.keys(r.acks[0] ?? {}).sort(), ["action", "actor", "connectionId", "fileId", "workspaceId"], "no content, no hunk id, no count");
  await build(user, r.workspaceId, v.head, sel(true));
  assert.equal(r.acks.length, 1, "one event per first acknowledgement in the session");
});

test("the binding hands the acknowledgement to the core unchanged: a cut hunk accepted without it is refused there too", { skip: SKIP ?? false }, async (t) => {
  let real: ReviewService | undefined;
  const { r, user } = await setup(t, { review: (s) => ((real = s), s) });
  r.write("a.txt", BASE.replace("l2\n", "L2\n").replace("l20\n", `${"x".repeat(WIDTH)}\r`));
  await look(user, r, "a.txt");
  assert.ok(real);
  const round = await real.open(r.workspaceId, { caller: { actor: "user", connectionId: "c".repeat(22), windowId: "w" }, signal: new AbortController().signal });
  const loaded = await round.hunks("a.txt");
  assert.equal(loaded.kind, "hunks");
  const cut = loaded.kind === "hunks" ? loaded.hunks.find((h) => h.truncated) : undefined;
  assert.ok(cut);
  assert.throws(() => round.acceptHunk("a.txt", cut.id, { acceptTruncated: false }), (e: unknown) => e instanceof ReviewRefusal && e.reason === "truncated_hunk");
  round.acceptHunk("a.txt", cut.id, { acceptTruncated: true });
  assert.ok((await round.build()).reviewedTree);
});

test("build: a cut whole file needs acknowledged: true; an acknowledgement of an uncut file is not applied or audited", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("long.txt", `${"y".repeat(WIDTH + 1)}\n`);
  r.write("short.txt", "s\n");
  const long = await look(user, r, "long.txt");
  const short = await look(user, r, "short.txt");
  refused(await build(user, r.workspaceId, long.head, [{ fileId: long.fileId, versionId: long.versionId, whole: true }]), "E_CONFLICT", "truncated_hunk");
  const ok = await build(user, r.workspaceId, long.head, [{ fileId: long.fileId, versionId: long.versionId, whole: true, acknowledged: true }, { fileId: short.fileId, versionId: short.versionId, whole: true, acknowledged: true }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.deepEqual(ok.result?.["selection"], [{ fileId: long.fileId, versionId: long.versionId, whole: true, acknowledged: true }, { fileId: short.fileId, versionId: short.versionId, whole: true }]);
  assert.deepEqual(r.acks.map((a) => a.fileId), [long.fileId]);
});

test("build: hunk ids on a file that offers only a whole-file decision are refused no_hunks", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("new.txt", "fresh\n");
  const v = await look(user, r, "new.txt");
  assert.equal(v.res.result?.["fileLevelReason"], "added");
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, hunkIds: ["0:0123456789abcdef"] }]), "E_INVALID_ARGUMENT", "no_hunks");
});

test("hunks: a file over the reply's line bound is a whole-file decision, never a partial list, and can still be taken whole", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  const big = Array.from({ length: 900 }, (_, i) => `v${i}\n`).join("");
  r.write("big.txt", big);
  r.git("add", "big.txt");
  r.git("commit", "-q", "-m", "big");
  r.write("big.txt", big.replace(/^v/gm, "w"));
  const v = await look(user, r, "big.txt");
  assert.equal(v.res.result?.["fileLevelReason"], "over_view_budget");
  assert.equal(v.res.result?.["hunks"], undefined);
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, hunkIds: ["0:0123456789abcdef"] }]), "E_INVALID_ARGUMENT", "no_hunks");
  const whole = await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, whole: true }]);
  assert.equal(whole.ok, true, JSON.stringify(whole.error));
});

test("build: an audit write that fails refuses the build and records nothing", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t, { failAudit: true });
  r.write("long.txt", `${"y".repeat(WIDTH + 1)}\n`);
  const v = await look(user, r, "long.txt");
  refused(await build(user, r.workspaceId, v.head, [{ fileId: v.fileId, versionId: v.versionId, whole: true, acknowledged: true }]), "E_INTERNAL");
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
});

test("hunks and build: user only, outside every plugin grant and the web allow-list", () => {
  for (const m of ["axis.review/1.hunks", "axis.review/1.build"]) {
    assert.equal(pluginDenied(m), true, m);
    assert.equal(WEB_ALLOWED.has(m), false, m);
  }
});
