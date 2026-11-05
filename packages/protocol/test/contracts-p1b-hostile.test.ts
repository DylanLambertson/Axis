// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ALLOWED_BINARY_PATHS, MAX_PUSH_FINDINGS, MAX_REVIEW_FILES, MAX_REVIEW_SKIPPED, MAX_MESSAGE_BYTES, MAX_MESSAGE_NODES, contracts, inspectMessage } from "../src/index.js";
import { DIGEST, SHA1, SHA2, completed, diffResponse, plan } from "./samples-p1b.js";
import { errorText, parse, schemaOf } from "./suite.js";

const REQUESTS: Array<[string, string, Record<string, unknown>]> = [
  ["axis.git", "pushPlan", { workspaceId: "ws-1", remote: "origin" }],
  ["axis.git", "commit", { workspaceId: "ws-1", reviewedTreeHash: SHA2, expectedParent: SHA1, expectedBranch: "axis/x", message: "m" }],
  ["axis.git", "push", { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST } }],
  ["axis.git", "compareUrl", { workspaceId: "ws-1", remote: "origin" }],
  ["axis.review", "diff", { workspaceId: "ws-1" }],
  ["axis.review", "complete", { runId: "run-1" }],
];

for (const [c, m, ok] of REQUESTS) {
  test(`${c}.${m}: accessors, Proxies, prototype pollution and shared references are refused without echo`, () => {
    const schema = schemaOf(c, m, "request");
    assert.equal(parse(schema, structuredClone(ok), m).success, true);
    const first = Object.keys(ok)[0] as string;
    let reads = 0;
    const getter = { ...ok };
    Object.defineProperty(getter, first, { enumerable: true, get: () => (reads++ === 0 ? ok[first] : "CANARY") });
    const bad: Array<[string, unknown]> = [
      ["getter", getter],
      ["proxy", new Proxy(structuredClone(ok), {})],
      ["throwing proxy", new Proxy({}, { ownKeys() { throw new Error("CANARY"); } })],
      ["__proto__ key", JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(ok).slice(1)}`)],
      ["constructor key", { ...ok, constructor: { prototype: { x: 1 } } }],
      ["prototype key", { ...ok, prototype: {} }],
      ["null prototype with an extra key", Object.assign(Object.create(null), ok, { CANARY: 1 })],
      ["class instance", Object.assign(new (class CANARY {})(), ok)],
      ["array", [ok]],
      ["null", null],
      ["string", JSON.stringify(ok)],
      ["extra symbol key", Object.assign({ ...ok }, { [Symbol("CANARY")]: 1 })],
    ];
    for (const [name, input] of bad) {
      const r = parse(schema, input, name);
      assert.equal(r.success, false, `${name} should be rejected`);
      assert.equal(errorText(r).includes("CANARY"), false, `${name} echoes input`);
    }
    assert.equal(({} as Record<string, unknown>)["admin"], undefined, "Object.prototype was polluted");
    // The accessor is read at most once by the guard, and never again after the check.
    assert.ok(reads <= 1);
  });

  test(`${c}.${m}: an oversized string in any field is refused`, () => {
    const schema = schemaOf(c, m, "request");
    for (const k of Object.keys(ok)) {
      if (typeof ok[k] !== "string") continue;
      for (const n of [100_000, 300_000]) {
        const r = parse(schema, { ...structuredClone(ok), [k]: "a".repeat(n) }, `${k} ${n}`);
        assert.equal(r.success, false, `${k} of ${n} characters`);
      }
    }
  });
}

test("a push or push plan with 50 maximal binary paths still fits the message limits, and one more is refused", () => {
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(4, "0")}${"d".repeat(4090)}`);
  for (const [m, base] of [["pushPlan", { workspaceId: "ws-1", remote: "origin" }], ["push", { workspaceId: "ws-1", remote: "origin", confirmedPlan: { tip: SHA1, digest: DIGEST } }]] as const) {
    const full = { ...base, allowedBinaryPaths: paths(MAX_ALLOWED_BINARY_PATHS) };
    assert.deepEqual(inspectMessage(full), { ok: true });
    assert.equal(parse(schemaOf("axis.git", m, "request"), full, m).success, true);
    assert.equal(parse(schemaOf("axis.git", m, "request"), { ...base, allowedBinaryPaths: paths(MAX_ALLOWED_BINARY_PATHS + 1) }, m).success, false);
  }
});

test("worst-case replies fit one message: 200 files of three-byte display paths, 500 findings, 50 skipped", () => {
  const wide = (n: number) => "€".repeat(n);
  const file = (i: number) => ({
    displayPath: wide(256 - String(i).length) + String(i),
    displayOldPath: wide(256),
    status: "R",
    kind: "filtered",
    similarity: 100,
    additions: Number.MAX_SAFE_INTEGER,
    deletions: Number.MAX_SAFE_INTEGER,
    unsafePath: true,
    truncated: true,
    acknowledged: true,
    protectedRules: [1, 2, 3, 4].map((n) => wide(64) + (i + n)).map((s) => s.slice(0, 64)),
    fileLevelReason: wide(128),
    warnings: [1, 2, 3, 4].map((n) => wide(64) + (i + n)).map((s) => s.slice(0, 64)),
  });
  const diff = {
    ...structuredClone(diffResponse),
    treeHash: null,
    files: Array.from({ length: MAX_REVIEW_FILES }, (_, i) => file(i)),
    skipped: Array.from({ length: MAX_REVIEW_SKIPPED }, () => ({ displayPath: wide(256), size: Number.MAX_SAFE_INTEGER, reason: "too_large_to_review" })),
    skippedCount: Number.MAX_SAFE_INTEGER,
  };
  assert.deepEqual(inspectMessage({ id: "r".repeat(64), result: diff }), { ok: true });
  const ack = { workspaceId: "ws-1", acknowledged: diff.files.map((f) => f.displayPath) };
  assert.deepEqual(inspectMessage({ id: "r".repeat(64), payload: ack }), { ok: true });
  assert.equal(parse(schemaOf("axis.review", "diff", "request"), ack, "ack").success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(diff)) < MAX_MESSAGE_BYTES);
  assert.equal(parse(schemaOf("axis.review", "diff", "response"), diff, "diff").success, true);

  const pushPlan = {
    ...structuredClone(plan),
    reasons: Array.from({ length: 8 }, () => wide(1024)),
    findings: Array.from({ length: MAX_PUSH_FINDINGS }, () => ({ rule: "r".repeat(64), path: wide(256), line: Number.MAX_SAFE_INTEGER, commit: "e".repeat(64) })),
    findingsTruncated: true,
  };
  assert.deepEqual(inspectMessage({ id: "r".repeat(64), result: pushPlan }), { ok: true });
  assert.ok(Buffer.byteLength(JSON.stringify(pushPlan)) < MAX_MESSAGE_BYTES);
  assert.ok(MAX_PUSH_FINDINGS * 5 + 100 < MAX_MESSAGE_NODES);
  assert.equal(parse(schemaOf("axis.git", "pushPlan", "response"), pushPlan, "plan").success, true);
});

test("responses are never shared with the input and a completed run echoes nothing it was not given", () => {
  const input = { run: structuredClone(completed) };
  const r = parse(schemaOf("axis.review", "complete", "response"), input, "complete");
  assert.equal(r.success, true);
  if (r.success) assert.notEqual((r.data as { run: unknown }).run, input.run);
});

test("every served method of the two contracts is in the registry with a guarded request and response", () => {
  for (const key of ["axis.git/1", "axis.review/1"]) {
    for (const [name, spec] of Object.entries(contracts[key] ?? {})) {
      for (const side of ["request", "response"] as const) {
        const r = parse(spec[side], { CANARY: new Proxy({}, {}) }, `${key}.${name} ${side}`);
        assert.equal(r.success, false);
        assert.equal(errorText(r).includes("CANARY"), false);
      }
    }
  }
});
