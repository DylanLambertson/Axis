// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockProvider, guardProvider, NO_SECRETS, ProviderError, type GenerateRequest, type StreamEvent } from "@axis/providers";
import { createAgentBinding, type AgentBindingDeps } from "../src/index.js";
import { ANT, CONN, credentialRows, runOnce, setup, type Setup } from "./anthropic-rig.js";
import { fakeBackend, MODEL } from "./anthropic-server.js";
import { START } from "./composer-rig.js";

// Review c6-anthropic r1: SF-2 and N1 to N4.

const REQ: GenerateRequest = { model: MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxOutputTokens: 64 };

/** Every event the binding's stream yields, and how it ended (`completed` or `code/reason`). */
async function streamOf(s: Setup): Promise<{ readonly events: StreamEvent[]; readonly end: string }> {
  const provider = s.c.agent.provider("anthropic");
  assert.ok(provider);
  const events: StreamEvent[] = [];
  try {
    for await (const ev of provider.stream(REQ, { runId: "r-stream", signal: new AbortController().signal })) events.push(ev);
    return { events, end: "completed" };
  } catch (e) {
    return { events, end: `${(e as { code?: string }).code}/${(e as { details?: { reason?: string } }).details?.reason}` };
  }
}

const textOf = (events: readonly StreamEvent[]): string => events.map((e) => (e.type === "content_block_delta" && e.delta.type === "text" ? e.delta.text : "")).join("");

test("SF-2: nothing of a provider's error body reaches the run, its events, the stored rows or the error the binding throws", async () => {
  const MARK = ["zebra", "corn", "marker"].join("-");
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `${MARK}: please email ${MARK}@example.test` }, request_id: `req_${MARK}` });
  const s = await setup([{ kind: "error", status: 400, body, headers: { "x-detail": MARK } }]);
  try {
    const { run, events } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_REQUEST"]);
    for (const shown of [run, events, s.c.service.list({ limit: 10 })]) assert.ok(!JSON.stringify(shown).includes(MARK));
    assert.ok(!s.dbText().includes(MARK), "the body is in the journal or the audit log");
    // At the provider boundary: the fixed text of the code, the status, nothing from the body.
    const provider = s.c.agent.provider("anthropic");
    assert.ok(provider);
    const err = await provider.generate(REQ, { runId: "r-direct", signal: new AbortController().signal }).then(
      () => assert.fail("answered"),
      (e: unknown) => e as ProviderError,
    );
    assert.equal(err.code, "invalid_request");
    assert.equal(err.message, new ProviderError("invalid_request").message);
    assert.ok(!JSON.stringify({ message: err.message, details: err.details, s: String(err) }).includes(MARK));
  } finally {
    await s.done();
  }
});

test("N1: a stream releases no part of a key: a key split across deltas is refused before any of it is yielded", async () => {
  const s = await setup([]);
  try {
    // The mock sends 7 characters per delta: the key arrives in pieces, after some text.
    s.api.replies = [{ kind: "text", text: `${"lead ".repeat(4)}${s.key} tail` }];
    const out = await streamOf(s);
    assert.equal(out.end, "invalid_response/credential_echo");
    assert.ok(!textOf(out.events).includes(s.key.slice(0, 6)), `a prefix of the key was yielded: ${JSON.stringify(textOf(out.events))}`);
    // The key straddles the first point where the check releases text (16,384 held characters, 7 per delta): what was
    // checked before the key was whole is still held back, so its first characters are not released early.
    s.api.replies = [{ kind: "text", text: `${"w".repeat(16_364)}${s.key} tail` }];
    const straddle = await streamOf(s);
    assert.equal(straddle.end, "invalid_response/credential_echo");
    assert.ok(textOf(straddle.events).length > 0, "text before the key was released");
    assert.ok(!textOf(straddle.events).includes(s.key.slice(0, 6)), "a prefix of the key was released at the boundary");
    // A long, clean answer streams whole and in order, through the hold-back.
    const long = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
    s.api.replies = [{ kind: "text", text: long }];
    const ok = await streamOf(s);
    assert.equal(ok.end, "completed");
    assert.equal(textOf(ok.events), long);
    assert.ok(ok.events.length > 1000, "streamed in many deltas, not one");
  } finally {
    await s.done();
  }
});

test("N2: a key is found in a tool input's parsed strings and in an encoded form, and an unrelated key-shaped example is not refused", async () => {
  // A key with a quote and a backslash: in the tool input's JSON text it would only appear escaped.
  const key = ["hold", 'out"stand', "in\\credential-c6"].join("");
  for (const reply of [
    { kind: "tool" as const, name: "write_file", input: { path: "a.txt", content: `x${key}x` } },
    { kind: "tool" as const, name: "write_file", input: { path: "a.txt", content: "ok", [key]: 1 } },
    { kind: "text" as const, text: `hex: ${Buffer.from(key, "utf8").toString("hex")}` },
    { kind: "text" as const, text: `b64: ${Buffer.from(key, "utf8").toString("base64")}` },
  ]) {
    const s = await setup([reply], {}, fakeBackend(CONN, key), key);
    try {
      const { run } = await runOnce(s);
      assert.deepEqual([run.state, run.reason], ["FAILED", "PROVIDER_INVALID_RESPONSE"], JSON.stringify(reply).slice(0, 60));
    } finally {
      await s.done();
    }
  }
  const example = ["sk", "ant", "api03", "documentation".padEnd(30, "x")].join("-");
  const s = await setup([{ kind: "text", text: `A key looks like ${example}.` }]);
  try {
    const { run } = await runOnce(s);
    assert.deepEqual([run.state, run.reason], ["REVIEWING", null], "only a key the vault handed out is refused");
  } finally {
    await s.done();
  }
});

test("N3: a key the redactor cannot register is not used, and its read is still audited (unusable)", async () => {
  const s = await setup([{ kind: "text", text: "unused" }], {}, fakeBackend(CONN, "short"), "short");
  try {
    await assert.rejects(s.c.service.start(START(s.c.workspaceId, ANT), new AbortController().signal), (e: { details?: { reason?: string } }) => e.details?.reason === "provider_unavailable");
    assert.equal(s.api.seen.length, 0);
    const rows = credentialRows(s.c);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]?.outcome, rows[0]?.payload], ["failure", { purpose: "provider_request", outcome: "unusable" }]);
  } finally {
    await s.done();
  }
});

test("c7 N1: a stored key the windowed scan could not hold whole (too long, not printable ASCII) is never registered or sent", async () => {
  for (const key of ["q".repeat(4097), `key-${"\u00e9".repeat(40)}`]) {
    const s = await setup([{ kind: "text", text: "unused" }], {}, fakeBackend(CONN, key), key);
    try {
      const forms = s.c.redactor.registeredForms;
      await assert.rejects(s.c.service.start(START(s.c.workspaceId, ANT), new AbortController().signal), (e: { details?: { reason?: string } }) => e.details?.reason === "provider_unavailable");
      assert.equal(s.api.seen.length, 0, "nothing was sent");
      assert.equal(s.c.redactor.registeredForms, forms, "nothing was registered");
      assert.deepEqual(credentialRows(s.c).map((r) => r.payload), [{ purpose: "provider_request", outcome: "unusable" }]);
    } finally {
      await s.done();
    }
  }
});

test("N4: the recorded model list answers only its own connection", async () => {
  const s = await setup([{ kind: "text", text: "ok" }]);
  try {
    await runOnce(s);
    assert.deepEqual(s.c.providers.cachedModels(CONN), [{ id: MODEL, displayName: "Claude Test" }]);
    for (const other of ["mock", "anthropic-other", ""]) assert.equal(s.c.providers.cachedModels(other), undefined, other);
  } finally {
    await s.done();
  }
});

test("N4: the agent binding refuses a provider id registered twice (the mock's included)", () => {
  const deps = { redactor: { redactString: (t: string) => t }, approvals: {}, audit: {} } as unknown as AgentBindingDeps;
  const as = (providerId: string) => guardProvider(createMockProvider({ providerId, connectionId: `${providerId}-conn` }), { redactor: NO_SECRETS });
  assert.throws(() => createAgentBinding({ ...deps, providers: [as("mock")] }), /registered twice/);
  assert.throws(() => createAgentBinding({ ...deps, providers: [as("other"), as("other")] }), /registered twice/);
  const ok = createAgentBinding({ ...deps, providers: [as("other")] });
  assert.deepEqual(ok.providers().map((p) => p.descriptor.providerId).sort(), ["mock", "other"]);
  ok.dispose();
});
