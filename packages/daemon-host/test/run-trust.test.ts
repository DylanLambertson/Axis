// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { createDaemonHost, createRunTrustMinter, toRunError } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { runsRig } from "./runs-rig.js";
import { ticketFor } from "../testing/open-gate.js";
import { createWs as createWsRaw, gitSkipReason } from "./worktrees-rig.js";
import { must } from "./helpers.js";

const skip = gitSkipReason();

test("the minter's attestation is accepted once, for its own workspace, while fresh; a plain claim is refused", { skip }, async (t) => {
  const r = await runsRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const a = (await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true), x))).id;
  const b = (await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true), x), "Other")).id;
  const agent = (r.answers.agents as unknown[])[0];
  const mint = (ws: string) => r.attest(ws);
  const start = (ws: string, trust: unknown) => r.runs.service.start({ workspaceId: ws, agent, actor: "user", trust: trust as never });
  const reason = async (p: Promise<unknown>): Promise<unknown> => p.then(() => "started", (e) => (e as { details?: { reason?: string } }).details?.reason);

  assert.equal(await reason(start(a, { trusted: true })), "untrusted", "a plain claim is not an attestation");
  assert.equal(await reason(start(a, await mint(b))), "attestation_mismatch", "bound to its workspace");
  const stale = await mint(a);
  r.clock.advance(31_000);
  assert.equal(await reason(start(a, stale)), "attestation_expired", "the attestation expires on the supervisor's clock");
  const used = await mint(a);
  assert.equal(await reason(start(a, used)), "started");
  assert.equal(await reason(start(b, used)), "attestation_used", "single use, whichever workspace it is shown for");
  assert.equal(r.pty.spawns.length, 1);
  // The refusals are closed-set errors, and nothing from the package reaches the wire.
  assert.equal(toRunError(new Error("secret /home/x")).message, "The run operation failed.");
});

test("the supervisor's run limit reaches the wire as its fixed text on E_BACKPRESSURE", () => {
  const e = toRunError(new AxisError("E_BACKPRESSURE", "raw text /home/x", { reason: "RUN_LIMIT" }));
  assert.equal(e.code, "E_BACKPRESSURE");
  assert.equal(e.message, "Too many runs are active.");
  assert.equal(toRunError(new AxisError("E_BACKPRESSURE", "other")).message, "Too many requests are waiting.");
});

test("a pre-run snapshot refusal reaches the wire with a closed reason: timeout and failure are told apart, unknown reasons are dropped", () => {
  for (const [raw, wire, text] of [
    ["SNAPSHOT_TIMEOUT", "snapshot_timeout", "The snapshot before the run did not finish in time; try again."],
    ["SNAPSHOT_FAILED", "snapshot_failed", "The snapshot before the run could not be taken."],
  ] as const) {
    const e = toRunError(new AxisError("E_UNAVAILABLE", "raw text /home/x", { reason: raw }));
    assert.deepEqual([e.code, e.message, (e as { details?: Record<string, unknown> }).details?.["reason"]], ["E_UNAVAILABLE", text, wire]);
  }
  const other = toRunError(new AxisError("E_UNAVAILABLE", "raw text /home/x", { reason: "SOMETHING_ELSE" }));
  assert.deepEqual([other.message, (other as { details?: unknown }).details], ["The run could not be started right now.", undefined]);
});

test("the minter refuses malformed facts with a fixed error and stamps the host clock", async () => {
  let now = 1_700_000_000_000;
  const mono = () => 5_000;
  const minter = createRunTrustMinter({ now: () => now, monotonic: mono });
  const ticket = (f: { workspaceId: string; projectId: string }) => ticketFor(f.projectId, f.workspaceId, mono);
  for (const facts of [{ workspaceId: "", projectId: "p" }, { workspaceId: "w", projectId: "" }, { workspaceId: "w".repeat(129), projectId: "p" }]) {
    const t = await ticket(facts);
    assert.throws(() => minter.attest(facts, t), (e: { code?: string; message?: string }) => e.code === "E_INTERNAL" && e.message === "The run operation failed.");
  }
  now = Number.NaN;
  const nan = await ticket({ workspaceId: "w", projectId: "p" });
  assert.throws(() => minter.attest({ workspaceId: "w", projectId: "p" }, nan), (e: { code?: string }) => e.code === "E_INTERNAL");
  now = 1_700_000_000_000;
  assert.ok(minter.attest({ workspaceId: "w", projectId: "p" }, await ticket({ workspaceId: "w", projectId: "p" })));
});

test("no attestation without the gate: the minter refuses a missing, forged, spent or crossed ticket (mutant: ticket not consumed)", async () => {
  const mono = () => 5_000;
  const minter = createRunTrustMinter({ now: () => 1_700_000_000_000, monotonic: mono });
  const facts = { workspaceId: "w", projectId: "p" };
  const untrusted = (e: unknown) => e instanceof AxisError && e.code === "E_POLICY_DENIED" && e.detail["reason"] === "untrusted";
  assert.throws(() => minter.attest(facts, undefined), untrusted);
  assert.throws(() => minter.attest(facts, { projectId: "p", workspaceId: "w" }), untrusted, "a structural copy is not a ticket");
  const t = await ticketFor("p", "w", mono);
  assert.ok(minter.attest(facts, t));
  assert.throws(() => minter.attest(facts, t), untrusted, "single use");
  const otherWs = await ticketFor("p", "other", mono);
  const otherProject = await ticketFor("q", "w", mono);
  assert.throws(() => minter.attest(facts, otherWs), untrusted, "bound to its workspace");
  assert.throws(() => minter.attest(facts, otherProject), untrusted, "bound to its project");
});

test("the host's real audit log keeps the cli_run.start keys and drops others", async () => {
  const fix = hostFixture();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    const audit = must(s.audit);
    audit.append({ actor: "user", action: "cli_run.start", target: "run:x", outcome: "success", payload: { runId: "r1", workspaceId: "w1", argCount: 2, extra: "dropped" } });
    const row = s.auditRead.list({ limit: 50 }).find((e) => e.action === "cli_run.start");
    const payload = row?.payload as Record<string, unknown>;
    assert.equal(payload["runId"], "r1");
    assert.equal(payload["argCount"], 2);
    assert.equal(payload["extra"], undefined);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});
