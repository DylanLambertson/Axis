// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// G-28 order pin on the BUILT bundle: main.cjs runs the debugging-switch check before any other module of main is initialised.
// The bundle runs under plain Node with a hook that fakes `electron` and records every module load. Mutants it kills: E1 main
// (and the daemon host's modules) imported statically by the entry, so they initialise before the check; E2 the check skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../scripts/bundle.mjs";

const out = mkdtempSync(join(tmpdir(), "axis-desktop-entry-"));
await bundle(out);
test.after(() => rmSync(out, { recursive: true, force: true }));

const hook = join(out, "hook.cjs");
writeFileSync(
  hook,
  `const Module = require("node:module");
const load = Module._load;
const seen = [];
process.on("exit", () => process.stdout.write("LOADED " + JSON.stringify(seen) + "\\n"));
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.endsWith("main.cjs")) seen.push(request);
  if (request === "electron") return { app: { isPackaged: process.env.FAKE_PACKAGED === "1" } };
  return load.apply(this, arguments);
};
`,
);

function run(packaged, args) {
  const script = `process.argv = ${JSON.stringify(["/opt/axis/axis", ...args])}; require(${JSON.stringify(join(out, "main.cjs"))});`;
  const r = spawnSync(process.execPath, ["--require", hook, "-e", script], { env: { PATH: process.env.PATH, FAKE_PACKAGED: packaged ? "1" : "0" }, encoding: "utf8", timeout: 30_000 });
  const line = r.stdout.split("\n").find((l) => l.startsWith("LOADED "));
  return { status: r.status, loaded: line ? JSON.parse(line.slice(7)) : null, stderr: r.stderr };
}

test("a packaged build with a debugging switch exits 64 having loaded nothing but electron", () => {
  const r = run(true, ["--inspect-brk-node=0"]);
  assert.equal(r.status, 64, r.stderr);
  assert.deepEqual(r.loaded, ["electron"], "E1: nothing of main or the daemon host initialised before the check");
  assert.match(r.stderr, /inspect-brk-node/);
});

test("a run that passes the check goes on to load main and its modules", () => {
  const r = run(false, []);
  assert.ok(r.loaded && r.loaded.length > 1 && r.loaded[0] === "electron", `E2: ${JSON.stringify(r.loaded)}`);
  assert.ok(r.loaded.some((m) => m.startsWith("node:")), "main's own modules loaded after the check");
});
