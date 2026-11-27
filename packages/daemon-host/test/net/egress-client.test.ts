// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEgressClient, createEgressClientForTest, type EgressClient } from "../../src/net/egress-client.js";
import { CANARY, failure, fakeClock, HOST, PUBLIC, rig, skip } from "./egress-rig.js";

// PV-N1d slice B: the egress client against a local HTTPS server. The test seam resolves the declared host to a PUBLIC
// address (so the address rule runs on what the resolver said) and dials that checked address at 127.0.0.1.

test("a GET goes to the checked address with SNI on the original host, no Accept-Encoding, the parsed path; the body comes back whole", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
  const res = await r.client().send(r.req({ url: `${r.origin}/v1/a/%2e%2e/items?q=1`, headers: { Authorization: `Bearer ${CANARY}` } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"ok":true}');
  const hit = r.hits[0]!;
  assert.equal(hit.url, "/v1/items?q=1", "the path sent is the parsed target's (%2e%2e resolved), never the raw input");
  assert.equal(hit.servername, HOST);
  assert.equal(hit.headers.host, `${HOST}:${r.port}`);
  assert.equal(hit.headers["accept-encoding"], undefined, "no Accept-Encoding is sent");
  assert.equal(hit.headers.authorization, `Bearer ${CANARY}`);
});

test("a POST sends its body with the computed length; exactly 1 MiB is sent, one byte more is refused before anything leaves", { skip }, async (t) => {
  const r = await rig(t);
  let resolved = 0;
  const c = r.client({ resolve: async () => (resolved++, [PUBLIC]) });
  await c.send(r.req({ method: "POST", body: new Uint8Array(1_048_576).fill(0x61) }));
  assert.equal(r.hits[0]!.headers["content-length"], "1048576");
  assert.equal(r.hits[0]!.body.length, 1_048_576);
  assert.equal((await failure(c.send(r.req({ method: "POST", body: new Uint8Array(1_048_577) })))).code, "request_too_large");
  assert.equal(r.hits.length, 1);
  assert.equal(resolved, 1, "the refused request never resolved the host");
});

test("an undeclared target, a client-owned header or a resolved private address sends nothing", { skip }, async (t) => {
  const r = await rig(t);
  let resolved = 0;
  const c = r.client({ resolve: async () => (resolved++, [PUBLIC, "10.0.0.1"]) });
  assert.equal((await failure(c.send(r.req({ url: `https://other.example.test:${r.port}/` })))).code, "target_refused");
  assert.equal((await failure(c.send(r.req({ url: `https://127.0.0.1:${r.port}/`, origins: [`https://127.0.0.1:${r.port}`] })))).code, "target_refused");
  assert.equal((await failure(c.send(r.req({ headers: { "Accept-Encoding": "gzip" } })))).code, "header_refused");
  assert.equal(resolved, 0);
  assert.equal((await failure(c.send(r.req()))).code, "address_refused", "one private address among the answers refuses");
  assert.equal(resolved, 1);
  assert.equal((await failure(r.client({ resolve: async () => [] }).send(r.req()))).code, "address_refused");
  assert.equal((await failure(r.client({ resolve: async () => [`::ffff:127.0.0.1`] }).send(r.req()))).code, "address_refused");
  assert.equal(r.hits.length, 0, "the server saw nothing");
});

test("the lookup keeps the resolver's order and checks every address, the last one included", { skip }, async (t) => {
  // Two servers on the same port, one per loopback family; the checked public answers A and B dial to them. The agent
  // connects to the first address the lookup returned, so the server that answers shows the order was kept.
  const r = await rig(t);
  r.handle((q, s) => s.end(String(q.socket.localAddress)));
  const twin = https.createServer({ key: readFileSync(r.keyFile), cert: readFileSync(r.certFile) }, (q, s) => s.end(String(q.socket.localAddress)));
  const bound = await new Promise<boolean>((resolve) => twin.once("error", () => resolve(false)).listen(r.port, "::1", () => resolve(true)));
  if (!bound) return t.skip("no ::1 on this host");
  t.after(() => (twin.closeAllConnections(), twin.close()));
  const [A, B] = ["93.184.215.14", "2606:4700::1111"];
  const dial = (a: string): string => (a === A ? "127.0.0.1" : a === B ? "::1" : a);
  const via = (order: string[]): EgressClient => {
    const c = createEgressClientForTest({}, { ca: readFileSync(r.certFile), resolve: async () => order, dial });
    t.after(() => c.close());
    return c;
  };
  assert.equal((await via([A, B]).send(r.req())).body.toString(), "127.0.0.1");
  assert.equal((await via([B, A]).send(r.req())).body.toString(), "::1");
  // The SYSTEM resolver path, with node:dns lookup stood in by a spy: asked for every address in the resolver's order.
  const asked: unknown[] = [];
  const system = (order: string[]): EgressClient => {
    const dnsLookup = ((host: string, opts: unknown, cb: (e: null, list: Array<{ address: string; family: number }>) => void) => {
      asked.push({ host, opts });
      cb(null, order.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    }) as never;
    const c = createEgressClientForTest({}, { ca: readFileSync(r.certFile), dnsLookup, dial });
    t.after(() => c.close());
    return c;
  };
  assert.equal((await system([B, A]).send(r.req())).body.toString(), "::1");
  assert.equal((await system([A, B]).send(r.req())).body.toString(), "127.0.0.1");
  assert.deepEqual(asked, [{ host: HOST, opts: { all: true, order: "verbatim" } }, { host: HOST, opts: { all: true, order: "verbatim" } }]);
  assert.equal((await failure(system([A, "10.0.0.1"]).send(r.req()))).code, "address_refused", "the system path is checked too");
  for (const bad of ["10.0.0.1", "::ffff:127.0.0.1", "fe80::1", "not an address"]) {
    assert.equal((await failure(via([A, B, A, bad]).send(r.req()))).code, "address_refused", `${bad} last`);
  }
});

test("a redirect is refused with its status and its Location never appears; nothing is followed", { skip }, async (t) => {
  const r = await rig(t);
  for (const status of [301, 302, 303, 307, 308]) {
    r.handle((_q, s) => s.writeHead(status, { location: `https://evil.example/${CANARY}` }).end(CANARY));
    const e = await failure(r.client().send(r.req()));
    assert.deepEqual([e.code, e.status], ["redirect_refused", status]);
  }
  assert.equal(r.hits.length, 5, "one request per try, nothing followed");
});

test("an encoded response is refused; identity is accepted", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.writeHead(200, { "content-encoding": "gzip" }).end(CANARY));
  assert.equal((await failure(r.client().send(r.req()))).code, "encoding_refused");
  r.handle((_q, s) => s.writeHead(200, { "content-encoding": "identity" }).end("ok"));
  assert.equal((await r.client().send(r.req())).body.toString(), "ok");
});

test("a response over 4 MiB fails with nothing returned; exactly 4 MiB is returned", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.writeHead(200).end(Buffer.alloc(4_194_304, 0x61)));
  assert.equal((await r.client().send(r.req())).body.byteLength, 4_194_304);
  r.handle((_q, s) => s.writeHead(200).end(Buffer.alloc(4_194_305, 0x61)));
  assert.equal((await failure(r.client().send(r.req()))).code, "response_too_large");
});

test("response headers over 16 KiB are refused", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.writeHead(200, { "x-big": "a".repeat(17_000) }).end("x"));
  assert.equal((await failure(r.client().send(r.req()))).code, "response_headers_too_large");
  r.handle((_q, s) => s.writeHead(200, { "x-ok": "a".repeat(8_000) }).end("x"));
  assert.equal((await r.client().send(r.req())).status, 200);
});

test("the 16 KiB header cap is the client's own, not the process default", { skip }, async (t) => {
  // A child with the process default raised to 80 KiB: the client still refuses a 17 KB header block.
  const r = await rig(t);
  const dir = mkdtempSync(join(tmpdir(), "axis-egress-child-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "child.mjs");
  const clientUrl = new URL("../../src/net/egress-client.js", import.meta.url).href;
  writeFileSync(script, `
    import https from "node:https";
    import { readFileSync } from "node:fs";
    import { createEgressClientForTest } from ${JSON.stringify(clientUrl)};
    const [key, cert] = [readFileSync(process.argv[2]), readFileSync(process.argv[3])];
    const server = https.createServer({ key, cert, maxHeaderSize: 131072 }, (q, s) => s.writeHead(200, { "x-big": "a".repeat(17000) }).end("x"));
    server.listen(0, "127.0.0.1", async () => {
      const origin = "https://${HOST}:" + server.address().port;
      const c = createEgressClientForTest({}, { ca: cert, resolve: async () => ["${PUBLIC}"], dial: () => "127.0.0.1" });
      let out;
      try { await c.send({ integration: "x", origins: [origin], method: "GET", url: origin + "/" }); out = "accepted"; } catch (e) { out = e.code; }
      c.close(); server.close(); process.stdout.write(out);
    });`);
  const out = execFileSync(process.execPath, ["--max-http-header-size=81920", script, r.keyFile, r.certFile], { encoding: "utf8" });
  assert.equal(out, "response_headers_too_large");
});

test("an error status is closed: the status only, never the body", { skip }, async (t) => {
  const r = await rig(t);
  for (const status of [400, 401, 404, 500, 502]) {
    r.handle((_q, s) => s.writeHead(status, { "x-reason": CANARY }).end(`{"error":"${CANARY}"}`));
    const e = await failure(r.client().send(r.req()));
    assert.deepEqual([e.code, e.status], ["http_status", status]);
  }
});

test("429 and 503 back off on the injected clock: integer Retry-After, else doubling, never over 15 minutes", { skip }, async (t) => {
  const r = await rig(t);
  const clock = fakeClock();
  const c = r.client({ clock });
  r.handle((_q, s) => s.writeHead(429, { "retry-after": "120" }).end(CANARY));
  const e = await failure(c.send(r.req()));
  assert.deepEqual([e.code, e.status, e.retryAfterSeconds], ["rate_limited", 429, 120]);
  r.handle((_q, s) => s.end("ok"));
  const held = await failure(c.send(r.req()));
  assert.deepEqual([held.code, held.status], ["rate_limited", undefined]);
  assert.equal(r.hits.length, 1, "nothing is sent while backing off");
  clock.advance(120_000);
  assert.equal((await c.send(r.req())).status, 200);
  r.handle((_q, s) => s.writeHead(503).end());
  assert.equal((await failure(c.send(r.req()))).retryAfterSeconds, 2, "the success reset the doubling for this integration");
  clock.advance(2_000);
  r.handle((_q, s) => s.writeHead(503, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }).end());
  assert.equal((await failure(c.send(r.req({ integration: "x" })))).retryAfterSeconds, 2, "a date is ignored: the doubling applies");
  r.handle((_q, s) => s.writeHead(429, { "retry-after": "86400" }).end());
  assert.equal((await failure(c.send(r.req({ integration: "y" })))).retryAfterSeconds, 900);
});

test("at most 4 requests in flight per integration", { skip }, async (t) => {
  const r = await rig(t);
  const held: ServerResponse[] = [];
  r.handle((_q, s) => held.push(s));
  const c = r.client();
  const four = [1, 2, 3, 4].map(() => c.send(r.req()));
  while (held.length < 4) await new Promise((x) => setTimeout(x, 5));
  assert.equal((await failure(c.send(r.req()))).code, "busy");
  const other = c.send(r.req({ integration: "other" }));
  while (held.length < 5) await new Promise((x) => setTimeout(x, 5));
  for (const s of held) s.end("ok");
  await Promise.all([...four, other]);
  r.handle((_q, s) => s.end("ok"));
  assert.equal((await c.send(r.req())).status, 200, "a finished request frees its slot");
});

test("no first byte in 10 s and no complete response in 30 s are closed timeouts", { skip }, async (t) => {
  const r = await rig(t);
  let got = 0;
  r.handle(() => got++);
  const clock = fakeClock();
  const first = r.client({ clock }).send(r.req());
  while (got < 1) await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(clock.pending(), [10_000, 30_000], "both timers are armed at the ADR's lengths");
  clock.advance(9_999);
  assert.equal(clock.pending().length, 2, "nothing fires before 10 s");
  clock.advance(1);
  assert.equal((await failure(first)).code, "first_byte_timeout");
  assert.deepEqual(clock.pending(), [], "a settled request leaves no timer");
  let headersSent = false;
  r.handle((_q, s) => (s.writeHead(200), s.write("partial", () => (headersSent = true))));
  const clock2 = fakeClock();
  const total = r.client({ clock: clock2 }).send(r.req());
  for (let i = 0; i < 400 && clock2.pending().length !== 1; i++) await new Promise((x) => setTimeout(x, 5));
  assert.ok(headersSent);
  assert.deepEqual(clock2.pending(), [30_000], "the first-byte timer is cleared by the response");
  clock2.advance(29_999);
  clock2.advance(1);
  assert.equal((await failure(total)).code, "total_timeout");
});

test("a certificate the client does not trust fails closed; an abort is closed", { skip }, async (t) => {
  const r = await rig(t);
  assert.equal(r.client().systemTrustOnly, false, "the test client trusts its test CA");
  assert.equal((await failure(r.client({ ca: r.otherCa }).send(r.req()))).code, "tls_failed");
  r.handle(() => undefined);
  const ac = new AbortController();
  const p = r.client().send(r.req({ signal: ac.signal }));
  ac.abort();
  assert.equal((await failure(p)).code, "aborted");
});

test("the production client uses the system resolver and Node's default CA store: localhost is refused by the address rule", async () => {
  // localhost resolves from the hosts file: no DNS query leaves the machine in CI.
  const c = createEgressClient();
  try {
    assert.equal(c.systemTrustOnly, true, "no CA of its own");
    const e = await failure(c.send({ integration: "x", origins: ["https://localhost"], method: "GET", url: "https://localhost/" }));
    assert.equal(e.code, "address_refused");
  } finally {
    c.close();
  }
});
