// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-N0c-1 (docs/design/secret-broker.md §3.5, §6.1 "The provider reveal gate", gate line 5 at daemon level): the providers
// binding over the broker backend, with the wiring's vault policy (`refuse`, rollback 65 s). A provider entry whose own
// metadata, as main reports it, is unprotected is refused at the startup validation and on a provider request: its key is
// never registered, never sent, and no HTTP request leaves. The startup reveal validates every stored provider entry once,
// audited, skips integration entries, and retries nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Redactor } from "@axis/audit";
import { asVaultBackend, createProvidersBinding, productionConnection } from "../src/bindings/providers.js";
import { BROKER_ROLLBACK_MS, STOP_WAIT_MS, secretBrokerWiring } from "../src/compose-secrets.js";
import { ChannelMux, ControlClient } from "../src/index.js";
import { STARTUP_WAIT_MS } from "../src/bindings/providers.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { META, secretsRig } from "../testing/secrets-rig.js";
import { CONN, credentialRows, runOnce, setup } from "./anthropic-rig.js";
import { mockAnthropic, testKey } from "./anthropic-server.js";

const VAULT = { weakPolicy: "refuse" as const, rollbackTimeoutMs: BROKER_ROLLBACK_MS };
const WEAK = { ...META, protection: "none" as const };

test("a provider entry main reports as unprotected is refused on a provider request: no HTTP, no registration, audited weak_entry", async () => {
  const key = testKey();
  const r = secretsRig();
  r.main.entries.set(CONN, { secret: key, meta: WEAK });
  const s = await setup([{ kind: "text", text: "never sent" }], { vault: VAULT }, asVaultBackend(r.backend) as unknown as Parameters<typeof setup>[2], key);
  try {
    // The start reads the key for the model list first: refused there, so the run never starts.
    await assert.rejects(runOnce(s), { message: "The provider could not be reached." });
    assert.deepEqual(s.api.seen, [], "no request left for the provider");
    const rows = credentialRows(s.c);
    assert.ok(rows.length >= 1);
    for (const row of rows) assert.deepEqual([row.outcome, row.payload], ["failure", { purpose: "provider_request", outcome: "weak_entry" }]);
    assert.ok(r.ops().every((o) => o === `get:${CONN}` || o === "info"), "only the backend report and reads of that entry reached main");
  } finally {
    await s.done();
  }
});

test("the same entry, protected, is served through the broker: one read per request, each audited", async () => {
  const key = testKey();
  const r = secretsRig();
  r.main.entries.set(CONN, { secret: key, meta: { ...META } });
  const s = await setup([{ kind: "text", text: "Hello", inputTokens: 3, outputTokens: 2 }], { vault: VAULT }, asVaultBackend(r.backend) as unknown as Parameters<typeof setup>[2], key);
  try {
    const { run } = await runOnce(s);
    assert.equal(run.state, "REVIEWING", run.reason ?? "");
    assert.ok(s.api.seen.length >= 1 && s.api.seen.every((q) => q.key === key));
    assert.equal(r.ops().filter((o) => o === `get:${CONN}`).length, s.api.seen.length, "one broker read per HTTP request");
    assert.ok(credentialRows(s.c).every((row) => row.outcome === "success"));
  } finally {
    await s.done();
  }
});

test("the startup reveal validates each stored provider entry once, refuses the weak one, skips integrations, and retries nothing", async () => {
  const r = secretsRig();
  const good = "test-provider-key-good-0001";
  const weak = "test-provider-key-weak-0002";
  const token = "test-integration-token-0003";
  r.main.entries.set("other-conn", { secret: weak, meta: WEAK }); // listed first: its refusal must not stop the rest
  r.main.entries.set(CONN, { secret: good, meta: { ...META } });
  r.main.entries.set("integration:github", { secret: token, meta: { ...META } });
  const rows: Array<{ target: string; outcome: string; payload: unknown }> = [];
  const redactor = new Redactor();
  const binding = createProvidersBinding({ redactor, audit: { append: (e) => (rows.push(e as never), e as never) }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT } });
  assert.deepEqual(await binding.validateStored(), { listed: true, validated: 1, failed: 1 });
  assert.deepEqual(
    rows.map((x) => [x.target, x.outcome, x.payload]),
    [
      ["connection:other-conn", "failure", { purpose: "validate_connection", outcome: "weak_entry" }],
      [`connection:${CONN}`, "success", { purpose: "validate_connection", outcome: "ok" }],
    ],
  );
  assert.notEqual(redactor.redactString(`k=${good}`), `k=${good}`, "the validated key is registered with the redactor");
  assert.equal(redactor.redactString(`k=${weak}`), `k=${weak}`, "the refused key is not");
  assert.equal(redactor.redactString(`k=${token}`), `k=${token}`, "integration entries are not revealed at start");
  assert.deepEqual(r.ops().filter((o) => o !== "info"), ["list", "get:other-conn", `get:${CONN}`], "one list, one read per provider entry, no retry, no integration read");
  for (const k of [good, weak, token]) assert.equal(JSON.stringify(rows).includes(k), false, "no audit row carries a key");
  for (const x of rows) assert.deepEqual(Object.keys(x.payload as object).sort(), ["outcome", "purpose"], "the payload is purpose and outcome only: no key, no length");
});

test("the startup reveal survives a failing list and a hung read: closed counts, never a throw", async () => {
  const r = secretsRig(undefined, 200);
  r.main.rawAnswer = (m) => (m.type === "secrets.list" ? { type: "secrets.result", requestId: m.requestId, ok: false, error: "failed" } : undefined);
  const binding = createProvidersBinding({ redactor: new Redactor(), audit: { append: (e) => e as never }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT } });
  assert.deepEqual(await binding.validateStored(), { listed: false, validated: 0, failed: 0 });
  const h = secretsRig({ budgetMs: { get: 60_000 } }, 200);
  h.main.entries.set(CONN, { secret: "test-provider-key-hung-0004", meta: { ...META } });
  h.main.workMs = (op) => (op === "get" ? Infinity : 0);
  const rows: Array<{ outcome: string; payload: unknown }> = [];
  const b2 = createProvidersBinding({ redactor: new Redactor(), audit: { append: (e) => (rows.push(e as never), e as never) }, anthropic: { connectionId: CONN, backend: asVaultBackend(h.backend), vault: VAULT } });
  assert.deepEqual(await b2.validateStored(), { listed: true, validated: 0, failed: 1 });
  assert.deepEqual(rows.map((x) => [x.outcome, x.payload]), [["failure", { purpose: "validate_connection", outcome: "backend_failed" }]]);
  assert.equal(h.ops().filter((o) => o.startsWith("get:")).length, 1, "a hung read is not retried");
});

test("an unavailable cipher: the vault reports stores as refused (no consent path) through the broker", async () => {
  const r = secretsRig();
  r.main.info = { backend: "gnome_libsecret", protection: "os_protected", available: false };
  const binding = createProvidersBinding({ redactor: new Redactor(), audit: { append: (e) => e as never }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT } });
  assert.deepEqual(await binding.credential(CONN, new AbortController().signal), { state: "missing", backend: "gnome_libsecret", protection: "none", policy: "refused" });
});

test("the wiring raises the vault's rollback of a timed-out put to 65 s, and the composition's copy keeps it", () => {
  assert.equal(BROKER_ROLLBACK_MS, 65_000);
  const conn = productionConnection({ connectionId: CONN, backend: asVaultBackend(secretsRig().backend), vault: VAULT });
  assert.deepEqual(conn.anthropic?.vault, { weakPolicy: "refuse", rollbackTimeoutMs: 65_000 });
});

test("the vault USES the wiring's 65 s rollback: a stray copy whose removal takes 12 s is removed, not left in quarantine (review n0c1-b S1)", async () => {
  // Main lies that the put landed elsewhere; the vault must remove the copy, and main's remove takes 12 s: two 5 s attempts
  // would both give up (rollback_failed), one 65 s attempt succeeds.
  const r = secretsRig({ budgetMs: { put: 60_000, remove: 60_000, meta: 60_000 } }, { slow: 65_000, fast: 20_000 });
  r.main.rawAnswer = (m, normal) => (m.type === "secrets.put" ? { type: "secrets.result", requestId: m.requestId, ok: true, value: { op: "put", landedOn: { backend: "kwallet6", protection: "os_protected" } } } : normal);
  r.main.workMs = (op) => (op === "remove" ? 12_000 : 0);
  let seam: { store: (id: string, secret: string) => Promise<unknown>; outcomes: readonly string[] } | undefined;
  createProvidersBinding({ redactor: new Redactor(), audit: { append: (e) => e as never }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT }, observeVault: (v) => void (seam = v) });
  await assert.rejects(seam!.store(CONN, "test-provider-key-new-0001"), { code: "backend_changed" });
  assert.deepEqual(seam!.outcomes, ["error"], "the copy was removed (an `error` store), not `rollback_failed`");
  assert.equal(r.main.entries.has(CONN), false);
});

test("the wiring hands out ONE backend: the same object on every read of it (review n0c1-b S2)", () => {
  const { a } = memoryChannelPair();
  const w = secretBrokerWiring({ connectionId: CONN }, new ControlClient({ mux: new ChannelMux(a) }), undefined);
  assert.ok(w !== undefined);
  assert.equal(w.backend, w.backend);
  assert.equal(Object.getOwnPropertyDescriptor(w, "backend")?.get, undefined, "a data property, not a getter that could build anew");
  assert.ok(Object.isFrozen(w));
});

test("a provider request waits for the running startup reveal, so the redactor knows every stored key before it is sent (S3)", async () => {
  const r = secretsRig({ budgetMs: { get: 60_000 } }, 60_000);
  r.main.entries.set("other-conn", { secret: "test-provider-key-other-0005", meta: { ...META } });
  r.main.entries.set(CONN, { secret: "test-provider-key-main-0006", meta: { ...META } });
  r.main.workMs = (op, name) => (op === "get" && name === "other-conn" ? 600 : 0);
  const api = await mockAnthropic();
  let done = false;
  const sentAfterStartup: boolean[] = [];
  const redactor = new Redactor();
  const binding = createProvidersBinding({ redactor, audit: { append: (e) => e as never }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT, fetch: (u, i) => (sentAfterStartup.push(done), api.fetch(u, i)) } });
  try {
    const startup = binding.validateStored().then((x) => ((done = true), x));
    await binding.providers[0]!.listModels({ signal: new AbortController().signal }).catch(() => undefined);
    assert.deepEqual(await startup, { listed: true, validated: 2, failed: 0 });
    assert.ok(sentAfterStartup.length >= 1 && sentAfterStartup.every(Boolean), "no HTTP request before the startup reveal finished");
    assert.notEqual(redactor.redactString("x test-provider-key-other-0005"), "x test-provider-key-other-0005", "the other key was known first");
  } finally {
    await api.close();
  }
});

test("the wait is bounded: with the startup reveal hung, a provider request goes on after STARTUP_WAIT_MS (S3)", async () => {
  assert.equal(STARTUP_WAIT_MS, 10_000);
  const r = secretsRig({ budgetMs: { get: 120_000 } }, 120_000);
  r.main.entries.set("other-conn", { secret: "test-provider-key-other-0007", meta: { ...META } });
  r.main.entries.set(CONN, { secret: "test-provider-key-main-0008", meta: { ...META } });
  r.main.workMs = (op, name) => (op === "get" && name === "other-conn" ? Infinity : 0);
  const api = await mockAnthropic();
  const binding = createProvidersBinding({ redactor: new Redactor(), audit: { append: (e) => e as never }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT, fetch: api.fetch } });
  try {
    void binding.validateStored().catch(() => undefined);
    const started = Date.now();
    await binding.providers[0]!.listModels({ signal: new AbortController().signal }).catch(() => undefined);
    const took = Date.now() - started;
    assert.ok(took >= STARTUP_WAIT_MS - 500 && took < STARTUP_WAIT_MS + 15_000, `went on after the bound (${took} ms)`);
    assert.ok(api.seen.length >= 1, "the request was sent after the bound");
  } finally {
    await api.close();
    r.client.dispose();
  }
});

test("shutdown stops the startup reveal: no entry is read after the signal, and stop() is bounded even for a hung read (nit)", async () => {
  const r = secretsRig({ budgetMs: { get: 60_000 } }, 60_000);
  for (const n of ["p1", "p2", "p3"]) r.main.entries.set(n, { secret: `test-provider-key-${n}-0009`, meta: { ...META } });
  r.main.workMs = (op) => (op === "get" ? 100 : 0);
  const binding = createProvidersBinding({ redactor: new Redactor(), audit: { append: (e) => e as never }, anthropic: { connectionId: CONN, backend: asVaultBackend(r.backend), vault: VAULT } });
  const ac = new AbortController();
  const run = binding.validateStored(ac.signal);
  await new Promise((res) => setTimeout(res, 50));
  ac.abort();
  const out = await run;
  assert.equal(out.validated, 1, "the read in flight finished; no later entry started");
  assert.equal(r.ops().filter((o) => o.startsWith("get:")).length, 1);
  const { a } = memoryChannelPair();
  const w = secretBrokerWiring({ connectionId: CONN }, new ControlClient({ mux: new ChannelMux(a) }), undefined);
  let given: AbortSignal | undefined;
  void w!.startup((signal) => ((given = signal), new Promise(() => undefined))); // a reveal that never settles
  const t = Date.now();
  await w!.stop();
  assert.ok(Date.now() - t < STOP_WAIT_MS + 2_000, "stop() is bounded");
  assert.equal(given?.aborted, true, "the reveal was told to stop");
});
