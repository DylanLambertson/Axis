// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDENTIAL_BACKENDS, CREDENTIAL_PROTECTIONS } from "@axis/protocol";
import { BACKEND_IDS, PROTECTIONS } from "../src/index.js";

// PRV-1 (ticket C6): the provider list shows the vault's backend and protection through closed protocol enums, so the two
// lists must be the same; a backend added here without the contract would make every listing of it `unavailable`.
test("the protocol's credential backends and protections are the vault's", () => {
  assert.deepEqual([...CREDENTIAL_BACKENDS].sort(), [...BACKEND_IDS].sort());
  assert.deepEqual([...CREDENTIAL_PROTECTIONS].sort(), [...PROTECTIONS].sort());
});
