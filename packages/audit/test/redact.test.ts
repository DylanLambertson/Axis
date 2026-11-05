// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError, Redactor, summarizeContent } from "../src/index.js";
import { FAKE, FAKE_NEEDLES } from "./fakes.js";

const r = () => new Redactor();

function assertClean(text: string): void {
  for (const needle of FAKE_NEEDLES) {
    assert.ok(!text.includes(needle), `leaked a fake credential (${needle.slice(0, 6)}...)`);
  }
}

test("provider API keys, GitHub tokens, JWTs and AWS/Google keys get kind-specific placeholders", () => {
  const out = r().redactString(
    [FAKE.anthropic, FAKE.openai, FAKE.github, FAKE.githubFine, FAKE.google, FAKE.aws, FAKE.jwt].join(" | "),
  );
  assert.equal(
    out,
    [
      "[REDACTED:anthropic-api-key]",
      "[REDACTED:openai-api-key]",
      "[REDACTED:github-token]",
      "[REDACTED:github-token]",
      "[REDACTED:google-api-key]",
      "[REDACTED:aws-access-key]",
      "[REDACTED:jwt]",
    ].join(" | "),
  );
});

test("private key blocks are removed, including a block truncated before its END line", () => {
  const full = r().redactString(`before\n${FAKE.privateKey}\nafter`);
  assert.equal(full, "before\n[REDACTED:private-key]\nafter");
  const cut = r().redactString(`log: ${FAKE.rsaKeyTruncated}`);
  assert.equal(cut, "log: [REDACTED:private-key]");
  assertClean(full + cut);
});

test("Authorization headers keep the header name and lose the credential", () => {
  const redactor = r();
  assert.equal(
    redactor.redactString(`Authorization: Bearer ${FAKE.jwt}`),
    "Authorization: [REDACTED:authorization]",
  );
  assert.equal(
    redactor.redactString(`{"authorization":"Basic ${"dXNlcjpwYXNz".repeat(2)}"}`),
    '{"authorization":"[REDACTED:authorization]"}',
  );
  assert.equal(
    redactor.redactString(`curl -H 'x: y' Bearer ${"abcd1234".repeat(3)}`),
    "curl -H 'x: y' Bearer [REDACTED:authorization]",
  );
});

test("URL credentials are removed but host and path survive", () => {
  const out = r().redactString(`git clone https://alice:${FAKE.password}@example.test/org/repo.git`);
  assert.equal(out, "git clone https://[REDACTED:url-credentials]@example.test/org/repo.git");
  assertClean(out);
});

test("registered secrets are redacted in raw, URL-encoded, base64 and JSON-escaped forms", () => {
  const redactor = r();
  const secret = 'vault "quoted" secret/with+chars=9';
  redactor.registerSecret(secret);
  const variants = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    JSON.stringify(secret).slice(1, -1),
  ];
  for (const v of variants) {
    assert.equal(redactor.redactString(`x ${v} y`), "x [REDACTED:registered-secret] y");
  }
});

test("registering a too-short secret is refused", () => {
  assert.throws(
    () => r().registerSecret("short"),
    (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT",
  );
});

test("redaction is deterministic and idempotent", () => {
  const redactor = r();
  const input = `k=${FAKE.anthropic} Authorization: Bearer ${FAKE.jwt} https://u:${FAKE.password}@h.test/`;
  const once = redactor.redactString(input);
  assert.equal(redactor.redactString(input), once);
  assert.equal(redactor.redactString(once), once);
});

test("deep redaction covers nested values, array items, keys and sensitive field names", () => {
  const redactor = r();
  redactor.registerSecret(FAKE.vaultKey);
  const payload = {
    note: `used ${FAKE.anthropic}`,
    nested: { list: [`x ${FAKE.github}`, { deeper: FAKE.jwt }], password: FAKE.password },
    headers: { Authorization: `Bearer ${FAKE.jwt}`, "X-Api-Key": FAKE.openai, accept: "json" },
    githubToken: FAKE.github,
    [`key-${FAKE.vaultKey}`]: 1,
    count: 3,
    empty: "",
    nothing: null,
    gone: undefined,
    err: new Error(`failed with ${FAKE.aws}`),
    big: 10n,
    when: new Date("2026-01-02T03:04:05.000Z"),
  };
  const out = redactor.redactValue(payload) as Record<string, unknown>;
  const text = JSON.stringify(out);
  assertClean(text);
  assert.ok(!text.includes("stack"));
  assert.deepEqual((out["nested"] as Record<string, unknown>)["password"], "[REDACTED:sensitive-field]");
  assert.equal(out["githubToken"], "[REDACTED:sensitive-field]");
  assert.deepEqual(out["headers"], {
    Authorization: "[REDACTED:sensitive-field]",
    "X-Api-Key": "[REDACTED:sensitive-field]",
    accept: "json",
  });
  assert.equal(out["count"], 3);
  assert.equal(out["empty"], "");
  assert.equal(out["nothing"], null);
  assert.ok(!("gone" in out));
  assert.equal(out["big"], "10");
  assert.equal(out["when"], "2026-01-02T03:04:05.000Z");
  assert.ok("key-[REDACTED:registered-secret]" in out);
});

test("cycles, deep nesting and prototype-polluting keys are handled safely", () => {
  const redactor = r();
  const loop: Record<string, unknown> = { a: 1 };
  loop["self"] = loop;
  assert.deepEqual(redactor.redactValue(loop), { a: 1, self: "[CIRCULAR]" });

  let deep: unknown = "leaf";
  for (let i = 0; i < 100; i++) deep = { d: deep };
  assert.ok(JSON.stringify(redactor.redactValue(deep)).includes("[TRUNCATED:depth]"));

  const evil = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as unknown;
  const out = redactor.redactValue(evil) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(out["ok"], 1);
  assert.ok(Object.hasOwn(out, "__proto__"));
});

test("content fields can be summarised as length plus hash instead of text", () => {
  const s = summarizeContent("print('hello')");
  assert.equal(s.length, 14);
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
});
