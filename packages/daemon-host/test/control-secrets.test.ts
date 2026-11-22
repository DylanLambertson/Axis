// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The secret broker's control messages (ticket PV-N0a, docs/design/secret-broker.md §3.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundMessageSchema, outboundMessageSchema } from "../src/control/messages.js";
import { secretsRequestSchema, secretsResultSchema } from "../src/control/secrets-messages.js";

const META = { storedAt: 1, backend: "gnome_libsecret", protection: "os_protected", weakConsent: false };
const SECRET = "test-credential-value-0001";

test("the six requests are outbound control messages with strict payloads", () => {
  const good = [
    { type: "secrets.info", requestId: "r1" },
    { type: "secrets.put", requestId: "r1", name: "c1", secret: SECRET, meta: META },
    { type: "secrets.put", requestId: "r1", name: "integration:github", secret: SECRET, meta: { ...META, label: "Work key" } },
    { type: "secrets.get", requestId: "r1", name: "c1" },
    { type: "secrets.meta", requestId: "r1", name: "c1" },
    { type: "secrets.remove", requestId: "r1", name: "c1" },
    { type: "secrets.list", requestId: "r1" },
  ];
  for (const m of good) {
    assert.equal(secretsRequestSchema.safeParse(m).success, true, m.type);
    assert.equal(outboundMessageSchema.safeParse(m).success, true, `${m.type} outbound`);
    assert.equal(inboundMessageSchema.safeParse(m).success, false, `${m.type} is never inbound`);
  }
  const bad = [
    { type: "secrets.get", requestId: "r1", name: "C1" },
    { type: "secrets.get", requestId: "r1", name: "integration:" },
    { type: "secrets.get", requestId: "r1", name: "x:y" },
    { type: "secrets.get", requestId: "r1", name: "c1", extra: 1 },
    { type: "secrets.put", requestId: "r1", name: "c1", secret: "short", meta: META },
    { type: "secrets.put", requestId: "r1", name: "c1", secret: "has space in it", meta: META },
    { type: "secrets.put", requestId: "r1", name: "c1", secret: SECRET, meta: { ...META, backend: "plain" } },
    { type: "secrets.put", requestId: "r1", name: "c1", secret: SECRET, meta: { ...META, path: "/x" } },
    { type: "secrets.list", requestId: "r 1" },
    { type: "secrets.drop", requestId: "r1" },
  ];
  for (const m of bad) assert.equal(outboundMessageSchema.safeParse(m).success, false, JSON.stringify(m));
});

test("an answer is a value or a closed error, never both and never neither, and it is inbound", () => {
  const ok = { type: "secrets.result", requestId: "r1", ok: true, value: { op: "remove", removed: true } };
  const no = { type: "secrets.result", requestId: "r1", ok: false, error: "refused" };
  for (const m of [ok, no]) {
    assert.equal(secretsResultSchema.safeParse(m).success, true);
    assert.equal(inboundMessageSchema.safeParse(m).success, true, "inbound");
    assert.equal(outboundMessageSchema.safeParse(m).success, false, "never outbound");
  }
  for (const m of [
    { ...ok, error: "failed" },
    { ...no, value: { op: "remove", removed: true } },
    { type: "secrets.result", requestId: "r1", ok: true },
    { type: "secrets.result", requestId: "r1", ok: false },
    { ...no, error: "EACCES: /home/u/secrets" },
    { ...ok, value: { op: "get", secret: SECRET, meta: META, path: "/x" } },
    { ...ok, value: { op: "list", entries: Array.from({ length: 257 }, (_, i) => ({ name: `c${i}`, meta: META })) } },
  ]) {
    assert.equal(inboundMessageSchema.safeParse(m).success, false, JSON.stringify(m).slice(0, 60));
  }
});
