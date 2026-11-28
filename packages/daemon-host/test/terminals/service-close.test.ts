// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md sections 3 to 6): close (plain only, idempotent, audited), attach (only an open terminal, granted to
// the named conn, audited with ids only), and the plain terminal's environment: exactly `buildPlainTerminalEnv` of the daemon's own
// environment with secret names stripped: no messaging names, no secret-looking names, the sockets and HOME and PATH kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachTerminal, closeTerminal, openTerminal, plainTerminalEnv } from "../../src/terminals/service.js";
import { FakeHandle } from "./fakes.js";
import { serviceRig } from "./service-rig.js";

const notFound = (e: unknown): boolean => (e as { code?: unknown }).code === "E_NOT_FOUND";

async function opened() {
  const r = serviceRig();
  const p = openTerminal(r.deps, { workspaceId: "ws1", cols: 80, rows: 24 }, r.context());
  for (let i = 0; i < 1000 && r.port.spawns.length === 0; i++) await new Promise((res) => setImmediate(res));
  const h = new FakeHandle();
  r.port.spawns[0]?.resolve(h);
  const rec = await p;
  r.audits.length = 0;
  return { r, h, id: rec.terminalId };
}

test("attach grants an open terminal to the named conn only, audited with the terminal id and the conn", async () => {
  const { r, id } = await opened();
  attachTerminal(r.deps, id, "conn-1");
  assert.deepEqual(r.port.grants, [[id, "conn-1"]]);
  assert.deepEqual(r.audits.map((a) => [a.action, a.payload]), [["terminal.attach", { terminalId: id, conn: "conn-1" }]]);
  assert.throws(() => attachTerminal(r.deps, "pty_ffffffffffffffffffffffffffffffff", "conn-1"), notFound, "an id the daemon did not open");
});

test("close: revoked then killed, closed, audited; repeated close is fine; attach afterwards is not_found with no grant", async () => {
  const { r, h, id } = await opened();
  closeTerminal(r.deps, id);
  assert.deepEqual(r.port.revokes, [id]);
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.equal(r.registry.get(id)?.state, "closed");
  closeTerminal(r.deps, id);
  assert.deepEqual(r.audits.map((a) => a.action), ["terminal.close", "terminal.close"]);
  assert.deepEqual(r.audits[0]?.payload, { terminalId: id, workspaceId: "ws1", projectId: "p1" });
  assert.throws(() => attachTerminal(r.deps, id, "conn-1"), notFound);
  assert.deepEqual(r.port.grants, []);
});

test("a close whose kill throws: closing, then daemon attach refused; the leader's later exit does not reopen it", async () => {
  const { r, h, id } = await opened();
  h.killThrows = true;
  closeTerminal(r.deps, id);
  assert.equal(r.registry.get(id)?.state, "closing");
  assert.throws(() => attachTerminal(r.deps, id, "c"), notFound);
  h.exit();
  assert.throws(() => attachTerminal(r.deps, id, "c"), notFound);
  assert.deepEqual(r.port.grants, []);
});

test("a natural exit: a re-grant is refused", async () => {
  const { r, h, id } = await opened();
  attachTerminal(r.deps, id, "c1");
  h.exit();
  assert.throws(() => attachTerminal(r.deps, id, "c2"), notFound);
  assert.deepEqual(r.port.grants, [[id, "c1"]]);
});

test("close refuses a CLI run's terminal and an unknown id (not_found), with no audit", async () => {
  const { r } = await opened();
  const run = new FakeHandle();
  r.registry.addCliRun(run, { runId: "run1", workspaceId: "ws1", projectId: "p1" });
  assert.throws(() => closeTerminal(r.deps, run.terminalId), notFound);
  assert.throws(() => closeTerminal(r.deps, "pty_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), notFound);
  assert.deepEqual(run.kills, []);
  assert.deepEqual(r.audits, []);
});

test("the environment is exactly the plain-terminal builder with secret names stripped", () => {
  const daemonEnv = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    SSH_AUTH_SOCK: "/run/agent",
    GPG_AGENT_INFO: "/run/gpg",
    DOCKER_HOST: "unix:///run/docker.sock",
    NPM_CONFIG_USERCONFIG: "/home/u/.npmrc",
    AXIS_MESSAGES_ENDPOINT: "/run/axis/ep",
    AXIS_MESSAGES_TOKEN: "t",
    PLUGIN_TOKEN: "x",
    SERVICE_API_KEY: "x",
    GH_TOKEN: "x",
    AWS_SECRET_ACCESS_KEY: "x",
  };
  const env = plainTerminalEnv(daemonEnv, "linux");
  for (const kept of ["PATH", "HOME", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DOCKER_HOST", "NPM_CONFIG_USERCONFIG"]) assert.equal(env[kept], daemonEnv[kept as keyof typeof daemonEnv], `${kept} kept`);
  for (const gone of ["AXIS_MESSAGES_ENDPOINT", "AXIS_MESSAGES_TOKEN", "PLUGIN_TOKEN", "SERVICE_API_KEY", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY"]) assert.equal(env[gone], undefined, `${gone} removed`);
});
