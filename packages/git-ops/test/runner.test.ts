// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeRunner } from "../src/index.js";
import { fixture } from "./realFixture.js";

test("RR-N4: the node runner reports truncated when stdout passes its limit, and not otherwise", async () => {
  const f = fixture();
  const req = { argv: ["var", "-l"], cwd: f.wt.workTree, env: { PATH: process.env["PATH"] ?? "", HOME: f.home }, context: "pty" as const };
  const small = await createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true, maxOutput: 40 }).run(req);
  assert.equal(small.truncated, true);
  assert.equal(small.stdout.length, 40);
  const big = await createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run(req);
  assert.equal(big.truncated, undefined);
  assert.ok(big.stdout.length > 40);
});

test("RR-N5: a normal daemon exit kills git's live process groups (a crash cannot; that is documented)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = fixture();
  const pidFile = join(f.root, "pid");
  const runnerUrl = new URL("../src/nodeRunner.js", import.meta.url).href;
  // The runner refuses `-c alias.*`, so the alias lives in the user-level config under HOME.
  const alias = `!sh -c 'echo $$ > "${pidFile}"; exec sleep 60' & wait`;
  writeFileSync(join(f.home, ".gitconfig"), `[alias]\n\tslow = "${alias.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`);
  const script = `
    import { createNodeRunner } from ${JSON.stringify(runnerUrl)};
    import { existsSync } from "node:fs";
    createNodeRunner({ allowPtyContext: true, allowUnpinnedGit: true }).run({
      argv: ["slow"],
      cwd: ${JSON.stringify(f.root)}, env: { PATH: process.env.PATH, HOME: ${JSON.stringify(f.home)} }, context: "pty",
    });
    const t = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); setTimeout(() => process.exit(0), 100); } }, 20);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 20_000, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), "the grandchild did not outlive the daemon's exit");
});
