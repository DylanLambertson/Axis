// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { z } from "zod";
import { ERROR_NAMES, ERRNO_NAMES, EXIT, exitCodeForStartupError, summarizeError } from "../src/index.js";

/** Built at runtime so no credential-shaped literal sits in the source. */
const canary = (): string => ["sk", "ant", "api03", "Zq".repeat(20)].join("-");

test("the common errors keep their name and nothing else", () => {
  assert.deepEqual(summarizeError(new Error(canary())), { name: "Error" });
  assert.deepEqual(summarizeError(new TypeError("x")), { name: "TypeError" });
  assert.deepEqual(summarizeError(new RangeError("x")), { name: "RangeError" });
  assert.deepEqual(summarizeError(new AggregateError([new Error("a")], "m")), { name: "AggregateError" });
});

test("AxisError keeps its protocol code, a system error keeps its errno name", () => {
  assert.deepEqual(summarizeError(new AxisError("E_CONFLICT", canary())), { name: "AxisError", code: "E_CONFLICT" });
  const enoent = Object.assign(new Error(`ENOENT: no such file '/home/u/${canary()}'`), { code: "ENOENT", errno: -2, path: "/home/u/x" });
  assert.deepEqual(summarizeError(enoent), { name: "Error", errno: "ENOENT" });
  const sqlite = Object.assign(new Error("near X: syntax error"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
  assert.deepEqual(summarizeError(sqlite), { name: "Error", errno: "ERR_SQLITE_ERROR" });
});

test("the output is built from closed sets only: nothing from the error can appear in it", () => {
  const names = new Set<string>(ERROR_NAMES);
  const errnos = new Set<string>(ERRNO_NAMES);
  const evil = canary();
  const inputs: unknown[] = [
    Object.assign(new Error("m"), { name: evil, code: evil }),
    Object.assign(new Error("m"), { name: "Evil" + evil, code: "E_" + evil }),
    Object.assign(new Error("m"), { code: "ENOENT" + evil }),
    Object.assign(new Error("m"), { code: 5 }),
    Object.assign(new Error("m"), { code: { toString: () => evil } }),
    { name: evil, code: evil, message: evil, stack: evil, cause: new Error(evil) },
    evil, 42, null, undefined, true, Symbol(evil), 12n, () => evil,
  ];
  for (const input of inputs) {
    const s = summarizeError(input);
    assert.ok(names.has(s.name));
    assert.ok(s.errno === undefined || errnos.has(s.errno));
    assert.ok(!JSON.stringify(s).includes(evil), String(input));
    assert.deepEqual(Object.keys(s).filter((k) => !["name", "code", "errno"].includes(k)), []);
  }
});

test("non-error values are NonError and are never echoed", () => {
  for (const v of ["a string", 0, null, undefined, false, 7n, Symbol("s")]) assert.deepEqual(summarizeError(v), { name: "NonError" });
});

test("getters are never run: not on the error, not on its prototype", () => {
  let ran = 0;
  const e = new Error("m");
  Object.defineProperty(e, "code", { get: () => { ran++; return "ENOENT"; } });
  Object.defineProperty(e, "name", { get: () => { ran++; return "TypeError"; } });
  Object.defineProperty(e, "message", { get: () => { ran++; return "x"; } });
  Object.defineProperty(e, "cause", { get: () => { ran++; return "x"; } });
  assert.deepEqual(summarizeError(e), { name: "Error" });
  class Sneaky extends Error {
    get code(): string { ran++; return "E_CONFLICT"; }
    override get name(): string { ran++; return "AxisError"; }
  }
  assert.deepEqual(summarizeError(new Sneaky("m")), { name: "Error" });
  assert.equal(ran, 0);
});

test("a Proxy is reported as a plain Error and none of its traps run", () => {
  let trapped = 0;
  const bump = (): undefined => { trapped++; return undefined; };
  const handler: ProxyHandler<object> = {
    get: bump, has: () => (trapped++, true), ownKeys: () => (trapped++, []), getOwnPropertyDescriptor: bump,
    getPrototypeOf: () => (trapped++, null), apply: bump,
  };
  assert.deepEqual(summarizeError(new Proxy(new Error("m"), handler)), { name: "Error" });
  assert.deepEqual(summarizeError(new Proxy({}, handler)), { name: "Error" });
  assert.deepEqual(summarizeError(new Proxy(function f() {}, handler)), { name: "Error" });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.deepEqual(summarizeError(revocable.proxy), { name: "Error" });
  // A Proxy in the prototype chain is not followed.
  const proto = new Proxy({}, handler);
  assert.deepEqual(summarizeError(Object.create(proto)), { name: "Error" });
  assert.equal(trapped, 0);
});

test("hostile shapes: null prototype, frozen, circular, deep prototype chain, huge strings", () => {
  assert.deepEqual(summarizeError(Object.create(null)), { name: "Error" });
  assert.deepEqual(summarizeError(Object.freeze(new Error("m"))), { name: "Error" });
  const cyc: Record<string, unknown> = { name: "TypeError" };
  cyc["cause"] = cyc;
  assert.deepEqual(summarizeError(cyc), { name: "TypeError" });
  let deep: object = { name: "TypeError" };
  for (let i = 0; i < 50; i++) deep = Object.create(deep) as object;
  assert.deepEqual(summarizeError(deep), { name: "Error" }, "the prototype walk is bounded");
  const huge = Object.assign(new Error("m"), { code: "E_".padEnd(10_000_000, "X"), name: "A".repeat(1_000_000) });
  assert.deepEqual(summarizeError(huge), { name: "Error" });
});

test("a subclass of a known error keeps the known name; the zod error is recognised", () => {
  class MyDomainError extends AxisError {}
  assert.deepEqual(summarizeError(new MyDomainError("E_NOT_FOUND", "m")), { name: "AxisError", code: "E_NOT_FOUND" });
  const r = z.object({ a: z.string() }).safeParse({ a: canary().length });
  assert.ok(!r.success);
  const s = summarizeError(r.error);
  assert.ok(s.name === "ZodError" || s.name === "Error");
  assert.ok(!JSON.stringify(s).includes("Invalid"));
});

test("the result is frozen", () => {
  assert.ok(Object.isFrozen(summarizeError(new Error("m"))));
  assert.ok(Object.isFrozen(summarizeError(null)));
});

test("exit codes: a startup error maps by its protocol code", () => {
  assert.equal(exitCodeForStartupError(new AxisError("E_CONFLICT", "m")), EXIT.LOCK_HELD);
  assert.equal(exitCodeForStartupError(new AxisError("E_INVALID_ARGUMENT", "m")), EXIT.BAD_CONFIG);
  assert.equal(exitCodeForStartupError(new AxisError("E_POLICY_DENIED", "m")), EXIT.BAD_CONFIG);
  for (const code of ["E_UNAVAILABLE", "E_INTERNAL", "E_NOT_FOUND", "E_TIMEOUT"] as const) {
    assert.equal(exitCodeForStartupError(new AxisError(code, "m")), EXIT.INTERNAL, code);
  }
  assert.equal(exitCodeForStartupError(new Error("m")), EXIT.INTERNAL);
  assert.equal(exitCodeForStartupError("E_CONFLICT"), EXIT.INTERNAL);
  assert.equal(exitCodeForStartupError({ code: "E_CONFLICT" }), EXIT.LOCK_HELD, "a plain object with an own data code counts");
  assert.equal(exitCodeForStartupError(Object.defineProperty({}, "code", { get: () => "E_CONFLICT" })), EXIT.INTERNAL);
});

test("the exit code table is fixed", () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, UNSETTLED: 1, INTERNAL: 70, LOCK_HELD: 75, BAD_CONFIG: 78, DEGRADED: 79 });
  assert.ok(Object.isFrozen(EXIT));
  assert.equal(new Set(Object.values(EXIT)).size, 6);
});
