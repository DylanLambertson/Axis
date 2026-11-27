// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { secretForms } from "@axis/audit";
import { INTEGRATIONS_REFUSAL_MESSAGE, integrationsMethods } from "@axis/protocol";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, transcript, type Answer } from "../../testing/test-client.js";
import type { TestSupervisor } from "../../testing/test-supervisor.js";
import { auditRows, databaseBytes, disposeHosts, openStopped, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";
import type { SliceIntegrationsConfig } from "../../testing/slice-integrations.js";
import { INTEGRATIONS_PAYLOAD_ALLOWLIST } from "../../src/integrations/service.js";
import { opensslMissing } from "../net/openssl.js";

/**
 * The canary end to end (docs/design/net-read-slice.md §8; net-tier-decision §5, §6 item 3): the REAL host composition in a
 * child process, a user window through its real connection path, a loopback HTTPS server answering as GitHub, and one canary
 * token in the fake vault. Every case checks every sink for the token in every registered form: the replies and errors, every
 * frame a window received, the pending approvals (no challenge at tier 0), the host's log lines, and, after a graceful stop,
 * every audit row and every byte of the database.
 */
const CANARY = String.raw`canary"T0k3n\x+y/z=Q9w-synthetic-0001`;
const HEADER = `Bearer ${CANARY}`;
const FORMS = [...new Set([...secretForms(HEADER), ...secretForms(CANARY)])];
const I = "axis.integrations";
const PR = { number: 7, title: "Fix the build", state: "open", user: { login: "octo" }, html_url: "https://github.com/o/r/pull/7", body: "long text the reply drops" };
const REDUCED = { items: [{ number: 7, title: "Fix the build", state: "open", author: "octo" }] };
const ARGS = { owner: "octo", repo: "hello", state: "open", perPage: 5 };
const holdsCanary = (text: string): boolean => FORMS.some((f) => text.includes(f));
const unicodeEscaped = (s: string): string => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const json = (res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
};

const skip = gitSkipReason() || opensslMissing();

describe("headless slice: the integrations read canary", { skip, timeout: 240_000 }, () => {
  let fx: GitFixture;
  let dir: string;
  let server: https.Server;
  let handler: Handler = (_q, s) => json(s, 200, JSON.stringify([PR]));
  const hits: Array<{ url: string; headers: IncomingMessage["headers"]; servername: string | undefined }> = [];
  let otherCert: { key: Buffer; cert: Buffer };
  let cert: { key: Buffer; cert: Buffer };
  let sup: TestSupervisor;
  let user: TestClient;
  let projectId: string;
  const config = (name: string, c: Omit<SliceIntegrationsConfig, "caFile" | "port">): string => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ caFile: join(dir, "a.pem"), port: (server.address() as { port: number }).port, ...c }));
    return file;
  };
  const read = (args: Record<string, unknown> = ARGS, operation = "pulls_list"): Promise<Answer> => user.call(I, "read", { projectId, integrationId: "github", operation, args });
  const refused = (a: Answer, code: string, reason: string, what: string): void => {
    assert.equal(a.ok, false, what);
    assert.deepEqual([a.error?.code, a.error?.details], [code, { reason }], what);
    assert.equal(a.error?.message, INTEGRATIONS_REFUSAL_MESSAGE, what);
  };
  /** Every live sink: every frame any window received, the host's log, and the pending approvals (none at tier 0). */
  const sinksClean = async (what: string): Promise<void> => {
    assert.equal(holdsCanary(transcript.join("\n")), false, `${what}: no frame holds the canary`);
    assert.equal(holdsCanary(sup.stderr), false, `${what}: no log line holds the canary`);
    const pending = await user.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {});
    assert.deepEqual(pending.challenges, [], `${what}: no challenge at tier 0`);
  };

  before(async () => {
    fx = createGitFixture();
    dir = mkdtempSync(join(tmpdir(), "axis-int-canary-"));
    const make = (name: string): { key: Buffer; cert: Buffer } => {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.pem`), "-days", "1", "-subj", "/CN=api.github.com", "-addext", "subjectAltName=DNS:api.github.com"], { stdio: "ignore" });
      return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
    };
    cert = make("a");
    otherCert = make("b");
    server = https.createServer({ ...cert, maxHeaderSize: 65_536 }, (q, s) => {
      hits.push({ url: q.url ?? "", headers: q.headers, servername: (q.socket as { servername?: string }).servername });
      q.resume();
      q.on("end", () => handler(q, s));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    // The forms the scans look for are distinct from the raw token, so each echo case tests its own encoding.
    for (const [name, form] of [["json", JSON.stringify(CANARY).slice(1, -1)], ["url", encodeURIComponent(CANARY)], ["base64", Buffer.from(CANARY).toString("base64")]] as const) {
      assert.notEqual(form, CANARY, `${name} differs from the raw token`);
      assert.ok(secretForms(CANARY).includes(form), `${name} is a form secretForms lists`);
    }
    const h = await startHost(fx, { integrationsConfig: config("main", { canary: CANARY }) });
    sup = h.sup;
    await h.ready;
    trustWindow(sup);
    projectId = await registerProject(sup, fx.repo);
    user = await TestClient.open(sup);
  });
  after(async () => {
    await disposeHosts();
    server.closeAllConnections();
    server.close();
    fx.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  test("list and status show GitHub connected, with its declared operations and no granted scope", async () => {
    const list = await user.ok<{ integrations: Array<Record<string, unknown>> }>(I, "list", { projectId });
    assert.ok(integrationsMethods.list.response.safeParse(list).success);
    assert.deepEqual(list.integrations.map((x) => [x["id"], x["state"], x["grantedScopes"]]), [["github", "connected", []]]);
    const status = await user.ok<{ integration: Record<string, unknown> }>(I, "status", { projectId, integrationId: "github" });
    assert.equal(status.integration["state"], "connected");
    assert.deepEqual(status.integration["operations"], [{ operation: "pulls_list", write: false }, { operation: "issue_get", write: false }]);
    await sinksClean("list and status");
  });

  test("a read sends exactly one request, to the composed path with the credential on the original host, and answers the reduced result", async () => {
    const from = hits.length;
    handler = (_q, s) => json(s, 200, JSON.stringify([PR]));
    const a = await read();
    assert.equal(a.ok, true, JSON.stringify(a.error));
    assert.deepEqual(a.result, { status: 200, result: REDUCED });
    assert.equal(hits.length, from + 1, "exactly one request");
    const hit = hits[from]!;
    assert.equal(hit.url, "/repos/octo/hello/pulls?state=open&per_page=5");
    assert.equal(hit.headers["authorization"], HEADER);
    assert.equal(hit.servername, "api.github.com", "SNI on the original host");
    const { authorization: _sent, ...others } = hit.headers;
    assert.equal(holdsCanary(hit.url) || holdsCanary(JSON.stringify(others)), false, "no other copy of the canary in the request");
    await sinksClean("read");
  });

  const echoes: Array<[string, Handler]> = [
    ["the header value in a JSON field", (_q, s) => json(s, 200, JSON.stringify([{ ...PR, title: HEADER }]))],
    ["the token in a JSON field", (_q, s) => json(s, 200, JSON.stringify([{ ...PR, body: CANARY }]))],
    ["the token in a response header", (_q, s) => json(s, 200, JSON.stringify([PR]), { "x-echo": CANARY })],
    ["the header value in a response header", (_q, s) => json(s, 200, JSON.stringify([PR]), { "x-echo": HEADER })],
    ["the token base64-encoded", (_q, s) => json(s, 200, JSON.stringify([{ ...PR, body: Buffer.from(CANARY).toString("base64") }]))],
    ["the token URL-encoded", (_q, s) => json(s, 200, JSON.stringify([{ ...PR, body: encodeURIComponent(CANARY) }]))],
    ["the token split across two chunks", (_q, s) => {
      const text = JSON.stringify([{ ...PR, body: CANARY }]);
      const cut = text.indexOf("T0k3n");
      s.writeHead(200, { "content-type": "application/json" });
      s.write(text.slice(0, cut));
      setTimeout(() => s.end(text.slice(cut)), 20);
    }],
  ];
  for (const [what, h] of echoes) {
    test(`first scan: ${what} is credential_echoed and no part of the response reaches the caller`, async () => {
      handler = h;
      refused(await read(), "E_UNAVAILABLE", "credential_echoed", what);
      await sinksClean(what);
    });
  }

  test("second scan: a token whose every character is a JSON escape is in no listed form in the raw body, and is refused after the parse", async () => {
    const raw = `[{"number":7,"title":"Fix","state":"open","user":{"login":"octo"},"body":"${unicodeEscaped(CANARY)}"}]`;
    assert.equal(holdsCanary(raw), false, "precondition: no listed form of the token or header in the raw body");
    assert.equal((JSON.parse(raw) as Array<{ body: string }>)[0]?.body, CANARY, "precondition: the parsed string is the whole token");
    handler = (_q, s) => json(s, 200, raw);
    refused(await read(), "E_UNAVAILABLE", "credential_echoed", "unicode-escaped");
    await sinksClean("second scan");
  });

  test("echoes the client refuses: a 401 holding the token, and a 302 whose Location holds it, which is not followed", async () => {
    handler = (_q, s) => json(s, 401, JSON.stringify({ message: CANARY }), { "x-echo": CANARY });
    refused(await read(), "E_UNAVAILABLE", "upstream_status", "401");
    const from = hits.length;
    handler = (_q, s) => {
      s.writeHead(302, { location: `https://api.github.com/x?t=${encodeURIComponent(CANARY)}` });
      s.end();
    };
    refused(await read(), "E_UNAVAILABLE", "redirect_refused", "302");
    assert.equal(hits.length, from + 1, "the redirect is not followed");
    await sinksClean("refused echoes");
  });

  test("refusals: an unknown operation, an argument with a separator, an answer over its caps, a dropped socket, a TLS failure", async () => {
    let from = hits.length;
    refused(await read(ARGS, "pulls_delete"), "E_NOT_FOUND", "not_found", "unknown operation");
    refused(await read({ ...ARGS, owner: "a/b" }), "E_INVALID_ARGUMENT", "argument_refused", "separator");
    assert.equal(hits.length, from, "nothing sent for a refused argument or operation");
    handler = (_q, s) => json(s, 200, `[${" ".repeat(5 * 1024 * 1024)}]`);
    refused(await read(), "E_UNAVAILABLE", "response_too_large", "over the cap");
    handler = (_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.write('[{"number":7,');
      setTimeout(() => s.socket?.destroy(), 20);
    };
    refused(await read(), "E_UNAVAILABLE", "network_unavailable", "socket dropped mid-body");
    handler = (_q, s) => json(s, 200, JSON.stringify([{ ...PR, state: "merged" }]));
    refused(await read(), "E_UNAVAILABLE", "response_invalid", "result schema mismatch");
    server.setSecureContext(otherCert);
    from = hits.length;
    try {
      refused(await read(), "E_UNAVAILABLE", "network_unavailable", "TLS failure");
      assert.equal(hits.length, from, "no request over an untrusted certificate");
    } finally {
      server.setSecureContext(cert);
    }
    const again = await read();
    assert.equal(again.ok, false, "the server still answers a schema mismatch");
    await sinksClean("refusals");
  });

  test("after a graceful stop: one request row for every credential row, only allowlisted keys, and the canary in no audit row or database byte", async () => {
    user.close();
    sup.kill("SIGTERM");
    assert.deepEqual(await sup.exited, { code: 0, signal: null });
    const db = openStopped(sup.dataDir, join(dir, "stopped"));
    const rows = auditRows(db);
    const credential = rows.filter((r) => r.action === "integration.credential");
    const request = rows.filter((r) => r.action === "integration.request");
    assert.ok(credential.length >= 15, `every read that reached the send wrote a credential row (${credential.length})`);
    assert.equal(request.length, credential.length, "exactly one request row per credential row");
    for (const r of [...credential, ...request]) {
      const keys = Object.keys(JSON.parse(r.payload) as Record<string, unknown>);
      for (const k of keys) assert.ok(INTEGRATIONS_PAYLOAD_ALLOWLIST[r.action]?.includes(k), `${r.action} stores only allowlisted keys (${k})`);
    }
    const reasons = request.map((r) => (JSON.parse(r.payload) as { reason: string }).reason);
    assert.ok(reasons.includes("ok") && reasons.includes("credential_echoed") && reasons.includes("network_unavailable"), reasons.join(","));
    const ok = JSON.parse(request.find((r) => (JSON.parse(r.payload) as { reason: string }).reason === "ok")!.payload) as Record<string, number>;
    assert.equal(ok["bytesOut"], Buffer.byteLength("/repos/octo/hello/pulls?state=open&per_page=5"));
    assert.equal(ok["bytesIn"], Buffer.byteLength(JSON.stringify([PR])));
    assert.equal(holdsCanary(JSON.stringify(rows)), false, "no audit row holds the canary");
    assert.equal(holdsCanary(databaseBytes(join(dir, "stopped")).toString("latin1")), false, "no database byte holds the canary");
    db.close();
  });

  for (const [name, noBackend] of [["no integrations option, as production", undefined], ["only a client, no backend", true]] as const) {
    test(`no secret backend (${name}): list and status show available, read is not_connected, and nothing is sent or audited`, async () => {
      const from = hits.length;
      const h = await startHost(fx, noBackend === undefined ? {} : { integrationsConfig: config(`nobackend-${name.length}`, { noBackend }) });
      await h.ready;
      trustWindow(h.sup);
      const pid = await registerProject(h.sup, fx.repo);
      const c = await TestClient.open(h.sup);
      const list = await c.ok<{ integrations: Array<{ state: string; grantedScopes: unknown[] }> }>(I, "list", { projectId: pid });
      assert.deepEqual(list.integrations.map((x) => [x.state, x.grantedScopes]), [["available", []]]);
      assert.equal((await c.ok<{ integration: { state: string } }>(I, "status", { projectId: pid, integrationId: "github" })).integration.state, "available");
      const r = await c.call(I, "read", { projectId: pid, integrationId: "github", operation: "pulls_list", args: ARGS });
      assert.deepEqual([r.error?.code, r.error?.details], ["E_CONFLICT", { reason: "not_connected" }]);
      assert.equal(hits.length, from, "no request");
      c.close();
      h.sup.kill("SIGTERM");
      await h.sup.exited;
      const db = openStopped(h.sup.dataDir, join(dir, `stopped-${name.length}`));
      assert.deepEqual(auditRows(db).filter((x) => x.action.startsWith("integration.")), [], "no integration row (policy rows are still written)");
      db.close();
    });
  }
});
