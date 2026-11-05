// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  MAX_TIMEOUT_MS,
  challengeReferenceSchema,
  contractIdSchema,
  contracts,
  guarded,
  lookupMethod,
  lookupMethodIn,
  methodNameSchema,
  parseClientMessage,
  permissionTierSchema,
  requiresIdempotencyKey,
  specProblem,
  tableProblems,
  type MethodSpec,
} from "../src/index.js";

type Row = readonly [contract: string, method: string, sideEffect: string, tier: number, idempotency: string, timeoutMs: number];

/**
 * The registry as docs/design/daemon-host.md (on branch docs/daemon-host-design) section 4.2 gives it (tier, side
 * effect, idempotency), pinned literally. Adding, removing or changing any
 * method fails this test until the table and the design agree.
 */
const EXPECTED: readonly Row[] = [
  ["axis.worktrees", "list", "read", 0, "none", 10_000],
  ["axis.worktrees", "status", "read", 0, "none", 15_000],
  ["axis.worktrees", "create", "write", 2, "required", 30_000],
  ["axis.worktrees", "finalise", "write", 2, "required", 30_000],
  ["axis.worktrees", "remove", "destructive", 4, "required", 30_000],
  ["axis.worktrees", "restoreFromRunBase", "write", 2, "required", 30_000],
  ["axis.projects", "list", "read", 0, "none", 10_000],
  ["axis.approvals", "resolve", "write", 2, "none", 10_000],
  ["axis.approvals", "pending", "read", 0, "none", 5_000],
  ["axis.audit", "status", "read", 0, "none", 5_000],
  ["axis.audit", "list", "read", 1, "none", 10_000],
  ["axis.audit", "verify", "read", 1, "none", 30_000],
  ["axis.cli-runs", "start", "write", 2, "required", 30_000],
  ["axis.cli-runs", "stop", "write", 2, "required", 15_000],
  ["axis.cli-runs", "get", "read", 0, "none", 5_000],
  ["axis.cli-runs", "list", "read", 0, "none", 10_000],
  ["axis.providers", "list", "read", 0, "none", 10_000],
];

function actualRows(): Row[] {
  const rows: Row[] = [];
  for (const [key, methods] of Object.entries(contracts)) {
    const [contract, major] = key.split("/") as [string, string];
    assert.equal(major, "1", `${key}: only major version 1 exists`);
    for (const [name, spec] of Object.entries(methods)) {
      rows.push([contract, name, spec.sideEffect, spec.tier, spec.idempotency, spec.timeoutMs]);
    }
  }
  return rows;
}

const sortRows = (rows: readonly Row[]): Row[] => [...rows].sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`));

test("registry: exactly the designed methods, with the designed tier, side effect, idempotency and timeout", () => {
  assert.deepEqual(sortRows(actualRows()), sortRows(EXPECTED));
});

test("registry coverage: every entry has a request and response schema, a valid tier and a servable spec", () => {
  assert.deepEqual(tableProblems(contracts), []);
  let n = 0;
  for (const [key, methods] of Object.entries(contracts)) {
    const id = key.slice(0, key.lastIndexOf("/"));
    assert.equal(contractIdSchema.safeParse(id).success, true, `${key}: contract id must pass the envelope's contractIdSchema`);
    for (const [name, spec] of Object.entries(methods)) {
      n++;
      assert.equal(methodNameSchema.safeParse(name).success, true, `${key}.${name}: method name`);
      assert.equal(permissionTierSchema.safeParse(spec.tier).success, true, `${key}.${name}: tier`);
      assert.equal(typeof spec.request.safeParse, "function", `${key}.${name}: request schema`);
      assert.equal(typeof spec.response.safeParse, "function", `${key}.${name}: response schema`);
      assert.ok(Number.isInteger(spec.timeoutMs) && spec.timeoutMs >= 1 && spec.timeoutMs <= MAX_TIMEOUT_MS, `${key}.${name}: timeout`);
      assert.equal(lookupMethod(id, 1, name), spec, `${key}.${name}: lookup`);
      // The envelope accepts a request that names it.
      const parsed = parseClientMessage({ v: 1, id: "r1", contract: id, contractVersion: 1, method: name, payload: {} });
      assert.equal(parsed.ok, true, `${key}.${name}: envelope`);
    }
  }
  assert.equal(n, EXPECTED.length);
});

test("registry: requiresIdempotencyKey follows the table for every method", () => {
  for (const [contract, method, , , idempotency] of EXPECTED) {
    assert.equal(requiresIdempotencyKey(contract, 1, method), idempotency === "required", `${contract}.${method}`);
  }
  assert.equal(requiresIdempotencyKey("axis.audit", 1, "nope"), false);
});

test("registry is frozen: no caller can lower a tier at run time", () => {
  assert.equal(Object.isFrozen(contracts), true);
  for (const [key, methods] of Object.entries(contracts)) {
    assert.equal(Object.isFrozen(methods), true, key);
    for (const [name, spec] of Object.entries(methods)) {
      assert.equal(Object.isFrozen(spec), true, `${key}.${name}`);
      assert.throws(() => { (spec as { tier: number }).tier = 0; }, TypeError, `${key}.${name}`);
    }
    assert.throws(() => { (methods as Record<string, unknown>)["extra"] = {}; }, TypeError, key);
  }
  assert.throws(() => { (contracts as Record<string, unknown>)["axis.extra/1"] = {}; }, TypeError);
});

test("lookup fails closed on unknown contracts, versions and methods", () => {
  const unknown: Array<[string, number, string]> = [
    ["axis.nope", 1, "list"],
    ["axis.audit", 0, "list"],
    ["axis.audit", 2, "list"],
    ["axis.audit", -1, "list"],
    ["axis.audit", 1.5, "list"],
    ["axis.audit", Number.NaN, "list"],
    ["axis.audit", Number.POSITIVE_INFINITY, "list"],
    ["axis.audit", 2 ** 53, "list"],
    ["axis.audit", 1, "resolve"], // a method of another contract
    ["axis.approvals", 1, "list"],
    ["axis.audit", 1, "List"],
    ["axis.audit", 1, "list "],
    ["axis.audit", 1, ""],
    ["axis.audit/1", 1, "list"],
    ["axis.audit/1/1", 1, "list"],
    ["", 1, "list"],
  ];
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    unknown.push(["axis.audit", 1, name], [name, 1, "list"], ["axis.worktrees", 1, name]);
  }
  for (const [c, v, m] of unknown) assert.equal(lookupMethod(c, v, m), undefined, `${c} ${v} ${m}`);
  // Values the types forbid but a caller can still pass.
  assert.equal(lookupMethod("axis.audit", "1" as unknown as number, "list"), undefined, "version as a string");
  assert.equal(lookupMethod("axis.audit", 1n as unknown as number, "list"), undefined, "version as a bigint");
  assert.equal(lookupMethod(undefined as unknown as string, 1, "list"), undefined);
  assert.equal(lookupMethod("axis.audit", 1, undefined as unknown as string), undefined);
  assert.equal(lookupMethod("axis.audit", 1, ["list"] as unknown as string), undefined, "array coerces to the name");
  assert.notEqual(lookupMethod("axis.audit", 1, "list"), undefined);
});

const approvalSchema = guarded(z.strictObject({ approval: challengeReferenceSchema.optional() }));
const base: MethodSpec = Object.freeze({
  request: guarded(z.strictObject({})),
  response: guarded(z.strictObject({})),
  sideEffect: "read",
  tier: 0,
  idempotency: "none",
  timeoutMs: 1000,
} as const);
const tableOf = (spec: unknown) => ({ "axis.fake/1": { m: spec as MethodSpec } });

test("a spec with an invalid tier is not served (NaN, out of range, fractional, wrong type)", () => {
  assert.equal(specProblem(base), null);
  assert.equal(lookupMethodIn(tableOf(base), "axis.fake", 1, "m"), base);
  for (const tier of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 6, 100, 1.5, "2", "0", null, undefined, 2n, [2], { valueOf: () => 2 }]) {
    const spec = { ...base, tier };
    assert.notEqual(specProblem(spec), null, `tier ${String(tier)}`);
    assert.equal(lookupMethodIn(tableOf(spec), "axis.fake", 1, "m"), undefined, `lookup with tier ${String(tier)}`);
    assert.ok(tableProblems(tableOf(spec)).length >= 1, `table with tier ${String(tier)}`);
  }
});

test("a spec outside the closed sets or bounds is not served", () => {
  const bad: Array<[string, unknown]> = [
    ["not an object", null],
    ["a string", "spec"],
    ["unknown side effect", { ...base, sideEffect: "mutate" }],
    ["no side effect", { ...base, sideEffect: undefined }],
    ["unknown idempotency", { ...base, idempotency: "maybe" }],
    ["timeout 0", { ...base, timeoutMs: 0 }],
    ["timeout NaN", { ...base, timeoutMs: Number.NaN }],
    ["timeout over the ceiling", { ...base, timeoutMs: MAX_TIMEOUT_MS + 1 }],
    ["timeout fractional", { ...base, timeoutMs: 1.5 }],
    ["timeout as string", { ...base, timeoutMs: "1000" }],
    ["no request schema", { ...base, request: undefined }],
    ["response without safeParse", { ...base, response: {} }],
    ["a read above tier 1", { ...base, tier: 2 }],
    ["destructive at tier 2", { ...base, sideEffect: "destructive", tier: 2 }],
    ["network at tier 2", { ...base, sideEffect: "network", tier: 2 }],
    ["credential at tier 0", { ...base, sideEffect: "credential", tier: 0 }],
    ["tier 4 without an approval field", { ...base, sideEffect: "destructive", tier: 4 }],
    ["tier 3 with a required approval", { ...base, sideEffect: "network", tier: 3, request: guarded(z.strictObject({ approval: challengeReferenceSchema })) }],
  ];
  for (const [name, spec] of bad) {
    assert.notEqual(specProblem(spec), null, name);
    assert.equal(lookupMethodIn(tableOf(spec), "axis.fake", 1, "m"), undefined, name);
  }
  const fine = Object.freeze({ ...base, sideEffect: "destructive", tier: 4, request: approvalSchema }) as MethodSpec;
  assert.equal(specProblem(fine), null, "tier 4 with an optional approval is servable");
  assert.equal(lookupMethodIn(tableOf(fine), "axis.fake", 1, "m"), fine);
  // A table is bad as a whole when any entry is, and a bad contract key is reported.
  assert.equal(tableProblems({ "axis.fake/1": { ok: base, bad: { ...base, tier: Number.NaN } as unknown as MethodSpec } }).length, 1);
  assert.equal(tableProblems({ "Axis.Fake/1": { ok: base } }).length, 1);
  assert.equal(tableProblems({ "axis.fake/0": { ok: base } }).length, 1);
  assert.equal(tableProblems({ "axis.fake/1": { "a/b": base } }).length, 1);
});

test("a spec whose fields are accessors or Proxy traps is not served, and a served copy cannot change", () => {
  let reads = 0;
  const flipping = { ...base };
  Object.defineProperty(flipping, "tier", { get: () => (++reads === 1 ? 0 : Number.NaN), enumerable: true });
  assert.notEqual(specProblem(flipping), null, "an accessor tier fails the check");
  assert.equal(lookupMethodIn(tableOf(flipping), "axis.fake", 1, "m"), undefined);
  for (const field of ["sideEffect", "idempotency", "timeoutMs", "request", "response"] as const) {
    const o = { ...base };
    Object.defineProperty(o, field, { get: () => base[field], enumerable: true });
    assert.notEqual(specProblem(o), null, `accessor ${field}`);
  }
  const trap = (): never => { throw new Error("CANARY"); };
  assert.notEqual(specProblem(new Proxy({ ...base }, { getOwnPropertyDescriptor: trap, get: trap })), null, "a throwing Proxy is a problem, not an exception");
  // An unfrozen spec is served as a frozen snapshot of what was checked.
  const loose = { ...base };
  const served = lookupMethodIn(tableOf(loose), "axis.fake", 1, "m") as MethodSpec;
  assert.notEqual(served, loose);
  assert.equal(Object.isFrozen(served), true);
  (loose as { tier: number }).tier = Number.NaN;
  assert.equal(served.tier, 0, "a change to the original after lookup is not seen");
  Object.freeze(loose);
});

test("a table key that no lookup can reach, or a missing method table, is a problem", () => {
  for (const key of ["axis.fake/01", "axis.fake/1e0", "axis.fake/ 1", "axis.fake/+1", "axis.fake/1.0", "axis.fake/"]) {
    assert.ok(tableProblems({ [key]: { m: base } }).length >= 1, key);
  }
  assert.ok(tableProblems({ "axis.fake/1": null as unknown as Record<string, MethodSpec> }).length >= 1, "null method table");
  assert.ok(tableProblems({ "axis.fake/1": "x" as unknown as Record<string, MethodSpec> }).length >= 1, "string method table");
  assert.deepEqual(tableProblems({ "axis.fake/1": { m: base } }), []);
});

test("lookup counts own entries only: an inherited contract key or method is not served", () => {
  const own = Object.freeze({ m: base });
  assert.equal(lookupMethodIn({ "axis.fake/1": own }, "axis.fake", 1, "m"), base);
  assert.equal(lookupMethodIn({ "axis.fake/1": Object.create(own) as Record<string, MethodSpec> }, "axis.fake", 1, "m"), undefined, "inherited method");
  assert.equal(lookupMethodIn(Object.create({ "axis.fake/1": own }) as Record<string, Record<string, MethodSpec>>, "axis.fake", 1, "m"), undefined, "inherited contract");
});

test("the guard keeps `shape` so the daemon still sees an approval field", () => {
  assert.notEqual((approvalSchema as { shape?: unknown }).shape, undefined);
  const worktreesRemove = lookupMethod("axis.worktrees", 1, "remove") as MethodSpec;
  assert.notEqual((worktreesRemove.request as { shape?: unknown }).shape, undefined);
});

test("methods that need approval: tier 3 and above, an optional approval field, and only those", () => {
  const needing: string[] = [];
  for (const [key, methods] of Object.entries(contracts)) {
    for (const [name, spec] of Object.entries(methods)) {
      if (spec.tier >= 3) needing.push(`${key.slice(0, key.lastIndexOf("/"))}.${name}`);
    }
  }
  // Every method added by P1a and P1c is tier 2 or below, so none of them has a challenge to vector.
  assert.deepEqual(needing, ["axis.worktrees.remove"]);
  const remove = lookupMethod("axis.worktrees", 1, "remove") as MethodSpec;
  const withApproval = remove.request.safeParse({ id: "ws-1", approval: { challengeId: "A".repeat(22) } });
  assert.equal(withApproval.success, true);
});
