// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { composeRequest } from "../../src/net/compose-request.js";
import { createEgressClientForTest, type EgressClient } from "../../src/net/egress-client.js";
import { declaredOrigins, egressTarget, type EgressTarget } from "../../src/net/host.js";
import { authorize, type AuthorizedRequest, Credential, matchTarget, type MatchedTarget } from "../../src/net/url-pattern.js";
import { CANARY, failure, HOST, PUBLIC, rig, skip, type Rig } from "./egress-rig.js";
import { NAMED } from "./templates.js";

// The PV-N1f requirement from PV-N1e review 2: the egress client OWNS the `authorization` header. A caller can never set
// it, for any host; it is attached only by sendAuthorized, from a genuine, unspent AuthorizedRequest, to exactly its URL.

const ORIGIN = `https://${HOST}`; // an origin carries no port; the test seam connects port 443 to the local server
const SECRET = `Bearer ${CANARY}-secret`;

function authorized(name = "x", integration = "gh"): AuthorizedRequest {
  const c = composeRequest(NAMED, integration, ORIGIN, { name });
  const t = egressTarget(c.url, declaredOrigins([ORIGIN]));
  assert.ok(typeof t === "object");
  return authorize(matchTarget(c, t as EgressTarget) as MatchedTarget, new Credential(SECRET, { integration, origin: ORIGIN }));
}

function clientFor(r: Rig, t: import("node:test").TestContext): EgressClient {
  const c = createEgressClientForTest({}, { ca: readFileSync(r.certFile), resolve: async () => [PUBLIC], dial: () => "127.0.0.1", port: r.port });
  t.after(() => c.close());
  return c;
}

test("an authorized request goes to exactly its URL, with its credential as the Authorization header", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.end("ok"));
  const res = await clientFor(r, t).sendAuthorized(authorized("café"), { headers: { Accept: "application/json" } });
  assert.equal(res.status, 200);
  const hit = r.hits.at(-1);
  assert.deepEqual([hit?.url, hit?.headers.authorization, hit?.headers.accept, hit?.servername], ["/labels/caf%C3%A9", SECRET, "application/json", HOST]);
});

test("a caller can never set Authorization, in any spelling, for any host", { skip }, async (t) => {
  const r = await rig(t);
  const c = clientFor(r, t);
  for (const name of ["authorization", "Authorization", "AUTHORIZATION", "aUtHoRiZaTiOn"]) {
    const e = await failure(c.send({ integration: "x", origins: [ORIGIN], method: "GET", url: `${ORIGIN}/a`, headers: { [name]: SECRET } }));
    assert.equal(e.code, "header_refused", name);
    const viaExtra = await failure(c.sendAuthorized(authorized(), { headers: { [name]: "Bearer other" } }));
    assert.equal(viaExtra.code, "header_refused", `${name} beside an authorized request`);
  }
  assert.equal(r.hits.length, 0, "nothing was sent");
});

test("an authorized request is sent once: a replay, a copy or a forgery is not_authorized and sends nothing", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.end("ok"));
  const c = clientFor(r, t);
  const req = authorized();
  await c.sendAuthorized(req);
  assert.equal((await failure(c.sendAuthorized(req))).code, "not_authorized", "a replay");
  const fresh = authorized("y");
  assert.equal((await failure(c.sendAuthorized({ ...fresh }))).code, "not_authorized", "a copy");
  assert.equal((await failure(c.sendAuthorized(structuredClone(fresh)))).code, "not_authorized", "a structured clone");
  const forged = Object.freeze({ method: "GET", url: `${ORIGIN}/labels/z`, origin: ORIGIN, integration: "gh", body: undefined }) as AuthorizedRequest;
  assert.equal((await failure(c.sendAuthorized(forged))).code, "not_authorized", "a look-alike");
  assert.equal((await failure(c.sendAuthorized(null as never))).code, "not_authorized");
  assert.equal(r.hits.length, 1, "only the first send went out");
  await c.sendAuthorized(fresh);
  assert.equal(r.hits.length, 2);
});

test("the body sent is the authorized one, whatever happens to the request's body array before the send (N1f review 1 nit 4)", { skip }, async (t) => {
  const r = await rig(t);
  r.handle((_q, s) => s.end("ok"));
  const create = { method: "POST" as const, path: [{ literal: "issues" }], body: [{ name: "title", arg: "title", kind: "text" as const, required: true }] };
  const c = composeRequest(create, "gh", ORIGIN, { title: "ab" });
  const target = egressTarget(c.url, declaredOrigins([ORIGIN])) as EgressTarget;
  const req = authorize(matchTarget(c, target) as MatchedTarget, new Credential(SECRET, { integration: "gh", origin: ORIGIN }));
  (req.body as Uint8Array).fill(0x7a);
  await clientFor(r, t).sendAuthorized(req);
  assert.equal(r.hits.at(-1)?.body, '{"title":"ab"}');
});

test("no error carries the credential", { skip }, async (t) => {
  const r = await rig(t);
  const c = clientFor(r, t);
  const req = authorized();
  for (const p of [c.sendAuthorized(req, { headers: { authorization: SECRET } }), c.sendAuthorized(req), c.send({ integration: "x", origins: [ORIGIN], method: "GET", url: `${ORIGIN}/a`, headers: { authorization: SECRET } })]) {
    const e = await failure(p);
    assert.ok(!`${e.message} ${String(e.stack)} ${JSON.stringify(e)}`.includes("secret"), e.code);
  }
});
