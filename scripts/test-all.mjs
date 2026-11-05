// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs the build, every workspace's tests and the root test suites, continuing past
// failures. Exits non-zero if anything failed. `--json <file>` writes the per-suite
// results for scripts/gate.mjs.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestCounts } from "./gate/lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jsonAt = process.argv[2] === "--json" ? process.argv[3] : undefined;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(name, command, args) {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    shell: false
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(output);
  const counts = parseTestCounts(output);
  const ok = r.status === 0 && r.error === undefined;
  console.log(`\n== ${name}: ${ok ? "ok" : "FAILED"} (${counts.pass} pass, ${counts.fail} fail)\n`);
  return { name, ok, ...counts };
}

const suites = [run("build", npm, ["run", "build"])];
const packagesDir = join(root, "packages");
for (const dir of readdirSync(packagesDir).sort()) {
  const file = join(packagesDir, dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.scripts?.test === undefined) continue;
  suites.push(run(pkg.name, npm, ["test", "--workspace", pkg.name]));
}
suites.push(run("test/packages", process.execPath, ["--test", "test/packages/*.test.mjs"]));
suites.push(run("test/gate", process.execPath, ["--test", "test/gate/*.test.mjs"]));

console.log("Test summary");
for (const s of suites) console.log(`  ${s.ok ? "ok    " : "FAILED"} ${s.name}: ${s.pass} pass, ${s.fail} fail`);
if (jsonAt !== undefined) writeFileSync(jsonAt, JSON.stringify(suites));
process.exit(suites.every((s) => s.ok) ? 0 : 1);
