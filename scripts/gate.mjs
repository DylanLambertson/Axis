// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `npm run gate`: every pre-push check, in order, without stopping at the first failure.
// Environment: GATE_BASE (default origin/main), GATE_GITLEAKS (binary path),
// GATE_SKIP (comma-separated step ids; a run with skips is reported INCOMPLETE, exit 2),
// GATE_OVERLAY_TREE (a builder's PRIVATE Code OSS vendor dir: the overlay tests run there; unset, they are reported as
// skipped and the verdict says so), AXIS_REQUIRE_OVERLAY_TESTS=1 (a missing tree then FAILS the gate).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countLines, exitCode, findLongFiles, formatReport, formatTable, gitleaksInstallSteps,
  overlayNotRun, parseGitleaksPin, parseLog, parseSidecarHash, scanCommits, versionMatchesPin
} from "./gate/lib.mjs";
import { failureDigest, splitSuites } from "./gate/failures.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(scriptDir, "gate", "config.json"), "utf8"));
const base = process.env.GATE_BASE ?? "origin/main";
const skip = new Set((process.env.GATE_SKIP ?? "").split(",").filter(Boolean));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function sh(command, args, options = {}) {
  const r = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 20 * 60 * 1000, ...options
  });
  return { ok: r.status === 0 && r.error === undefined, status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}

const top = sh("git", ["rev-parse", "--show-toplevel"]);
if (!top.ok) {
  console.error("gate: not inside a git repository");
  process.exit(1);
}
const root = top.out.trim();
const git = (...args) => sh("git", args, { cwd: root });
const tail = (text, n = 12) => text.trimEnd().split("\n").slice(-n).join("\n");
const range = `${base}..HEAD`;

const head = git("rev-parse", "HEAD").out.trim();
const branchName = git("rev-parse", "--abbrev-ref", "HEAD").out.trim();
const branch = branchName === "HEAD" ? "(detached HEAD)" : branchName;
const baseOk = !base.startsWith("-") && git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).ok;
// Diff-based gates compare against the merge base, like the PR merge result in CI, so a
// base that has moved on does not show its own changes reversed. Log and gitleaks use
// base..HEAD, which already means "commits only on this branch".
const mergeBase = baseOk ? git("merge-base", base, "HEAD").out.trim() : "";
const diffRange = `${base}...HEAD`;
const baseMissing = { status: "fail", detail: `base ref ${base} not found (git fetch origin)` };

const steps = [];
const step = (id, name, fn) => steps.push({ id, name, fn });

function parsePin() {
  const wf = join(root, ".github", "workflows", "ci.yml");
  return existsSync(wf) ? parseGitleaksPin(readFileSync(wf, "utf8")) : undefined;
}

step("diff-check", "git diff --check", () => {
  if (!baseOk) return baseMissing;
  const r = git("diff", "--check", diffRange);
  return r.ok ? { status: "pass", detail: diffRange } : { status: "fail", detail: tail(r.out) };
});

step("gitleaks", "gitleaks", () => {
  if (!baseOk) return baseMissing;
  const bin = process.env.GATE_GITLEAKS ?? join(homedir(), ".cache", "project-axis", "tools", "gitleaks", "gitleaks");
  if (!existsSync(bin)) {
    const pin = parsePin();
    const how = pin
      ? `install the CI pin (${pin.version}):\n    ${gitleaksInstallSteps(pin, dirname(bin)).join("\n    ")}`
      : "no pin found in .github/workflows/ci.yml (GITLEAKS_VERSION / GITLEAKS_SHA256)";
    return { status: "fail", detail: `${bin} is missing; ${how}` };
  }
  const pin = parsePin();
  if (!pin) return { status: "fail", detail: "no GITLEAKS_VERSION / GITLEAKS_SHA256 pin in .github/workflows/ci.yml; refusing to run an unverified binary" };
  // Hash first: nothing is executed until the file matches the recorded hash.
  let note = `binary hash not recorded (${bin}.sha256)`;
  if (existsSync(`${bin}.sha256`)) {
    const recorded = parseSidecarHash(readFileSync(`${bin}.sha256`, "utf8"));
    const actual = createHash("sha256").update(readFileSync(bin)).digest("hex");
    if (recorded !== actual) return { status: "fail", detail: `${bin} does not match ${bin}.sha256; refusing to run an unverified binary` };
    note = "hash verified";
  }
  const v = sh(bin, ["version"], { cwd: root, timeout: 30000 });
  if (!v.ok || !versionMatchesPin(v.out, pin)) {
    return { status: "fail", detail: `${bin} reports "${v.out.trim().slice(0, 60)}", CI pins ${pin.version}; refusing to run an unverified binary (reinstall it)` };
  }
  const r = sh(bin, ["git", "--no-banner", "--redact", `--log-opts=${range}`, "."], { cwd: root });
  return r.ok ? { status: "pass", detail: `no leaks; v${pin.version}, ${note}` } : { status: "fail", detail: tail(r.out) };
});

step("line-limit", `files over ${config.lineLimit} lines`, () => {
  if (!baseOk) return baseMissing;
  const listing = git("diff", "--name-status", "-z", "-M", "--diff-filter=AMRC", diffRange).out.split("\0").filter(Boolean);
  const changed = [];
  for (let i = 0; i < listing.length; ) {
    const code = listing[i][0];
    if (code === "R" || code === "C") { changed.push({ path: listing[i + 2], oldPath: listing[i + 1] }); i += 3; }
    else { changed.push({ path: listing[i + 1], oldPath: listing[i + 1] }); i += 2; }
  }
  // Committed content on both sides, not the working tree.
  const files = [];
  for (const { path, oldPath } of changed) {
    const now = git("show", `HEAD:${path}`);
    if (!now.ok || now.out.includes("\0")) continue;
    const old = git("show", `${mergeBase}:${oldPath}`);
    files.push({ path, lines: countLines(now.out), baseLines: old.ok ? countLines(old.out) : undefined });
  }
  const long = findLongFiles(files, config);
  return long.length === 0
    ? { status: "pass", detail: `${files.length} changed files` }
    : { status: "fail", detail: long.map((f) => `${f.path} (${f.lines})`).join(", ") };
});

step("wording", "commit wording", () => {
  if (!baseOk) return baseMissing;
  const log = git("log", "--format=%H%x00%B%x01", range);
  const problems = scanCommits(parseLog(log.out), branch, config);
  return problems.length === 0
    ? { status: "pass", detail: `${parseLog(log.out).length} commits` }
    : { status: "fail", detail: problems.join("; ") };
});

step("node-version", "node version", () => {
  let pinned;
  try { pinned = JSON.parse(readFileSync(join(root, "code-oss", "upstream.json"), "utf8")).node; } catch { /* below */ }
  if (typeof pinned !== "string") return { status: "fail", detail: "code-oss/upstream.json has no node pin" };
  return process.version === `v${pinned}`
    ? { status: "pass", detail: process.version }
    : { status: "fail", detail: `running ${process.version}, upstream.json pins v${pinned}` };
});

step("typecheck", "typecheck", () => {
  const r = sh(npm, ["run", "typecheck"], { cwd: root });
  return r.ok ? { status: "pass" } : { status: "fail", detail: tail(r.out) };
});

// The whole tests step has its own limit (each suite keeps its own 20 minute one in scripts/gate/run-suite.mjs): at a load of 20 to 37 the
// run took about 20 minutes, and the fixed 20 minutes of `sh` killed it before its summary, leaving a failure with no suite named.
const MAX_TIMER_MS = 2 ** 31 - 1;
const TESTS_LIMIT_MS = (() => {
  const raw = process.env.AXIS_GATE_TESTS_TIMEOUT_MS;
  if (raw === undefined) return 3 * 60 * 60 * 1000;
  return /^[1-9][0-9]*$/.test(raw) && Number(raw) <= MAX_TIMER_MS ? Number(raw) : raw; // above this a timer fires at once
})();

let packageCounts = [];
step("test", "tests", () => {
  if (typeof TESTS_LIMIT_MS !== "number") return { status: "fail", detail: `AXIS_GATE_TESTS_TIMEOUT_MS must be a positive integer of at most ${MAX_TIMER_MS}, got ${JSON.stringify(TESTS_LIMIT_MS)}` };
  const dir = mkdtempSync(join(tmpdir(), "axis-gate-"));
  const file = join(dir, "tests.json");
  let keep = false;
  try {
    // ADR 0009's first test (PV-N1d) may skip on a dev machine without openssl, never under the gate.
    const r = sh(process.execPath, [join(root, "scripts", "test-all.mjs"), "--json", file], { cwd: root, timeout: TESTS_LIMIT_MS, env: { ...process.env, AXIS_REQUIRE_PINNING_TEST: "1" } });
    try { packageCounts = JSON.parse(readFileSync(file, "utf8")); } catch { /* summary missing */ }
    if (!Array.isArray(packageCounts)) packageCounts = [];
    // A run that exits 0 with no summary, or with a summary of no suite, ran nothing: that is a failure, never "pass, 0 suites".
    if (r.ok && packageCounts.length > 0) return { status: "pass", detail: `${packageCounts.length} suites` };
    if (r.ok) { return { status: "fail", detail: "the test run ended without a summary of any suite (zero suites ran, or no summary was written)" }; }
    const bad = packageCounts.filter((s) => !s.ok).map((s) => s.name);
    // Passing suites stay quiet. A failing one prints its failing tests' names and first error lines here and
    // keeps its whole output in a file, because a flake that cannot be named cannot be chased.
    const saved = [];
    for (const s of splitSuites(r.out).filter((x) => !x.ok)) {
      keep = true;
      const log = join(dir, `${s.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`);
      writeFileSync(log, s.text);
      saved.push(log);
      console.log(`\n== ${s.name}: failing tests\n${failureDigest(s.text) || "(no failing test name in the output; see the full output)"}\n== full output: ${log}\n`);
    }
    const where = saved.length > 0 ? `; full output: ${saved.join(", ")}` : "";
    if (bad.length > 0) return { status: "fail", detail: `failed: ${bad.join(", ")}${where}` };
    // No suite is marked failed: the run itself ended without its summary. Say why, and which suite it was in (the runner names it on a signal).
    const started = [...r.out.matchAll(/^== running (.+)$/gm)].map((m) => m[1]);
    const running = started.at(-1);
    const why = r.error?.code === "ETIMEDOUT" ? `timed out after ${Math.round(TESTS_LIMIT_MS / 1000)}s` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    return { status: "fail", detail: `the test run ended without a summary (${why})${running ? ` while running ${running}` : ""}\n${tail(r.out)}` };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// PV-X3: the overlay's node unit tests (vs/axis/**/test/common), which no other gate step or CI job runs. They need an
// applied, installed Code OSS tree, so they run only when GATE_OVERLAY_TREE names one; otherwise the step is "absent":
// loud, and the verdict says "PASSED (overlay tests skipped)", or a FAIL with AXIS_REQUIRE_OVERLAY_TESTS=1.
step("overlay-tests", "overlay tests", () => {
  const required = process.env.AXIS_REQUIRE_OVERLAY_TESTS === "1";
  const tree = process.env.GATE_OVERLAY_TREE;
  if (!tree) return overlayNotRun("no Code OSS tree: set GATE_OVERLAY_TREE to your private vendor dir", required);
  const r = sh("bash", [join(root, "scripts", "code-oss", "overlay-tests.sh")], { cwd: root, env: { ...process.env, AXIS_CODE_OSS_VENDOR_DIR: tree } });
  if (r.status === 3) return overlayNotRun(tail(r.out, 2), required);
  const passing = /(\d+) passing/.exec(r.out)?.[1];
  return r.ok ? { status: "pass", detail: `${passing ?? "?"} passing` } : { status: "fail", detail: tail(r.out) };
});

const results = [];
for (const s of steps) {
  let r;
  if (skip.has(s.id)) {
    r = { status: "skip", detail: "skipped by GATE_SKIP" };
    console.error(`WARNING: ${s.name} skipped; this run is not a valid pre-push result`);
  }
  else {
    try { r = s.fn(); } catch (e) { r = { status: "fail", detail: `gate error: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  results.push({ name: s.name, ...r });
  console.log(`${r.status.toUpperCase().padEnd(4)} ${s.name}`);
  if (r.status === "absent") console.error(`WARNING: ${s.name} did not run (${r.detail}); the verdict says so`);
}

console.log(`\n${formatTable(results)}\n`);
console.log(formatReport({ branch, head, results, packageCounts }));
process.exit(exitCode(results));
