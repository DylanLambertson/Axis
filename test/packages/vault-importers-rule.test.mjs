// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESTRICTED_MODULES } from "../../scripts/code-oss/stage-scan.mjs";
import { VAULT_RULES, vaultVerdict } from "./vault-importers-rule.mjs";

const OTHER_HOST_FILES = ["src/bindings/agent.ts", "src/bindings/integrations-helper.ts", "src/compose.ts", "src/handlers/providers.ts", "src/host.ts", "src/secrets-backend.ts", "src/main/answers.ts", "test/providers-anthropic.test.ts", "test/types/x.ts", "testing/rig.ts"];

test("vault: only the providers and integrations bindings import @axis/vault (ADR 0009 decision 5, PV-N1c)", () => {
  assert.equal(vaultVerdict("@axis/vault", "src/bindings/providers.ts"), "ok");
  assert.equal(vaultVerdict("@axis/vault", "src/bindings/integrations.ts"), "ok");
  for (const f of OTHER_HOST_FILES) assert.notEqual(vaultVerdict("@axis/vault", f), "ok", f);
  assert.match(vaultVerdict("@axis/vault/src/vault.js", "src/host.ts") ?? "", /^only /, "a subpath is the package, refused elsewhere");
  assert.equal(vaultVerdict("@axis/vault/src/vault.js", "src/bindings/integrations.ts"), "ok", "and allowed where the package is");
  assert.notEqual(vaultVerdict("@axis/vault", null), "ok", "no file: refused");
});

test("adapter: only the providers binding imports @axis/anthropic, never the integrations binding", () => {
  assert.equal(vaultVerdict("@axis/anthropic", "src/bindings/providers.ts"), "ok");
  assert.notEqual(vaultVerdict("@axis/anthropic", "src/bindings/integrations.ts"), "ok");
  for (const f of OTHER_HOST_FILES) assert.notEqual(vaultVerdict("@axis/anthropic", f), "ok", f);
});

test("other specifiers are not this rule's", () => {
  for (const spec of ["@axis/vaults", "@axis/anthropic-x", "@axis/runs", "node:fs", "vault"]) assert.equal(vaultVerdict(spec, "src/host.ts"), null, spec);
});

test("the staged-tree scan mirrors the rule exactly, and nothing broader", () => {
  const entry = (pkg) => RESTRICTED_MODULES.filter((m) => m.pkg === pkg && m.file === "index.ts");
  for (const [spec, files] of VAULT_RULES) {
    const pkg = spec.slice("@axis/".length);
    const rows = entry(pkg);
    assert.equal(rows.length, 1, `${pkg}: one row`);
    assert.equal(rows[0].importers.size, 0, `${pkg}: no package may import it whole`);
    assert.deepEqual([...rows[0].files].sort(), files.map((f) => `daemon-host/${f.replace(/^src\//, "")}`).sort(), `${pkg}: the same files`);
  }
});
