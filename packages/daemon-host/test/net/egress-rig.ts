// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressClientForTest, type EgressClient, type EgressClock, type EgressRequest } from "../../src/net/egress-client.js";
import { EgressError } from "../../src/net/egress-errors.js";
import { opensslMissing } from "./openssl.js";

// The PV-N1d client tests' rig: a local HTTPS server with a test certificate, and clients whose test seam resolves the
// declared host to a PUBLIC address (so the address rule runs on what the resolver said) and dials it at 127.0.0.1.

export const HOST = "api.example.test";
export const CANARY = "CANARY7f3a";
export const PUBLIC = "93.184.215.14";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
export interface Rig {
  port: number;
  origin: string;
  hits: Array<{ method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string; servername: string | undefined }>;
  handle: (h: Handler) => void;
  client: (opts?: { clock?: EgressClock; resolve?: (h: string) => Promise<readonly string[]>; ca?: Buffer }) => EgressClient;
  req: (over?: Partial<EgressRequest>) => EgressRequest;
  otherCa: Buffer;
  keyFile: string;
  certFile: string;
}

export async function rig(t: import("node:test").TestContext): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "axis-egress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cert = (name: string, cn: string): Buffer => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.pem`), "-days", "1", "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn}`], { stdio: "ignore" });
    return readFileSync(join(dir, `${name}.pem`));
  };
  const ca = cert("a", HOST);
  const otherCa = cert("b", HOST);
  let handler: Handler = (_q, s) => s.end("{}");
  const hits: Rig["hits"] = [];
  const server = https.createServer({ key: readFileSync(join(dir, "a.key")), cert: ca, maxHeaderSize: 65_536 }, (q, s) => {
    let body = "";
    q.on("data", (c: Buffer) => (body += c.toString()));
    q.on("end", () => {
      hits.push({ method: q.method, url: q.url, headers: q.headers, body, servername: (q.socket as { servername?: string }).servername });
      handler(q, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const clients: EgressClient[] = [];
  t.after(() => {
    for (const c of clients) c.close();
    server.closeAllConnections();
    server.close();
  });
  const origin = `https://${HOST}:${port}`;
  return {
    port, origin, hits, otherCa, keyFile: join(dir, "a.key"), certFile: join(dir, "a.pem"),
    handle: (h) => (handler = h),
    client: (opts = {}) => {
      const c = createEgressClientForTest(opts.clock === undefined ? {} : { clock: opts.clock }, { ca: opts.ca ?? ca, resolve: opts.resolve ?? (async () => [PUBLIC]), dial: (a) => (a === PUBLIC ? "127.0.0.1" : a) });
      clients.push(c);
      return c;
    },
    req: (over = {}) => ({ integration: "gh", origins: [origin], method: "GET", url: `${origin}/v1/items?q=1`, ...over }),
  };
}

/** A clock whose time and timers move only when the test says. */
export function fakeClock(start = 5_000_000): EgressClock & { advance(ms: number): void; pending(): number[] } {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimeout: (fn, ms) => (timers.set(next, { at: now + ms, fn }), next++),
    clearTimeout: (h) => void timers.delete(h as number),
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) (timers.delete(id), t.fn());
    },
  };
}

export const failure = async (p: Promise<unknown>): Promise<EgressError> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof EgressError, `not an EgressError: ${String(e)}`);
    const text = `${e.message} ${String(e.stack)} ${JSON.stringify(e)}`;
    assert.ok(!text.includes(CANARY) && !text.includes(HOST) && !text.includes("/v1/"), `error text leaks request or response data: ${text}`);
    return e;
  }
  assert.fail("expected the request to fail");
};

export const skip = opensslMissing();
