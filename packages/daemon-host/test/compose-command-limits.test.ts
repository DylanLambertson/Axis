// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import type { GitRunner } from "@axis/git-ops";
import { DEFAULT_COMMAND_LIMITS, composeDaemonHost, hostCommandLimits, type CommandLimits, type ComposeOptions, type PtyPort } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

// C3: the host may lower the composer's `run_command` bounds (ComposeOptions.composer.commandLimits), never raise them.

const BAD = "command_limits_invalid";
const KEYS = ["timeoutMs", "maxOutputBytes", "modelChars"] as const;

test("absent: the defaults; each bound may be lowered alone, down to 1, or kept at its default", () => {
  assert.deepEqual(hostCommandLimits(undefined), DEFAULT_COMMAND_LIMITS);
  assert.deepEqual(hostCommandLimits({}), DEFAULT_COMMAND_LIMITS);
  for (const k of KEYS) {
    for (const v of [1, Math.floor(DEFAULT_COMMAND_LIMITS[k] / 2), DEFAULT_COMMAND_LIMITS[k]]) {
      assert.deepEqual(hostCommandLimits({ [k]: v }), { ...DEFAULT_COMMAND_LIMITS, [k]: v }, `${k}=${v}`);
    }
  }
  assert.deepEqual(hostCommandLimits({ timeoutMs: 5, maxOutputBytes: 6, modelChars: 7 }), { timeoutMs: 5, maxOutputBytes: 6, modelChars: 7 });
});

test("never raised: one unit above a default, or any value that is not a positive safe integer, is refused", () => {
  for (const k of KEYS) {
    const d = DEFAULT_COMMAND_LIMITS[k];
    for (const v of [d + 1, d * 2, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, Infinity, NaN, 0, -1, 1.5, "1", 1n, null, undefined, true, [1], { valueOf: () => 1 }]) {
      assert.equal(hostCommandLimits({ [k]: v }), BAD, `${k}=${String(v)}`);
    }
  }
});

test("hostile objects: unknown, symbol, inherited and __proto__ keys, getters and setters, odd prototypes and non-objects are refused", () => {
  let got = 0;
  const getter = Object.defineProperty({}, "timeoutMs", { get: () => (got++, 1), enumerable: true });
  const setter = Object.defineProperty({}, "timeoutMs", { set: () => undefined, enumerable: true });
  const sneaky: unknown[] = [
    { timeoutMs: 1, extra: 1 },
    { constructor: 1 },
    { [Symbol("timeoutMs")]: 1 },
    JSON.parse('{"__proto__": {"timeoutMs": 999999999}}'),
    JSON.parse('{"timeoutMs": 1, "__proto__": null}'),
    Object.create({ timeoutMs: 1 }),
    Object.create({ timeoutMs: 1 }, { modelChars: { value: 1, enumerable: true } }),
    getter,
    setter,
    new (class Limits { timeoutMs = 1; })(),
    Object.assign([], { timeoutMs: 1 }),
    new Map([["timeoutMs", 1]]),
    null, "timeoutMs=1", 1, () => undefined,
    new Proxy({}, { ownKeys: () => { throw new Error("boom"); } }),
    new Proxy({ timeoutMs: 1 }, { getOwnPropertyDescriptor: () => { throw new Error("boom"); } }),
  ];
  for (const [i, raw] of sneaky.entries()) assert.equal(hostCommandLimits(raw), BAD, String(i));
  assert.equal(got, 0, "a getter is never called");
});

test("read once, field by field: a null-prototype object is accepted, the result is frozen and owes nothing to the input", () => {
  const raw = Object.assign(Object.create(null) as Record<string, unknown>, { modelChars: 100 });
  const out = hostCommandLimits(raw) as CommandLimits;
  assert.deepEqual({ ...out }, { ...DEFAULT_COMMAND_LIMITS, modelChars: 100 });
  assert.ok(Object.isFrozen(out));
  raw["modelChars"] = 1;
  assert.equal(out.modelChars, 100);
  // A Proxy sees each own key's descriptor asked once; its `get` trap is never used.
  const asked: string[] = [];
  const proxy = new Proxy({ timeoutMs: 10 }, {
    getOwnPropertyDescriptor: (t, k) => (asked.push(`d:${String(k)}`), Reflect.getOwnPropertyDescriptor(t, k)),
    get: (t, k) => (asked.push(`g:${String(k)}`), 999_999_999),
  });
  assert.equal((hostCommandLimits(proxy) as CommandLimits).timeoutMs, 10);
  assert.deepEqual(asked, ["d:timeoutMs"]);
});

test("review cmd-bounds N1: a Proxy that lies about its prototype passes that check, but only checked own values come out", () => {
  let got = 0;
  const base = Object.defineProperty({ modelChars: 999_999_999 }, "timeoutMs", { get: () => (got++, 999_999_999) });
  const liar = (target: object): object => new Proxy(target, { getPrototypeOf: () => Object.prototype });
  const empty = liar(Object.create(base) as object);
  assert.equal(Object.getPrototypeOf(empty), Object.prototype, "the lie holds");
  assert.deepEqual(hostCommandLimits(empty), DEFAULT_COMMAND_LIMITS, "the real prototype's values never come out");
  assert.deepEqual(hostCommandLimits(liar(Object.assign(Object.create(base) as object, { modelChars: 50 }))), { ...DEFAULT_COMMAND_LIMITS, modelChars: 50 });
  assert.equal(hostCommandLimits(liar(Object.assign(Object.create(base) as object, { modelChars: 999_999_999 }))), BAD);
  assert.equal(hostCommandLimits(liar(new (class Limits { timeoutMs = 60_001; })())), BAD);
  assert.equal(got, 0, "the prototype's getter is never called");
});

const pty: PtyPort = { spawn: () => Promise.reject(new Error("unused")) };
const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });
function options(fix: ReturnType<typeof hostFixture>, over: Partial<ComposeOptions> = {}): ComposeOptions {
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  return { config: fix.config, control: fix.client, ports, pty, ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined, ...over };
}

test("compose: a lowered bound reaches the composer binding; absent, the defaults", async () => {
  for (const [over, want] of [
    [undefined, DEFAULT_COMMAND_LIMITS],
    [{ timeoutMs: 1_000, modelChars: 2_000 }, { ...DEFAULT_COMMAND_LIMITS, timeoutMs: 1_000, modelChars: 2_000 }],
  ] as const) {
    const fix = hostFixture();
    let seen: CommandLimits | undefined;
    const composed = composeDaemonHost(options(fix, { ...(over === undefined ? {} : { composer: { commandLimits: over } }), observeAgent: (a) => void (seen = a.commandLimits) }));
    try {
      await composed.start();
      assert.deepEqual(seen, want);
    } finally {
      await composed.stop();
      fix.cleanup();
    }
  }
});

test("compose: an override that would raise a bound (or is not a plain object of the three bounds) refuses the composition, closed and without the value", () => {
  const fix = hostFixture();
  try {
    for (const bad of [{ timeoutMs: DEFAULT_COMMAND_LIMITS.timeoutMs + 1 }, { maxOutputBytes: 123_456_789 }, { timeoutMs: 1, path: "/secret/x" }]) {
      assert.throws(
        () => composeDaemonHost(options(fix, { composer: { commandLimits: bad as never } })),
        (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT" && e.detail["reason"] === BAD && Object.keys(e.detail).length === 1 && !/\d|secret/.test(e.message),
      );
    }
  } finally {
    fix.cleanup();
  }
});
