// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { providersListResponseSchema, type RunEvent } from "@axis/protocol";
import type { AnthropicConnectionOptions } from "../src/bindings/providers.js";
import { createProvidersHandlers } from "../src/handlers/providers.js";
import { fakeBackend, mockAnthropic, MODEL, ORIGIN, plainKey, testKey, type FakeBackend, type MessagesReply, type MockAnthropic } from "./anthropic-server.js";
import { allEvents, composerRig, START, type ComposerRig } from "./composer-rig.js";

// Ticket C6: the Anthropic adapter and the vault through bindings/providers.ts, against a local mock HTTP server (no live API).

const CONN = "anthropic-main";
const ANT = { providerId: "anthropic", modelId: MODEL };

interface Setup {
  readonly c: ComposerRig;
  readonly api: MockAnthropic;
  readonly backend: FakeBackend;
  readonly key: string;
  readonly dir: string;
  /** Every byte of the rig's database (journal and audit), its WAL included. */
  readonly dbText: () => string;
  done(): Promise<void>;
}

async function setup(replies: MessagesReply[], over: Partial<AnthropicConnectionOptions> = {}, backend?: FakeBackend, key = testKey()): Promise<Setup> {
  const api = await mockAnthropic();
  api.replies = replies;
  const store = backend ?? fakeBackend(CONN, key);
  const dir = mkdtempSync(join(tmpdir(), "axis-c6-"));
  const dbPath = join(dir, "host.db");
  const c = await composerRig({ replies: [], dbPath, anthropic: { connectionId: CONN, backend: store, fetch: api.fetch, ...over } });
  const dbText = (): string => [dbPath, `${dbPath}-wal`].filter((p) => existsSync(p)).map((p) => readFileSync(p).toString("latin1")).join("\n");
  return {
    c,
    api,
    backend: store,
    key,
    dir,
    dbText,
    async done() {
      await c.cleanup();
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wait for the run to leave RUNNING (real sockets: bounded event-loop waits, never a timing assertion). */
async function ended(c: ComposerRig, runId: string): Promise<ReturnType<ComposerRig["service"]["get"]>> {
  for (let i = 0; i < 10_000; i++) {
    const run = c.service.get(runId);
    if (run.state !== "RUNNING" && run.state !== "QUEUED") return run;
    await new Promise((res) => setTimeout(res, 2));
  }
  throw new Error("the run did not end");
}

async function runOnce(s: Setup, prompt = "Say hello"): Promise<{ run: Awaited<ReturnType<typeof ended>>; events: RunEvent[] }> {
  const { run } = await s.c.service.start(START(s.c.workspaceId, { ...ANT, prompt, mode: "ask" }), new AbortController().signal);
  const done = await ended(s.c, run.runId);
  return { run: done, events: allEvents(s.c, run.runId) };
}

/** Nowhere the host keeps or shows anything: the live events, the run, the journal and audit rows (raw database bytes). */
function assertNoKey(s: Setup, ...shown: unknown[]): void {
  for (const value of shown) assert.ok(!JSON.stringify(value).includes(s.key), "the key is in an answer or an event");
  assert.ok(!s.dbText().includes(s.key), "the key is in the database (journal or audit)");
  assert.ok(!s.dbText().includes(s.key.slice(8)), "a part of the key is in the database");
}

const credentialRows = (c: ComposerRig) => c.audit.list({ limit: 500 }).filter((e) => e.action === "provider.credential");

test("a run on the Anthropic connection: the key is read from the vault once per request and kept nowhere; usage reaches the budget; the destination is shown", async () => {
  const s = await setup([{ kind: "text", text: "Hello from the mock", inputTokens: 40, outputTokens: 9 }]);
  try {
    const { run, events } = await runOnce(s);
    assert.deepEqual([run.state, run.reason, run.providerId, run.modelId], ["REVIEWING", null, "anthropic", MODEL]);
    // Every HTTP request carried the key, and each one read it from the vault exactly once (start's model list, the model's capabilities, the message).
    assert.deepEqual(s.api.seen.map((r) => `${r.method} ${r.path}`), ["GET /v1/models", `GET /v1/models/${MODEL}`, "POST /v1/messages"]);
    assert.ok(s.api.seen.every((r) => r.key === s.key));
    assert.equal(s.backend.reads(), s.api.seen.length);
    assert.ok(s.api.asked.every((u) => u.startsWith(`${ORIGIN}/`)));
    // DMN-5: each read is audited with its purpose and outcome, never the key.
    const rows = credentialRows(s.c);
    assert.equal(rows.length, s.api.seen.length);
    assert.ok(rows.every((r) => r.target === `connection:${CONN}` && r.outcome === "success"));
    for (const r of rows) assert.deepEqual(r.payload, { purpose: "provider_request", outcome: "ok" });
    // PRV-4: the request event names the connection and the fixed origin; the mock provider was never asked.
    const req = events.find((e) => e.type === "request");
    assert.ok(req?.type === "request");
    assert.deepEqual([req.providerId, req.connectionId, req.modelId, req.destination], ["anthropic", CONN, MODEL, ORIGIN]);
    assert.equal(s.c.wire(), 0, "no fallback to the mock");
    // J2/C10: the reported usage is in the run budget and the run's usage.
    assert.deepEqual([s.c.journal.composer.get(run.runId)?.budget.tokens, s.c.journal.composer.get(run.runId)?.budget.requests], [49, 1]);
    assert.deepEqual([run.usage?.inputTokens, run.usage?.outputTokens], [40, 9]);
    assert.ok(events.some((e) => e.type === "text" && e.text === "Hello from the mock"));
    assertNoKey(s, run, events);
  } finally {
    await s.done();
  }
});

test("DMN-6: an error body and a header that echo the key fail the run with a closed reason, and the key reaches nothing", async () => {
  const echo = (k: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `bad key ${k} sk-ant-${k}` } });
  const s = await setup([]);
  s.api.replies = [{ kind: "error", status: 400, body: echo(s.key), headers: { "x-echo": s.key } }];
  try {
    const { run, events } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_REQUEST"]);
    assertNoKey(s, run, events, s.c.service.list({ limit: 10 }));
  } finally {
    await s.done();
  }
});

test("DMN-6: a reply that carries the key back (text, or a tool call's input) is refused before the run shows or uses it", async () => {
  for (const reply of [(k: string): MessagesReply => ({ kind: "text", text: `here it is: ${k}` }), (k: string): MessagesReply => ({ kind: "tool", name: "write_file", input: { path: "leak.txt", content: k } })]) {
    const s = await setup([]);
    s.api.replies = [reply(s.key)];
    try {
      const { run, events } = await runOnce(s);
      assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"]);
      assert.ok(!events.some((e) => e.type === "tool"), "no tool call ran");
      assert.ok(!existsSync(join(s.c.root, "leak.txt")));
      // Settled by the guard before the check: the request still counts.
      assert.equal(s.c.journal.composer.get(run.runId)?.budget.requests, 1);
      assertNoKey(s, run, events);
    } finally {
      await s.done();
    }
  }
});

test("ANT-1: a redirect to another host is refused; nothing is sent there and the key goes out once, to the fixed origin", async () => {
  const s = await setup([{ kind: "redirect", location: "https://collector.example/steal" }]);
  try {
    const { run, events } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"]);
    assert.ok(s.api.asked.every((u) => u.startsWith(`${ORIGIN}/`)), s.api.asked.join(" "));
    assert.equal(s.api.seen.filter((r) => r.path === "/v1/messages").length, 1);
    assertNoKey(s, run, events);
  } finally {
    await s.done();
  }
});

test("ANT-1: an oversized stream is cut at the byte cap and the run fails closed; the request is charged", async () => {
  // Valid and complete, and under every other bound (the guard's 8M text characters): only the byte cap can refuse it.
  const total = 7.5 * 1024 * 1024;
  const s = await setup([{ kind: "flood", bytes: total, chunk: 1024 }], { limits: { maxStreamBytes: 256 * 1024 } });
  try {
    const { run } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"]);
    assert.ok(s.api.streamed() < total, `the client stopped reading (${s.api.streamed()} bytes sent)`);
    assert.equal(s.c.journal.composer.get(run.runId)?.budget.requests, 1);
    assert.ok((s.c.journal.composer.get(run.runId)?.budget.tokens ?? 0) > 0, "charged at its reservation: no usage was reported");
  } finally {
    await s.done();
  }
});

test("a response that claims another model fails the run (model_mismatch), and its usage still reaches the budget", async () => {
  const s = await setup([{ kind: "text", text: "from elsewhere", model: "claude-other-9", inputTokens: 30, outputTokens: 4 }]);
  try {
    const { run, events } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"]);
    assert.ok(!events.some((e) => e.type === "text"), "the other model's text is not shown");
    assert.equal(s.c.journal.composer.get(run.runId)?.budget.tokens, 34);
  } finally {
    await s.done();
  }
});

test("a request that never answers ends at the guard's request timeout with a closed reason", { timeout: 60_000 }, async () => {
  const s = await setup([{ kind: "hang" }], { guardLimits: { requestTimeoutMs: 300 } });
  try {
    const { run } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_TIMEOUT"]);
  } finally {
    await s.done();
  }
});

test("a locked or empty vault fails closed: the start is refused with nothing sent and nothing created; the error carries no key", async () => {
  for (const prep of [(b: FakeBackend) => b.lock(true), (b: FakeBackend) => b.setKey(undefined)]) {
    const s = await setup([{ kind: "text", text: "unused" }]);
    prep(s.backend);
    try {
      const err = await s.c.service.start(START(s.c.workspaceId, ANT), new AbortController().signal).then(
        () => assert.fail("started"),
        (e: unknown) => e as { code: string; message: string; details?: unknown },
      );
      assert.deepEqual([err.code, (err.details as { reason?: string } | undefined)?.reason], ["E_UNAVAILABLE", "provider_unavailable"]);
      assert.equal(s.api.seen.length, 0, "no request without a key");
      assert.equal(s.c.service.list({ limit: 10 }).length, 0);
      assert.equal(s.c.wire(), 0, "no fallback to the mock");
      const rows = credentialRows(s.c);
      assert.ok(rows.length >= 1 && rows.every((r) => r.outcome === "failure" && ["backend_failed", "not_found"].includes(String((r.payload as { outcome: string }).outcome))));
      assertNoKey(s, err.message, err.details);
    } finally {
      await s.done();
    }
  }
});

test("a vault that locks during a run ends it PROVIDER_AUTHENTICATION before any message is sent", async () => {
  const backend = fakeBackend(CONN, testKey());
  const s = await setup([{ kind: "text", text: "unused" }], {}, backend);
  // The start's model list reads the key once; lock right after it.
  const get = backend.get.bind(backend);
  backend.get = async (name) => {
    const out = await get(name);
    backend.lock(true);
    return out;
  };
  try {
    const { run } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_AUTHENTICATION"]);
    assert.equal(s.api.seen.filter((r) => r.path === "/v1/messages").length, 0);
  } finally {
    await s.done();
  }
});

test("a key read whose audit row cannot be written is not used: no request goes out", async () => {
  const key = testKey();
  const api = await mockAnthropic();
  const c = await composerRig({ replies: [], failAudit: (a) => a === "provider.credential", anthropic: { connectionId: CONN, backend: fakeBackend(CONN, key), fetch: api.fetch } });
  try {
    await assert.rejects(c.service.start(START(c.workspaceId, ANT), new AbortController().signal), (e: { details?: { reason?: string } }) => e.details?.reason === "provider_unavailable");
    assert.equal(api.seen.length, 0);
  } finally {
    await c.cleanup();
    await api.close();
  }
});

test("the key is registered with the host redactor before use: a prompt that holds it is refused before anything is sent", async () => {
  const key = plainKey();
  const s = await setup([{ kind: "text", text: "first" }], {}, fakeBackend(CONN, key), key);
  assert.equal(s.c.redactor.redactString(key), key, "no built-in rule knows this key");
  try {
    await runOnce(s);
    const before = s.api.seen.length;
    const { run } = await runOnce(s, `please use ${s.key}`);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_SECRET_IN_REQUEST"]);
    assert.ok(s.api.seen.slice(before).every((r) => r.path !== "/v1/messages"), "the prompt never went out");
    assert.equal(s.c.redactor.redactString(s.key).includes(s.key), false);
    assertNoKey(s, run);
  } finally {
    await s.done();
  }
});

// C5 SF-1 and PRV-1 through `axis.providers/1.list`, as compose wires it.
const listOf = async (c: ComposerRig): Promise<Record<string, unknown>[]> => {
  const h = createProvidersHandlers({ providers: () => c.agent.providers(), cachedModels: (id) => c.providers.cachedModels(id), credential: (id, signal) => c.providers.credential(id, signal) }).list;
  const out = providersListResponseSchema.parse(await h({ identity: { kind: "user" }, requestId: "r", correlationId: "c", signal: new AbortController().signal } as unknown as HandlerContext, {} as never));
  return out.providers as unknown as Record<string, unknown>[];
};
const anthropicOf = async (c: ComposerRig): Promise<Record<string, unknown>> => {
  const p = (await listOf(c)).find((x) => x["providerId"] === "anthropic");
  assert.ok(p);
  return p;
};

test("the list never asks the network adapter: unchecked until a run start fetched the models, then ready with them; a failed fetch clears them", async () => {
  const s = await setup([{ kind: "text", text: "ok" }]);
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual([(await anthropicOf(s.c))["status"], (await anthropicOf(s.c))["models"]], ["unchecked", []]);
    assert.equal(s.api.asked.length, 0, "no request per list call");
    assert.equal(s.backend.reads(), 0, "and no key read");
    await runOnce(s);
    const asked = s.api.asked.length;
    const p = await anthropicOf(s.c);
    assert.deepEqual([p["status"], p["models"]], ["ready", [{ modelId: MODEL, displayName: "Claude Test" }]]);
    assert.equal(s.api.asked.length, asked);
    // The mock is listed as before, without a credential.
    assert.equal((await listOf(s.c)).find((x) => x["providerId"] === "mock")?.["credential"], undefined);
    s.backend.lock(true);
    await assert.rejects(s.c.service.start(START(s.c.workspaceId, ANT), new AbortController().signal));
    s.backend.lock(false);
    assert.equal((await anthropicOf(s.c))["status"], "unchecked");
  } finally {
    await s.done();
  }
});

test("PRV-1: the list shows where the key is stored, a weak backend as weak, and a locked vault as unavailable, never the key", async () => {
  const strong = await setup([]);
  try {
    assert.deepEqual((await anthropicOf(strong.c))["credential"], { state: "stored", backend: "gnome_libsecret", protection: "os_protected", weakConsent: false, backendChanged: false });
    strong.backend.setKey(undefined);
    assert.deepEqual((await anthropicOf(strong.c))["credential"], { state: "missing", backend: "gnome_libsecret", protection: "os_protected", policy: "allowed" });
    strong.backend.lock(true);
    const locked = await anthropicOf(strong.c);
    assert.deepEqual([locked["credential"], locked["status"]], [{ state: "unavailable" }, "unchecked"]);
  } finally {
    await strong.done();
  }
  const weak = await setup([], {}, fakeBackend(CONN, testKey(), { id: "basic_text", protection: "none" }));
  try {
    const p = await anthropicOf(weak.c);
    assert.deepEqual(p["credential"], { state: "stored", backend: "basic_text", protection: "none", weakConsent: true, backendChanged: false });
    weak.backend.setKey(undefined);
    assert.deepEqual((await anthropicOf(weak.c))["credential"], { state: "missing", backend: "basic_text", protection: "none", policy: "consent_required" });
    assert.ok(!JSON.stringify(await listOf(weak.c)).includes(weak.key));
  } finally {
    await weak.done();
  }
});

test("the stream path holds the same rules: another model, or the key split across deltas, fails the stream", async () => {
  const s = await setup([]);
  try {
    const provider = s.c.agent.provider("anthropic");
    assert.ok(provider);
    const drain = async (): Promise<string> => {
      const req = { model: MODEL, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], maxOutputTokens: 64 };
      try {
        for await (const _ of provider.stream(req, { runId: "r-stream", signal: new AbortController().signal })) void _;
        return "completed";
      } catch (e) {
        return `${(e as { code?: string }).code}/${(e as { details?: { reason?: string } }).details?.reason}`;
      }
    };
    s.api.replies = [{ kind: "text", text: "fine" }];
    assert.equal(await drain(), "completed");
    s.api.replies = [{ kind: "text", text: "elsewhere", model: "claude-other-9" }];
    assert.equal(await drain(), "invalid_response/model_mismatch");
    // The mock server sends text in 7-character deltas, so the key arrives in pieces.
    s.api.replies = [{ kind: "text", text: `pad ${s.key} pad` }];
    assert.equal(await drain(), "invalid_response/credential_echo");
  } finally {
    await s.done();
  }
});
