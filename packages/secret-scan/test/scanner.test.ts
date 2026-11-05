// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretScanner, parseScanMode, SecretScanError } from "../src/index.js";
import { canary, patch, randomValue, rules } from "./helpers.js";

const bigPatch = (n: number): string => patch("a.txt", Array.from({ length: n }, (_, i) => `line ${i} of ordinary text`));

test("the default mode is refuse, and an unknown mode is refuse too", () => {
  assert.equal(createSecretScanner().mode, "refuse");
  assert.equal(createSecretScanner({ mode: "warn" }).mode, "warn");
  for (const bad of [undefined, null, "", "off", "Warn", "WARN", "none", 0, false, {}, ["warn"]]) assert.equal(parseScanMode(bad), "refuse");
  assert.equal(parseScanMode("warn"), "warn");
  assert.equal(createSecretScanner({ mode: "off" as never }).mode, "refuse");
});

test("scan returns findings, with the commit, in both modes", async () => {
  for (const mode of ["refuse", "warn"] as const) {
    const s = createSecretScanner({ mode });
    const fs = await s.scan(patch("a.txt", [canary.aws()]), { commit: "c".repeat(40), part: "patch", binaryPaths: [], truncated: false });
    assert.deepEqual(fs, [{ rule: "aws-access-key-id", path: "a.txt", line: 1, commit: "c".repeat(40) }]);
    assert.deepEqual(await s.scan(bigPatch(3), { commit: "c".repeat(40) }), []);
  }
});

test("a scanner that fails refuses in refuse mode with a fixed error that holds no text", async () => {
  const leak = randomValue(1, 40);
  const s = createSecretScanner({ mode: "refuse" });
  const meta = { get part(): never { throw new Error(`boom ${leak}`); } };
  await assert.rejects(s.scan(patch("a.txt", [canary.aws()]), meta), (e: unknown) => {
    assert.ok(e instanceof SecretScanError);
    assert.equal(e.code, "internal");
    assert.ok(!String(e.message).includes(leak) && !String(e.stack).includes(leak));
    assert.equal(e.cause, undefined);
    return true;
  });
  await assert.rejects(s.scan(42 as never, {}), SecretScanError);
  await assert.rejects(s.scan(null as never, {}), SecretScanError);
});

test("in warn mode a failure is a finding the user must confirm, never silence", async () => {
  const s = createSecretScanner({ mode: "warn" });
  const meta = { commit: "d".repeat(40), get part(): never { throw new Error("boom"); } };
  assert.deepEqual(await s.scan("+x\n", meta), [{ rule: "scanner-error", commit: "d".repeat(40) }]);
  assert.deepEqual(rules(await s.scan(null as never, {})), ["scanner-error"]);
});

test("a scan over the byte limit: refuse throws, warn reports scan-incomplete with what it found", async () => {
  const text = patch("a.txt", [canary.aws(), ...Array.from({ length: 2000 }, () => "filler filler filler")]);
  await assert.rejects(createSecretScanner({ mode: "refuse", maxBytes: 5000 }).scan(text, {}), (e: unknown) => e instanceof SecretScanError && e.code === "too_large");
  const fs = await createSecretScanner({ mode: "warn", maxBytes: 5000 }).scan(text, { commit: "e".repeat(40) });
  assert.deepEqual(rules(fs), ["aws-access-key-id", "scan-incomplete"]);
  // Exactly at the limit is complete.
  assert.deepEqual(await createSecretScanner({ maxBytes: text.length }).scan(text, {}), [{ rule: "aws-access-key-id", path: "a.txt", line: 1 }]);
});

test("a scan past its deadline is incomplete, from an injected clock", async () => {
  let t = 0;
  const now = (): number => (t += 400);
  const text = bigPatch(2000);
  await assert.rejects(createSecretScanner({ mode: "refuse", deadlineMs: 2000, now }).scan(text, {}), (e: unknown) => e instanceof SecretScanError && e.code === "deadline");
  t = 0;
  assert.deepEqual(rules(await createSecretScanner({ mode: "warn", deadlineMs: 2000, now }).scan(text, {})), ["scan-incomplete"]);
  // A clock that never advances never times out.
  assert.deepEqual(await createSecretScanner({ deadlineMs: 2000, now: () => 5 }).scan(text, {}), []);
});

test("options are checked, and the message names the option, not a value", () => {
  for (const o of [{ maxBytes: 0 }, { maxFindings: -1 }, { deadlineMs: 1.5 }, { maxLineLength: 10 }, { maxBinaryBytes: Number.NaN }, { maxBytes: 2 ** 40 }]) {
    assert.throws(() => createSecretScanner(o), (e: unknown) => e instanceof RangeError && /option/.test(e.message) && !/\d{4,}/.test(e.message));
  }
});

test("the scanner and its limits are frozen", () => {
  const s = createSecretScanner();
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.limits));
});
