// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PushedBases, loadPushedBases, savePushedBases } from "../src/index.js";
import { gitRig, gitUnavailable, type GitClient, type GitRig } from "./git-rig.js";

const SKIP = gitUnavailable();

async function pushed(r: GitRig, c: GitClient): Promise<{ ok?: boolean }> {
  r.write("a.txt", "hello\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "add a");
  const p = (await c.rpc("axis.git", "pushPlan", { workspaceId: r.workspaceId, remote: "origin" })).result as unknown as { tip: string; digest: string };
  const key = randomUUID();
  const body = { workspaceId: r.workspaceId, remote: "origin", confirmedPlan: { tip: p.tip, digest: p.digest } };
  const first = await c.rpc("axis.git", "push", body, key);
  const ch = (first.error?.details as { challenge: { challengeId: string; digest: string } }).challenge;
  await c.rpc("axis.approvals", "resolve", { challengeId: ch.challengeId, decision: "approve", digest: ch.digest });
  await r.confirmNative(ch.challengeId);
  while (r.approvals.stats().native.entries !== 0) await new Promise((x) => setTimeout(x, 5));
  return c.rpc("axis.git", "push", { ...body, approval: { challengeId: ch.challengeId } }, key);
}
function store(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "axis-bases-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "push-bases.v1.json");
}

test("a push is written to the base file, and a table loaded from it after a restart has the destination's base", { skip: SKIP ?? false }, async (t) => {
  const path = store(t);
  const bases = new PushedBases(8, [], (e) => savePushedBases(path, e));
  const r = await gitRig({ bases });
  t.after(() => r.cleanup());
  const res = await pushed(r, await r.connect());
  assert.equal(res.ok, true, JSON.stringify(res));
  const tip = r.remoteTip();
  const onDisk = loadPushedBases(path, 8);
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.[0], r.workspaceId);
  assert.equal(onDisk[0]?.[2], tip);
  const restarted = new PushedBases(8, onDisk);
  assert.equal(restarted.baseFor(r.workspaceId, onDisk[0]?.[1] ?? "", "recorded"), tip, "the restarted table knows this destination");
  assert.equal(restarted.baseFor(r.workspaceId, "f".repeat(64), "recorded"), "recorded", "another destination does not");
});

test("if the base file cannot be written after the push went out, the push still succeeds and the failure is reported", { skip: SKIP ?? false }, async (t) => {
  const bases = new PushedBases(8, [], async () => { throw new Error("disk full"); });
  const r = await gitRig({ bases });
  t.after(() => r.cleanup());
  const res = await pushed(r, await r.connect());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.gate.bookkeeping.length, 1);
  assert.equal(r.journal.getWorkspace(r.workspaceId)?.lastPushedSha, r.remoteTip(), "the journal write still ran after the failed base write");
  assert.equal(bases.size, 1, "the in-memory base is kept");
});
