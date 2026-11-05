// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { createDaemonHost, createRunTrustMinter, toRunError } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { runsRig } from "./runs-rig.js";
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
  const mint = (ws: string) => r.handlerDeps.minter.attest({ workspaceId: ws, projectId: r.projectId });
  const start = (ws: string, trust: unknown) => r.runs.service.start({ workspaceId: ws, agent, actor: "user", trust: trust as never });
  const reason = async (p: Promise<unknown>): Promise<unknown> => p.then(() => "started", (e) => (e as { details?: { reason?: string } }).details?.reason);

  assert.equal(await reason(start(a, { trusted: true })), "untrusted", "a plain claim is not an attestation");
  assert.equal(await reason(start(a, mint(b))), "attestation_mismatch", "bound to its workspace");
  const stale = mint(a);
  r.clock.advance(31_000);
  assert.equal(await reason(start(a, stale)), "attestation_expired", "the attestation expires on the supervisor's clock");
  const used = mint(a);
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

test("the minter refuses malformed facts with a fixed error and stamps the host clock", () => {
  let now = 1_700_000_000_000;
  const minter = createRunTrustMinter({ now: () => now });
  for (const facts of [{ workspaceId: "", projectId: "p" }, { workspaceId: "w", projectId: "" }, { workspaceId: "w".repeat(129), projectId: "p" }]) {
    assert.throws(() => minter.attest(facts), (e: { code?: string; message?: string }) => e.code === "E_INTERNAL" && e.message === "The run operation failed.");
  }
  now = Number.NaN;
  assert.throws(() => minter.attest({ workspaceId: "w", projectId: "p" }), (e: { code?: string }) => e.code === "E_INTERNAL");
  now = 1_700_000_000_000;
  assert.ok(minter.attest({ workspaceId: "w", projectId: "p" }));
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
