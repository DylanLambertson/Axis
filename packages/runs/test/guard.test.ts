// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { attestTrust } from "../src/daemon-attestation.js";
import { TrustAttestation } from "../src/attestation.js";
import { flush, harness } from "./helpers.js";

const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

async function refused(h: ReturnType<typeof harness>, w: { id: string; projectId: string }, trust: unknown, why: string): Promise<void> {
  await assert.rejects(h.start(w, { trust }), (e: unknown) => e instanceof AxisError && e.code === "E_POLICY_DENIED" && e.detail["reason"] === why, why);
  assert.equal(h.pty.spawns.length, 0, why);
  assert.equal(h.journal.listRuns().length, 0, `${why}: no run row`);
  assert.equal(h.supervisor.activeCount, 0, why);
}

test("TRU-2: a start without main's attestation is refused, whatever else is passed", async () => {
  const h = harness();
  const w = h.workspace();
  const real = h.attest(w);
  await refused(h, w, undefined, "NOT_ATTESTED");
  await refused(h, w, { trusted: true }, "NOT_ATTESTED");
  await refused(h, w, true, "NOT_ATTESTED");
  await refused(h, w, structuredClone({ ...real }), "NOT_ATTESTED");
  await refused(h, w, Object.create(TrustAttestation.prototype), "NOT_ATTESTED");
  await refused(h, w, new Proxy(real, {}), "NOT_ATTESTED");
  assert.throws(() => new TrustAttestation(Symbol("guess"), { workspaceId: w.id, projectId: w.projectId, issuedAt: h.clock.now() }), code("E_POLICY_DENIED"));
  const rows = h.auditRows().filter((r) => r.action === "cli_run.refused");
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.outcome === "denied"));
});

test("an attestation is bound to its workspace and project, expires, and is single use", async () => {
  const h = harness({ limits: { attestationTtlMs: 5000 } });
  const w = h.workspace();
  const other = h.workspace();
  await refused(h, w, h.attest(other), "ATTESTATION_MISMATCH");
  await refused(h, w, attestTrust({ workspaceId: w.id, projectId: "someone-else", issuedAt: h.clock.now() }), "ATTESTATION_MISMATCH");
  await refused(h, w, h.attest(w, h.clock.now() - 6000), "ATTESTATION_EXPIRED");
  await refused(h, w, h.attest(w, h.clock.now() + 60_000), "ATTESTATION_EXPIRED");
  const once = h.attest(w);
  await h.start(w, { trust: once });
  await assert.rejects(h.start(w, { trust: once }), (e: unknown) => e instanceof AxisError && e.code === "E_POLICY_DENIED" && e.detail["reason"] === "ATTESTATION_USED");
  assert.equal(h.pty.spawns.length, 1);
  assert.equal(h.supervisor.activeCount, 1);
});

test("revoked trust: main mints no new attestation, so the next start is refused", async () => {
  const h = harness({ limits: { attestationTtlMs: 5000 } });
  const w = h.workspace();
  const { run, handle } = await h.running(w);
  handle.emitExit();
  await flush();
  // Trust was revoked: main will not attest again. The only things left to present are nothing, a spent attestation,
  // or an old one.
  await assert.rejects(h.start(w, { trust: undefined }), code("E_POLICY_DENIED"));
  const old = h.attest(w, h.clock.now() - 1000);
  h.clock.t += 6000;
  await assert.rejects(h.start(w, { trust: old }), code("E_POLICY_DENIED"));
  assert.equal(h.pty.spawns.length, 1);
  assert.equal(h.supervisor.get(run.runId).state, "REVIEWING");
});

test("trust that goes stale during a slow snapshot refuses the launch just before spawn", async () => {
  const h = harness({ limits: { attestationTtlMs: 5000, snapshotTimeoutMs: 60_000 } });
  h.snapshotter.before_ = "hang";
  const w = h.workspace();
  const p = h.start(w);
  const asserted = assert.rejects(p, code("E_POLICY_DENIED"));
  await flush();
  h.clock.t += 6000;
  h.snapshotter.releaseBefore?.();
  await asserted;
  assert.equal(h.pty.spawns.length, 0);
  assert.equal(h.supervisor.list()[0]?.reason, "LAUNCH_REFUSED");
  assert.equal(h.supervisor.activeCount, 0);
});

test("an unknown, unready or unlocatable workspace is refused without a run", async () => {
  const h = harness();
  const w = h.workspace();
  await assert.rejects(h.start({ id: "no-such-workspace", projectId: "p" }), code("E_NOT_FOUND"));
  h.journal.transitionWorkspace(w.id, "REMOVING");
  await assert.rejects(h.start(w), code("E_CONFLICT"));
  assert.equal(h.pty.spawns.length, 0);
});

test("a malformed request is refused by shape", async () => {
  const h = harness();
  const w = h.workspace();
  for (const bad of [null, undefined, "x", { workspaceId: "", agent: {}, actor: "user", trust: h.attest(w) }, { workspaceId: w.id, agent: {}, actor: "root", trust: h.attest(w) }]) {
    await assert.rejects(h.supervisor.start(bad as never), code("E_INVALID_ARGUMENT"));
  }
  await assert.rejects(h.start(w, { idempotencyKey: "not-a-uuid" }), code("E_INVALID_ARGUMENT"));
});

test("commit and push guard: active from reservation to the confirmed end of the process", async () => {
  const h = harness({ limits: { graceMs: 1000 } });
  h.pty.mode = "hang";
  const w = h.workspace();
  assert.equal(h.supervisor.isCliRunActive(w.tree), false);
  const p = h.start(w);
  void p.catch(() => {});
  await flush();
  assert.equal(h.supervisor.isCliRunActive(w.tree), true, "starting, spawn pending");
  const handle = h.pty.makeHandle();
  h.pty.pending[0]?.resolve(handle);
  await p;
  assert.equal(h.supervisor.isCliRunActive(w.tree), true, "running");
  assert.equal(h.supervisor.hasActiveRun(w.id), true);
  const other = h.workspace();
  assert.equal(h.supervisor.isCliRunActive(other.tree), false, "another workspace is unaffected");
  const runId = h.supervisor.list()[0]?.runId ?? "";
  h.supervisor.stop(runId, "user");
  assert.equal(h.supervisor.isCliRunActive(w.tree), true, "stopping");
  handle.emitExit({ exitCode: null, signal: "SIGINT" });
  await flush();
  assert.equal(h.supervisor.isCliRunActive(w.tree), false, "exited");
  assert.equal(h.supervisor.hasActiveRun(w.id), false);
});

test("the guard compares paths with case and Unicode folding, and a reference it cannot read counts as active", async () => {
  const h = harness();
  const w = h.workspace();
  await h.start(w);
  const t = w.tree;
  assert.equal(h.supervisor.isCliRunActive({ workTree: t.workTree.toUpperCase() + "/", gitDir: "/else" }), true);
  assert.equal(h.supervisor.isCliRunActive({ workTree: "/else", gitDir: t.gitDir }), true, "the git dir matches too");
  assert.equal(h.supervisor.isCliRunActive({ workTree: "/else", gitDir: "/other" }), false);
  for (const bad of [null, undefined, "x", {}, { workTree: 1, gitDir: 2 }, { workTree: "", gitDir: "" }]) {
    assert.equal(h.supervisor.isCliRunActive(bad as never), true);
  }
  const nfc = harness();
  const w2 = nfc.workspace();
  nfc.trees.set(w2.id, { workTree: "/work/caf\u00e9", gitDir: "/g/caf\u00e9" });
  await nfc.start(w2);
  assert.equal(nfc.supervisor.isCliRunActive({ workTree: "/work/cafe\u0301", gitDir: "/x" }), true);
});

test("a git operation lease blocks new runs, expires, and is refused while a run is active", async () => {
  const h = harness();
  const w = h.workspace();
  const lease = h.supervisor.acquireGitOperation(w.tree, { maxMs: 1000 });
  await assert.rejects(h.start(w), (e: unknown) => e instanceof AxisError && e.code === "E_CONFLICT" && e.detail["reason"] === "GIT_OPERATION_ACTIVE");
  assert.equal(h.pty.spawns.length, 0);
  lease.release();
  lease.release();
  assert.equal(h.clock.pending, 0);
  const l2 = h.supervisor.acquireGitOperation(w.tree, { maxMs: 1000 });
  assert.equal(l2.held, true);
  l2.assertHeld();
  await h.clock.advance(1000);
  // A lapsed lease is not dropped (git may still be running): new runs stay refused and the holder is told.
  assert.equal(l2.held, false);
  assert.throws(() => l2.assertHeld(), code("E_CONFLICT"));
  await assert.rejects(h.start(w), (e: unknown) => e instanceof AxisError && e.detail["reason"] === "GIT_OPERATION_ACTIVE");
  l2.release();
  await h.start(w);
  assert.throws(() => h.supervisor.acquireGitOperation(w.tree), code("E_CONFLICT"));
  assert.throws(() => h.supervisor.acquireGitOperation(w.tree, { maxMs: 0 }), code("E_INVALID_ARGUMENT"));
  assert.throws(() => h.supervisor.acquireGitOperation({} as never), code("E_INVALID_ARGUMENT"));
});

test("the lease table is bounded and dispose clears it", () => {
  const h = harness();
  for (let i = 0; i < 64; i++) h.supervisor.acquireGitOperation({ workTree: `/w/${i}`, gitDir: `/g/${i}` });
  assert.throws(() => h.supervisor.acquireGitOperation({ workTree: "/w/x", gitDir: "/g/x" }), code("E_BACKPRESSURE"));
  h.supervisor.dispose();
  assert.equal(h.clock.pending, 0);
});
