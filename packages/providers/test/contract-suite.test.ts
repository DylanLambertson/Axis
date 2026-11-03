// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The contract suite must fail leaky adapters (review S9, re-review NS1 and
// NS5). Runs each variant of the leaky harness in a child process and checks
// which suite tests fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runProviderContractSuite } from "../contract/index.js";
import { fileURLToPath } from "node:url";

interface ChildRun {
  readonly failed: Set<string>;
  readonly passed: number;
}

function runFixture(file: string, vars: Record<string, string>): ChildRun {
  const fixture = fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));
  // Drop NODE_TEST_CONTEXT, or the child reports to this runner instead of printing TAP.
  const env: NodeJS.ProcessEnv = { ...process.env, ...vars };
  delete env["NODE_TEST_CONTEXT"];
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixture], { encoding: "utf8", timeout: 120_000, env });
  const failed = new Set([...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]?.trim() ?? ""));
  const passed = Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? "0");
  return { failed, passed };
}

function failedTests(leak: string): Set<string> {
  return runFixture("leaky-harness.js", { LEAK: leak }).failed;
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
  ["stream-drop-cap", ["forwards model, maxOutputTokens, system and stopSequences unchanged"]],
  ["base64", ["stream: an error after some output surfaces from iteration"]],
  ["upper", ["stream: an error after some output surfaces from iteration"]],
  ["descriptor", ["descriptor declares the API version, ids and a destination", "listModels returns unique ids including the fixture model"]],
];

for (const [leak, mustFail] of VARIANTS) {
  test(`S9/NS5: the contract suite fails the "${leak}" leaky adapter`, () => {
    const failed = failedTests(leak);
    for (const name of mustFail) assert.ok(failed.has(name), `the suite should fail: ${name}`);
    // These variants leak in every scenario (or in the text scenario the unrelated check uses).
    const pervasive = ["error-props", "descriptor"].includes(leak);
    if (!pervasive) assert.ok(!failed.has(UNRELATED), "unrelated checks still pass");
    if (!pervasive) assert.ok(!failed.has("getCapabilities returns a well-formed report for the model"), "the fixture is otherwise well-behaved");
  });
}

test("redirect: a well-behaved HTTP adapter that refuses redirects passes the whole suite", () => {
  const r = runFixture("http-harness.js", { FOLLOW: "0" });
  assert.deepEqual([...r.failed], []);
  assert.ok(r.passed > 70, `only ${r.passed} checks ran`);
});

// 1: fetch's default (follow); manual: re-requests the Location; fail: follows,
// then errors; retry: two requests to the origin for one call.
for (const mode of ["1", "manual", "fail", "retry"]) {
  test(`redirect: the suite fails an adapter that misbehaves on a redirect (FOLLOW=${mode})`, () => {
    const { failed } = runFixture("http-harness.js", { FOLLOW: mode });
    for (const status of [301, 302, 303, 307, 308]) {
      for (const call of ["generate", "stream", "listModels", "validateConnection", "countTokens"]) {
        const name = `${call}: a ${status} redirect is not followed, one request per call, all on the origin`;
        assert.ok(failed.has(name), `the suite should fail: ${name}`);
      }
    }
    // FOLLOW=1 leaves every request on fetch's default, so every check fails for it.
    if (mode !== "1") assert.ok(!failed.has("stream: a text reply follows the event grammar"), "unrelated checks still pass");
    else assert.ok(failed.has("stream: a text reply follows the event grammar"), "redirect: follow is refused in every scenario");
  });
}

test("R4: a harness with a short credential or canary is refused before any test is registered", () => {
  const base = { name: "x", setup: () => { throw new Error("unreachable"); } };
  assert.throws(() => runProviderContractSuite({ ...base, canary: "canary-long-enough", credential: "short-cred" }), RangeError);
  assert.throws(() => runProviderContractSuite({ ...base, canary: "", credential: "a-credential-long-enough" }), RangeError);
});
