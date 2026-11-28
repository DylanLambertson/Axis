// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-N0c-1 (docs/design/secret-broker.md §3.4, §3.5): the daemon host's broker messages and its secret backend restate the
// vault's entry-name rule, because only the two bindings may import `@axis/vault` (vault-importers-rule.mjs). The backend's
// tolerant startup list drops each name that rule refuses, so the copy must be the vault's rule exactly. Checked over the
// BUILT packages (`npm test` builds first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_RE } from "@axis/vault";

const messages = await import(new URL("../../packages/daemon-host/dist/src/control/secrets-messages.js", import.meta.url).href);

test("the broker's secret name rule is the vault's NAME_RE, flags included", () => {
  assert.equal(messages.SECRET_NAME_RE.source, NAME_RE.source);
  assert.equal(messages.SECRET_NAME_RE.flags, NAME_RE.flags);
  for (const name of ["c1", "integration:github", "a.b-c_d", "x".repeat(64)]) assert.equal(messages.SECRET_NAME_RE.test(name), NAME_RE.test(name), name);
  for (const name of ["C1", "x:y", "integration:", "-a", "x".repeat(65), "a b"]) assert.equal(messages.SECRET_NAME_RE.test(name), false, name);
});
