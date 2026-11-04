// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `npm run gate`: every pre-push check, in order, without stopping at the first failure.
// Environment: GATE_BASE (default origin/main), GATE_GITLEAKS (binary path),
// GATE_SKIP (comma-separated step ids; a run with skips is reported INCOMPLETE, exit 2).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countLines, exitCode, findLongFiles, formatReport, formatTable, gitleaksInstallSteps,
  parseGitleaksPin, parseLog, scanCommits
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
const branch = git("rev-parse", "--abbrev-ref", "HEAD").out.trim();
const baseOk = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).ok;
const baseMissing = { status: "fail", detail: `base ref ${base} not found (git fetch origin)` };

const steps = [];
const step = (id, name, fn) => steps.push({ id, name, fn });

step("diff-check", "git diff --check", () => {
  if (!baseOk) return baseMissing;
  const r = git("diff", "--check", range);
  return r.ok ? { status: "pass", detail: range } : { status: "fail", detail: tail(r.out) };
});

step("gitleaks", "gitleaks", () => {
  if (!baseOk) return baseMissing;
  const bin = process.env.GATE_GITLEAKS ?? join(homedir(), ".cache", "project-axis", "tools", "gitleaks", "gitleaks");
  if (!existsSync(bin)) {
    const wf = join(root, ".github", "workflows", "ci.yml");
    const pin = existsSync(wf) ? parseGitleaksPin(readFileSync(wf, "utf8")) : undefined;
    const how = pin
      ? `install the CI pin (${pin.version}):\n    ${gitleaksInstallSteps(pin, dirname(bin)).join("\n    ")}`
      : "no pin found in .github/workflows/ci.yml (GITLEAKS_VERSION / GITLEAKS_SHA256)";
    return { status: "fail", detail: `${bin} is missing; ${how}` };
  }
  const r = sh(bin, ["git", "--no-banner", "--redact", `--log-opts=${range}`, "."], { cwd: root });
  return r.ok ? { status: "pass", detail: "no leaks" } : { status: "fail", detail: tail(r.out) };
});

step("line-limit", `files over ${config.lineLimit} lines`, () => {
  if (!baseOk) return baseMissing;
  const names = git("diff", "--name-only", "--diff-filter=AM", "-z", range).out.split("\0").filter(Boolean);
  const files = [];
  for (const path of names) {
    let text;
    try { text = readFileSync(join(root, path), "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    const old = git("show", `${base}:${path}`);
    files.push({ path, lines: countLines(text), baseLines: old.ok ? countLines(old.out) : undefined });
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
  if (skip.has(s.id)) r = { status: "skip", detail: "skipped by GATE_SKIP" };
  else {
    try { r = s.fn(); } catch (e) { r = { status: "fail", detail: `gate error: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  results.push({ name: s.name, ...r });
  console.log(`${r.status.toUpperCase().padEnd(4)} ${s.name}`);
}

console.log(`\n${formatTable(results)}\n`);
console.log(formatReport({ branch, head, results, packageCounts }));
process.exit(exitCode(results));
