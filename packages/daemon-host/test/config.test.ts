// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError, Redactor } from "@axis/audit";
import { exitCodeForStartupError, EXIT, parseHostConfig } from "../src/index.js";
import { validConfig } from "./helpers.js";

function refused(input: unknown): AxisError {
  try {
    parseHostConfig(input, new Redactor());
  } catch (e) {
    assert.ok(e instanceof AxisError, "an AxisError");
    assert.equal(e.code, "E_INVALID_ARGUMENT");
    assert.equal(exitCodeForStartupError(e), EXIT.BAD_CONFIG);
    return e;
  }
  assert.fail("expected the config to be refused");
}

test("a valid config parses, applies defaults, turns the key into bytes and is frozen", () => {
  const c = parseHostConfig(validConfig(), new Redactor());
  assert.equal(c.logLevel, "info");
  assert.equal(c.devDiagnostics, false);
  assert.equal(c.devMemoryIdempotency, false);
  assert.equal(c.contracts, undefined);
  assert.deepEqual(c.limits, {});
  assert.ok(c.attestationKey instanceof Uint8Array);
  assert.equal(c.attestationKey.length, 32);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.limits));
});

test("the input is not modified", () => {
  const input = validConfig({ limits: { maxConnections: 4 } });
  const before = JSON.stringify(input);
  parseHostConfig(input, new Redactor());
  assert.equal(JSON.stringify(input), before);
});

test("an unknown key is refused at every level", () => {
  refused(validConfig({ extra: 1 }));
  refused(validConfig({ limits: { nope: 1 } }));
  refused(validConfig({ env: { PATH: "/bin" } }));
});

test("__proto__ and constructor keys are refused, not applied", () => {
  const withProto = JSON.parse(`{"__proto__": {"devDiagnostics": true}}`) as Record<string, unknown>;
  refused({ ...validConfig(), ...Object.fromEntries(Object.entries(withProto)) });
  const own = validConfig();
  Object.defineProperty(own, "__proto__", { value: { polluted: true }, enumerable: true });
  refused(own);
  const limits = JSON.parse(`{"__proto__": {"maxConnections": 1}}`) as unknown;
  refused(validConfig({ limits }));
  refused(validConfig({ constructor: { prototype: {} } }));
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(({} as Record<string, unknown>)["devDiagnostics"], undefined);
});

test("wrong types are refused", () => {
  for (const [key, value] of [
    ["dataDir", 5], ["dataDir", null], ["dataDir", ["/a"]], ["worktreeRoot", {}], ["platform", "freebsd"], ["platform", 1],
    ["logLevel", "trace"], ["devDiagnostics", "true"], ["devDiagnostics", 1], ["devMemoryIdempotency", "yes"],
    ["attestationKey", 5], ["attestationKey", null], ["attestationKey", Buffer.alloc(32, 1)], ["contracts", "axis.worktrees"],
    ["contracts", [5]], ["limits", 5], ["limits", []],
  ] as const) {
    refused(validConfig({ [key]: value }));
  }
});

test("required keys are required", () => {
  for (const key of ["dataDir", "worktreeRoot", "platform", "attestationKey"]) {
    const c = validConfig();
    delete c[key];
    refused(c);
  }
});

test("paths must be absolute, free of NUL and bounded", () => {
  for (const p of ["", "relative/dir", "./x", "x\0y", "/" + "a".repeat(4096)]) {
    refused(validConfig({ dataDir: p }));
    refused(validConfig({ worktreeRoot: p }));
  }
});

test("attestationKey: at least 32 bytes of canonical base64url", () => {
  const key = (bytes: number): string => Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 7 + 1) & 255)).toString("base64url");
  assert.equal(parseHostConfig(validConfig({ attestationKey: key(32) }), new Redactor()).attestationKey.length, 32);
  assert.equal(parseHostConfig(validConfig({ attestationKey: key(96) }), new Redactor()).attestationKey.length, 96);
  refused(validConfig({ attestationKey: key(31) }));
  refused(validConfig({ attestationKey: key(97) }));
  refused(validConfig({ attestationKey: "" }));
  refused(validConfig({ attestationKey: key(32) + "=" }), );
  refused(validConfig({ attestationKey: key(32).replace(/.$/, "+") }));
  refused(validConfig({ attestationKey: key(32) + "/" }));
  refused(validConfig({ attestationKey: key(32) + "\n" }));
  refused(validConfig({ attestationKey: " " + key(32) }));
  // Non-canonical trailing bits: 43 characters decode to 32 bytes, but only one final character per group is canonical.
  const canonical = key(32);
  const last = canonical.at(-1) as string;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const twin = alphabet[(alphabet.indexOf(last) + 1) % 64] as string;
  refused(validConfig({ attestationKey: canonical.slice(0, -1) + twin }));
});

test("attestationKey: an all-zero or low-entropy key is refused", () => {
  refused(validConfig({ attestationKey: Buffer.alloc(32).toString("base64url") }));
  refused(validConfig({ attestationKey: Buffer.alloc(64, 0x41).toString("base64url") }));
  refused(validConfig({ attestationKey: Buffer.from("ab".repeat(16)).toString("base64url") }));
});

test("limits: integers within bounds only; NaN, Infinity, floats and negatives are refused", () => {
  assert.equal(parseHostConfig(validConfig({ limits: { maxConnections: 8, connectBurst: 1 } }), new Redactor()).limits.maxConnections, 8);
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, 1.5, 2 ** 53, "8", null, true, 1025]) {
    refused(validConfig({ limits: { maxConnections: bad } }));
  }
  refused(validConfig({ limits: { logQueueSize: 15 } }));
  refused(validConfig({ limits: { anchorMaxAgeMs: NaN } }));
  refused(validConfig({ limits: { reconcileBudgetMs: 999 } }));
});

test("contracts: valid ids, unique, bounded", () => {
  assert.deepEqual(parseHostConfig(validConfig({ contracts: ["axis.worktrees", "axis.audit"] }), new Redactor()).contracts, ["axis.worktrees", "axis.audit"]);
  refused(validConfig({ contracts: ["axis.worktrees", "axis.worktrees"] }));
  refused(validConfig({ contracts: ["axis.worktrees/1"] }));
  refused(validConfig({ contracts: ["worktrees"] }));
  refused(validConfig({ contracts: Array.from({ length: 33 }, (_, i) => `axis.c${i}`) }));
});

test("devMemoryIdempotency needs devDiagnostics", () => {
  refused(validConfig({ devMemoryIdempotency: true }));
  refused(validConfig({ devMemoryIdempotency: true, devDiagnostics: false }));
  assert.equal(parseHostConfig(validConfig({ devMemoryIdempotency: true, devDiagnostics: true }), new Redactor()).devMemoryIdempotency, true);
});

test("non-objects, arrays and null are refused", () => {
  for (const v of [undefined, null, 5, "x", true, [], [validConfig()], () => validConfig(), Symbol("x")]) refused(v);
});

test("hostile inputs: a throwing getter and a Proxy are refused without running the trap", () => {
  const getter = validConfig();
  Object.defineProperty(getter, "dataDir", { enumerable: true, get: () => { throw new Error("boom"); } });
  refused(getter);
  let trapped = 0;
  const proxy = new Proxy(validConfig(), { get: (t, k) => { trapped++; return Reflect.get(t, k); }, ownKeys: (t) => { trapped++; return Reflect.ownKeys(t); } });
  refused(proxy);
  assert.equal(trapped, 0);
});

test("the refusal never carries a value, the key or a client key name", () => {
  const key = validConfig().attestationKey as string;
  const secretish = "client-supplied-name-SHOULD-NOT-APPEAR";
  const e = refused(validConfig({ attestationKey: key.slice(0, 10), [secretish]: key, dataDir: "relative-" + key }));
  const text = JSON.stringify({ m: e.message, d: e.detail });
  assert.ok(!text.includes(key.slice(0, 10)));
  assert.ok(!text.includes(secretish));
  assert.ok(!text.includes("relative-"));
  assert.equal(e.detail["reason"], "invalid_config");
  assert.ok(String(e.detail["issues"]).length <= 512);
});

test("a long list of problems is reported bounded", () => {
  const over: Record<string, unknown> = {};
  for (let i = 0; i < 500; i++) over[`k${i}`] = i;
  const e = refused(validConfig(over));
  assert.ok(String(e.detail["issues"]).length <= 512);
});
