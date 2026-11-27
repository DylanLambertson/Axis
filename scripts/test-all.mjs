// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the build, every workspace's tests and the root test suites, continuing past
// failures. Exits non-zero if anything failed. `--json <file>` writes the per-suite
// results for scripts/gate.mjs.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killGroup, live, readLimits, runSuite } from "./gate/run-suite.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jsonAt = process.argv[2] === "--json" ? process.argv[3] : undefined;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// One suite at a time, each streamed live, time-limited and output-capped (scripts/gate/run-suite.mjs).
// A suite that dies, hangs, floods or is killed leaves its last lines and its name in the log. On
// SIGTERM, SIGINT or SIGHUP the runner names the running suite, kills its group (SIGTERM, then
// SIGKILL after a grace) and exits.
// Env: AXIS_TEST_SUITE_TIMEOUT_MS (default 20 min per suite), AXIS_TEST_OUTPUT_CAP_BYTES (default 512 MiB).
try {
  readLimits();
} catch (e) {
  process.stderr.write(`test runner: ${e.message}\n`);
  process.exit(2);
}

// `terminating` is set synchronously by a signal, before anything awaits: a killed suite's close
// must never let the loop start the next suite (a cancelled CI job would begin a build).
let terminating = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, async () => {
    terminating = true;
    process.stderr.write(`\n== test runner received ${sig} while running ${live.name}\n`);
    await killGroup(live.child?.pid);
    process.exit(128 + (sig === "SIGTERM" ? 15 : sig === "SIGINT" ? 2 : 1));
  });
}

const never = () => new Promise(() => {});
const run = async (name, command, args) => {
  if (terminating) return never();
  const result = await runSuite(name, command, args, { cwd: root });
  return terminating ? never() : result;
};

// AXIS_TEST_ALL_SUITES_JSON ([[name, command, args], ...]) replaces the list. It exists only for the
// runner's own tests: it needs AXIS_TEST_ALL_SEAM=runner-self-test and is refused when CI is set, so
// it can never turn a CI run green by running nothing.
const override = process.env.AXIS_TEST_ALL_SUITES_JSON;
if (override !== undefined && (process.env.CI !== undefined || process.env.AXIS_TEST_ALL_SEAM !== "runner-self-test")) {
  process.stderr.write("test runner: AXIS_TEST_ALL_SUITES_JSON is a test-only seam; refused (CI is set or AXIS_TEST_ALL_SEAM is missing)\n");
  process.exit(2);
}
const suites = [];
if (override !== undefined) {
  for (const [name, command, args] of JSON.parse(override)) suites.push(await run(name, command, args));
} else {
  suites.push(await run("build", npm, ["run", "build"]));
  const packagesDir = join(root, "packages");
  for (const dir of readdirSync(packagesDir).sort()) {
    const file = join(packagesDir, dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.scripts?.test === undefined) continue;
    suites.push(await run(pkg.name, npm, ["test", "--workspace", pkg.name]));
  }
  suites.push(await run("test/packages", process.execPath, ["--test", "test/packages/*.test.mjs"]));
  // Every test/code-oss suite (about 17 s), so the renderer boundary pins run in the solo gate too, not only in CI's
  // Code OSS scripts job: import rules, the daemon call allow-list, project actions, the overlay test script, staging.
  suites.push(await run("test/code-oss", process.execPath, ["--test", "test/code-oss/*.test.mjs"]));
  suites.push(await run("test/gate", process.execPath, ["--test", "test/gate/*.test.mjs"]));
}

console.log("Test summary");
for (const s of suites) console.log(`  ${s.ok ? "ok    " : "FAILED"} ${s.name}: ${s.pass} pass, ${s.fail} fail`);
if (jsonAt !== undefined) writeFileSync(jsonAt, JSON.stringify(suites));
process.exit(suites.every((s) => s.ok) ? 0 : 1);
