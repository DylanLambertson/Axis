// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The contract suite must fail a leaky adapter (review S9). Runs the leaky
// harness in a child process and checks which suite tests fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("S9: the contract suite fails an adapter that leaks through extra error properties, events or providerOptions", () => {
  const fixture = fileURLToPath(new URL("./fixtures/leaky-harness.js", import.meta.url));
  // Drop NODE_TEST_CONTEXT, or the child reports to this runner instead of printing TAP.
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixture], { encoding: "utf8", timeout: 60_000, env });
  const failed = new Set([...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]?.trim() ?? ""));
  for (const name of [
    "stream: a provider authentication error maps to the taxonomy without leaking",
    "generate: a provider rate_limited error maps to the taxonomy without leaking",
    "stream: an error after some output surfaces from iteration",
    "stream: a text reply follows the event grammar",
    "providerOptions cannot redirect the request, add headers or change auth",
  ]) {
    assert.ok(failed.has(name), `the suite should fail: ${name}`);
  }
  assert.ok(!failed.has("generate: returns what collectStream builds from stream"), "unrelated checks still pass");
});
