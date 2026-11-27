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
 * - `rejectUnauthorized: true` and `minVersion: "TLSv1.2"` on the agent (and the request); no proxy option, so no proxy
 *   applies (the entry refuses NODE_USE_ENV_PROXY and NODE_TLS_REJECT_UNAUTHORIZED; a test runs a child with both proxy
 *   variables set); Node's default CA store only.
 * - Every caller-supplied field is checked at RUN TIME before a slot is taken (the method against GET, HEAD and POST);
 *   any throw, before or inside the request, becomes a closed error, and the slot is released on every path.
 * - No redirect is followed (`redirect_refused`, its `Location` never read); no `Accept-Encoding` is sent and only
 *   `identity` is accepted; the caps of egress-limits.ts; at most 4 requests in flight per integration and the backoff.
 * - Errors are EgressError: a closed code, a fixed text and the status (egress-errors.ts).
 *
 * - The client OWNS the `authorization` header (PV-N1e review 2, the PV-N1f requirement): a caller can never set it, for
 *   any host (`header_refused`). It is attached only by `sendAuthorized`, from an `AuthorizedRequest` (url-pattern.ts),
 *   whose credential it TAKES once, to exactly that request's URL, origin, method and body.
 *
 * `createEgressClientForTest` takes a CA, a resolver and a dial map for tests against local servers; nothing in src may
 * name it (test/net/egress-wiring.test.ts), and `createEgressClient` passes no test seam.
 */

import { lookup } from "node:dns";
import { Agent, request } from "node:https";
import { resolvedRefusal } from "./address.js";
import { copyBytes, isBytes } from "./bytes.js";
import { EgressError, socketError } from "./egress-errors.js";
import { BodyCollector, checkContentEncoding, checkRequestBody, EGRESS_LIMITS, IntegrationGate, parseRetryAfter, requestHeaders } from "./egress-limits.js";
import { declaredOrigins, egressTarget, type EgressTarget } from "./host.js";
import { type AuthorizedRequest, takeAuthorization } from "./url-pattern.js";

/** The closed method set, checked at run time. */
export const EGRESS_METHODS = ["GET", "HEAD", "POST"] as const;
export type EgressMethod = (typeof EGRESS_METHODS)[number];

export interface EgressRequest {
  /** The integration (or plugin) the request is for: the key of the in-flight cap and the backoff. */
  readonly integration: string;
  /** The origins this integration declared; the target must be one of them. */
  readonly origins: readonly string[];
  readonly method: EgressMethod;
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
  /** A request with no credential: a caller-set `authorization` header is refused. */
  send(req: EgressRequest): Promise<EgressResponse>;
  /** The one way a credential leaves: an AuthorizedRequest, sent once, to exactly its URL; `headers` may add others, never `authorization`. */
  sendAuthorized(req: AuthorizedRequest, extra?: { readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<EgressResponse>;
  close(): void;
  /** True when the agent carries no CA of its own (Node's default CA store only), read from the agent itself. */
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

/**
 * Test-only: trust `ca`, connect a checked address `a` at `dial(a)`, and resolve with `resolve`, or through the SYSTEM
 * resolver path with `dnsLookup` standing in for the node:dns lookup (so its options are observable). Never set in production.
 */
export interface EgressTestSeam {
  readonly ca: Buffer;
  readonly dial: (address: string) => string;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly dnsLookup?: typeof lookup;
  /** Connect to this port instead of the URL's: an origin carries no port (the contract), so a local test server needs it. */
  readonly port?: number;
}

type LookupEntry = { address: string; family: number };

/** The system resolver path: every address, in the resolver's own order (`verbatim`), never one family first. */
const systemResolver =
  (dnsLookup: typeof lookup) =>
  (host: string): Promise<readonly string[]> =>
    new Promise((resolve, reject) => dnsLookup(host, { all: true, order: "verbatim" }, (err, list) => (err ? reject(err) : resolve(list.map((a) => a.address)))));

function checkedLookup(resolve: (host: string) => Promise<readonly string[]>, dial: (address: string) => string) {
  // The client never sets a family, so the agent asks for every address (autoSelectFamily) and gets all of them, checked.
  return (hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void): void => {
    resolve(hostname).then(
      (addresses) => {
        try {
          if (resolvedRefusal(addresses) !== null) return cb(new EgressError("address_refused")); // none, or any one not public
          const list: LookupEntry[] = addresses.map((a) => ({ address: dial(a), family: a.includes(":") ? 6 : 4 }));
          if (options.all === true) return cb(null, list);
          return cb(null, list[0]!.address, list[0]!.family);
        } catch {
          return cb(new EgressError("connect_failed"));
        }
      },
      (err: unknown) => cb(socketError(err)),
    );
  };
}

/** What is sent: one copy of the caller's request, taken once and checked; nothing reads the caller's object again. */
interface Snapshot {
  readonly integration: string;
  readonly method: EgressMethod;
  readonly target: EgressTarget;
  readonly headers: Record<string, string>;
  readonly body: Buffer | undefined;
  readonly signal: AbortSignal | undefined;
}

/**
 * The request's fields, each READ ONCE into a snapshot and checked at run time whatever the types said (review 2: a
 * getter or a Proxy cannot show one value to the check and send another). The body bytes are COPIED, so a caller
 * changing its array afterwards changes nothing; the client computes Content-Length from the copy. Any problem is a
 * closed error.
 */
function snapshot(req: EgressRequest): Snapshot {
  if (typeof req !== "object" || req === null) throw new EgressError("request_refused");
  const { integration, method, origins, url, headers, body, signal } = req;
  if (typeof integration !== "string" || !/^[\x21-\x7e]{1,128}$/.test(integration)) throw new EgressError("request_refused");
  if (typeof method !== "string" || !(EGRESS_METHODS as readonly string[]).includes(method)) throw new EgressError("method_refused");
  const originList: unknown[] | null = Array.isArray(origins) ? Array.from(origins) : null;
  if (originList === null || originList.some((o) => typeof o !== "string") || typeof url !== "string") throw new EgressError("request_refused");
  if (headers !== undefined && (typeof headers !== "object" || headers === null || ![Object.prototype, null].includes(Object.getPrototypeOf(headers)))) throw new EgressError("header_refused");
  if (body !== undefined && !isBytes(body)) throw new EgressError("request_refused");
  if (body !== undefined && (method === "GET" || method === "HEAD")) throw new EgressError("request_refused");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new EgressError("request_refused");
  const target = egressTarget(url, declaredOrigins(originList as string[]));
  if (typeof target === "string") throw new EgressError("target_refused");
  const bytes = body === undefined ? undefined : copyBytes(body); // no caller code runs: review 3 nit 1
  const copy = bytes === undefined ? undefined : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  checkRequestBody(copy);
  const sent = requestHeaders(headers ?? {});
  if (copy !== undefined) sent["content-length"] = String(copy.byteLength);
  return Object.freeze({ integration, method: method as EgressMethod, target, headers: sent, body: copy, signal });
}

/** Any throw as a closed error: an EgressError as it is, anything else (a Node TypeError echoing input) as `request_refused`. */
const closed = (e: unknown): EgressError => (e instanceof EgressError ? e : new EgressError("request_refused"));

function build(options: EgressClientOptions, seam: EgressTestSeam | undefined): EgressClient {
  const clock = options.clock ?? REAL_CLOCK;
  const gate = new IntegrationGate(() => clock.now());
  const resolver = seam?.resolve ?? systemResolver(seam?.dnsLookup ?? lookup);
  const lookupChecked = checkedLookup(resolver, seam?.dial ?? ((a) => a));
  const agent = new Agent({ lookup: lookupChecked as never, autoSelectFamily: true, rejectUnauthorized: true, minVersion: "TLSv1.2", keepAlive: false, ...(seam === undefined ? {} : { ca: seam.ca }) });

  const send = (req: EgressRequest): Promise<EgressResponse> => run(() => snapshot(req));
  const sendAuthorized = (req: AuthorizedRequest, extra?: { readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<EgressResponse> =>
    run(() => {
      let value: string;
      try {
        value = takeAuthorization(req); // genuine and unspent, or refused; spent from here on
      } catch {
        throw new EgressError("not_authorized");
      }
      const snap = snapshot({ integration: req.integration, origins: [req.origin], method: req.method, url: req.url, ...(req.body === undefined ? {} : { body: req.body }), ...(extra?.headers === undefined ? {} : { headers: extra.headers }), ...(extra?.signal === undefined ? {} : { signal: extra.signal }) });
      if (snap.target.url.href !== req.url || snap.target.origin !== req.origin) throw new EgressError("not_authorized");
      snap.headers.authorization = value;
      return snap;
    });

  function run(make: () => Snapshot): Promise<EgressResponse> {
    let snap: Snapshot;
    let release: () => void;
    try {
      snap = make();
      release = gate.enter(snap.integration);
    } catch (e) {
      return Promise.reject(closed(e));
    }
    return new Promise<EgressResponse>((resolve, reject) => {
      const timers: unknown[] = [];
      let settled = false;
      let r: ReturnType<typeof request> | undefined;
      const finish = (err: EgressError | null, value?: EgressResponse): void => {
        if (settled) return;
        settled = true;
        release(); // first, so nothing below can keep the slot
        try {
          for (const t of timers) clock.clearTimeout(t);
        } catch {
          // a clock that throws cannot keep the slot or turn a closed error into a raw one
        }
        if (err === null) resolve(value as EgressResponse);
        else {
          r?.destroy();
          reject(err);
        }
      };
      try {
        start();
      } catch (e) {
        finish(closed(e));
      }
      function start(): void {
        const sent = request({
          agent, host: snap.target.host, port: seam?.port ?? snap.target.port, servername: snap.target.host, method: snap.method, path: `${snap.target.url.pathname}${snap.target.url.search}`,
          headers: snap.headers, rejectUnauthorized: true, minVersion: "TLSv1.2", maxHeaderSize: EGRESS_LIMITS.responseHeaderBytes, insecureHTTPParser: false, signal: snap.signal,
        });
        r = sent;
        sent.on("error", (e) => finish(socketError(e))); // first: a request destroyed by a later throw must not raise an unhandled error
        timers.push(clock.setTimeout(() => finish(new EgressError("first_byte_timeout")), EGRESS_LIMITS.firstByteMs));
        timers.push(clock.setTimeout(() => finish(new EgressError("total_timeout")), EGRESS_LIMITS.totalMs));
        sent.on("response", (res) => {
          try {
            clock.clearTimeout(timers[0]);
            const status = res.statusCode ?? 0;
            res.on("error", (e) => finish(socketError(e)));
            res.on("aborted", () => finish(new EgressError("connect_failed")));
            if (status >= 300 && status < 400) return finish(new EgressError("redirect_refused", status));
            if (status === 429 || status === 503) {
              const seconds = gate.backOff(snap.integration, parseRetryAfter(res.headers["retry-after"]));
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
              gate.succeeded(snap.integration);
              finish(null, { status, headers: { ...res.headers }, body: body.body() });
            });
          } catch (e) {
            finish(closed(e));
          }
        });
        sent.end(snap.body);
      }
    });
  }
  return { send, sendAuthorized, close: () => agent.destroy(), systemTrustOnly: (agent.options as { ca?: unknown }).ca === undefined };
}

/** The production client: the system resolver, Node's default CA store, no test seam. */
export function createEgressClient(options: EgressClientOptions = {}): EgressClient {
  return build(options, undefined);
}

/** Tests only (see the file comment): no file under src may name this. */
export function createEgressClientForTest(options: EgressClientOptions, seam: EgressTestSeam): EgressClient {
  return build(options, seam);
}
