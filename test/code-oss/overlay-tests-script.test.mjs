// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X3: scripts/code-oss/overlay-tests.sh refuses (exit 3, "no usable tree") before touching anything when there is no
// installed vendor tree, so the gate can report a skip; it never applies into a directory it did not find a tree in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/code-oss/overlay-tests.sh", import.meta.url));
const run = (env) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "AXIS_CODE_OSS_VENDOR_DIR"));
  return spawnSync("bash", [script], { encoding: "utf8", env: { ...clean, ...env } });
};

test("no vendor directory: exit 3 with the reason", { skip: process.platform === "win32" }, () => {
  const r = run({});
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /no vendor directory/);
});

test("a vendor directory without an installed tree: exit 3, and nothing is written into it", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-x3-"));
  try {
    mkdirSync(join(dir, "code-oss"));
    const r = run({ AXIS_CODE_OSS_VENDOR_DIR: dir });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /has no installed tree/);
    assert.deepEqual(readdirSync(dir), ["code-oss"], "no apply ran: no log, no stamp (mutant: apply before the check)");
    assert.equal(existsSync(join(dir, "code-oss.applied")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("apply.sh is handed the pinned Node through NODE24_BIN before it runs (its hooks do not read PATH; a gate run has no env.sh)", () => {
  const text = readFileSync(script, "utf8");
  const exported = text.indexOf("export NODE24_BIN");
  const apply = text.indexOf('"$here/apply.sh" --force');
  assert.ok(exported > 0 && apply > 0, "both present");
  assert.ok(exported < apply, "NODE24_BIN is exported before the apply (mutant: after, or not at all)");
  assert.match(text, /if \[ -z "\$\{NODE24_BIN:-\}" \]; then\n\tNODE24_BIN="\$\(dirname "\$\(command -v node\)"\)"/, "only when unset, from the node the script already checked");
});
