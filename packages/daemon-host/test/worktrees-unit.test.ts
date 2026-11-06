// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { test } from "node:test";
import * as path from "node:path";
import { DaemonError } from "@axis/daemon";
import { AxisError } from "@axis/audit";
import { newKey } from "./approvals-rig.js";
import { ProjectMutex, toDaemonError, fromWorktreeError, workspaceSlug } from "../src/index.js";
import { worktreesCapability } from "../src/gate/worktrees-confirm.js";
import { finaliseApproved, createWs, gitSkipReason, worktreesRig } from "./worktrees-rig.js";
import { wait } from "./helpers.js";

const skip = gitSkipReason();
const ok = (_m: "create", x: Parameters<typeof toDaemonError>[0] & { ok?: boolean; error?: unknown }) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x as never);

test("ProjectMutex: serial per key, parallel across keys, re-entrant in the chain, released on error and abort", async () => {
  const m = new ProjectMutex();
  const order: string[] = [];
  const a = m.run("p", async () => (order.push("a1"), await wait(20), order.push("a2")));
  const b = m.run("p", async () => void order.push("b"));
  const other = m.run("q", async () => void order.push("q"));
  await Promise.all([a, b, other]);
  assert.deepEqual(order.filter((x) => x !== "q"), ["a1", "a2", "b"]);
  assert.ok(order.indexOf("q") < order.indexOf("a2"), "another key is not blocked");
  await m.run("p", async () => m.run("p", async () => order.push("inner")));
  await assert.rejects(m.run("p", () => Promise.reject(new Error("x"))));
  await m.run("p", async () => undefined);
  const c = new AbortController();
  const hold = m.run("p", () => wait(30));
  const waiting = m.run("p", async () => order.push("never"), c.signal);
  c.abort();
  await assert.rejects(waiting);
  await hold;
  assert.equal(order.includes("never"), false);
  assert.equal(m.size, 0, "no entry is left behind");
});

test("workspaceSlug: reduced to the package's slug pattern with a suffix", () => {
  const random = { bytes: (n: number) => Uint8Array.from({ length: n }, () => 171), uuid: () => "" };
  for (const name of ["Fix the Parser!", "  ", "日本語", "a".repeat(80), "--x--"]) {
    const s = workspaceSlug(name, random);
    assert.match(s, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, name);
    assert.ok(s.endsWith("-ababab"));
  }
});

test("worktreesCapability: only finalise and remove of axis.worktrees/1, bound to the approved target; a mismatch is refused", () => {
  const digest = "a".repeat(64);
  const input = (method: string, id: unknown, contract = "axis.worktrees") =>
    ({ contract, contractVersion: 1, method, args: { id }, digest: "d", tier: 4 }) as never;
  const content = { target: "workspace:ws-1", contentDigest: digest };
  assert.notEqual(worktreesCapability(input("remove", "ws-1"), content), undefined);
  assert.notEqual(worktreesCapability(input("finalise", "ws-1"), content), undefined);
  assert.equal(worktreesCapability(input("create", "ws-1"), content), undefined);
  // Below tier 4 there was no native dialog: no token, whatever else matches.
  assert.equal(worktreesCapability({ ...(input("remove", "ws-1") as object), tier: 3 } as never, content), undefined);
  assert.equal(worktreesCapability({ ...(input("remove", "ws-1") as object), tier: undefined } as never, content), undefined);
  assert.equal(worktreesCapability(input("remove", "ws-1", "axis.git"), content), undefined);
  assert.throws(() => worktreesCapability(input("remove", "ws-2"), content));
  assert.throws(() => worktreesCapability(input("remove", "ws-1"), { target: "request:" + digest, contentDigest: digest }));
  assert.throws(() => worktreesCapability(input("remove", "ws-1"), { ...content, contentDigest: "short" }));
  const a = worktreesCapability(input("remove", "ws-1"), content);
  const b = worktreesCapability(input("remove", "ws-1"), content);
  assert.notEqual(a, b, "every spend gets its own single-use token");
});

test("errors: closed codes, fixed texts, nothing from the cause", () => {
  const nasty = "/home/u/secret-repo ghp" + "_" + "Ab1".repeat(12);
  for (const e of [new Error(nasty), new AxisError("E_INTERNAL", nasty), new AxisError("E_POLICY_DENIED", nasty), "x", null]) {
    const d = toDaemonError(e);
    assert.equal(d.code, "E_INTERNAL");
    assert.ok(!d.message.includes("secret"));
  }
  const c = toDaemonError(new AxisError("E_CONFLICT", nasty, { state: nasty }));
  assert.equal(c.code, "E_CONFLICT");
  assert.ok(!JSON.stringify([c.message, c.details]).includes("secret"));
  assert.equal(fromWorktreeError("E_POLICY_DENIED", "git-drift").code, "E_CONFLICT", "only the daemon may say E_POLICY_DENIED");
  assert.deepEqual(fromWorktreeError("E_CONFLICT", "git-drift").details, { reason: "git_drift" });
  assert.equal(fromWorktreeError("E_CONFLICT", nasty).details, undefined, "an unknown reason is dropped");
  const same = new DaemonError("E_NOT_FOUND", "kept");
  assert.equal(toDaemonError(same), same);
});

test("a snapshot refused by the REF-1 secret scan reaches the wire as its own closed reason, with fixed text", () => {
  for (const [pkg, wire] of [["snapshot-secret", "snapshot_secret"], ["snapshot-unscanned", "snapshot_unscanned"]] as const) {
    const d = fromWorktreeError("E_POLICY_DENIED", pkg);
    assert.equal(d.code, "E_CONFLICT");
    assert.deepEqual(d.details, { reason: wire });
    assert.match(d.message, /no snapshot was written/);
  }
});

test("a failure after the journal row leaves it FAILED and unlocked, and the error text names no path or ref", { skip }, async (t) => {
  const r = await worktreesRig({ fixedSuffix: true });
  t.after(() => r.cleanup());
  const user = await r.connect();
  r.git(r.repo, "branch", "axis/one-010203", "main");
  const res = await user.call("axis.worktrees", "create", { projectId: "proj-1", name: "One" }, newKey());
  assert.equal(res.ok, false);
  const row = r.journal.listWorkspaces({ includeRemoved: true })[0];
  assert.equal(row?.state, "FAILED");
  assert.equal(row?.lockState, "unlocked");
  assert.deepEqual(r.journal.transitions("workspace", row?.id as string).map((x) => x.to), ["CREATING", "FAILED"]);
  const text = JSON.stringify(res);
  for (const bad of [r.tmp, r.repo, r.root, "axis/one"]) assert.ok(!text.includes(bad), bad);
});

test("errors on the wire never echo a path, a ref or a secret-shaped input", { skip }, async (t) => {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const canary = "ghp" + "_" + "Ab1".repeat(12);
  const answers = [
    await user.call("axis.worktrees", "create", { projectId: "proj-1", name: "n", baseRef: canary }, newKey()),
    await user.call("axis.worktrees", "create", { projectId: canary.slice(0, 20), name: "n" }, newKey()),
    await user.call("axis.worktrees", "status", { ids: [canary.slice(0, 30)] }),
    await finaliseApproved(r, user, "ws-missing", "archived"),
  ];
  for (const a of answers) {
    assert.equal(a.ok, false);
    const text = JSON.stringify(a);
    for (const bad of [r.tmp, r.repo, r.root, canary, canary.slice(0, 20), "ws-missing"]) assert.ok(!text.includes(bad), bad);
  }
});

test("locator: unknown, removed, moved, symlinked and outside-the-root worktrees are all E_NOT_FOUND", { skip }, async (t) => {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user, ok);
  const dir = String(r.journal.getWorkspace(id)?.worktreePath);
  const found = await r.binding.locator.locate(id);
  assert.equal(found.workTree, dir);
  assert.ok(found.gitDir.includes("worktrees"));
  await assert.rejects(r.binding.locator.locate("ws-unknown"), (e: unknown) => e instanceof DaemonError && e.code === "E_NOT_FOUND");
  await assert.rejects(r.binding.locator.locate("../x"));
  // Swap the directory for a symlink to another place: the recorded path no longer names itself.
  const elsewhere = path.join(r.tmp, "elsewhere");
  r.git(dir, "worktree", "list");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, dir);
  await assert.rejects(r.binding.locator.locate(id), (e: unknown) => e instanceof DaemonError && e.code === "E_NOT_FOUND" && !e.message.includes(r.tmp));
  rmSync(dir);
  await assert.rejects(r.binding.locator.locate(id), (e: unknown) => e instanceof DaemonError && e.code === "E_NOT_FOUND");
});
