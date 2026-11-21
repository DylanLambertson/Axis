// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the build, every workspace's tests and the root test suites, continuing past
// failures. Exits non-zero if anything failed. `--json <file>` writes the per-suite
// results for scripts/gate.mjs.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestCounts } from "./gate/lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jsonAt = process.argv[2] === "--json" ? process.argv[3] : undefined;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// One suite at a time. Output is streamed as it arrives (never held until the suite ends), so a
// suite that dies, hangs or is killed leaves its last lines and its name in the log, and a
// signal is reported by name instead of as a bare exit status.
let running = "(none)";
let current;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    process.stderr.write(`\n== test runner received ${sig} while running ${running}\n`);
    if (current?.pid !== undefined) try { process.kill(-current.pid, "SIGKILL"); } catch { /* already gone */ }
    process.exit(128 + (sig === "SIGTERM" ? 15 : sig === "SIGINT" ? 2 : 1));
  });
}

function run(name, command, args) {
  running = name;
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    current = child;
    const chunks = [];
    let spawnError;
    const take = (out) => (data) => {
      chunks.push(data);
      out.write(data);
    };
    child.stdout.on("data", take(process.stdout));
    child.stderr.on("data", take(process.stderr));
    child.on("error", (e) => { spawnError = e; });
    child.on("close", (status, signal) => {
      const counts = parseTestCounts(Buffer.concat(chunks).toString("utf8"));
      const ok = status === 0 && signal === null && spawnError === undefined;
      const why = signal !== null ? `, killed by ${signal}` : spawnError !== undefined ? `, ${spawnError.message}` : status !== 0 ? `, exit ${status}` : "";
      console.log(`\n== ${name}: ${ok ? "ok" : "FAILED"} (${counts.pass} pass, ${counts.fail} fail${why})\n`);
      resolve({ name, ok, ...counts });
    });
  });
}

const suites = [await run("build", npm, ["run", "build"])];
const packagesDir = join(root, "packages");
for (const dir of readdirSync(packagesDir).sort()) {
  const file = join(packagesDir, dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.scripts?.test === undefined) continue;
  suites.push(await run(pkg.name, npm, ["test", "--workspace", pkg.name]));
}
suites.push(await run("test/packages", process.execPath, ["--test", "test/packages/*.test.mjs"]));
suites.push(await run("test/code-oss/renderer-imports", process.execPath, ["--test", "test/code-oss/renderer-imports.test.mjs"]));
suites.push(await run("test/code-oss/net-gate", process.execPath, ["--test", "test/code-oss/net-gate.test.mjs"]));
suites.push(await run("test/gate", process.execPath, ["--test", "test/gate/*.test.mjs"]));

console.log("Test summary");
for (const s of suites) console.log(`  ${s.ok ? "ok    " : "FAILED"} ${s.name}: ${s.pass} pass, ${s.fail} fail`);
if (jsonAt !== undefined) writeFileSync(jsonAt, JSON.stringify(suites));
process.exit(suites.every((s) => s.ok) ? 0 : 1);
