// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { it } from "node:test";
import { isProviderError } from "../src/errors.js";
import type { ProviderAdapter } from "../src/types.js";
import { assertNoLeak, drain, request } from "./helpers.js";
import type { SuiteRuntime } from "./runtime.js";
import { REDIRECT_HOST, REDIRECT_STATUSES } from "./types.js";

export function registerRedirectChecks(rt: SuiteRuntime): void {
  const { harness, needles, live, fixture, takeViolations, trackedOf, offOrigin } = rt;
  for (const status of REDIRECT_STATUSES) {
    for (const call of ["generate", "stream", "listModels", "getCapabilities", "validateConnection", "countTokens"] as const) {
      it(`${call}: a ${status} redirect is not followed, one request per call, all on the origin`, async (t) => {
        const f = await fixture(t, { kind: "redirect", status });
        const tr = trackedOf(f);
        const a = f.adapter;
        if (call === "countTokens" && a.countTokens === undefined) return; // The adapter has no such call path.

        // Run the call; record whether it failed and with what.
        let failed = false;
        let thrown: unknown;
        try {
          if (call === "generate") await a.generate(request(f.model), { signal: live() });
          else if (call === "stream") await drain(a.stream(request(f.model), { signal: live() }));
          else if (call === "listModels") await a.listModels({ signal: live() });
          else if (call === "getCapabilities") await a.getCapabilities(f.model, { signal: live() });
          else if (call === "countTokens") await (a.countTokens as NonNullable<ProviderAdapter["countTokens"]>)(request(f.model), { signal: live() });
          else {
            const r = await a.validateConnection({ signal: live() });
            if (!r.ok) {
              failed = true;
              thrown = r.error;
            }
          }
        } catch (e) {
          failed = true;
          thrown = e;
        }
        if (thrown !== undefined) {
          assert.ok(isProviderError(thrown), "failures are ProviderErrors");
          assertNoLeak(thrown, ...needles);
        }
        // A follow made while the call ran fails here; a later one fails a
        // later check or the suite's final one (SF-1).
        assert.deepEqual(takeViolations(), [], "a request reached the redirect host, left the origin or bypassed the transport");

        const origin = a.descriptor.destination.origin;
        if (origin === undefined) {
          assert.equal(tr.requests.length, 0, `no network (${harness.noNetwork ?? ""}): the transport saw no request`);
          return;
        }
        const sent = tr.requests;
        // Capabilities may be known locally; every other path is a network call.
        if (call === "getCapabilities" && sent.length === 0) return;
        assert.equal(sent.length, 1, `exactly one outbound request per call (saw ${sent.length})`);
        assert.ok(failed, "a redirected call fails; the error code is the adapter's own");
        assert.equal(sent.filter((r) => new URL(r.url).host === REDIRECT_HOST).length, 0, "no request reached the redirect host");
        for (const r of offOrigin(tr)) assert.deepEqual(r.credentialIn, [], "the credential left the adapter's origin");
        assert.equal(offOrigin(tr).length, 0, "every request went to the declared destination");
      });
    }
  }

  for (const status of REDIRECT_STATUSES) {
    it(`generate twice: a ${status} redirect is not followed on a later call either`, async (t) => {
      const f = await fixture(t, { kind: "redirect", status });
      const tr = trackedOf(f);
      for (let i = 0; i < 2; i++) await f.adapter.generate(request(f.model), { signal: live() }).catch(() => undefined);
      assert.deepEqual(takeViolations(), [], "a request reached the redirect host, left the origin or bypassed the transport");
      // At most one request per call, so at most two; none without an origin (N-1).
      const max = f.adapter.descriptor.destination.origin === undefined ? 0 : 2;
      assert.ok(tr.requests.length <= max, `at most ${max} requests for two calls (saw ${tr.requests.length})`);
    });
  }
}
