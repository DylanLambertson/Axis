// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A gate run on the wrong Node says so in one line at the top (scripts/gate/lib.mjs wrongNodeLine, scripts/gate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrongNodeLine } from "../../scripts/gate/lib.mjs";

const gate = fileURLToPath(new URL("../../scripts/gate.mjs", import.meta.url));
const ciYml = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

test("wrongNodeLine: nothing when the running Node is the pinned one", () => {
  assert.equal(wrongNodeLine({ running: "v24.22.1", pinned: "24.22.1", execPath: "/n/node", hints: [] }), undefined);
});

test("wrongNodeLine: one line with the expected and actual version, the running binary and the pinned path", () => {
  const line = wrongNodeLine({ running: "v26.13.0", pinned: "24.22.1", execPath: "/usr/bin/node", hints: ["/opt/node24/bin"] });
  assert.ok(typeof line === "string" && !line.includes("\n"), "one line");
  assert.match(line, /^gate: wrong Node: running v26\.13\.0 \(\/usr\/bin\/node\), expected v24\.22\.1/);
  assert.match(line, /code-oss\/upstream\.json/);
  assert.match(line, /put \/opt\/node24\/bin first on PATH/);
});

test("wrongNodeLine: with no pinned Node found it says how to get one, and a missing pin is not a mismatch", () => {
  const line = wrongNodeLine({ running: "v26.13.0", pinned: "24.22.1", execPath: "/usr/bin/node", hints: [] });
  assert.match(line, /no pinned Node found/);
  assert.match(line, /NODE24_BIN/);
  assert.equal(wrongNodeLine({ running: "v26.13.0", pinned: undefined, execPath: "/usr/bin/node", hints: [] }), undefined, "the node-version step reports a missing pin");
});

test("gate: on the wrong Node the first line of output is the wrong-Node line; a skipped node-version step prints none", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-gate-wrongnode-"));
  try {
    const run = (args, cwd, env = {}) => spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GATE_") && !k.startsWith("GIT_"))), ...env } });
    run(["git", "init", "-q", "-b", "main"], dir);
    mkdirSync(join(dir, "code-oss"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    copyFileSync(ciYml, join(dir, ".github", "workflows", "ci.yml"));
    writeFileSync(join(dir, "code-oss", "upstream.json"), JSON.stringify({ node: "1.0.0" }));
    writeFileSync(join(dir, "README.md"), "x\n");
    for (const a of [["config", "user.name", "T"], ["config", "user.email", "t@example.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-q", "-m", "chore: base"], ["update-ref", "refs/remotes/origin/main", "HEAD"]]) run(["git", ...a], dir);
    const skip = "gitleaks,typecheck,test,diff-check,line-limit,wording";
    const r = run([process.execPath, gate], dir, { GATE_SKIP: skip });
    const out = `${r.stdout}${r.stderr}`;
    const first = r.stdout.split("\n")[0];
    assert.match(first, /^gate: wrong Node: running v\S+ \(.+\), expected v1\.0\.0/, out);
    const none = run([process.execPath, gate], dir, { GATE_SKIP: `${skip},node-version` });
    assert.doesNotMatch(`${none.stdout}${none.stderr}`, /wrong Node/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
