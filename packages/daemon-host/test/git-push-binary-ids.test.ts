// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ticket P1f: a blocked plan names each binary file by an opaque identity, and that identity (not the display text) allows it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { gitRig, gitUnavailable, type GitClient, type GitRig } from "./git-rig.js";

const SKIP = gitUnavailable();
type File = { id: string; path: string; lossy: boolean };
type Plan = { tip: string; digest: string; requiresConfirmation: boolean; blocked?: { reason: string; binaryFiles: File[]; binaryFilesTruncated: boolean } };

async function setup(t: TestContext): Promise<{ r: GitRig; c: GitClient }> {
  const r = await gitRig({ scanMode: "refuse" });
  t.after(() => r.cleanup());
  return { r, c: await r.connect("user") };
}
const planOf = async (c: GitClient, r: GitRig, extra: Record<string, unknown> = {}): Promise<Plan> => {
  const res = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin", ...extra });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.result as unknown as Plan;
};
const push = (c: GitClient, r: GitRig, p: Plan, extra: Record<string, unknown> = {}) =>
  c.rpc("axis.git", "push", { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: p.digest }, ...extra }, randomUUID());
const commitAll = (r: GitRig, message: string): void => {
  r.git("add", "-A");
  r.git("commit", "-q", "-m", message);
};

test("an id from pushPlan allows that file in pushPlan and in push, and is the same in both; another request without it stays blocked", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.write("img/a.bin", Buffer.from([0, 1, 2]));
  r.write("img/b.bin", Buffer.from([0, 3, 4]));
  commitAll(r, "two binaries");
  const first = await planOf(c, r);
  assert.equal(first.blocked?.reason, "binary_unscanned");
  assert.deepEqual(first.blocked?.binaryFiles.map((f) => [f.path, f.lossy]), [["img/a.bin", false], ["img/b.bin", false]]);
  const [a, b] = first.blocked?.binaryFiles ?? [];
  assert.ok(a !== undefined && b !== undefined && /^bin_[0-9a-f]{32}$/.test(a.id) && a.id !== b.id);
  assert.deepEqual((await planOf(c, r)).blocked?.binaryFiles, first.blocked?.binaryFiles, "the identity is stable between plans");
  // One id allows one file; the other stays listed with the same id.
  const half = await planOf(c, r, { allowedBinaryIds: [a.id] });
  assert.deepEqual(half.blocked?.binaryFiles, [b]);
  // Both: unblocked, and the tier 4 flow is reached with the same ids on push (a challenge, not a refusal).
  const ids = { allowedBinaryIds: [a.id, b.id] };
  const ok = await planOf(c, r, ids);
  assert.equal(ok.blocked, undefined);
  assert.equal((await push(c, r, ok, ids)).error?.code, "E_APPROVAL_REQUIRED");
  // The push that does not carry the ids is a different plan (it is blocked), whatever the user once saw.
  const bare = await push(c, r, ok);
  assert.equal(bare.error?.code, "E_CONFLICT");
  assert.equal((bare.error?.details as { reason?: string }).reason, "binary_unscanned");
  assert.equal(r.calls.executePush, 0);
  assert.equal(r.remoteTip(), null);
});

test("names that decode to one displayed name are three rows with three ids, all lossy, and no id allows any of them", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  const tail = Buffer.from(".bin");
  for (const b of [Buffer.from([0xff]), Buffer.from([0xfe]), Buffer.from("�")]) writeFileSync(Buffer.concat([Buffer.from(`${r.repo}/alias`), b, tail]), Buffer.from([0, 1, 2]));
  commitAll(r, "three names");
  const p = await planOf(c, r);
  const files = p.blocked?.binaryFiles ?? [];
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((f) => f.path), ["alias�.bin", "alias�.bin", "alias�.bin"]);
  assert.equal(new Set(files.map((f) => f.id)).size, 3);
  assert.ok(files.every((f) => f.lossy));
  const all = { allowedBinaryIds: files.map((f) => f.id), allowedBinaryPaths: ["alias�.bin"] };
  const q = await planOf(c, r, all);
  assert.equal(q.blocked?.reason, "binary_unscanned", "a lossy name stays blocked, by id and by path");
  assert.deepEqual(q.blocked?.binaryFiles, files);
  const res = await push(c, r, q, all);
  assert.equal((res.error?.details as { reason?: string } | undefined)?.reason, "binary_unscanned");
  assert.equal(r.supervisor.filter((m) => m["type"] === "native.confirm").length, 0);
  assert.equal(r.calls.executePush, 0);
});

test("a request that is not a set of well formed ids is invalid, and so is an id the plan never named (it allows nothing)", { skip: SKIP ?? false }, async (t) => {
  const { r, c } = await setup(t);
  r.write("a.bin", Buffer.from([0, 1]));
  commitAll(r, "binary");
  for (const bad of [["a.bin"], ["bin_zz"], [`bin_${"0".repeat(32)}`, `bin_${"0".repeat(32)}`], "bin_" + "0".repeat(32)]) {
    const res = await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin", allowedBinaryIds: bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.error?.code, "E_INVALID_ARGUMENT");
  }
  const stranger = await planOf(c, r, { allowedBinaryIds: [`bin_${"0".repeat(32)}`] });
  assert.equal(stranger.blocked?.reason, "binary_unscanned");
  assert.equal(stranger.blocked?.binaryFiles.length, 1);
});
