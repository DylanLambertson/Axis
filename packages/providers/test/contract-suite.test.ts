// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The contract suite must fail leaky adapters (review S9, re-review NS1 and
// NS5). Runs each variant of the leaky harness in a child process and checks
// which suite tests fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function failedTests(leak: string): Set<string> {
  const fixture = fileURLToPath(new URL("./fixtures/leaky-harness.js", import.meta.url));
  // Drop NODE_TEST_CONTEXT, or the child reports to this runner instead of printing TAP.
  const env: NodeJS.ProcessEnv = { ...process.env, LEAK: leak };
  delete env["NODE_TEST_CONTEXT"];
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixture], { encoding: "utf8", timeout: 60_000, env });
  return new Set([...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]?.trim() ?? ""));
}

const UNRELATED = "generate: returns what collectStream builds from stream";

// error-props leaks into every stream's first event, so no check is unrelated to it.
const VARIANTS: Array<[leak: string, mustFail: string[]]> = [
  [
    "error-props",
    [
      "stream: a provider authentication error maps to the taxonomy without leaking",
      "generate: a provider rate_limited error maps to the taxonomy without leaking",
      "stream: an error after some output surfaces from iteration",
      "stream: a text reply follows the event grammar",
      "providerOptions cannot redirect the request, add headers or change auth",
    ],
  ],
  ["midstream-delta", ["stream: an error after some output surfaces from iteration"]],
  ["tool-id", ["stream: a tool call carries its name and parsed input"]],
  ["maxtok", ["stream: reports max_tokens"]],
  ["masked", ["stream: a provider authentication error maps to the taxonomy without leaking", "generate: a provider server_error error maps to the taxonomy without leaking"]],
  ["drop-cap", ["forwards model, maxOutputTokens, system and stopSequences unchanged"]],
];

for (const [leak, mustFail] of VARIANTS) {
  test(`S9/NS5: the contract suite fails the "${leak}" leaky adapter`, () => {
    const failed = failedTests(leak);
    for (const name of mustFail) assert.ok(failed.has(name), `the suite should fail: ${name}`);
    if (leak !== "error-props") assert.ok(!failed.has(UNRELATED), "unrelated checks still pass");
    if (leak !== "error-props") assert.ok(!failed.has("getCapabilities returns a well-formed report for the model"), "the fixture is otherwise well-behaved");
  });
}
