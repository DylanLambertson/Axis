// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type Identity, type IdentityVerifier } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { usageMethods } from "@axis/protocol";
import { InMemoryTrustRegistry, RuleTablePolicy, createUsageHandlers, createUsageService, usageServiceDeps } from "../src/index.js";
import { Client } from "./approvals-rig.js";

// axis.usage/1 through the real daemon pipeline, the served policy rows and the composed deps over a real journal (PV-D3
// review N-4): the user's desktop is answered; a worker connection and a web client are refused by policy before the handler.

const C = "axis.usage";
/** The attestation is "<actor>#<connection>#<clientKind>". */
const verifier: IdentityVerifier = {
  verify(att) {
    const [actor, conn, kind] = String(att).split("#");
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: kind === "web" ? "web" : "win-1", actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: kind === "web" ? "web" : "desktop" };
  },
};

async function setup(t: TestContext): Promise<(att?: string) => Promise<Client>> {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  const daemon = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(trust) });
  daemon.register(C, 1, createUsageHandlers(createUsageService(usageServiceDeps(journal, { workspaceLimits: Object.freeze({ maxTokens: 10 }) }))));
  const ports: { close(): void }[] = [];
  t.after(() => {
    daemon.stop();
    for (const p of ports) p.close();
    db.close();
  });
  return async (att = "user#conn-1#desktop") => {
    const { client, server } = memoryPair();
    ports.push(client);
    const c = new Client(client);
    daemon.accept(server, att);
    client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: C, versions: [1] }] });
    await c.until((m) => m.type !== undefined);
    return c;
  };
}

test("the user's desktop gets the summary; an unregistered project is E_NOT_FOUND; a worker or web caller is E_POLICY_DENIED for any project", async (t) => {
  const connect = await setup(t);
  const user = await connect();
  const ok = await user.call(C, "summary", { projectId: "p1" });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.ok(usageMethods.summary.response.safeParse(ok.result).success);
  const unknown = await user.call(C, "summary", { projectId: "p2" });
  assert.deepEqual([unknown.error?.code, unknown.error?.details], ["E_NOT_FOUND", { reason: "not_found" }]);
  for (const att of ["agent:a1#conn-2#desktop", "user#conn-3#web"]) {
    const c = await connect(att);
    for (const projectId of ["p1", "p2"]) {
      const res = await c.call(C, "summary", { projectId });
      assert.equal(res.error?.code, "E_POLICY_DENIED", `${att} ${projectId}: the same answer whether or not the project exists`);
    }
  }
});
