// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the security review of the redactor (B1, B2, S3, S4, S5).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  MAX_STRING_CHARS,
  REDACTION_RULES,
  Redactor,
  isWellFormedString,
  wellFormed,
} from "../src/index.js";

// Low-entropy, runtime-assembled stand-ins; none is a credential.
const SECRET = "hunter2" + "hunter2" + "xyz";
const ONE_MIB = 1_048_576;

const fill = (unit: string, bytes = ONE_MIB): string => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/**
 * Fastest of n runs, in CPU milliseconds: a descheduled process or a GC pause in
 * one run (a shared CI machine) must not fail a complexity check.
 */
function bestOf(n: number, fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const before = process.cpuUsage();
    fn();
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

const ADVERSARIAL: Array<[string, string]> = [
  ["a-", fill("a-")],
  ["a.", fill("a.")],
  ["://", fill("://")],
  ["a://:", fill("a://:")],
  ["a://u:", fill("a://u:")],
  ["x://a@", fill("x://a@")],
  ["@", fill("@")],
  [":", fill(":")],
  ["eyJ-chain", fill("eyJaaaaa.")],
  ["eyJ-long", "eyJ" + fill("a", ONE_MIB - 3)],
  ["sk-", fill("sk-")],
  ["sk-ant-", fill("sk-ant-")],
  ["AKIA", fill("AKIA")],
  ["ghp_", fill("ghp_")],
  ["github_pat_", fill("github_pat_")],
  ["BEGIN", fill("-----BEGIN ")],
  ["BEGIN-words", "-----BEGIN " + fill("A ", ONE_MIB - 11)],
  ["BEGIN-key", fill("-----BEGIN PRIVATE KEY-----\n")],
  ["authorization", fill("authorization ")],
  ["authorization:", fill("authorization: ")],
  ["authorization-spaces", "authorization" + fill(" ", ONE_MIB - 13)],
  ["escaped-json", fill('\\"Authorization\\":\\"')],
  ["bearer", fill("Bearer ")],
  ["bearer-long", "Bearer " + fill("a", ONE_MIB - 7)],
  ["basic", fill("Basic ")],
  ["cookie", fill("cookie: ")],
  ["x-api-key", fill("x-api-key=")],
  ["secret=", fill("secret=")],
  ["word-secret", fill("a_secret_")],
  ["long-word", fill("a")],
  ["spaces", fill(" ")],
  ["newlines", fill("\n")],
  ["quotes", fill("\"'")],
];

test("every redaction rule is linear: 1 MiB of adversarial input takes under 50 ms per rule", () => {
  const slow: string[] = [];
  for (const rule of REDACTION_RULES) {
    for (const [name, input] of ADVERSARIAL) {
      const ms = bestOf(3, () => rule.apply(input));
      if (ms >= 50) slow.push(`${rule.kind} on ${name}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test("redactString (all rules, literals and the encoded-run pass) is bounded on 1 MiB of adversarial input", () => {
  const r = new Redactor();
  r.registerSecret(SECRET);
  const slow: string[] = [];
  for (const [name, input] of ADVERSARIAL) {
    let out = "";
    const ms = bestOf(3, () => void (out = r.redactString(input)));
    if (ms >= 50) slow.push(`${name}: ${ms.toFixed(0)} ms`);
    assert.ok(out.length <= 8 * MAX_STRING_CHARS, `${name} output is not bounded`);
  }
  assert.deepEqual(slow, []);
});

test("B2: the review's quadratic inputs now run in milliseconds", () => {
  const r = new Redactor();
  for (const input of ["a-".repeat(40_000), "a.".repeat(80_000), "eyJaaaaa.".repeat(30_000), "sk-".repeat(60_000)]) {
    const t0 = performance.now();
    r.redactString(input);
    assert.ok(performance.now() - t0 < 50);
  }
});

test("strings past the cap are truncated and the cut is recorded; a token cut in half is not left behind", () => {
  const r = new Redactor();
  const long = "word ".repeat(10_000) + "ghp_" + "a1B2c3".repeat(7);
  const out = r.redactString(long);
  assert.match(out, /\[TRUNCATED:\d+\]$/);
  assert.ok(out.length <= MAX_STRING_CHARS + 32);
  const edge = "x ".repeat(MAX_STRING_CHARS / 2 - 3) + "sk-ant-" + "A1b2".repeat(20);
  const cut = r.redactString(edge);
  assert.ok(!/sk-ant-A1b2/.test(cut), "a partial key prefix survived the cut");
});

test("B1: Buffers, typed arrays, DataViews and ArrayBuffers are summarised and their bytes are never copied", () => {
  const r = new Redactor();
  r.registerSecret(SECRET);
  const text = `token=${SECRET}\n`;
  const buf = Buffer.from(text);
  const out = r.redactValue({
    stdout: buf,
    u8: new Uint8Array(buf),
    u16: new Uint16Array(4),
    dv: new DataView(new ArrayBuffer(8)),
    ab: new ArrayBuffer(16),
    nested: [buf],
  }) as Record<string, unknown>;
  const json = JSON.stringify(out);
  assert.ok(!json.includes(SECRET));
  assert.ok(!/"\d+":\d+/.test(json), "byte indices must not appear");
  assert.deepEqual(out["stdout"], { "[binary]": { length: buf.length, sha256: createHash("sha256").update(buf).digest("hex") } });
  assert.deepEqual((out["ab"] as Record<string, { length: number }>)["[binary]"]?.length, 16);
  assert.ok(json.length < 1500);
});

test("B1: a large Buffer does not inflate the payload", () => {
  const out = JSON.stringify(new Redactor().redactValue({ x: Buffer.alloc(5_000_000, 1) }));
  assert.ok(out.length < 200);
});

test("Map and Set are summarised, not silently emptied", () => {
  const out = new Redactor().redactValue({ m: new Map([[1, 2]]), s: new Set([1, 2, 3]) });
  assert.deepEqual(out, { m: "[Map:1]", s: "[Set:3]" });
});

test("B3: lone surrogates are replaced so stored and hashed forms cannot differ", () => {
  const r = new Redactor();
  assert.equal(isWellFormedString("a\ud800b"), false);
  assert.equal(wellFormed("a\ud800b"), "a\ufffdb");
  assert.equal(wellFormed("ok \ud83d\ude00"), "ok \ud83d\ude00");
  assert.equal(r.redactString("x\udc00y"), "x\ufffdy");
  const out = r.redactValue({ ["k\ud800"]: "v\ud800" }) as Record<string, string>;
  assert.deepEqual(out, { "k\ufffd": "v\ufffd" });
});

test("S3: registered secrets are caught in base64url, unpadded base64, hex, NFC/NFD and lower-case percent forms", () => {
  const r = new Redactor();
  const plain = "crème-brûlée-42" + "x";
  r.registerSecret(plain);
  r.registerSecret(SECRET);
  const b = Buffer.from(SECRET);
  const forms = [
    b.toString("base64url"),
    b.toString("base64").replace(/=+$/, ""),
    b.toString("base64"),
    b.toString("hex"),
    b.toString("hex").toUpperCase(),
    encodeURIComponent(plain).toLowerCase(),
    plain.normalize("NFD"),
    plain.normalize("NFC"),
  ];
  for (const f of forms) {
    const out = r.redactString(`value: ${f} end`);
    assert.ok(out.includes("[REDACTED:registered-secret]"), `form not redacted: ${f}`);
    assert.ok(!out.includes(f));
  }
});

test("S3: Basic base64(user:secret) without a header name, and offset-shifted base64, are caught by the decode pass", () => {
  const r = new Redactor();
  r.registerSecret(SECRET);
  for (const prefix of ["", "u", "us", "user:"]) {
    const enc = Buffer.from(`${prefix}${SECRET}`).toString("base64");
    const out = r.redactString(`curl -u ${enc} x`);
    assert.ok(!out.includes(enc), `shifted encoding survived: ${prefix}`);
  }
  assert.ok(!r.redactString("Basic " + Buffer.from("bob:pa55word9").toString("base64")).includes("Ym9iOnBh"));
});

test("S4: URL credential shapes from the review", () => {
  const r = new Redactor();
  const t = "ghp".length ? "tok" + "en1234567890ABCDEF" : "";
  const cases: Array<[string, string]> = [
    ["redis://:pw@host:6379/0", "redis://[REDACTED:url-credentials]@host:6379/0"],
    [`https://${t}@git.example.test/r.git`, "https://[REDACTED:url-credentials]@git.example.test/r.git"],
    ["https://bob:pa55/w0rd@host/p", "https://[REDACTED:url-credentials]@host/p"],
    ["https://bob:pa55@w0rd@host/p", "https://[REDACTED:url-credentials]@host/p"],
    ["https://bob:pass@host", "https://[REDACTED:url-credentials]@host"],
    ["git+ssh://git@host/r.git", "git+ssh://git@host/r.git"],
    ["https://host/path?mail=a:b@c.d", "https://host/path?mail=a:b@c.d"],
    ["ssh://user@host", "ssh://user@host"],
  ];
  for (const [input, expected] of cases) assert.equal(r.redactString(input), expected, input);
});

test("S4: escaped-JSON Authorization, Cookie, x-api-key, Basic and environment assignments", () => {
  const r = new Redactor();
  const cases: Array<[string, RegExp]> = [
    ['{"msg":"{\\"Authorization\\":\\"Basic ' + "dXNlcjpwYXNzd29yZDEyMw==" + '\\"}"}', /dXNlcjpw/],
    ["Cookie: session=abc123def456; theme=dark", /abc123def456/],
    ["Set-Cookie: sid=zzzz1111; Path=/", /zzzz1111/],
    ["x-api-key: " + "k7k7k7k7k7k7k7k7", /k7k7k7k7/],
    ["X-Auth-" + "Token=" + "abcd".concat("1234", "efgh5678"), /abcd1234efgh/],
    ["AWS_SECRET_ACCESS_KEY=" + "wJalr" + "XUtnFEMI", /wJalrXUtn/],
    ['DB_PWD="p a s s w o r d"', /p a s s/],
    ["export GITHUB_" + "TOKEN='" + "abcdef".concat("0123", "456789") + "'", /abcdef0123/],
  ];
  for (const [input, leak] of cases) {
    const out = r.redactString(input);
    assert.ok(!leak.test(out), `leaked: ${input} -> ${out}`);
    assert.ok(out.includes("[REDACTED:"), input);
  }
});

test("S4: more sensitive key names", () => {
  const out = new Redactor().redactValue({
    aws_secret_access_key: "v1",
    pwd: "v2",
    accessKey: "v3",
    sessionId: "v4",
    signature: "v5",
    harmless: "ok",
  });
  assert.deepEqual(out, {
    aws_secret_access_key: "[REDACTED:sensitive-field]",
    pwd: "[REDACTED:sensitive-field]",
    accessKey: "[REDACTED:sensitive-field]",
    sessionId: "[REDACTED:sensitive-field]",
    signature: "[REDACTED:sensitive-field]",
    harmless: "ok",
  });
});

test("S5: a shared-subtree DAG is walked once (the 24-level case took 31 s)", () => {
  let node: unknown[] = [];
  for (let i = 0; i < 24; i++) node = [node, node];
  const t0 = performance.now();
  const out = JSON.stringify(new Redactor().redactValue(node));
  assert.ok(performance.now() - t0 < 100);
  assert.ok(out.includes("[SHARED]"));
  assert.ok(out.length < 10_000);
});

test("S5: a node budget bounds wide and getter-generated structures", () => {
  const wide = Array.from({ length: 100_000 }, (_, i) => ({ i }));
  const out = JSON.stringify(new Redactor().redactValue(wide));
  assert.ok(out.includes("[TRUNCATED:size]"));
  assert.ok(out.length < 400_000);
  let calls = 0;
  const gen: { readonly next: unknown } = {
    get next(): unknown {
      calls++;
      return calls < 1e6 ? { get next(): unknown { return gen.next; } } : null;
    },
  };
  new Redactor().redactValue(gen);
  assert.ok(calls < 1e5);
});

test("S5: a throwing getter yields a fixed marker and its message never escapes", () => {
  const r = new Redactor();
  const evil = {
    ok: 1,
    get boom(): string {
      throw new Error(`getter says ${SECRET}`);
    },
  };
  const out = r.redactValue(evil);
  assert.deepEqual(out, { ok: 1, boom: "[UNREADABLE]" });
  const proxy = new Proxy({}, { ownKeys() { throw new Error(SECRET); } });
  assert.equal(r.redactValue({ p: proxy }) !== null && JSON.stringify(r.redactValue({ p: proxy })).includes(SECRET), false);
  const err = new Error("x");
  Object.defineProperty(err, "message", { get() { throw new Error(SECRET); } });
  assert.ok(!JSON.stringify(r.redactValue(err)).includes(SECRET));
});
