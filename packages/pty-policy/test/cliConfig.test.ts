// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLI_PROJECT_CONFIG } from "../src/index.js";

test("the CLI project-configuration list: frozen, every row names its source, lower-case root-anchored segments, warn in slice 1", () => {
  assert.ok(Object.isFrozen(CLI_PROJECT_CONFIG));
  assert.deepEqual(CLI_PROJECT_CONFIG.map((r) => `${r.cli}:${r.segments.join("/")}`), [
    "claude:.claude/settings.json",
    "claude:.claude/settings.local.json",
    "claude:.claude/hooks",
    "codex:.codex/config.toml",
    "codex:.codex/hooks",
  ]);
  for (const r of CLI_PROJECT_CONFIG) {
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.segments), r.segments.join("/"));
    assert.ok(r.source.length > 20, `${r.segments.join("/")} names where it was verified`);
    assert.ok(r.segments.every((s) => s === s.toLowerCase() && s.length > 0 && !s.includes("/")));
    assert.equal(r.severity, "warn");
  }
});
