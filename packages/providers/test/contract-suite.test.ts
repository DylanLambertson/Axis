// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The contract suite must fail leaky adapters (review S9, re-review NS1 and
// NS5). Runs each variant of the leaky harness in a child process and checks
// which suite tests fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runProviderContractSuite } from "../contract/index.js";
import { fileURLToPath } from "node:url";

interface ChildRun {
  readonly failed: Set<string>;
  readonly passed: number;
  readonly output: string;
  readonly code: number | null;
}

/**
 * Run a fixture suite in a child process. Children run concurrently (a small
 * pool) and are started when first asked for, so the suite's one final late
 * window is paid in parallel rather than once per child.
 */
const runs = new Map<string, Promise<ChildRun>>();
let active = 0;
const waiting: Array<() => void> = [];
const POOL = 8;

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= POOL) await new Promise<void>((r) => waiting.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function spawnFixture(file: string, vars: Record<string, string>): Promise<ChildRun> {
  const fixture = fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));
  // Drop NODE_TEST_CONTEXT, or the child reports to this runner instead of printing TAP.
  const env: NodeJS.ProcessEnv = { ...process.env, ...vars };
  delete env["NODE_TEST_CONTEXT"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = new Set([...stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]?.trim() ?? ""));
      const passed = Number(/^# pass (\d+)$/m.exec(stdout)?.[1] ?? "0");
      resolve({ failed, passed, output: stdout + stderr, code });
    });
  });
}

function runFixture(file: string, vars: Record<string, string>): Promise<ChildRun> {
  const key = `${file} ${JSON.stringify(vars)}`;
  let run = runs.get(key);
  if (run === undefined) {
    run = slot(() => spawnFixture(file, vars));
    runs.set(key, run);
  }
  return run;
}

async function failedTests(leak: string): Promise<Set<string>> {
  return (await runFixture("leaky-harness.js", { LEAK: leak })).failed;
}

// Start every child run now, so they overlap with each other and with the tests.
for (const leak of ["error-props", "midstream-delta", "tool-id", "maxtok", "masked", "drop-cap", "stream-drop-cap", "base64", "upper", "descriptor"]) {
  void runFixture("leaky-harness.js", { LEAK: leak });
}
for (const mode of ["0", "1", "manual", "fail", "retry", "global", "captured", "https", "bypass", "late", "verylate", "second"]) {
  void runFixture("http-harness.js", { FOLLOW: mode });
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
  test(`S9/NS5: the contract suite fails the "${leak}" leaky adapter`, async () => {
    const failed = await failedTests(leak);
    for (const name of mustFail) assert.ok(failed.has(name), `the suite should fail: ${name}`);
    // These variants leak in every scenario (or in the text scenario the unrelated check uses).
    const pervasive = ["error-props", "descriptor"].includes(leak);
    if (!pervasive) assert.ok(!failed.has(UNRELATED), "unrelated checks still pass");
    if (!pervasive) assert.ok(!failed.has("getCapabilities returns a well-formed report for the model"), "the fixture is otherwise well-behaved");
  });
}

test("redirect: a well-behaved HTTP adapter that refuses redirects passes the whole suite", async () => {
  const r = await runFixture("http-harness.js", { FOLLOW: "0" });
  assert.deepEqual([...r.failed], []);
  assert.equal(r.code, 0);
  assert.ok(r.passed > 70, `only ${r.passed} checks ran`);
});

// 1: fetch's default (follow); manual: re-requests the Location; fail: follows,
// then errors; retry: two requests to the origin for one call.
for (const mode of ["1", "manual", "fail", "retry"]) {
  test(`redirect: the suite fails an adapter that misbehaves on a redirect (FOLLOW=${mode})`, async () => {
    const { failed } = await runFixture("http-harness.js", { FOLLOW: mode });
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

// global: follows with globalThis.fetch; captured: with a fetch captured at
// module load; https: with node:https (N-2); bypass: never uses the transport.
// Each follow happens while the call runs, so the call's own check fails.
for (const mode of ["global", "captured", "https", "bypass"]) {
  test(`redirect: the suite fails an adapter that leaks outside the transport (FOLLOW=${mode})`, async () => {
    const { failed, code } = await runFixture("http-harness.js", { FOLLOW: mode });
    for (const status of [301, 302, 303, 307, 308]) {
      const name = `generate: a ${status} redirect is not followed, one request per call, all on the origin`;
      assert.ok(failed.has(name), `the suite should fail: ${name}`);
    }
    assert.notEqual(code, 0);
  });
}

// late: fails the call at once and follows 50 ms later through the wrapped
// fetch (SF-1). No check waits for it; it must still fail the file, in a later
// check or in the suite's final one.
test("redirect: the suite fails an adapter that follows after the call settled (FOLLOW=late)", async () => {
  const { failed, output, code } = await runFixture("http-harness.js", { FOLLOW: "late" });
  assert.ok(failed.size > 0, "some check fails");
  assert.notEqual(code, 0, "the file fails");
  assert.match(output, /redirect host: https:\/\/redirect-target\.contract\.invalid/, "the late request is the reported violation");
});

// verylate: follows 4 s later, after the suite's final late window closed.
// Every check passes; the process exit scan must still fail the file.
test("redirect: a request after the suite ended still fails the file (FOLLOW=verylate)", async () => {
  const { output, code } = await runFixture("http-harness.js", { FOLLOW: "verylate" });
  assert.notEqual(code, 0, "the file fails");
  assert.match(output, /requests after the suite ended/);
  assert.match(output, /redirect host: https:\/\/redirect-target\.contract\.invalid/);
});

test("redirect: the suite fails an adapter that follows only on a later call (FOLLOW=second, N-1)", async () => {
  const { failed } = await runFixture("http-harness.js", { FOLLOW: "second" });
  for (const status of [301, 302, 303, 307, 308]) {
    const name = `generate twice: a ${status} redirect is not followed on a later call either`;
    assert.ok(failed.has(name), `the suite should fail: ${name}`);
    // A single call is refused correctly, so the one-call check alone would pass it.
    assert.ok(!failed.has(`listModels: a ${status} redirect is not followed, one request per call, all on the origin`));
  }
});

test("R4: a harness with a short credential or canary is refused before any test is registered", () => {
  const base = { name: "x", setup: () => { throw new Error("unreachable"); } };
  assert.throws(() => runProviderContractSuite({ ...base, canary: "canary-long-enough", credential: "short-cred" }), RangeError);
  assert.throws(() => runProviderContractSuite({ ...base, canary: "", credential: "a-credential-long-enough" }), RangeError);
});
