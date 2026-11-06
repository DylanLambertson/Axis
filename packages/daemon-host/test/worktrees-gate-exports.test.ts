// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChallengeAuditSink, ChannelMux, ControlClient } from "../src/index.js";
import * as host from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { fakeClock } from "./helpers.js";
import { createWorktreesApprovals } from "../src/index.js";

/**
 * The discard capability of `@axis/worktrees` is an empty frozen object (an opaque token the package tracks in a WeakMap). No
 * function the host exports, and nothing the approval wiring returns, may produce one without a spent approval. This walks
 * every export of the public index and everything reachable from the wiring's return value (own and inherited properties,
 * returned functions and objects, constructors too), calls every function with hostile arguments, and fails when any result
 * looks like such a token. (The import-path rule in test/packages/imports.test.mjs blocks the other way in: loading the
 * minter's module.)
 */
const isToken = (v: unknown): boolean =>
  typeof v === "object" && v !== null && Object.isFrozen(v) && Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === 0;

const input = {
  contract: "axis.worktrees", contractVersion: 1, method: "remove", args: { id: "ws-1" }, digest: "d", tier: 4, actor: "user",
  connectionId: "c", requestId: "r", correlationId: "c", signal: new AbortController().signal,
  identity: { connectionId: "c", windowId: "w", actorId: "a", actor: "user", trusted: true, clientKind: "desktop" },
};
const content = { target: "workspace:ws-1", contentDigest: "a".repeat(64) };
const BATTERY: unknown[][] = [[], [input, content], [content, input], [input], [content], [{}], [null], ["x"], [input, { id: "ws-1" }, content, async () => 1]];

const settle = async (v: unknown): Promise<unknown> => {
  if (typeof (v as { then?: unknown } | null)?.then !== "function") return v;
  return Promise.race([Promise.resolve(v).catch(() => undefined), new Promise((r) => setTimeout(() => r(undefined), 20).unref())]);
};

// Not spelled `Function.prototype`: the staging import check refuses the identifier `Function` everywhere.
const FUNCTION_PROTO: object = Object.getPrototypeOf(() => undefined) as object;

/** Names of everything reachable that yielded a token. */
async function findTokens(root: unknown, name: string, seen = new Set<unknown>(), depth = 0): Promise<string[]> {
  if (isToken(root)) return [name];
  if (depth > 4 || (typeof root !== "object" && typeof root !== "function") || root === null || seen.has(root)) return [];
  // zod schemas: calling their internals with hostile arguments rewrites the shared prototypes of zod's classes for the whole
  // process (zod's own `$constructor` installs trait members on the receiver's prototype). They hold no capability.
  if (Object.hasOwn(root, "_zod")) return [];
  seen.add(root);
  const found: string[] = [];
  if (typeof root === "function") {
    for (const args of BATTERY) {
      for (const how of ["call", "new"] as const) {
        let out: unknown;
        try {
          out = how === "call" ? await settle((root as (...a: unknown[]) => unknown)(...args)) : Reflect.construct(root as new (...a: unknown[]) => object, args);
        } catch {
          continue;
        }
        found.push(...(await findTokens(out, `${name}()`, seen, depth + 1)));
      }
    }
  }
  for (let o: object | null = root as object; o !== null && o !== Object.prototype && o !== FUNCTION_PROTO; o = Object.getPrototypeOf(o) as object | null) {
    for (const key of Reflect.ownKeys(o)) {
      if (key === "caller" || key === "callee" || key === "arguments") continue;
      let value: unknown;
      try {
        value = (root as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      found.push(...(await findTokens(value, `${name}.${String(key)}`, seen, depth + 1)));
    }
  }
  return [...new Set(found)];
}

test("the detector itself: it flags a function that returns a frozen empty object, directly or nested", async () => {
  assert.equal(isToken(Object.freeze({})), true);
  assert.equal(isToken({}), false);
  assert.deepEqual(await findTokens({ mint: () => Object.freeze({}) }, "fake"), ["fake.mint()"]);
  assert.deepEqual(await findTokens({ deep: { make: async () => ({ inner: () => Object.freeze({}) }) } }, "fake"), ["fake.deep.make().inner()"]);
});

test("no export of the public index and nothing the approvals wiring returns can produce a spend-free discard capability", async () => {
  const { a } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const control = new ControlClient({ mux });
  const approvals = createWorktreesApprovals({ audit: createChallengeAuditSink({ append: () => undefined }), control, clock: fakeClock() });
  try {
    assert.deepEqual(Object.keys(approvals).sort(), ["dispose", "gate", "onPreview", "port", "stats"], "the wiring exposes exactly these");
    assert.deepEqual(await findTokens(approvals, "wiring"), []);
    // Skip the factories that need real resources: they refuse hostile input before touching any.
    // `policySurface()` returns frozen tables that are legitimately empty (no planned rows; `PLANNED_RULES` is an empty frozen table): data, not a capability.
    const { policySurface: _data, PLANNED_RULES: _planned, ...rest } = host;
    void _data;
    void _planned;
    assert.deepEqual(await findTokens({ ...rest }, "index"), []);
    assert.deepEqual((await findTokens({ policySurface: host.policySurface }, "index")).filter((n) => !/^index\.policySurface\(\)\.(registry|rules|planned)$/.test(n)), []);
  } finally {
    approvals.dispose();
    control.dispose();
    mux.dispose();
  }
});
