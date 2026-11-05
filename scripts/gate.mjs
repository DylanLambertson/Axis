// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `npm run gate`: every pre-push check, in order, without stopping at the first failure.
// Environment: GATE_BASE (default origin/main), GATE_GITLEAKS (binary path),
// GATE_SKIP (comma-separated step ids; a run with skips is reported INCOMPLETE, exit 2).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countLines, exitCode, findLongFiles, formatReport, formatTable, gitleaksInstallSteps,
  parseGitleaksPin, parseLog, parseSidecarHash, scanCommits, versionMatchesPin
} from "./gate/lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(scriptDir, "gate", "config.json"), "utf8"));
const base = process.env.GATE_BASE ?? "origin/main";
const skip = new Set((process.env.GATE_SKIP ?? "").split(",").filter(Boolean));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function sh(command, args, options = {}) {
  const r = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 20 * 60 * 1000, ...options
  });
  return { ok: r.status === 0 && r.error === undefined, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
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

let packageCounts = [];
step("test", "tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-gate-"));
  const file = join(dir, "tests.json");
  try {
    const r = sh(process.execPath, [join(root, "scripts", "test-all.mjs"), "--json", file], { cwd: root });
    try { packageCounts = JSON.parse(readFileSync(file, "utf8")); } catch { /* summary missing */ }
    if (r.ok) return { status: "pass", detail: `${packageCounts.length} suites` };
    const bad = packageCounts.filter((s) => !s.ok).map((s) => s.name);
    return { status: "fail", detail: bad.length > 0 ? `failed: ${bad.join(", ")}` : tail(r.out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
}

console.log(`\n${formatTable(results)}\n`);
console.log(formatReport({ branch, head, results, packageCounts }));
process.exit(exitCode(results));
