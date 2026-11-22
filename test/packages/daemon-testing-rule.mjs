// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// `@axis/daemon/testing` marks an identity as attested (ticket PV-K1c review 1), so a shipped file that imported it could mint an
// identity the project trust gate accepts. Only tests and test support may import it: anything under a package's `src/` is
// refused. Used by imports.test.mjs; mirrors the RESTRICTED_MODULES row for daemon/testing.ts in scripts/code-oss/stage-scan.mjs.

export const DAEMON_TESTING = "@axis/daemon/testing";

/** A refusal when shipped code (`inSrc`) imports the test-only subpath; otherwise null. */
export function daemonTestingVerdict(spec, inSrc) {
  if (spec !== DAEMON_TESTING && !spec.startsWith(`${DAEMON_TESTING}/`)) return null;
  return inSrc ? "only tests and test support may import @axis/daemon/testing (it marks identities as attested)" : null;
}
