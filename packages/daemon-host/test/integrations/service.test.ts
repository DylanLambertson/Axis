// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The read flow of net-read-slice.md §4 over the real vault (memory backend), the real redactor and a fake sender: each
// refusal, each order invariant, the epilogue on every exit after the credential row, both audit boundaries, the byte counts,
// cancellation, the weak-entry gate and the no-backend state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Redactor, type AuditEventInput } from "@axis/audit";
import { integrationsVault } from "../../src/bindings/integrations.js";
import { testBackend, type TestBackend } from "../../testing/integrations-backend.js";
import { EgressError } from "../../src/net/egress-errors.js";
import { takeAuthorization, type AuthorizedRequest } from "../../src/net/url-pattern.js";
import { INTEGRATIONS_PAYLOAD_ALLOWLIST, createIntegrationsService, type IntegrationsSender, type IntegrationsServiceDeps } from "../../src/integrations/service.js";
import { CONNECTORS, type Connector } from "../../src/integrations/registry.js";
import { IntegrationRefusal } from "../../src/integrations/wire.js";

const TOKEN = String.raw`canary"T0k3n\x+y/z=Q9w-synthetic-0001`;
const PR = { number: 7, title: "Fix", state: "open", user: { login: "octo" } };
const INPUT = { projectId: "p1", integrationId: "github", operation: "pulls_list", args: { owner: "octo", repo: "hello", perPage: 5 } };
const PATH = "/repos/octo/hello/pulls?per_page=5";
type Res = Awaited<ReturnType<IntegrationsSender["sendAuthorized"]>>;
const ok = (body: unknown, headers: Res["headers"] = {}): Res => ({ status: 200, headers, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

interface Rig {
  backend: TestBackend;
  redactor: Redactor;
  rows: AuditEventInput[];
  sent: Array<{ url: string; authorization: string }>;
  failAudit: (action: string) => boolean;
  reply: (req: AuthorizedRequest) => Promise<Res>;
  service: ReturnType<typeof createIntegrationsService>;
}

function rig(over: Partial<IntegrationsServiceDeps> & { seed?: boolean } = {}): Rig {
  const backend = testBackend();
  if (over.seed !== false) backend.seed("integration:github", TOKEN);
  const r: Rig = {
    backend,
    redactor: new Redactor(),
    rows: [],
    sent: [],
    failAudit: () => false,
    reply: async () => ok([PR]),
    service: undefined as never,
  };
  let t = 1000;
  r.service = createIntegrationsService({
    vault: integrationsVault(backend),
    sender: {
      sendAuthorized: async (req) => {
        const taken = takeAuthorization(req);
        r.sent.push({ url: req.url, authorization: taken.authorization });
        return r.reply(req);
      },
    },
    redactor: r.redactor,
    audit: { append: (e) => {
      if (r.failAudit(e.action)) throw new Error("audit down");
      r.rows.push(e);
    } },
    now: () => (t += 5),
    ...over,
  });
  return r;
}

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof IntegrationRefusal, String(e));
    return e.reason;
  }
  assert.fail("expected a refusal");
};
const live = (): AbortSignal => new AbortController().signal;
const actions = (r: Rig): string[] => r.rows.map((x) => x.action);
const requestRow = (r: Rig): Record<string, unknown> => r.rows.find((x) => x.action === "integration.request")?.payload as Record<string, unknown>;

test("a read: one send with the credential, the reduced result, then exactly the two allowlisted rows", async () => {
  const r = rig();
  const out = await r.service.read(INPUT, live());
  assert.deepEqual(out, { status: 200, result: { items: [{ number: 7, title: "Fix", state: "open", author: "octo" }] } });
  assert.deepEqual(r.sent, [{ url: `https://api.github.com${PATH}`, authorization: `Bearer ${TOKEN}` }]);
  assert.deepEqual(actions(r), ["integration.credential", "integration.request"]);
  assert.deepEqual(r.rows[0]?.payload, { integrationId: "github", operation: "pulls_list", projectId: "p1", actorKind: "user", purpose: "integration_request" });
  assert.deepEqual(requestRow(r), { integrationId: "github", operation: "pulls_list", projectId: "p1", status: 200, bytesOut: Buffer.byteLength(PATH), bytesIn: JSON.stringify([PR]).length, durationMs: requestRow(r)["durationMs"], reason: "ok" });
  assert.ok(Number.isInteger(requestRow(r)["durationMs"]) && (requestRow(r)["durationMs"] as number) > 0);
  for (const row of r.rows) assert.deepEqual(Object.keys(row.payload as object).filter((k) => !INTEGRATIONS_PAYLOAD_ALLOWLIST[row.action]?.includes(k)), [], row.action);
  assert.equal(JSON.stringify(r.rows).includes(TOKEN), false);
  assert.deepEqual([r.rows[0]?.outcome, r.rows[1]?.outcome, r.rows[0]?.actor, r.rows[0]?.target], ["success", "success", "user", "integration:github"]);
});

test("order: the token is registered with the redactor and the credential row written before the send", async () => {
  const r = rig();
  r.reply = async () => {
    assert.notEqual(r.redactor.redactString(TOKEN), TOKEN, "registered before use");
    assert.notEqual(r.redactor.redactString(`Bearer ${TOKEN}`), `Bearer ${TOKEN}`);
    assert.deepEqual(actions(r), ["integration.credential"], "the credential row is written before the send");
    return ok([PR]);
  };
  await r.service.read(INPUT, live());
});

test("the credential row cannot be written: audit_unavailable, nothing sent, no request row", async () => {
  const r = rig();
  r.failAudit = (a) => a === "integration.credential";
  assert.equal(await reason(r.service.read(INPUT, live())), "audit_unavailable");
  assert.deepEqual([r.sent.length, actions(r)], [0, []]);
});

test("the request row cannot be written after a send: the result is discarded and the call is audit_unavailable", async () => {
  const r = rig();
  r.failAudit = (a) => a === "integration.request";
  assert.equal(await reason(r.service.read(INPUT, live())), "audit_unavailable");
  assert.equal(r.sent.length, 1);
});

const exits: Array<[string, (req: AuthorizedRequest) => Promise<Res>, string, number | undefined]> = [
  ["a raw echo", async () => ok([PR], { "x-echo": TOKEN }), "credential_echoed", 200],
  ["a parsed echo", async () => ok(`[{"number":7,"title":"${[...TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}","state":"open","user":{"login":"octo"}}]`), "credential_echoed", 200],
  ["invalid JSON", async () => ok("[{"), "response_invalid", 200],
  ["a schema mismatch", async () => ok([{ ...PR, state: "merged" }]), "response_invalid", 200],
  ["a TLS failure", async () => Promise.reject(new EgressError("tls_failed")), "network_unavailable", undefined],
  ["an upstream status", async () => Promise.reject(new EgressError("http_status", 404)), "upstream_status", undefined],
  ["a timeout", async () => Promise.reject(new EgressError("total_timeout")), "timeout", undefined],
  ["a non-egress throw", async () => Promise.reject(new Error(`boom ${TOKEN}`)), "internal", undefined],
];
for (const [what, reply, want, status] of exits) {
  test(`the epilogue after ${what}: the refusal ${want}, and one request row with that reason`, async () => {
    const r = rig();
    r.reply = reply;
    assert.equal(await reason(r.service.read(INPUT, live())), want);
    assert.deepEqual(actions(r), ["integration.credential", "integration.request"]);
    const row = requestRow(r);
    assert.equal(row["reason"], want);
    assert.equal(row["status"], status);
    assert.equal(row["bytesOut"], Buffer.byteLength(PATH), "charged once the send started");
    assert.equal(r.rows[1]?.outcome, "failure");
    assert.equal(JSON.stringify(r.rows).includes(TOKEN), false);
  });
}

test("cancel before the reveal: nothing revealed, sent or audited", async () => {
  const r = rig();
  const c = new AbortController();
  c.abort();
  assert.equal(await reason(r.service.read(INPUT, c.signal)), "cancelled");
  assert.deepEqual([r.sent.length, actions(r)], [0, []]);
  assert.equal(r.redactor.registeredForms, 0, "nothing was revealed");
});

test("cancel after the credential row, before the send: a request row with reason cancelled and bytesOut 0", async () => {
  const c = new AbortController();
  const r = rig({ audit: { append: (e) => (rows.push(e), e.action === "integration.credential" ? c.abort() : undefined) } });
  const rows = r.rows;
  assert.equal(await reason(r.service.read(INPUT, c.signal)), "cancelled");
  assert.equal(r.sent.length, 0);
  assert.deepEqual(actions(r), ["integration.credential", "integration.request"]);
  assert.deepEqual([requestRow(r)["reason"], requestRow(r)["bytesOut"], requestRow(r)["bytesIn"], requestRow(r)["status"]], ["cancelled", 0, 0, undefined]);
});

test("cancel during the send stays E_CANCELLED even when its request row fails", async () => {
  const r = rig();
  r.reply = async () => Promise.reject(new EgressError("aborted"));
  assert.equal(await reason(r.service.read(INPUT, live())), "cancelled");
  assert.equal(requestRow(r)["reason"], "cancelled");
  const s = rig();
  s.reply = async () => Promise.reject(new EgressError("aborted"));
  s.failAudit = (a) => a === "integration.request";
  assert.equal(await reason(s.service.read(INPUT, live())), "cancelled");
});

test("the reveal gate: a weak entry, an entry moved between the state read and the reveal, and a token of the wrong shape need a reconnect, with no send", async () => {
  const weak = rig({ seed: false });
  weak.backend.seed("integration:github", TOKEN, { backend: "basic_text", protection: "none" });
  assert.equal(await reason(weak.service.read(INPUT, live())), "needs_reconnect");
  assert.equal((await weak.service.status("p1", "github")).state, "needs_reconnect");
  const moved = rig();
  assert.equal((await moved.service.status("p1", "github")).state, "connected");
  const get = moved.backend.get.bind(moved.backend);
  moved.backend.get = (async (n: string) => {
    const e = await get(n);
    return e && { secret: e.secret, meta: { storedAt: 1, backend: "basic_text", protection: "none", weakConsent: false } };
  }) as typeof moved.backend.get;
  assert.equal(await reason(moved.service.read(INPUT, live())), "needs_reconnect");
  const shape = rig({ seed: false });
  shape.backend.seed("integration:github", "short");
  assert.equal(await reason(shape.service.read(INPUT, live())), "needs_reconnect");
  for (const x of [weak, moved, shape]) assert.deepEqual([x.sent.length, actions(x)], [0, []]);
  assert.equal(shape.redactor.registeredForms, 0, "a token of the wrong shape is never registered");
});

test("no entry is not_connected; a failing backend is internal for read and for status", async () => {
  const none = rig({ seed: false });
  assert.equal(await reason(none.service.read(INPUT, live())), "not_connected");
  assert.equal((await none.service.status("p1", "github")).state, "available");
  const failing = rig();
  failing.backend.failWith(`backend down ${TOKEN}`);
  assert.equal(await reason(failing.service.read(INPUT, live())), "internal");
  assert.equal(await reason(failing.service.status("p1", "github")), "internal");
  assert.equal(await reason(failing.service.list("p1")), "internal");
  for (const x of [none, failing]) assert.deepEqual([x.sent.length, actions(x)], [0, []]);
});

test("no backend: list and status show available with no scope, read is not_connected, nothing is sent or audited", async () => {
  const r = rig({ vault: undefined });
  assert.deepEqual((await r.service.list("p1")).map((x) => [x.id, x.state, x.grantedScopes]), [["github", "available", []]]);
  assert.equal((await r.service.status("p1", "github")).state, "available");
  assert.equal(await reason(r.service.read(INPUT, live())), "not_connected");
  assert.deepEqual([r.sent.length, actions(r)], [0, []]);
});

test("unknown connectors and operations are not_found, a write operation is operation_kind_mismatch, a bad argument is argument_refused; none reveals", async () => {
  const github = CONNECTORS["github"]!;
  const withWrite: Readonly<Record<string, Connector>> = { github: { ...github, operations: { ...github.operations, issue_close: { kind: "write", template: { method: "POST", path: [{ literal: "x" }] } } } } };
  const r = rig({ connectors: withWrite });
  assert.equal(await reason(r.service.read({ ...INPUT, integrationId: "gitlab" }, live())), "not_found");
  assert.equal(await reason(r.service.read({ ...INPUT, operation: "constructor" }, live())), "not_found");
  assert.equal(await reason(r.service.read({ ...INPUT, operation: "issue_close" }, live())), "operation_kind_mismatch");
  assert.equal(await reason(r.service.read({ ...INPUT, args: { ...INPUT.args, owner: "a/b" } }, live())), "argument_refused");
  assert.equal(await reason(r.service.read({ ...INPUT, args: { ...INPUT.args, extra: 1 } }, live())), "argument_refused");
  assert.equal(await reason(r.service.status("p1", "gitlab")), "not_found");
  assert.deepEqual((await r.service.status("p1", "github")).operations.find((o) => o.operation === "issue_close"), { operation: "issue_close", write: true });
  assert.deepEqual([r.sent.length, actions(r), r.redactor.registeredForms], [0, [], 0]);
});
