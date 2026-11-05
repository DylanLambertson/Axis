// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { files, gitUnavailable, LONG_LINE, reviewRig, sha256, type Client, type ReviewRig, type RigOptions } from "./review-rig.js";

const SKIP = gitUnavailable();

async function setup(t: TestContext, options: RigOptions = {}): Promise<{ r: ReviewRig; user: Client }> {
  const r = await reviewRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}
const diff = (user: Client, workspaceId: string, acknowledged?: unknown[]) => user.call("diff", { workspaceId, ...(acknowledged ? { acknowledged } : {}) });
const pair = (m: { result?: Record<string, unknown> }, i = 0) => {
  const f = (m.result?.["files"] as Array<Record<string, unknown>>)[i] as Record<string, unknown>;
  return { fileId: f["fileId"] as string, contentId: f["contentId"] as string };
};

test("a file the view cuts is listed truncated with a content id, and the tree is null until it is acknowledged", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("long.txt", LONG_LINE);
  const first = await diff(user, r.workspaceId);
  const [row] = files(first);
  assert.equal(row?.["truncated"], true);
  assert.equal(row?.["acknowledged"], false);
  const oid = r.git("hash-object", "long.txt").trim();
  assert.equal(row?.["contentId"], await sha256(`100644 ${oid}`), "content id is the hash of <newMode> <newOid> of the snapshot entry");
  assert.equal(first.result?.["treeHash"], null);
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.acks.length, 0);

  const second = await diff(user, r.workspaceId, [pair(first)]);
  assert.equal(files(second)[0]?.["acknowledged"], true);
  const tree = second.result?.["treeHash"] as string;
  assert.match(r.git("ls-tree", "-r", tree), /long\.txt/);
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.reviewedTreeHash, tree);
});

test("a wrong content id or a wrong file id acknowledges nothing and is not echoed", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("long.txt", LONG_LINE);
  const first = await diff(user, r.workspaceId);
  const good = pair(first);
  for (const bad of [
    { fileId: good.fileId, contentId: "0".repeat(64) },
    { fileId: "1".repeat(64), contentId: good.contentId },
    { fileId: good.fileId, contentId: good.contentId.toUpperCase() },
    { fileId: good.fileId.toUpperCase(), contentId: good.contentId },
  ]) {
    const res = await diff(user, r.workspaceId, [bad]);
    if (res.ok) {
      assert.equal(files(res)[0]?.["acknowledged"], false, JSON.stringify(bad));
      assert.equal(res.result?.["treeHash"], null);
    } else assert.equal(res.error?.code, "E_INVALID_ARGUMENT"); // a non-hex id is refused by the contract
    assert.equal(JSON.stringify(res).includes("0".repeat(64)), false);
  }
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.acks.length, 0);
  // The pair of one file does not acknowledge another.
  r.write("other.txt", LONG_LINE.replace("x", "y"));
  const two = await diff(user, r.workspaceId, [good]);
  assert.deepEqual(files(two).map((f) => f["acknowledged"]), files(two).map((f) => f["fileId"] === good.fileId));
  assert.equal(files(two).filter((f) => f["acknowledged"]).length, 1);
  assert.equal(two.result?.["treeHash"], null);
});

test("a file rewritten after the acknowledgement is not acknowledged", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("long.txt", LONG_LINE);
  const first = await diff(user, r.workspaceId);
  r.write("long.txt", `${LONG_LINE}y\n`);
  const after = await diff(user, r.workspaceId, [pair(first)]);
  assert.equal(files(after)[0]?.["truncated"], true);
  assert.equal(files(after)[0]?.["acknowledged"], false);
  assert.equal(after.result?.["treeHash"], null);
  assert.notEqual(pair(after).contentId, pair(first).contentId);
  assert.equal(r.acks.length, 0);
});

test("a mode change is a different content: the old acknowledgement does not carry", { skip: SKIP ?? false, }, async (t) => {
  if (process.platform === "win32") return t.skip("file modes are not available on this platform");
  const { r, user } = await setup(t);
  r.write("long.txt", LONG_LINE);
  const first = await diff(user, r.workspaceId);
  chmodSync(join(r.repo, "long.txt"), 0o755);
  const after = await diff(user, r.workspaceId, [pair(first)]);
  assert.equal(files(after)[0]?.["acknowledged"], false);
  assert.equal(after.result?.["treeHash"], null);
  assert.equal(pair(after).contentId, await sha256(`100755 ${r.git("hash-object", "long.txt").trim()}`));
  const ack = await diff(user, r.workspaceId, [pair(after)]);
  assert.match(r.git("ls-tree", "-r", ack.result?.["treeHash"] as string), /^100755 blob /m);
});

test("a symlink with a target the view cuts needs the acknowledgement, bound to mode 120000", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  const target = `${"d/".repeat(1500)}end`;
  try {
    symlinkSync(target, join(r.repo, "link"));
  } catch {
    return t.skip("long symlinks are not available here");
  }
  const first = await diff(user, r.workspaceId);
  const [row] = files(first);
  assert.equal(row?.["kind"], "symlink");
  assert.equal(row?.["truncated"], true);
  assert.equal(row?.["contentId"], await sha256(`120000 ${await oidOfLink(r, target)}`));
  assert.equal(first.result?.["treeHash"], null);
  const done = await diff(user, r.workspaceId, [pair(first)]);
  assert.match(r.git("ls-tree", "-r", done.result?.["treeHash"] as string), /^120000 blob [0-9a-f]+\tlink$/m);
});

async function oidOfLink(r: ReviewRig, target: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("git", ["hash-object", "--stdin"], { cwd: r.repo, env: r.genv, input: target, encoding: "utf8" }).trim();
}

test("one audit event per first application of an acknowledgement per session, with the file id only", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("long.txt", LONG_LINE);
  const first = await diff(user, r.workspaceId);
  const ack = [pair(first)];
  assert.equal(r.acks.length, 0, "an unacknowledged file writes nothing");
  await diff(user, r.workspaceId, ack);
  await diff(user, r.workspaceId, ack);
  await diff(user, r.workspaceId, ack);
  assert.equal(r.acks.length, 1, "not one per poll");
  const [event] = r.acks;
  assert.deepEqual(Object.keys(event ?? {}).sort(), ["action", "actor", "connectionId", "fileId", "workspaceId"]);
  assert.equal(event?.fileId, ack[0]?.fileId);
  assert.equal(JSON.stringify(event).includes(ack[0]?.contentId as string), false);
  assert.equal(JSON.stringify(event).includes("long.txt"), false);
  // Another connection is another session; changed content is another pair.
  const other = await r.connect();
  await diff(other, r.workspaceId, ack);
  assert.equal(r.acks.length, 2);
  writeFileSync(join(r.repo, "long.txt"), `${LONG_LINE}z\n`);
  const changed = await diff(user, r.workspaceId);
  await diff(user, r.workspaceId, [pair(changed)]);
  assert.equal(r.acks.length, 3);
});

test("an audit write that fails fails the diff closed: no tree, nothing recorded", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t, { failAudit: true });
  r.write("long.txt", LONG_LINE);
  const first = await diff(user, r.workspaceId);
  const res = await diff(user, r.workspaceId, [pair(first)]);
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.equal(r.calls.recordReviewedTree, 0);
  assert.equal(r.trees.size, 0);
});
