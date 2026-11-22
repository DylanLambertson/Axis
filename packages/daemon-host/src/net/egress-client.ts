// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/*
 * The daemon's egress client (ticket PV-N1d slice B; ADR 0009 decision 4, TB24): the ONE file of the daemon that may load
 * node:https and node:dns (scripts/code-oss/web-rules.mjs EGRESS_CLIENT_FILE, egress-rules.mjs), pinned by its SHA-256
 * like the CLI endpoint template, so any edit fails the import lint until the pin changes in the same reviewed change.
 *
 * - The target is checked first (host.ts): HTTPS to a declared origin in its one spelling.
 * - A dedicated agent's `lookup` resolves the host once per connection, refuses the request if ANY address is not public
 *   unicast (address.ts), and hands the agent only the checked addresses, which are the only ones it connects to
 *   (test/net/agent-pinning.test.ts, Node 24.22.1). SNI and the certificate check use the original host.
 * - `rejectUnauthorized: true` on the agent and the request; no proxy option, so no proxy applies (the entry refuses
 *   NODE_USE_ENV_PROXY and NODE_TLS_REJECT_UNAUTHORIZED); the system trust store only.
 * - No redirect is followed (`redirect_refused`, its `Location` never read); no `Accept-Encoding` is sent and only
 *   `identity` is accepted; the caps of egress-limits.ts; at most 4 requests in flight per integration and the backoff.
 * - Errors are EgressError: a closed code, a fixed text and the status (egress-errors.ts).
 *
 * `createEgressClientForTest` takes a CA, a resolver and a dial map for tests against local servers; nothing in src may
 * name it (test/net/egress-wiring.test.ts), and `createEgressClient` passes no test seam.
 */

import { lookup } from "node:dns";
import { Agent, request } from "node:https";
import { resolvedRefusal } from "./address.js";
import { EgressError, socketError } from "./egress-errors.js";
import { BodyCollector, checkContentEncoding, checkRequestBody, EGRESS_LIMITS, IntegrationGate, parseRetryAfter, requestHeaders } from "./egress-limits.js";
import { declaredOrigins, egressTarget } from "./host.js";

export interface EgressRequest {
  /** The integration (or plugin) the request is for: the key of the in-flight cap and the backoff. */
  readonly integration: string;
  /** The origins this integration declared; the target must be one of them. */
  readonly origins: readonly string[];
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface EgressClient {
  send(req: EgressRequest): Promise<EgressResponse>;
  close(): void;
  /** True when the agent carries no CA of its own (the system trust store only), read from the agent itself. */
  readonly systemTrustOnly: boolean;
}

/** Time for the backoff and the two timeouts; injected so tests need no wait. Production uses the real one. */
export interface EgressClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EgressClientOptions {
  readonly clock?: EgressClock;
}

const REAL_CLOCK: EgressClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Test-only: trust `ca`, resolve with `resolve` and connect a checked address `a` at `dial(a)`. Never set in production. */
export interface EgressTestSeam {
  readonly ca: Buffer;
  readonly resolve: (host: string) => Promise<readonly string[]>;
  readonly dial: (address: string) => string;
}

type LookupEntry = { address: string; family: number };

const systemResolve = (host: string): Promise<readonly string[]> =>
  new Promise((resolve, reject) => lookup(host, { all: true, order: "verbatim" }, (err, list) => (err ? reject(err) : resolve(list.map((a) => a.address)))));

function checkedLookup(resolve: (host: string) => Promise<readonly string[]>, dial: (address: string) => string) {
  // The client never sets a family, so the agent asks for every address (autoSelectFamily) and gets all of them, checked.
  return (hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void): void => {
    resolve(hostname).then(
      (addresses) => {
        if (resolvedRefusal(addresses) !== null) return cb(new EgressError("address_refused")); // none, or any one not public
        const list: LookupEntry[] = addresses.map((a) => ({ address: dial(a), family: a.includes(":") ? 6 : 4 }));
        if (options.all === true) return cb(null, list);
        return cb(null, list[0]!.address, list[0]!.family);
      },
      (err: unknown) => cb(socketError(err)),
    );
  };
}

function build(options: EgressClientOptions, seam: EgressTestSeam | undefined): EgressClient {
  const clock = options.clock ?? REAL_CLOCK;
  const gate = new IntegrationGate(() => clock.now());
  const checked = checkedLookup(seam?.resolve ?? systemResolve, seam?.dial ?? ((a) => a));
  const agent = new Agent({ lookup: checked as never, autoSelectFamily: true, rejectUnauthorized: true, keepAlive: false, ...(seam === undefined ? {} : { ca: seam.ca }) });

  const send = (req: EgressRequest): Promise<EgressResponse> => {
    const target = egressTarget(req.url, declaredOrigins(req.origins));
    if (typeof target === "string") return Promise.reject(new EgressError("target_refused"));
    let headers: Record<string, string>;
    try {
      headers = requestHeaders(req.headers ?? {});
      checkRequestBody(req.body);
    } catch (e) {
      return Promise.reject(e);
    }
    if (req.body !== undefined) headers["content-length"] = String(req.body.byteLength);
    let release: () => void;
    try {
      release = gate.enter(req.integration);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise<EgressResponse>((resolve, reject) => {
      const timers: unknown[] = [];
      let settled = false;
      const finish = (err: EgressError | null, value?: EgressResponse): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clock.clearTimeout(t);
        release();
        if (err === null) resolve(value as EgressResponse);
        else {
          r.destroy();
          reject(err);
        }
      };
      const r = request({
        agent, host: target.host, port: target.port, servername: target.host, method: req.method, path: `${target.url.pathname}${target.url.search}`,
        headers, rejectUnauthorized: true, maxHeaderSize: EGRESS_LIMITS.responseHeaderBytes, insecureHTTPParser: false, signal: req.signal,
      });
      timers.push(clock.setTimeout(() => finish(new EgressError("first_byte_timeout")), EGRESS_LIMITS.firstByteMs));
      timers.push(clock.setTimeout(() => finish(new EgressError("total_timeout")), EGRESS_LIMITS.totalMs));
      r.on("error", (e) => finish(socketError(e)));
      r.on("response", (res) => {
        clock.clearTimeout(timers[0]);
        const status = res.statusCode ?? 0;
        res.on("error", (e) => finish(socketError(e)));
        res.on("aborted", () => finish(new EgressError("connect_failed")));
        if (status >= 300 && status < 400) return finish(new EgressError("redirect_refused", status));
        if (status === 429 || status === 503) {
          const seconds = gate.backOff(req.integration, parseRetryAfter(res.headers["retry-after"]));
          return finish(new EgressError("rate_limited", status, seconds));
        }
        if (status < 200 || status >= 300) return finish(new EgressError("http_status", status));
        try {
          checkContentEncoding(res.headers["content-encoding"]);
        } catch (e) {
          return finish(e as EgressError);
        }
        const body = new BodyCollector();
        res.on("data", (chunk: Buffer) => {
          try {
            body.add(chunk);
          } catch (e) {
            finish(e as EgressError);
          }
        });
        res.on("end", () => {
          if (settled) return;
          gate.succeeded(req.integration);
          finish(null, { status, headers: { ...res.headers }, body: body.body() });
        });
      });
      r.end(req.body === undefined ? undefined : Buffer.from(req.body));
    });
  };
  return { send, close: () => agent.destroy(), systemTrustOnly: (agent.options as { ca?: unknown }).ca === undefined };
}

/** The production client: the system resolver, the system trust store, no test seam. */
export function createEgressClient(options: EgressClientOptions = {}): EgressClient {
  return build(options, undefined);
}

/** Tests only (see the file comment): no file under src may name this. */
export function createEgressClientForTest(options: EgressClientOptions, seam: EgressTestSeam): EgressClient {
  return build(options, seam);
}
