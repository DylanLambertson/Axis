// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.integrations/1 through the real daemon pipeline and the served policy rows (net-read-slice.md §6, §7): the user's desktop
// is answered; a worker, a plugin and a web client are refused by policy before the handler; the deferred methods are not
// served; an unknown project is not_found; read goes through the project trust gate before anything is revealed; and the daemon
// entry passes no integrations option.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AxisError } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type Identity, type IdentityVerifier } from "@axis/daemon";
import { integrationsMethods } from "@axis/protocol";
import { InMemoryTrustRegistry, RuleTablePolicy } from "../../src/index.js";
import { isProjectGated, type ProjectTrustGate } from "../../src/gate/project-trust.js";
import { createIntegrationsHandlers } from "../../src/handlers/integrations.js";
import type { IntegrationsService } from "../../src/integrations/service.js";
import { IntegrationRefusal } from "../../src/integrations/wire.js";
import { Client } from "../approvals-rig.js";

const C = "axis.integrations";
const verifier: IdentityVerifier = {
  verify(att) {
    const [actor, conn, kind] = String(att).split("#");
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: kind === "web" ? "web" : "win-1", actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: kind === "web" ? "web" : "desktop" };
  },
};

interface Calls { list: number; status: number; read: number; admits: number }

async function setup(t: TestContext, over: { gate?: ProjectTrustGate; service?: Partial<IntegrationsService> } = {}): Promise<{ connect: (att?: string) => Promise<Client>; calls: Calls }> {
  const calls: Calls = { list: 0, status: 0, read: 0, admits: 0 };
  const integration = { id: "github", label: "GitHub", origins: ["https://api.github.com"], operations: [{ operation: "pulls_list", write: false }], declaredScopes: [], grantedScopes: [], state: "available" as const };
  const service: IntegrationsService = {
    list: async () => (calls.list++, [integration]),
    status: async () => (calls.status++, integration),
    read: async () => (calls.read++, { status: 200, result: { items: [] } }),
    ...over.service,
  };
  const gate: ProjectTrustGate = over.gate ?? { admit: async () => (calls.admits++, Promise.reject(new AxisError("E_POLICY_DENIED", "The project is not trusted", { reason: "untrusted" }))) };
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  const daemon = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(trust) });
  daemon.register(C, 1, createIntegrationsHandlers({ service, journal: { getProject: (id: string) => (id === "p1" ? ({ id } as never) : undefined) }, gate, now: () => 1 }));
  const ports: { close(): void }[] = [];
  t.after(() => {
    daemon.stop();
    for (const p of ports) p.close();
  });
  const connect = async (att = "user#conn-1#desktop"): Promise<Client> => {
    const { client, server } = memoryPair();
    ports.push(client);
    const c = new Client(client);
    daemon.accept(server, att);
    client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: C, versions: [1] }] });
    await c.until((m) => m.type !== undefined);
    return c;
  };
  return { connect, calls };
}

const READ = { projectId: "p1", integrationId: "github", operation: "pulls_list" };

test("the user's desktop gets list and status; an unknown project is not_found and reaches no service call", async (t) => {
  const { connect, calls } = await setup(t);
  const user = await connect();
  const list = await user.call(C, "list", { projectId: "p1" });
  assert.equal(list.ok, true, JSON.stringify(list.error));
  assert.ok(integrationsMethods.list.response.safeParse(list.result).success);
  assert.equal((await user.call(C, "status", { projectId: "p1", integrationId: "github" })).ok, true);
  for (const [m, p] of [["list", { projectId: "p2" }], ["status", { projectId: "p2", integrationId: "github" }], ["read", { ...READ, projectId: "p2" }]] as const) {
    const r = await user.call(C, m, p);
    assert.deepEqual([r.error?.code, r.error?.details], ["E_NOT_FOUND", { reason: "not_found" }], m);
  }
  assert.deepEqual(calls, { list: 1, status: 1, read: 0, admits: 0 });
});

test("a worker and a web client are refused by policy before the handler, for every served method", async (t) => {
  const { connect, calls } = await setup(t);
  // A plugin caller is refused the same way: no plugin permission names these methods (test/policy/integrations-policy.test.ts).
  for (const att of ["agent:a1#conn-2#desktop", "user#conn-4#web"]) {
    const c = await connect(att);
    for (const [m, p] of [["list", { projectId: "p1" }], ["status", { projectId: "p1", integrationId: "github" }], ["read", READ]] as const) {
      assert.equal((await c.call(C, m, p)).error?.code, "E_POLICY_DENIED", `${att} ${m}`);
    }
  }
  assert.deepEqual(calls, { list: 0, status: 0, read: 0, admits: 0 });
});

test("connect, disconnect and write are not served: E_METHOD_NOT_FOUND", async (t) => {
  const { connect } = await setup(t);
  const user = await connect();
  for (const [m, p] of [["connect", { projectId: "p1", integrationId: "github" }], ["disconnect", { projectId: "p1", integrationId: "github" }], ["write", READ]] as const) {
    assert.equal((await user.call(C, m, p)).error?.code, "E_METHOD_NOT_FOUND", m);
  }
});

test("read is project-gated: an untrusted project is E_CONFLICT untrusted from the gate, and the service is never asked", async (t) => {
  const { connect, calls } = await setup(t);
  assert.equal(isProjectGated(createIntegrationsHandlers({ service: {} as never, journal: { getProject: () => undefined }, gate: {} as never, now: () => 0 }).read), true);
  const r = await (await connect()).call(C, "read", READ);
  assert.deepEqual([r.error?.code, r.error?.details], ["E_CONFLICT", { reason: "untrusted" }]);
  assert.deepEqual([calls.admits, calls.read], [1, 0]);
});

test("a ticket that is not the gate's own is refused before the service; a refusal keeps its reason and fixed text", async (t) => {
  const { connect, calls } = await setup(t, {
    gate: { admit: async () => ({}) as never },
    service: { list: async () => Promise.reject(new IntegrationRefusal("needs_reconnect")), status: async () => Promise.reject(new Error("secret text")) },
  });
  const user = await connect();
  assert.deepEqual((await user.call(C, "read", READ)).error?.details, { reason: "untrusted" }, "a forged ticket is not spent");
  assert.equal(calls.read, 0);
  const refused = await user.call(C, "list", { projectId: "p1" });
  assert.deepEqual([refused.error?.code, refused.error?.details, refused.error?.message], ["E_CONFLICT", { reason: "needs_reconnect" }, "integration request refused"]);
  const internal = await user.call(C, "status", { projectId: "p1", integrationId: "github" });
  assert.equal(internal.error?.code, "E_INTERNAL");
  assert.equal(JSON.stringify(internal.error).includes("secret text"), false);
});

test("the daemon entry passes no integrations option: production has no test client and no backend (net-read-slice.md §7)", () => {
  const entry = readFileSync(fileURLToPath(new URL("../../../src/entry.ts", import.meta.url)), "utf8");
  const call = entry.slice(entry.indexOf("composeDaemonHost({"));
  assert.ok(call.length > 0 && call.includes("snapshotter: gitSnapshotRunSnapshotter"), "the scan reads the composition call");
  assert.equal(/integrations|vaultBackend|egress/i.test(entry), false);
});
