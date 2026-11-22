// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEgressClientForTest, EGRESS_METHODS } from "../../src/net/egress-client.js";
import { CANARY, failure, HOST, PUBLIC, rig, skip, type Rig } from "./egress-rig.js";

// PV-N1d slice B review 1: every caller-supplied field is checked at run time before a slot is taken; any throw, before or
// inside the request, is a closed error with no input in it; the slot is released on every path. And the proxy
// variables do not apply to the client, shown in a child process that sets them.

/** Proves no slot of `integration` is held: four held requests start, the fifth is `busy`; then they are answered. */
async function allFourSlotsFree(r: Rig, integration: string): Promise<void> {
  const held: ServerResponse[] = [];
  r.handle((_q, s) => held.push(s));
  const c = r.client();
  const four = [1, 2, 3, 4].map(() => c.send(r.req({ integration })));
  while (held.length < 4) await new Promise((x) => setTimeout(x, 5));
  assert.equal((await failure(c.send(r.req({ integration })))).code, "busy");
  for (const s of held) s.end("ok");
  await Promise.all(four);
}

test("the method set is GET, HEAD and POST, checked at run time; a bad method takes no slot and echoes nothing", { skip }, async (t) => {
  assert.deepEqual([...EGRESS_METHODS], ["GET", "HEAD", "POST"]);
  const r = await rig(t);
  const c = r.client();
  for (const method of [`GE${CANARY}T`, "GE T", "get", "PUT", "DELETE", "", 42, null, `GET\r\nX-${CANARY}: 1`]) {
    const e = await failure(c.send(r.req({ method: method as never })));
    assert.equal(e.code, "method_refused", JSON.stringify(method));
  }
  r.handle((_q, s) => s.end());
  assert.equal((await c.send(r.req({ method: "HEAD" }))).status, 200);
  assert.equal((await failure(c.send(r.req({ method: "GET", body: new Uint8Array(1) })))).code, "request_refused", "a read has no body");
  assert.equal(r.hits.length, 1);
  await allFourSlotsFree(r, "gh");
});

test("malformed fields and injected header values are refused before a slot, with no input in the error", { skip }, async (t) => {
  const r = await rig(t);
  const c = r.client();
  const cases: ReadonlyArray<readonly [object, string]> = [
    [{ headers: { "x-a": `v\r\nX-${CANARY}: 1` } }, "header_refused"], [{ headers: { [`x\r\n${CANARY}`]: "v" } }, "header_refused"],
    [{ headers: { "x-a": 1 } }, "header_refused"], [{ headers: [["x-a", "v"]] }, "header_refused"], [{ headers: null }, "header_refused"],
    [{ integration: "" }, "request_refused"], [{ integration: `a b${CANARY}` }, "request_refused"], [{ integration: 7 }, "request_refused"],
    [{ origins: "https://x" }, "request_refused"], [{ origins: [7] }, "request_refused"], [{ url: 7 }, "request_refused"],
    [{ body: `text${CANARY}`, method: "POST" }, "request_refused"], [{ body: [1, 2], method: "POST" }, "request_refused"],
    [{ signal: { aborted: false } }, "request_refused"], [{ url: `https://${CANARY}.example/` }, "target_refused"],
  ];
  for (const [over, want] of cases) assert.equal((await failure(c.send({ ...r.req(), ...over } as never))).code, want, JSON.stringify(over));
  assert.equal((await failure(c.send(null as never))).code, "request_refused");
  assert.equal(r.hits.length, 0);
  await allFourSlotsFree(r, "gh");
});

test("a throw inside the request, or inside the lookup, is a closed error and the slot is released", { skip }, async (t) => {
  const r = await rig(t);
  const c = r.client();
  // A body that passes the checks and throws when the request writes it (Buffer.from reads its length): a throw inside
  // the request, after the slot was taken.
  for (let i = 0; i < 6; i++) {
    const body = new Proxy(new Uint8Array(4), { get: (o, k) => (k === "length" ? (() => { throw new TypeError(`boom ${CANARY}`); })() : Reflect.get(o, k)) });
    assert.equal((await failure(c.send(r.req({ method: "POST", body })))).code, "request_refused");
  }
  await allFourSlotsFree(r, "gh");
  // A dial that throws inside the lookup: a closed error, not a hung request.
  const broken = createEgressClientForTest({}, { ca: Buffer.from(""), resolve: async () => [PUBLIC], dial: () => { throw new Error(CANARY); } });
  t.after(() => broken.close());
  for (let i = 0; i < 5; i++) assert.equal((await failure(broken.send(r.req()))).code, "connect_failed");
});

test("a throw inside the response handler is a closed error, and the slot is released", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.end("ok"));
  let now = 0;
  // A clock whose clearTimeout throws: the response handler's first call (clearing the first-byte timer) throws.
  const clock = { now: () => now, setTimeout: () => ({}), clearTimeout: () => { throw new Error(CANARY); } };
  const c = r.client({ clock });
  for (let i = 0; i < 6; i++) assert.equal((await failure(c.send(r.req()))).code, "request_refused");
  now += 1;
  await allFourSlotsFree(r, "gh");
});

test("the proxy variables do not apply: a child with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY reaches the target directly", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.end("direct"));
  let proxied = 0;
  const proxy = createServer((s) => (proxied++, s.destroy()));
  await new Promise<void>((x) => proxy.listen(0, "127.0.0.1", () => x()));
  t.after(() => proxy.close());
  const port = (proxy.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "axis-egress-proxy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "child.mjs");
  writeFileSync(script, `
    import { readFileSync } from "node:fs";
    import { createEgressClientForTest } from ${JSON.stringify(new URL("../../src/net/egress-client.js", import.meta.url).href)};
    const c = createEgressClientForTest({}, { ca: readFileSync(process.argv[2]), resolve: async () => ["${PUBLIC}"], dial: () => "127.0.0.1" });
    let out;
    try { out = (await c.send({ integration: "x", origins: [process.argv[3]], method: "GET", url: process.argv[3] + "/" })).body.toString(); } catch (e) { out = e.code; }
    c.close();
    process.stdout.write(out);`);
  const env = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, ALL_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "" };
  // Asynchronously: the parent serves the target, so it must not block while the child runs.
  const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, [script, r.certFile, r.origin], { env, encoding: "utf8" }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
  assert.equal(out, "direct");
  assert.equal(r.hits.length, 1, "the target got the request");
  assert.equal(proxied, 0, "the proxy got nothing");
  assert.ok(r.origin.includes(HOST));
});
