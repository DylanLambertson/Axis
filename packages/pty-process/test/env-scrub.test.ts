// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PtySpawnError } from "../src/index.js";
import { settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const DENIED = ["VSCODE_NONCE", "VSCODE_GIT_ASKPASS_NODE", "ELECTRON_RUN_AS_NODE", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EDITOR", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "AXIS_INTERNAL"];

for (const name of DENIED) {
  test(`PTY-5/6: a spawn whose environment holds ${name} is refused and nothing is started`, async () => {
    const r = rig();
    await assert.rejects(r.port.spawn({ ...SPEC, env: { ...SPEC.env, [name]: "x" } }), (e: unknown) => e instanceof PtySpawnError && e.code === "env_denied");
    assert.equal(r.requests.length, 0);
    assert.equal(r.clock.timers.size, 0, "the timer is cleared on settle");
  });
}

test("PTY-5: a lower-case denied name is refused whatever its case", async () => {
  const r = rig();
  await assert.rejects(r.port.spawn({ ...SPEC, env: { vscode_nonce: "x" } }), (e: unknown) => e instanceof PtySpawnError && e.code === "env_denied");
  assert.equal(r.requests.length, 0);
});

test("PTY-5: names with '=' or a NUL value are refused", async () => {
  const r = rig();
  await assert.rejects(r.port.spawn({ ...SPEC, env: { "A=B": "x" } }), (e: unknown) => e instanceof PtySpawnError && e.code === "env_denied");
  await assert.rejects(r.port.spawn({ ...SPEC, env: { OK: "a\0b" } }), (e: unknown) => e instanceof PtySpawnError && e.code === "env_denied");
  assert.equal(r.requests.length, 0);
});

test("PTY-5: a clean environment reaches the child exactly as given (SSH_AUTH_SOCK kept, nothing added, no nonce)", async () => {
  const r = rig();
  await r.port.spawn(SPEC);
  assert.equal(r.requests.length, 1);
  const req = r.requests[0];
  assert.deepEqual(req?.env, SPEC.env);
  assert.deepEqual(req?.argv, SPEC.argv);
  assert.equal(req?.cwd, SPEC.cwd);
  assert.equal("VSCODE_NONCE" in (req?.env ?? {}), false);
});

test("a refusal names no environment value in the host's error", async () => {
  const r = rig();
  const err = await r.port.spawn({ ...SPEC, env: { VSCODE_NONCE: "canary-value-1" } }).catch((e: unknown) => e as Error);
  assert.ok(!String((err as Error).message).includes("canary-value-1"));
  await settle();
  assert.ok(!JSON.stringify(r.pair.sent.b).includes("canary-value-1"));
});
