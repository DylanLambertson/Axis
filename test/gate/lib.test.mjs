// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  countLines, exitCode, findLongFiles, formatReport, formatTable, gitleaksInstallSteps,
  parseGitleaksPin, parseLog, parseSidecarHash, parseTestCounts, versionMatchesPin, scanCommits, scanWording
} from "../../scripts/gate/lib.mjs";

const config = JSON.parse(readFileSync(new URL("../../scripts/gate/config.json", import.meta.url), "utf8"));

test("countLines counts a final unterminated line", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("\n\n"), 2);
});

test("findLongFiles flags new and grown files, exempts generated ones", () => {
  const limit = config.lineLimit;
  const out = findLongFiles(
    [
      { path: "b/new.ts", lines: limit + 1 },
      { path: "a/exact.ts", lines: limit },
      { path: "a/grown.ts", lines: limit + 5, baseLines: limit + 2 },
      { path: "a/legacy-untouched-size.ts", lines: limit + 5, baseLines: limit + 5 },
      { path: "a/shrunk.ts", lines: limit + 1, baseLines: limit + 50 },
      { path: "package-lock.json", lines: 9000 },
      { path: "x/y/package-lock.json", lines: 9000 },
      { path: "assets/logo.PNG", lines: 9000 }
    ],
    config
  );
  assert.deepEqual(out.map((f) => f.path), ["a/grown.ts", "b/new.ts"]);
});

test("scanWording rejects attribution and tool names", () => {
  for (const text of [
    "feat: x\n\nCo-Authored-By: Someone <a@b.c>",
    "Generated with a tool",
    "ask Claude",
    "fix the agent loop",
    "Agents are fine?"
  ]) assert.notDeepEqual(scanWording(text, config), [], text);
});

test("scanWording allows product identifiers and word-boundary lookalikes", () => {
  for (const text of [
    "feat(pty-policy): resolve the CLI agent launch",
    "the cli agents setting",
    "docs: axis-agent-shell policies",
    "an agent-first IDE",
    "agent_runs table and cliAgents schema",
    "reassistant magenta"
  ]) assert.deepEqual(scanWording(text, config), [], text);
});

test("an allowed phrase does not hide a bare use next to it", () => {
  assert.deepEqual(scanWording("CLI agent and the agent", config), ["agent"]);
});

test("parseLog and scanCommits report the offending commit and branch", () => {
  const log = "aaaaaaaaaaaaaaaa\x00feat: ok\n\n\x01\nbbbbbbbbbbbbbbbb\x00fix: x\n\nCo-Authored-By: t\n\x01";
  const commits = parseLog(log);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].sha, "bbbbbbbbbbbbbbbb");
  const problems = scanCommits(commits, "chore/agent-thing", config);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /branch name/);
  assert.match(problems[1], /^bbbbbbbbbbbb: co-authored-by/);
  assert.deepEqual(scanCommits(commits.slice(0, 1), "chore/gate-script", config), []);
});

test("the workflow pin is parsed from the real ci.yml", () => {
  const pin = parseGitleaksPin(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  const steps = gitleaksInstallSteps(pin, "/d").join("\n");
  assert.ok(steps.includes(pin.sha256) && steps.includes(`v${pin.version}`));
  assert.equal(parseGitleaksPin("GITLEAKS_VERSION: 1.2.3\n"), undefined);
});

test("parseTestCounts reads TAP and spec summaries and adds them up", () => {
  assert.deepEqual(parseTestCounts("# pass 3\n# fail 1\n"), { pass: 3, fail: 1 });
  assert.deepEqual(parseTestCounts("ℹ pass 30\nℹ fail 0\nℹ pass 2\n"), { pass: 32, fail: 0 });
  assert.deepEqual(parseTestCounts("nothing"), { pass: 0, fail: 0 });
});

test("table, exit code and report", () => {
  const results = [
    { name: "a", status: "pass", detail: "ok" },
    { name: "long name", status: "fail", detail: "x\ny" },
    { name: "c", status: "skip" }
  ];
  const table = formatTable(results);
  assert.match(table, /^PASS {2}a {10}ok$/m);
  assert.match(table, /FAIL {2}long name {2}x \/ y/);
  assert.equal(exitCode(results), 1);
  assert.equal(exitCode(results.slice(0, 1)), 0);
  assert.equal(exitCode([results[0], results[2]]), 2);
  const report = formatReport({
    branch: "chore/x", head: "f".repeat(40), results,
    packageCounts: [{ name: "@axis/audit", pass: 5, fail: 0 }]
  });
  assert.ok(report.includes("head:   " + "f".repeat(40)));
  assert.ok(report.includes("@axis/audit: 5 pass, 0 fail"));
  assert.ok(report.includes("verdict: FAILED"));
});

test("scanWording sees through look-alike spellings", () => {
  for (const text of [
    "Co\u2011Authored\u2011By: x",
    "Co\u200b-Authored-By: x",
    "\uff23\uff4f-authored-by: x",
    "Co authored by x",
    "Generated  with x",
    "Generated\nwith x",
    "agentic loop",
    "the agent_x thing"
  ]) assert.notDeepEqual(scanWording(text, config), [], JSON.stringify(text));
});

test("scanWording keeps product identifiers and the anthropic package allowed", () => {
  for (const text of [
    "feat(anthropic): add the @axis/anthropic adapter",
    "the user-agent header",
    "the assistant role in a message",
    "agent_workspaces and agent_runs"
  ]) assert.deepEqual(scanWording(text, config), [], text);
});

test("version and sidecar helpers", () => {
  const pin = { version: "8.30.1" };
  assert.ok(versionMatchesPin("8.30.1\n", pin));
  assert.ok(versionMatchesPin("v8.30.1", pin));
  assert.ok(!versionMatchesPin("8.30.10", pin));
  assert.ok(!versionMatchesPin("evil 8.30.1", pin));
  assert.equal(parseSidecarHash(`${"a".repeat(64)}  gitleaks\n`), "a".repeat(64));
  assert.equal(parseSidecarHash("nothing"), undefined);
});
