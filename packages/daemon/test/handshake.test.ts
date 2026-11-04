// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { errorSchema, helloRejectedSchema, welcomeSchema } from "@axis/protocol";
import { protocolRegistry } from "../src/index.js";
import { CONTRACT, hello, identityOf, req, rig, verifier, type Rig } from "./harness.js";

function mk(t: TestContext, options: Parameters<typeof rig>[0] = {}): Rig {
  const r = rig(options);
  t.after(() => r.cleanup());
  return r;
}

const typed = (type: string) => (m: unknown): m is Record<string, unknown> =>
  typeof m === "object" && m !== null && (m as { type?: unknown }).type === type;

test("hello yields a welcome that matches the protocol schema and picks the highest common version", async (t) => {
  const r = mk(t);
  r.send(hello({ contracts: [{ id: CONTRACT, versions: [1, 2, 3] }] }));
  const w = await r.inbox.until(typed("welcome"));
  const parsed = welcomeSchema.parse(w);
  assert.deepEqual(parsed.contracts, [{ id: CONTRACT, version: 2 }]);
  assert.equal(parsed.protocolVersion, 1);
  assert.ok(parsed.limits.maxInFlight > 0);
});

test("no common protocol version is rejected with E_VERSION_UNSUPPORTED and the connection closes", async (t) => {
  const r = mk(t);
  r.send(hello({ protocolVersions: [99] }));
  const m = helloRejectedSchema.parse(await r.inbox.until(typed("hello-rejected")));
  assert.equal(m.error.code, "E_VERSION_UNSUPPORTED");
  assert.ok(await r.inbox.closedWithin());
});

test("a hello offering only unknown contracts is refused; a mixed hello welcomes only the known ones", async (t) => {
  const a = mk(t);
  a.send(hello({ contracts: [{ id: "axis.nope", versions: [1] }] }));
  assert.equal(helloRejectedSchema.parse(await a.inbox.until(typed("hello-rejected"))).error.code, "E_VERSION_UNSUPPORTED");

  const b = mk(t);
  b.send(hello({ contracts: [{ id: "axis.nope", versions: [1] }, { id: CONTRACT, versions: [1] }] }));
  const w = welcomeSchema.parse(await b.inbox.until(typed("welcome")));
  assert.deepEqual(w.contracts, [{ id: CONTRACT, version: 1 }]);
  b.send(req("u1", "echo", { text: "x" }, { contract: "axis.nope" }));
  assert.equal((await b.inbox.response("u1")).error?.code, "E_METHOD_NOT_FOUND");
});

test("a request for a version that was not negotiated is E_VERSION_UNSUPPORTED", async (t) => {
  const r = mk(t);
  await r.handshake();
  r.send(req("v2", "echo", { text: "x" }, { contractVersion: 2 }));
  assert.equal((await r.inbox.response("v2")).error?.code, "E_VERSION_UNSUPPORTED");
});

test("a request before hello is refused with E_UNAUTHENTICATED and the connection closes", async (t) => {
  const r = mk(t);
  r.send(req("early", "echo", { text: "x" }));
  const res = await r.inbox.response("early");
  assert.equal(res.error?.code, "E_UNAUTHENTICATED");
  assert.ok(await r.inbox.closedWithin());
});

test("garbage before hello is a rejected handshake, not a crash", async (t) => {
  for (const garbage of [null, 42, "hello", [], { type: "hello" }, { type: "hello", protocolVersions: [], contracts: [] }]) {
    const r = mk(t);
    r.send(garbage);
    const m = helloRejectedSchema.parse(await r.inbox.until(typed("hello-rejected")));
    assert.equal(m.error.code, "E_INVALID_ARGUMENT");
    assert.ok(await r.inbox.closedWithin());
  }
});

test("an attestation the verifier refuses gets hello-rejected E_UNAUTHENTICATED and no session", async (t) => {
  for (const attestation of [undefined, null, "forged", { windowId: "win-1" }]) {
    const r = mk(t, { attestation });
    const m = helloRejectedSchema.parse(await r.inbox.until(typed("hello-rejected")));
    assert.equal(m.error.code, "E_UNAUTHENTICATED");
    assert.ok(await r.inbox.closedWithin());
    assert.equal(r.daemon.connectionCount, 0);
  }
});

test("a verifier that throws is treated as a refusal and reported locally", async (t) => {
  const r = mk(t, {
    identity: {
      verify() {
        throw new Error("mac check exploded");
      },
    },
  });
  assert.equal(helloRejectedSchema.parse(await r.inbox.until(typed("hello-rejected"))).error.code, "E_UNAUTHENTICATED");
  assert.equal(r.internal.length, 1);
});

test("messages sent while an async verifier is still running are processed in order afterwards", async (t) => {
  const r = mk(t, {
    identity: { verify: async (a) => (await new Promise((res) => setTimeout(res, 30)), verifier.verify(a)) },
  });
  r.send(hello());
  r.send(req("q1", "echo", { text: "a" }));
  await r.inbox.until(typed("welcome"));
  assert.equal((await r.inbox.response("q1")).error?.code, "E_UNAVAILABLE", "the request was handled after the handshake, not dropped");
});

test("identity comes only from the verifier: identity-looking fields in a request are refused", async (t) => {
  const seen: unknown[] = [];
  const r = mk(t);
  r.daemon.register(CONTRACT, 1, { echo: (ctx, p: { text: string }) => (seen.push(ctx.identity), p) });
  await r.handshake();
  r.send(req("i1", "echo", { text: "x" }, { actor: "user", windowId: "win-evil", connectionId: "c-evil" }));
  assert.equal((await r.inbox.response("i1")).error?.code, "E_INVALID_ARGUMENT");
  r.send(req("i2", "echo", { text: "x", actor: "daemon" }));
  assert.equal((await r.inbox.response("i2")).error?.code, "E_INVALID_ARGUMENT");
  r.send(req("i3", "echo", { text: "ok" }));
  assert.equal((await r.inbox.response("i3")).ok, true);
  assert.deepEqual(seen, [identityOf()]);
});

test("a second hello is a protocol violation, not a renegotiation; repeated violations close the connection", async (t) => {
  const r = mk(t, { limits: { maxViolations: 3 } });
  await r.handshake();
  const before = r.inbox.all.length;
  for (let i = 0; i < 5; i++) r.send(hello());
  assert.ok(await r.inbox.closedWithin());
  assert.equal(r.inbox.all.slice(before).filter(typed("welcome")).length, 0);
});

test("a connection that never completes the handshake is closed", async (t) => {
  const r = mk(t, { limits: { handshakeTimeoutMs: 30 } });
  assert.ok(await r.inbox.closedWithin(500));
});

test("connections beyond the limit are closed immediately", async (t) => {
  const r = mk(t, { maxConnections: 1 });
  await r.handshake();
  const second = r.connect("good#conn-2");
  assert.ok(await second.inbox.closedWithin(500));
  assert.equal(r.daemon.connectionCount, 1);
});

test("the default registry serves the worktrees contract and refuses unknown methods", async (t) => {
  const r = mk(t, { registry: protocolRegistry });
  r.send(hello({ contracts: [{ id: "axis.worktrees", versions: [1] }] }));
  const w = welcomeSchema.parse(await r.inbox.until(typed("welcome")));
  assert.deepEqual(w.contracts, [{ id: "axis.worktrees", version: 1 }]);
  r.send(req("w1", "nosuch", {}, { contract: "axis.worktrees" }));
  assert.equal((await r.inbox.response("w1")).error?.code, "E_METHOD_NOT_FOUND");
  r.send(req("w2", "remove", { id: "ws-1" }, { contract: "axis.worktrees" }));
  assert.equal((await r.inbox.response("w2")).error?.code, "E_INVALID_ARGUMENT", "remove requires an idempotency key");
  r.send(req("w3", "list", { projectId: "p1" }, { contract: "axis.worktrees" }));
  assert.equal((await r.inbox.response("w3")).error?.code, "E_UNAVAILABLE", "known method, no handler registered");
});

test("every error that reaches the wire passes the protocol error schema", async (t) => {
  const r = mk(t);
  await r.handshake();
  for (const [i, p] of [{}, { text: 1 }, { text: "x", extra: 1 }].entries()) r.send(req(`e${i}`, "echo", p));
  for (let i = 0; i < 3; i++) errorSchema.parse((await r.inbox.response(`e${i}`)).error);
});
