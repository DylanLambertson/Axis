// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a: the lint entry for exec-node.ts says what the file enforces. The text is pinned here, so the documentation of the
// program set (scripts/code-oss/egress-rules.mjs SPAWN_FILES) cannot drift from the check in the file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "code-oss", "egress-rules.mjs");

test("the SPAWN_FILES entry for exec-node.ts names spawn, a program by value, and the exact runs text", () => {
  const text = readFileSync(RULES, "utf8");
  const line = text.split("\n").find((l) => l.includes('"pty-process/exec-node.ts"'));
  assert.equal(
    line?.trim(),
    '["pty-process/exec-node.ts", { names: new Set(["spawn"]), program: null, runs: "git or gh: exactly the configured gitPath or ghPath, checked in this file before the call" }],',
  );
});
