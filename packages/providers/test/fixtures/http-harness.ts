// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A fake HTTP adapter: the mock behind a real fetch-shaped call on an https
// origin, built with the suite's transport (`transport.wrap`), so the suite
// records every request itself. contract-suite.test.ts runs it in a child
// process. FOLLOW selects the behaviour on a 3xx:
//   0       redirect: "manual", and a 3xx fails the call. Must pass the suite.
//   1       leaves redirect unset (fetch's default, follow). Must fail.
//   manual  redirect: "manual", then re-requests the Location itself. Must fail.
//   fail    as manual, then reports invalid_response anyway. Must fail.
//   retry   redirect: "manual", and retries the same URL once. Must fail
//           (more than one request per call).
//   late    fails the call at once, then follows the Location 50 ms later
//           through the wrapped fetch. Must fail (SF-1).
//   second  refuses the first redirect, follows from its second request on.
//           Must fail (N-1).
//   global  follows the Location with globalThis.fetch instead of the
//           transport. Must fail (N-2).
//   bypass  never uses the transport; every request goes to globalThis.fetch.
//           Must fail (N-2).
//   verylate  as late, but 4 s later: after the suite's final late window.
//           Must fail the file through the process exit scan.
//   captured  follows with a fetch reference captured at module load, which
//           the globalThis.fetch trap cannot see. Must fail through Node's
//           request diagnostics channel.
//   https   follows with node:https directly. Must fail likewise.
// The captured and https variants aim at an unused local port (connection
// refused at once), standing in for the Location host, so no test leaves the
// machine.
// Not named *.test.ts, so `npm test` does not run it directly.
import { request as httpsRequest } from "node:https";
import { runProviderContractSuite, type ContractFetch, type ContractScenario } from "../../contract/index.js";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  createMockProvider,
  validateRequest,
  type GenerateRequest,
  type MockReply,
  type ProviderAdapter,
} from "../../src/index.js";

const ORIGIN = "https://api.provider.test";
const CANARY = "http-canary-body-text";
// Low-entropy stand-in for an API key.
const CREDENTIAL = "http-credential-stand-in";
const MODE = process.env["FOLLOW"] ?? "0";
// Captured before the suite installs its globalThis.fetch trap.
const capturedFetch = globalThis.fetch;
const LOCAL_SINK = "127.0.0.1:59999";

function reply(s: ContractScenario): MockReply {
  switch (s.kind) {
    case "text":
      return { kind: "text", text: s.text };
    case "max_tokens":
      return { kind: "text", text: s.text, stopReason: "max_tokens" };
    case "tool_use":
      return { kind: "tool_use", name: s.name, input: s.input };
    case "error":
      return { kind: "error", code: s.code, ...(s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs }) };
    case "mid_stream_error":
      return { kind: "error", code: "overloaded", afterText: s.text };
    case "hang":
      return { kind: "hang" };
    case "malformed":
      return { kind: "malformed" };
    case "redirect":
      // Only reached by an adapter that followed: the redirect host answered 200.
      return { kind: "text", text: "answered after a redirect" };
  }
}

/** The harness's own fake server: every request succeeds; content comes from the mock. */
const server: ContractFetch = async (_url, _init) => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

runProviderContractSuite({
  name: `http (FOLLOW=${MODE})`,
  canary: CANARY,
  credential: CREDENTIAL,
  setup(scenario, transport) {
    const mock = createMockProvider({
      replies: [reply(scenario)],
      ...(scenario.kind === "error" && scenario.code === "authentication" ? { connectionError: "authentication" as const } : {}),
    });
    const wrapped = transport.wrap(server);
    const fetch = (url: string, init: Parameters<typeof wrapped>[1]): Promise<Response> =>
      MODE === "bypass" ? globalThis.fetch(url, init as RequestInit) : wrapped(url, init);
    let sends = 0;

    /** One request to the origin; a 3xx is handled according to MODE. */
    const send = async (path: string, signal: AbortSignal, body?: unknown): Promise<void> => {
      const init = {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-api-key": CREDENTIAL, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(MODE === "1" ? {} : { redirect: "manual" as const }),
        signal,
      };
      sends += 1;
      const res = await fetch(`${ORIGIN}${path}`, init);
      if (res.status < 300 || res.status > 399) return;
      const location = res.headers.get("location") ?? "";
      const refuse = (): ProviderError => new ProviderError("invalid_response", { status: res.status, reason: "redirect" });
      if (MODE === "late" || MODE === "verylate") {
        // The defect under test: the call fails now, the key follows later.
        setTimeout(() => void wrapped(`${location}?key=${CREDENTIAL}`, init).catch(() => undefined), MODE === "late" ? 50 : 4_000);
        throw refuse();
      }
      if (MODE === "second") {
        if (sends < 2) throw refuse();
        await fetch(location, init);
        return;
      }
      if (MODE === "captured") {
        await capturedFetch(`http://${LOCAL_SINK}/follow`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
        throw refuse();
      }
      if (MODE === "https") {
        await new Promise<void>((resolve) => {
          const q = httpsRequest(`https://${LOCAL_SINK}/follow`, { timeout: 2_000 }, (r) => {
            r.resume();
            resolve();
          });
          q.on("error", () => resolve());
          q.on("timeout", () => q.destroy());
          q.end();
        });
        throw refuse();
      }
      if (MODE === "global") {
        await globalThis.fetch(location, init as RequestInit).catch(() => undefined);
        throw refuse();
      }
      if (MODE === "retry") {
        await fetch(`${ORIGIN}${path}`, init);
        throw new ProviderError("invalid_response", { status: res.status, reason: "redirect" });
      }
      if (MODE === "manual" || MODE === "fail") {
        // The defect under test: the request, key included, goes to the Location host.
        await fetch(location, init);
        if (MODE === "fail") throw new ProviderError("invalid_response", { status: res.status, reason: "redirect" });
        return;
      }
      throw new ProviderError("invalid_response", { status: res.status, reason: "redirect" });
    };
    /** Validate and honour the signal before anything reaches the transport. */
    const before = (r: GenerateRequest, signal: AbortSignal) => {
      if (signal.aborted) throw new ProviderError("cancelled");
      return validateRequest(r);
    };

    const adapter: ProviderAdapter = {
      descriptor: Object.freeze({ ...mock.descriptor, destination: Object.freeze({ origin: ORIGIN, description: "Fake HTTP provider" }) }),
      listModels: async (o) => {
        await send("/v1/models", o.signal);
        return mock.listModels(o);
      },
      // Capabilities come from a local table: no request.
      getCapabilities: (m, o) => mock.getCapabilities(m, o),
      validateConnection: async (o) => {
        try {
          await send("/v1/models", o.signal);
        } catch (e) {
          if (e instanceof ProviderError) return { ok: false, error: e };
          throw e;
        }
        return mock.validateConnection(o);
      },
      generate: async (r, o) => {
        await send("/v1/messages", o.signal, before(r, o.signal));
        return mock.generate(r, o);
      },
      stream: (r, o) => ({
        async *[Symbol.asyncIterator]() {
          await send("/v1/messages", o.signal, before(r, o.signal));
          yield* mock.stream(r, o);
        },
      }),
      countTokens: async (r, o) => {
        await send("/v1/messages/count_tokens", o.signal, before(r, o.signal));
        return (mock.countTokens as NonNullable<ProviderAdapter["countTokens"]>)(r, o);
      },
      estimateCost: (m, u) => mock.estimateCost?.(m, u),
    };
    return {
      adapter,
      model: MOCK_DEFAULT_MODEL,
      requestCount: () => mock.requests.length,
      openStreams: () => mock.openStreams,
      lastRequest: () => {
        const r = mock.requests.at(-1);
        if (r === undefined) return undefined;
        return {
          model: r.model,
          maxOutputTokens: r.maxOutputTokens,
          ...(r.system === undefined ? {} : { system: r.system }),
          ...(r.stopSequences === undefined ? {} : { stopSequences: r.stopSequences }),
        };
      },
    };
  },
});
