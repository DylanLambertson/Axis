// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Pure helpers for scripts/gate.mjs: no process, file system or git access.
import { dirname, join, resolve } from "node:path";

/** Number of lines in a text, counting a final line that has no newline. */
export function countLines(text) {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
}

/** True for a path the line limit does not apply to (generated or binary-like). */
export function isLineLimitExempt(path, config) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (config.lineLimitExemptFiles.includes(name)) return true;
  if ((config.lineLimitExemptPaths ?? []).includes(path)) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && config.lineLimitExemptExtensions.includes(name.slice(dot).toLowerCase());
}

/**
 * Files over the limit. `files` is [{ path, lines, baseLines }] where baseLines is the
 * length on the base branch (undefined for a new file). A file already over the limit on
 * the base is reported only if the change made it longer.
 */
export function findLongFiles(files, config) {
  return files
    .filter((f) => !isLineLimitExempt(f.path, config))
    .filter((f) => f.lines > config.lineLimit && (f.baseLines === undefined || f.lines > f.baseLines))
    .map((f) => ({ path: f.path, lines: f.lines }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Folds a text so look-alike spellings compare equal: NFKC (fullwidth letters, non-breaking
 * hyphens), no invisible format characters, and one space for any run of whitespace,
 * underscores or dash characters.
 */
export function foldText(text) {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s_\u2010-\u2015\u2212-]+/gu, " ")
    .toLowerCase();
}

/**
 * Forbidden wording in a text. Both sides are folded, allowed phrases are blanked first
 * (so "CLI agent" passes while a bare "agent" does not), and terms match as whole words
 * with an optional plural or "ic" suffix ("agents", "agentic"). Returns the distinct
 * offending terms.
 */
export function scanWording(text, config) {
  let rest = ` ${foldText(text)} `;
  for (const phrase of config.allowedPhrases) {
    rest = rest.replace(new RegExp(escapeRegExp(foldText(phrase)), "gu"), " ");
  }
  const found = new Set();
  for (const term of config.forbiddenWording) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(foldText(term))}(?:s|es|ic)?(?![\\p{L}\\p{N}])`, "u");
    if (pattern.test(rest)) found.add(term);
  }
  return [...found];
}

/** Splits `git log --format=%H%x00%B%x01` output into [{ sha, message }]. */
export function parseLog(output) {
  return output
    .split("\x01")
    .map((entry) => entry.replace(/^\n+/, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const i = entry.indexOf("\x00");
      return { sha: entry.slice(0, i), message: entry.slice(i + 1) };
    });
}

/** Offending commits (and branch name) as readable lines. */
export function scanCommits(commits, branch, config) {
  const problems = [];
  const branchHits = scanWording(branch, config);
  if (branchHits.length > 0) problems.push(`branch name "${branch}": ${branchHits.join(", ")}`);
  for (const c of commits) {
    const hits = scanWording(c.message, config);
    if (hits.length > 0) problems.push(`${c.sha.slice(0, 12)}: ${hits.join(", ")}`);
  }
  return problems;
}

/** Pinned gitleaks version and SHA-256 from the CI workflow text, or undefined if absent. */
export function parseGitleaksPin(workflowText) {
  const version = /^\s*GITLEAKS_VERSION:\s*([0-9][0-9A-Za-z.\-]*)\s*$/m.exec(workflowText)?.[1];
  const sha256 = /^\s*GITLEAKS_SHA256:\s*([0-9a-f]{64})\s*$/m.exec(workflowText)?.[1];
  return version && sha256 ? { version, sha256 } : undefined;
}

/** True if `gitleaks version` output is exactly the pinned version (optionally with a leading v). */
export function versionMatchesPin(output, pin) {
  return output.trim().replace(/^v/, "") === pin.version;
}

/** The hash recorded in a `sha256sum`-style sidecar file, or undefined. */
export function parseSidecarHash(text) {
  return /^([0-9a-f]{64})\b/.exec(text.trim())?.[1];
}

/** Install steps for the pinned gitleaks, derived from the workflow pin. */
export function gitleaksInstallSteps(pin, dir) {
  const archive = `gitleaks_${pin.version}_linux_x64.tar.gz`;
  return [
    `mkdir -p "${dir}" && cd "${dir}"`,
    `curl -fsSL -o ${archive} https://github.com/gitleaks/gitleaks/releases/download/v${pin.version}/${archive}`,
    `echo "${pin.sha256}  ${archive}" | sha256sum -c -`,
    `tar -xzf ${archive} gitleaks && ./gitleaks version`,
    "sha256sum gitleaks > gitleaks.sha256   # the gate re-checks the binary against this file",
    "(macOS: use the darwin archive and `shasum -a 256 -c -`; take its checksum from the release checksums file.)"
  ];
}

/** Sums the pass and fail counters node:test prints (TAP `# pass N` or spec `ℹ pass N`). */
export function parseTestCounts(output) {
  const grab = (name) => {
    let total = 0;
    for (const m of output.matchAll(new RegExp(`^(?:# |\u2139 )${name} (\\d+)\\s*$`, "gm"))) total += Number(m[1]);
    return total;
  };
  return { pass: grab("pass"), fail: grab("fail") };
}

const oneLine = (text) => (text ?? "").trim().replace(/\s*\n\s*/g, " / ");
// "absent": a step whose tool is not available here (the overlay tests without a tree). Unlike "skip" (GATE_SKIP) it does
// not make the run INCOMPLETE, but the verdict names it.
const MARK = { pass: "PASS", fail: "FAIL", skip: "SKIP", absent: "SKIP" };

/** The overlay tests could not run: a loud skip, or a failure when the builder requires them (PV-X3). */
export function overlayNotRun(reason, required) {
  return required
    ? { status: "fail", detail: `required by AXIS_REQUIRE_OVERLAY_TESTS=1 but did not run: ${reason}` }
    : { status: "absent", detail: reason };
}

/** Fixed-width table: one row per result { name, status, detail }. */
export function formatTable(results) {
  const width = Math.max(...results.map((r) => r.name.length), 4);
  return results
    .map((r) => `${MARK[r.status]}  ${r.name.padEnd(width)}  ${oneLine(r.detail)}`.trimEnd())
    .join("\n");
}

/** Overall verdict: 0 all passed, 1 any failed, 2 nothing failed but something was skipped. */
export function exitCode(results) {
  if (results.some((r) => r.status === "fail")) return 1;
  return results.some((r) => r.status === "skip") ? 2 : 0;
}

/** Ready-to-paste report block. */
export function formatReport({ branch, head, results, packageCounts }) {
  const lines = [
    "```",
    `branch: ${branch}`,
    `head:   ${head}`,
    `node:   ${process.version}`,
    "gates:"
  ];
  for (const r of results) lines.push(`  ${MARK[r.status]}  ${r.name}${r.detail ? ` (${oneLine(r.detail)})` : ""}`);
  if (packageCounts.length > 0) {
    lines.push("tests:");
    for (const p of packageCounts) lines.push(`  ${p.name}: ${p.pass} pass, ${p.fail} fail`);
  }
  const code = exitCode(results);
  const absent = results.some((r) => r.status === "absent");
  const passed = absent ? "PASSED (overlay tests skipped)" : "ALL GATES PASSED";
  lines.push(`verdict: ${code === 0 ? passed : code === 1 ? "FAILED" : "INCOMPLETE (skipped gates)"}`, "```");
  return lines.join("\n");
}

/**
 * The one line a gate run on the wrong Node prints first, or undefined when Node is the pinned one (or no pin is given: the
 * node-version step reports that). `hints` are directories that hold the pinned Node, in order of preference; `unusable` are
 * NODE24_BIN values that name no node binary.
 */
export function wrongNodeLine({ running, pinned, execPath, hints, unusable = [] }) {
  if (typeof pinned !== "string" || running === `v${pinned}`) return undefined;
  const where = hints.length > 0
    ? `put ${hints[0]} first on PATH`
    : "no pinned Node found: set NODE24_BIN to its bin directory or run scripts/code-oss/build.sh --toolchain-only";
  const note = unusable.map((u) => `; NODE24_BIN=${u} holds no node binary`).join("");
  return `gate: wrong Node: running ${running} (${execPath}), expected v${pinned} (pinned in code-oss/upstream.json); ${where}${note}`;
}

/**
 * Where the pinned Node may be, as { hints, unusable }: NODE24_BIN (a directory, or the binary itself, as scripts/code-oss/lib.sh accepts)
 * and the Code OSS tools directory (AXIS_CODE_OSS_TOOLS_DIR when set and not empty, else <root>/.tools), each only when it holds a `node`.
 * `fs` is { exists, isFile }; a file system that throws gives no hints, because the line is advice and must never stop the gate.
 */
export function pinnedNodeHints({ env, root, pinned, platform, arch, fs }) {
  const hints = [];
  const unusable = [];
  try {
    const named = env.NODE24_BIN;
    if (typeof named === "string" && named !== "") {
      const bin = resolve(named); // relative to the working directory, as scripts/code-oss/lib.sh uses it; the advice must print an absolute path
      const dir = fs.exists(bin) && fs.isFile(bin) ? dirname(bin) : bin;
      if (fs.exists(join(dir, "node"))) hints.push(dir);
      else unusable.push(named);
    }
    if (typeof pinned === "string") {
      const dist = `node-v${pinned}-${platform === "darwin" ? "darwin" : "linux"}-${arch === "arm64" ? "arm64" : "x64"}`;
      const tools = resolve(root, env.AXIS_CODE_OSS_TOOLS_DIR || ".tools");
      const dir = join(tools, dist, "bin");
      if (fs.exists(join(dir, "node"))) hints.push(dir);
    }
  } catch {
    return { hints: [], unusable: [] };
  }
  return { hints, unusable };
}

/** True for a parsed summary of the test run: a non-empty list whose every entry is { name, ok, pass, fail } of the right types. */
export function validSummary(counts) {
  const count = (n) => Number.isInteger(n) && n >= 0;
  return Array.isArray(counts) && counts.length > 0
    && counts.every((s) => s !== null && typeof s === "object" && typeof s.name === "string" && s.name !== "" && typeof s.ok === "boolean" && count(s.pass) && count(s.fail));
}
