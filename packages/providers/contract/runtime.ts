// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { recording } from "./recording.js";
import {
  LATE_REQUEST_WINDOW_MS,
  REDIRECT_HOST,
  type ContractFetch,
  type ContractFetchInit,
  type ContractFixture,
  type ContractHarness,
  type ContractScenario,
  type ContractTransport,
  type RecordedRequest,
} from "./types.js";

/** Node's built-in channels that see an outbound HTTP request (Node 24). */
const REQUEST_CHANNELS = ["undici:request:create", "http.client.request.start"] as const;

interface Tracked {
  fixture: ContractFixture | undefined;
  /** The adapter's origin once set up; requests are judged against it. */
  origin: string | undefined;
  ready: boolean;
  readonly requests: RecordedRequest[];
}


/**
 * The suite's per-run state and the suite-owned transport. One is built per
 * `runProviderContractSuite` call; `outputs`, `fixtures` and `savedFetch` are
 * reset or set by the hooks as tests run.
 */
export interface SuiteRuntime {
  readonly harness: ContractHarness;
  readonly needles: string[];
  readonly cancelMs: number;
  readonly live: () => AbortSignal;
  /** Everything the adapters produced in this test, for the leak checks. */
  outputs: unknown[];
  /** This test's fixtures. */
  fixtures: Tracked[];
  savedFetch: typeof globalThis.fetch | undefined;
  readonly bypasses: string[];
  readonly channelHandlers: ReadonlyArray<readonly [string, (message: unknown) => void]>;
  takeViolations(): string[];
  lateWindow(): Promise<void>;
  fixture(t: TestContext, scenario: ContractScenario): Promise<ContractFixture>;
  offOrigin(tr: Tracked): RecordedRequest[];
  trackedOf(f: ContractFixture): Tracked;
}

export function createRuntime(harness: ContractHarness, needles: string[]): SuiteRuntime {
  const cancelMs = harness.cancelWithinMs ?? 2_000;
  const live = (): AbortSignal => new AbortController().signal;
  /** Every fixture of the whole suite, kept so late requests are still judged (SF-1). */
  const everyFixture: Tracked[] = [];
  /** Calls to `globalThis.fetch` during a test, and real requests seen on Node's channels (N-2). */
  const bypasses: string[] = [];
  const onRealRequest = (name: string) => (message: unknown): void => {
    const req = (message as { request?: { origin?: unknown; host?: unknown; path?: unknown } } | undefined)?.request;
    const where = String(req?.origin ?? req?.host ?? "?");
    const path = String(req?.path ?? "").split(/[?#]/)[0] ?? "";
    bypasses.push(`${name}: ${where}${path}`);
  };
  const channelHandlers = REQUEST_CHANNELS.map((name) => [name, onRealRequest(name)] as const);

  /** Requests and bypasses already reported, so each violation fails exactly one check. */
  const reported = new WeakSet<RecordedRequest>();
  let bypassesReported = 0;

  /**
   * Every request, at any time in the suite, that reached the redirect host,
   * left its adapter's origin, or came from an adapter without one; plus every
   * bypass of the transport. Returns those not reported yet and marks them, so
   * a late violation fails the first check that sees it and no other. URLs are
   * reduced to origin and path.
   */
  const takeViolations = (): string[] => {
    const out: string[] = bypasses.slice(bypassesReported).map((u) => `bypassed the transport: ${u}`);
    bypassesReported = bypasses.length;
    for (const tr of everyFixture) {
      if (!tr.ready) continue;
      for (const r of tr.requests) {
        if (reported.has(r)) continue;
        let host = "";
        let originOf = "";
        try {
          const u = new URL(r.url);
          host = u.host;
          originOf = u.origin;
        } catch {
          // An unparsable URL is off-origin.
        }
        const shown = r.url.split(/[?#]/)[0] ?? "";
        if (host === REDIRECT_HOST) out.push(`redirect host: ${shown}`);
        else if (tr.origin === undefined || originOf !== tr.origin) out.push(`off origin: ${shown}`);
        else continue;
        reported.add(r);
      }
    }
    return out;
  };

  const lateWindow = (): Promise<void> => new Promise((r) => setTimeout(r, LATE_REQUEST_WINDOW_MS));

  // Anything still unreported when the process exits fails it: node --test
  // reports a file that exits non-zero as failed (N-4 of the re-check).
  process.once("exit", () => {
    const left = takeViolations();
    if (left.length > 0) {
      process.exitCode = 1;
      process.stderr.write(`contract suite (${harness.name}): requests after the suite ended:\n${left.join("\n")}\n`);
    }
  });

  const credentialIn = (url: string, headers: Record<string, string>, body: string | undefined): Array<"url" | "headers" | "body"> => {
    const has = (text: string): boolean => needles.some((n) => text.includes(n));
    const out: Array<"url" | "headers" | "body"> = [];
    if (has(url)) out.push("url");
    if (has(JSON.stringify(headers))) out.push("headers");
    if (body !== undefined && has(body)) out.push("body");
    return out;
  };

  /** The suite-owned transport for one fixture: records every request, and plays the redirect scenario itself. */
  const transportFor = (scenario: ContractScenario, requests: RecordedRequest[]): ContractTransport => ({
    // Every request is recorded into the fixture's list, which the suite keeps
    // for its whole run, so a request made after the call settled is judged too.
    wrap<I extends ContractFetchInit, R>(inner: ContractFetch<I, R>): ContractFetch<I, R | Response> {
      const fetchFn: ContractFetch<I, R | Response> = async (url, init) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
        const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body).toString("utf8");
        requests.push({
          url,
          method: (init.method ?? "GET").toUpperCase(),
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: init.redirect,
          credentialIn: credentialIn(url, headers, body),
        });
        if (scenario.kind !== "redirect") return inner(url, init);
        const target = new URL(url);
        if (target.host === REDIRECT_HOST) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        const location = `https://${REDIRECT_HOST}${target.pathname}${target.search}`;
        const mode = init.redirect ?? "follow";
        // Real fetch semantics, so an adapter relying on the default is caught too.
        if (mode === "error") throw new TypeError("fetch failed: redirect mode is error");
        if (mode === "follow") return fetchFn(location, init);
        return new Response(null, { status: scenario.status, headers: { location } });
      };
      return fetchFn;
    },
  });

  const fixture = async (t: TestContext, scenario: ContractScenario): Promise<ContractFixture> => {
    void t;
    const requests: RecordedRequest[] = [];
    const tracked: Tracked = { fixture: undefined, origin: undefined, ready: false, requests };
    everyFixture.push(tracked);
    rt.fixtures.push(tracked);
    const f = await harness.setup(scenario, transportFor(scenario, requests));
    assert.ok(f !== undefined, `harness must simulate ${scenario.kind}`);
    const origin = f.adapter.descriptor.destination.origin;
    if (origin === undefined) {
      assert.ok(typeof harness.noNetwork === "string" && harness.noNetwork.length > 0, "an adapter without an origin needs a stated noNetwork reason");
    } else {
      assert.equal(harness.noNetwork, undefined, "an adapter with an origin cannot opt out of the transport checks");
    }
    const wrapped: ContractFixture = {
      ...f,
      adapter: recording(f.adapter, rt.outputs),
      lastRequest: () => f.lastRequest(),
      requestCount: () => f.requestCount(),
      openStreams: () => f.openStreams(),
    };
    tracked.fixture = wrapped;
    tracked.origin = origin;
    tracked.ready = true;
    // The descriptor reaches every log line, so it is checked like an output (R1).
    rt.outputs.push(f.adapter.descriptor);
    return wrapped;
  };

  /** Recorded requests that left the adapter's origin; for an adapter without one, every request. */
  const offOrigin = (tr: Tracked): RecordedRequest[] => {
    const origin = tr.origin;
    return tr.requests.filter((r) => {
      if (origin === undefined) return true;
      try {
        return new URL(r.url).origin !== origin;
      } catch {
        return true;
      }
    });
  };

  const trackedOf = (f: ContractFixture): Tracked => {
    const tr = everyFixture.find((x) => x.fixture === f);
    assert.ok(tr !== undefined);
    return tr;
  };

  const rt: SuiteRuntime = {
    harness,
    needles,
    cancelMs,
    live,
    outputs: [],
    fixtures: [],
    savedFetch: undefined,
    bypasses,
    channelHandlers,
    takeViolations,
    lateWindow,
    fixture,
    offOrigin,
    trackedOf,
  };
  return rt;
}
