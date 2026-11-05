// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
/**
 * The provider adapter contract suite (`@axis/providers/contract`).
 *
 * Every adapter runs this suite against a harness that scripts its "wire":
 * the mock provider scripts replies directly; an HTTP adapter (ticket 9)
 * injects a fake transport that serves recorded responses and counts
 * requests. The suite needs no network.
 *
 * This entry point imports `node:test` and is test support only. It lives
 * outside `src/` so the ADR 0005 D3 staging hook, which copies
 * `packages/<name>/src/**`, never stages it into the Code OSS tree (N9).
 *
 * The suite is split by theme: `types.ts` (the harness-facing types and
 * constants), `needles.ts` (leak needles), `recording.ts` and `helpers.ts`
 * (shared test support), `runtime.ts` (the suite-owned transport, request
 * recording and bypass detection), and the `checks-*.ts` files (the hooks and
 * the checks, registered in this order).
 */
import { describe } from "node:test";
import { registerCoreChecks } from "./checks-core.js";
import { registerHooks } from "./checks-hooks.js";
import { registerLifecycleChecks } from "./checks-lifecycle.js";
import { registerRedirectChecks } from "./checks-redirect.js";
import { MIN_CANARY_LENGTH, MIN_CREDENTIAL_LENGTH, needlesFor } from "./needles.js";
import { createRuntime } from "./runtime.js";
import type { ContractHarness } from "./types.js";

export {
  CONTRACT_ERROR_CODES,
  LATE_REQUEST_WINDOW_MS,
  REDIRECT_HOST,
  REDIRECT_STATUSES,
  type ContractErrorCode,
  type ContractFetch,
  type ContractFetchInit,
  type ContractFixture,
  type ContractHarness,
  type ContractScenario,
  type ContractTransport,
  type ForwardedRequest,
  type RecordedRequest,
  type RedirectStatus,
} from "./types.js";
export { CREDENTIAL_WINDOW, MIN_CANARY_LENGTH, MIN_CREDENTIAL_LENGTH, needlesFor } from "./needles.js";

/** Register the contract suite with `node:test` for one harness. */
export function runProviderContractSuite(harness: ContractHarness): void {
  // Refuse a harness whose leak checks would be weak or vacuous (R4).
  if (typeof harness.credential !== "string" || harness.credential.length < MIN_CREDENTIAL_LENGTH) {
    throw new RangeError(`the contract harness credential must be at least ${MIN_CREDENTIAL_LENGTH} characters`);
  }
  if (typeof harness.canary !== "string" || harness.canary.length < MIN_CANARY_LENGTH) {
    throw new RangeError(`the contract harness canary must be at least ${MIN_CANARY_LENGTH} characters`);
  }
  const rt = createRuntime(harness, needlesFor(harness.canary, harness.credential));
  describe(`provider contract: ${harness.name}`, () => {
    registerHooks(rt);
    registerCoreChecks(rt);
    registerRedirectChecks(rt);
    registerLifecycleChecks(rt);
  });
}
