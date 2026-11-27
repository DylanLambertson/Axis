// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit A, L1 (plugin-grant-contract.md section 2: a decrease applies at once): a revoke or a disable is applied at once even while
// a plugin's approved start holds the project mutex across its slow waits, and the start is then refused at its next grant check.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PLUGIN_ATT, reason, setup, until, type Row, type Setup } from "./plugin-start-rig.js";

/** An approved plugin start paused inside the trust gate, which the handler awaits while it holds the project mutex. */
async function heldStart(t: Parameters<typeof setup>[0]) {
  let release: (() => void) | undefined;
  let entered = false;
  const s: Setup = await setup(t, {
    admit: () =>
      new Promise<void>((r) => {
        entered = true;
        release = r;
      }),
  });
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  const key = randomUUID();
  const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
  const digest = ((await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[])[0]?.["digest"];
  await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest });
  const started = plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
  await until(() => entered, "the start holding the mutex inside the trust gate");
  return { s, user, started, release: () => (release as () => void)() };
}

for (const decrease of ["revoke", "disable"] as const) {
  test(`a ${decrease} applies at once while an approved plugin start holds the project mutex; the start is then refused`, async (t) => {
    const { s, user, started, release } = await heldStart(t);
    const args = decrease === "revoke" ? { projectId: "p1", pluginId: "acme.board", permission: "runs.start" } : { projectId: "p1", pluginId: "acme.board" };
    let answered: { ok?: boolean } | undefined;
    void user.call("axis.plugins", decrease, args, randomUUID()).then((m) => (answered = m));
    await until(() => answered !== undefined, `the ${decrease}'s answer while the start still holds the mutex`, 3000);
    assert.equal(answered?.ok, true, JSON.stringify(answered));
    const state = s.journal.plugins.state("acme.board", "p1");
    assert.equal(decrease === "revoke" ? state?.permissions.includes("runs.start") : state?.enabled, false, "applied now");
    release();
    const done = await started;
    assert.equal(done.error?.code, "E_CONFLICT");
    assert.equal(reason(done), "grant_changed");
    assert.equal(s.starts.length, 0);
  });
}
