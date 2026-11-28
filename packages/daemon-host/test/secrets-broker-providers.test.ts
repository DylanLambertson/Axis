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
import { BROKER_ROLLBACK_MS } from "../src/compose-secrets.js";
import { META, secretsRig } from "../testing/secrets-rig.js";
import { CONN, credentialRows, runOnce, setup } from "./anthropic-rig.js";
import { testKey } from "./anthropic-server.js";

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
