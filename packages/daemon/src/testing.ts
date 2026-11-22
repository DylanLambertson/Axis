// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { markAttested, parseIdentity } from "./identity.js";
import type { Identity } from "./types.js";

/**
 * Tests only (`@axis/daemon/testing`): an identity marked as attested, as a session would hold it, so a host test can reach the
 * project trust gate without a full connection. No shipped file may import this subpath: test/packages/daemon-testing-rule.mjs
 * refuses it under any `src/`, and scripts/code-oss/stage-scan.mjs keeps it out of every staged tree.
 */
export function attestedIdentityForTests(value: unknown): Identity {
  const identity = parseIdentity(value);
  if (identity === undefined) throw new Error("not an identity");
  return markAttested(Object.freeze({ ...identity }));
}
