// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type Identity, type IdentityVerifier } from "@axis/daemon";
import { MAX_BODY_CHARS, MESSAGES_REFUSAL_MESSAGE, messagesMethods } from "@axis/protocol";
import { InMemoryTrustRegistry, MessageRefusal, RuleTablePolicy, WEB_ALLOWED, createMessagesHandlers, toMessagesError } from "../src/index.js";
import { Client, newKey } from "./approvals-rig.js";
import { messagesRig, sendReq, type MessagesRig } from "./messages-rig.js";

// axis.messages/1 over the bridge (ticket PV-M3 slice 1): the real daemon pipeline, the served policy rows, the handlers.

const C = "axis.messages";
/** The attestation is "<actor>#<connection>#<clientKind>". */
const verifier: IdentityVerifier = {
  verify(att) {
    const [actor, conn, kind] = String(att).split("#");
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: kind === "web" ? "web" : "win-1", actorId: `${actor}-id`, actor: actor as Identity["actor"], trusted: true, clientKind: kind === "web" ? "web" : "desktop" };
  },
};

async function setup(t: TestContext, limits?: NonNullable<Parameters<typeof messagesRig>[0]>["limits"]): Promise<{ r: MessagesRig; connect(att?: string): Promise<Client> }> {
  const r = messagesRig(limits === undefined ? {} : { limits });
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  const daemon = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(trust) });
  daemon.register(C, 1, createMessagesHandlers(r.binding));
  const ports: { close(): void }[] = [];
  t.after(() => {
    daemon.stop();
    for (const p of ports) p.close();
    r.close();
  });
  return {
    r,
    async connect(att = "user#conn-1#desktop") {
      const { client, server } = memoryPair();
      ports.push(client);
      const c = new Client(client);
      daemon.accept(server, att);
      client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: C, versions: [1] }] });
      await c.until((m) => m.type !== undefined);
      return c;
    },
  };
}

test("the user's connection sends, lists and reads; every answer passes the contract's response schema", async (t) => {
  const { connect } = await setup(t);
  const user = await connect();
  const sent = await user.call(C, "send", sendReq([{ agent: "a1" }], "over the bridge"), newKey());
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  assert.ok(messagesMethods.send.response.safeParse(sent.result).success);
  const threadId = (sent.result?.["message"] as { threadId: string }).threadId;
  for (const [method, payload] of [["thread", { threadId }], ["threads", {}], ["read", {}], ["markRead", { threadId, throughSeq: 1 }], ["settings", { projectId: "p1" }]] as const) {
    const res = await user.call(C, method, payload);
    assert.equal(res.ok, true, `${method}: ${JSON.stringify(res.error)}`);
    assert.ok(messagesMethods[method].response.safeParse(res.result).success, method);
  }
  const pause = await user.call(C, "pause", { scope: { agent: "a1" } });
  assert.deepEqual(pause.result, { scope: { agent: "a1" }, paused: true, changed: true });
});

test("an agent connection and a web client are refused every method by policy; a send needs an idempotency key", async (t) => {
  const { r, connect } = await setup(t);
  const payloads: Record<string, unknown> = {
    send: sendReq([{ agent: "a1" }]), thread: { threadId: "thr_AAAAAAAAAAAAAAAAAAAAAA" }, threads: {}, read: {}, markRead: { threadId: "thr_AAAAAAAAAAAAAAAAAAAAAA", throughSeq: 1 },
    pause: { scope: { project: "p1" } }, resume: { scope: { project: "p1" } }, settings: { projectId: "p1" }, updateSettings: { setting: "crossGroup", projectId: "p1", value: true },
  };
  for (const att of ["agent:a1#conn-2#desktop", "user#conn-3#web"]) {
    const c = await connect(att);
    for (const [method, payload] of Object.entries(payloads)) {
      const res = await c.call(C, method, payload, method === "send" ? newKey() : undefined);
      assert.equal(res.error?.code, "E_POLICY_DENIED", `${att} ${method}`);
    }
  }
  assert.equal([...WEB_ALLOWED].some((k) => k.startsWith("axis.messages/")), false);
  assert.equal(r.journal.messages.threads({ limit: 10 }).length, 0, "nothing was written");
  const user = await connect();
  assert.equal((await user.call(C, "send", sendReq([{ agent: "a1" }]))).error?.code, "E_INVALID_ARGUMENT", "no idempotency key");
});

test("forged daemon fields, a broadcast, a huge body and unknown keys are refused by the contract before the service", async (t) => {
  const { r, connect } = await setup(t);
  const user = await connect();
  const base = sendReq([{ agent: "a1" }]);
  for (const forged of [{ hop: 0 }, { sender: { kind: "user", verified: true } }, { projectId: "p2" }, { seq: 1 }, { createdAt: "2026-01-01T00:00:00.000Z" }, { messageId: "msg_AAAAAAAAAAAAAAAAAAAAAA" }, { expanded: [] }, { approval: { challengeId: "x" } }]) {
    const res = await user.call(C, "send", { ...base, ...forged }, newKey());
    assert.equal(res.error?.code, "E_INVALID_ARGUMENT", JSON.stringify(forged));
  }
  for (const recipients of [[{ all: true }], [{ project: "p1" }], [], Array.from({ length: 17 }, (_, i) => ({ agent: `z${i}` })), [{ agent: "a1" }, { agent: "a1" }]]) {
    assert.equal((await user.call(C, "send", { ...base, recipients }, newKey())).error?.code, "E_INVALID_ARGUMENT", JSON.stringify(recipients).slice(0, 40));
  }
  const huge = await user.call(C, "send", sendReq([{ agent: "a1" }], "x".repeat(MAX_BODY_CHARS + 1)), newKey());
  assert.equal(huge.error?.code, "E_INVALID_ARGUMENT");
  assert.equal(r.journal.messages.threads({ limit: 10 }).length, 0);
});

test("refusals leave as the fixed message with details { reason } only; backpressure keeps its reason on the wire", async (t) => {
  const { connect } = await setup(t, { threadsPerProject: 1 });
  const user = await connect();
  const missing = await user.call(C, "thread", { threadId: "thr_AAAAAAAAAAAAAAAAAAAAAA" });
  assert.deepEqual([missing.error?.code, missing.error?.message, missing.error?.details], ["E_NOT_FOUND", MESSAGES_REFUSAL_MESSAGE, { reason: "not_found" }]);
  const cross = await user.call(C, "send", sendReq([{ agent: "a1" }, { agent: "x1" }]), newKey());
  assert.deepEqual([cross.error?.code, cross.error?.details], ["E_CONFLICT", { reason: "cross_project" }]);
  assert.equal((await user.call(C, "send", sendReq([{ agent: "a1" }]), newKey())).ok, true);
  const full = await user.call(C, "send", sendReq([{ agent: "a2" }]), newKey());
  assert.deepEqual([full.error?.code, full.error?.details, (full.error as { retryable?: boolean } | undefined)?.retryable], ["E_BACKPRESSURE", { reason: "queue_full" }, true]);
  assert.equal(JSON.stringify([missing, cross, full]).includes("a1"), false, "no id or name in a refusal");
});

test("toMessagesError: a reason outside the contract's set, or under the wrong code, is an internal error", () => {
  const code = (e: unknown): string => {
    try {
      toMessagesError(e);
    } catch (x) {
      return `${(x as { code: string }).code}/${JSON.stringify((x as { details?: unknown }).details)}`;
    }
    return "none";
  };
  assert.equal(code(new MessageRefusal("E_NOT_FOUND", "not_found")), `E_NOT_FOUND/${JSON.stringify({ reason: "not_found" })}`);
  assert.equal(code(new MessageRefusal("E_NOT_FOUND", "forbidden")), "E_INTERNAL/undefined");
  assert.equal(code(new MessageRefusal("E_CONFLICT", "not_found")), "E_INTERNAL/undefined");
  assert.equal(code(new Error("SQLITE_CONSTRAINT: secret body text")), "E_INTERNAL/undefined");
});

test("behind the policy row, a handler still refuses any actor but the user with not_found and touches nothing", async (t) => {
  const r = messagesRig();
  t.after(() => r.close());
  const handlers = createMessagesHandlers(r.binding);
  const ctx = (actor: string) => ({ identity: { connectionId: "c".repeat(22), windowId: "win-1", actorId: "x", actor, trusted: true, clientKind: "desktop" }, requestId: "r1", correlationId: "c1", signal: new AbortController().signal }) as never;
  await assert.rejects(Promise.resolve(handlers.threads({ ...(ctx("user") as object), identity: { ...(ctx("user") as { identity: object }).identity, clientKind: "web" } } as never, {} as never)), { code: "E_NOT_FOUND" }, "a web client, even if an allow-list line admitted it");
  for (const actor of ["agent:a1", "daemon"]) {
    await assert.rejects(Promise.resolve(handlers.threads(ctx(actor), {} as never)), { code: "E_NOT_FOUND", details: { reason: "not_found" } }, actor);
    await assert.rejects(Promise.resolve(handlers.send(ctx(actor), sendReq([{ agent: "a1" }]) as never)), { code: "E_NOT_FOUND" }, actor);
  }
  assert.equal(r.journal.messages.threads({ limit: 10 }).length, 0);
  assert.deepEqual(await handlers.threads(ctx("user"), {} as never), { threads: [] });
});
