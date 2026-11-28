// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { secretForms } from "@axis/audit";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { FakeSecretsMain } from "../../testing/secrets-main.js";
import { TestClient, transcript, type Answer } from "../../testing/test-client.js";
import { auditRows, databaseBytes, disposeHosts, openStopped, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";
import { opensslMissing } from "../net/openssl.js";

/**
 * PV-N0c-1 end to end (docs/design/secret-broker.md §6.1): the REAL host composition in a child process, with the test
 * supervisor answering `secrets.*` from its model of main's broker (testing/secrets-main.ts).
 * - Off, as the daemon entry leaves it: no `secrets.*` request at start, on the integrations list, status and read, or ever;
 *   the integrations show `available` and a read is `not_connected`. This fails if the backend's construction or the startup
 *   reveal moves outside the option's guard: either sends at once.
 * - On: the startup reveal reads each stored provider entry once (a weak one is refused, `weak_entry`), never an integration
 *   entry; then the integrations read canary runs again with the token reaching the vault through the broker, and every sink
 *   (frames, log lines, stdout, audit rows, database bytes, every file of the host and the repository) is checked for the
 *   canary and for both provider keys in every registered form.
 */
const CANARY = String.raw`canary"T0k3n\x+y/z=Q9w-synthetic-0002`;
const GOOD = "test-provider-key-good-0001";
const WEAK = "test-provider-key-weak-0002";
const CONN = "anthropic-main";
const FORMS = [...new Set([...secretForms(`Bearer ${CANARY}`), ...secretForms(CANARY), ...secretForms(GOOD), ...secretForms(WEAK)])];
const holdsSecret = (text: string): boolean => FORMS.some((f) => text.includes(f));
const I = "axis.integrations";
const PR = { number: 7, title: "Fix the build", state: "open", user: { login: "octo" }, html_url: "https://github.com/o/r/pull/7" };
const ARGS = { owner: "octo", repo: "hello", state: "open", perPage: 5 };
const META = { storedAt: 5, backend: "gnome_libsecret", protection: "os_protected", weakConsent: false } as const;

function walk(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
const json = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
};
/** A broker holding a protected and a weak provider entry and the GitHub canary. */
function seeded(): FakeSecretsMain {
  const main = new FakeSecretsMain();
  main.entries.set(CONN, { secret: GOOD, meta: { ...META } });
  main.entries.set("other-conn", { secret: WEAK, meta: { ...META, protection: "none" } });
  main.entries.set("integration:github", { secret: CANARY, meta: { ...META } });
  return main;
}
const opsOf = (main: FakeSecretsMain): string[] => main.seen.filter((m) => m.type !== "secrets.info").map((m) => `${m.type.slice(8)}${typeof m["name"] === "string" ? `:${m["name"] as string}` : ""}`);

const skip = gitSkipReason() || opensslMissing();

describe("headless slice: the secret broker wiring", { skip, timeout: 240_000 }, () => {
  let fx: GitFixture;
  let dir: string;
  let server: https.Server;
  let handler: (q: IncomingMessage, s: ServerResponse) => void = (_q, s) => json(s, 200, JSON.stringify([PR]));
  const hits: Array<{ headers: IncomingMessage["headers"] }> = [];
  const clientOnly = (name: string): string => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ caFile: join(dir, "a.pem"), port: (server.address() as { port: number }).port, noBackend: true }));
    return file;
  };

  before(async () => {
    fx = createGitFixture();
    dir = mkdtempSync(join(tmpdir(), "axis-broker-slice-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "a.key"), "-out", join(dir, "a.pem"), "-days", "1", "-subj", "/CN=api.github.com", "-addext", "subjectAltName=DNS:api.github.com"], { stdio: "ignore" });
    server = https.createServer({ key: readFileSync(join(dir, "a.key")), cert: readFileSync(join(dir, "a.pem")) }, (q, s) => {
      hits.push({ headers: q.headers });
      q.resume();
      q.on("end", () => handler(q, s));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });
  after(async () => {
    await disposeHosts();
    server.closeAllConnections();
    server.close();
    fx.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  test("off, as the daemon entry leaves it: not one secrets request, at start or on list, status and read", async () => {
    const main = seeded();
    const h = await startHost(fx, { secrets: main, integrationsConfig: clientOnly("off") });
    await h.ready;
    trustWindow(h.sup);
    const pid = await registerProject(h.sup, fx.repo);
    const c = await TestClient.open(h.sup);
    const list = await c.ok<{ integrations: Array<{ state: string }> }>(I, "list", { projectId: pid });
    assert.deepEqual(list.integrations.map((x) => x.state), ["available"]);
    const r = await c.call(I, "read", { projectId: pid, integrationId: "github", operation: "pulls_list", args: ARGS });
    assert.deepEqual([r.error?.code, r.error?.details], ["E_CONFLICT", { reason: "not_connected" }]);
    await new Promise((res) => setTimeout(res, 500)); // a startup reveal, had it been started, has long sent its list
    assert.deepEqual(main.seen, [], "no secrets.* request reached main");
    assert.equal(h.sup.received.filter((m) => m.type.startsWith("secrets.")).length, 0);
    c.close();
    h.sup.kill("SIGTERM");
    await h.sup.exited;
  });

  test("on: the startup reveal validates each provider entry once, refuses the weak one, and the integrations canary runs through the broker", async () => {
    const main = seeded();
    const h = await startHost(fx, { secrets: main, integrationsConfig: clientOnly("on"), secretBroker: CONN, fullOutput: true });
    await h.ready;
    const deadline = Date.now() + 30_000;
    while (opsOf(main).length < 3 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(opsOf(main), ["list", `get:${CONN}`, "get:other-conn"], "one list, one read per provider entry, no integration entry, no retry");
    trustWindow(h.sup);
    const pid = await registerProject(h.sup, fx.repo);
    const user = await TestClient.open(h.sup);
    const status = await user.ok<{ integration: { state: string } }>(I, "status", { projectId: pid, integrationId: "github" });
    assert.equal(status.integration.state, "connected", "the integration entry is seen through the broker");
    const from = hits.length;
    handler = (_q, s) => json(s, 200, JSON.stringify([PR]));
    const ok: Answer = await user.call(I, "read", { projectId: pid, integrationId: "github", operation: "pulls_list", args: ARGS });
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(hits[from]?.headers["authorization"], `Bearer ${CANARY}`, "the token the broker returned was sent");
    handler = (_q, s) => json(s, 200, JSON.stringify([{ ...PR, title: CANARY }]));
    const echo = await user.call(I, "read", { projectId: pid, integrationId: "github", operation: "pulls_list", args: ARGS });
    assert.deepEqual([echo.error?.code, echo.error?.details], ["E_UNAVAILABLE", { reason: "credential_echoed" }]);
    assert.ok(opsOf(main).includes("get:integration:github"), "the read revealed the token through the broker");
    assert.equal(holdsSecret(transcript.join("\n")), false, "no frame holds a secret");
    user.close();
    h.sup.kill("SIGTERM");
    assert.deepEqual(await h.sup.exited, { code: 0, signal: null });
    assert.match(h.sup.output, /secrets\.startup/, "the startup reveal logged its closed counts");
    assert.equal(holdsSecret(h.sup.output), false, "nothing the host wrote holds a secret");
    const db = openStopped(h.sup.dataDir, join(dir, "stopped-on"));
    const rows = auditRows(db);
    const validate = rows.filter((x) => x.action === "provider.credential").map((x) => [x.target, x.outcome, JSON.parse(x.payload)]);
    assert.deepEqual(validate, [
      [`connection:${CONN}`, "success", { purpose: "validate_connection", outcome: "ok" }],
      ["connection:other-conn", "failure", { purpose: "validate_connection", outcome: "weak_entry" }],
    ]);
    assert.ok(rows.some((x) => x.action === "integration.credential"), "the integration reveal is audited");
    assert.equal(holdsSecret(JSON.stringify(rows)), false, "no audit row holds a secret");
    assert.equal(holdsSecret(databaseBytes(join(dir, "stopped-on")).toString("latin1")), false, "no database byte holds a secret");
    for (const f of [...walk(h.sup.root), ...walk(fx.repo)]) assert.equal(holdsSecret(readFileSync(f).toString("latin1")), false, `${f} holds a secret`);
    db.close();
  });

  test("on, gate 6 at composition level: a read whose token get hangs fails within the real budget, and the host stays usable meanwhile", async () => {
    const main = seeded();
    main.workMs = (op, name) => (op === "get" && name === "integration:github" ? Infinity : 0);
    const h = await startHost(fx, { secrets: main, integrationsConfig: clientOnly("hung"), secretBroker: CONN });
    await h.ready;
    trustWindow(h.sup);
    const pid = await registerProject(h.sup, fx.repo);
    const user = await TestClient.open(h.sup);
    const started = Date.now();
    const hung = user.call(I, "read", { projectId: pid, integrationId: "github", operation: "pulls_list", args: ARGS }, undefined, 75_000);
    await new Promise((res) => setTimeout(res, 200));
    const quick = Date.now();
    // Another connection's entry (main holds one operation per NAME, so the same entry waits there, by design §3.4).
    const listed = await user.ok<{ providers: Array<{ providerId: string; credential?: { state: string; protection?: string } }> }>("axis.providers", "list", {});
    const anthropic = listed.providers.find((p) => p.providerId === "anthropic");
    assert.deepEqual([anthropic?.credential?.state, anthropic?.credential?.protection], ["stored", "os_protected"], "the provider's credential still answers while the token read hangs");
    assert.ok(Date.now() - quick < 10_000, "the other connection was not held behind the hung read");
    const a = await hung;
    const took = Date.now() - started;
    assert.equal(a.ok, false, "the hung read is refused");
    assert.ok(took < 70_000, `refused within main's 60 s and the daemon's 65 s budget (${took} ms)`);
    user.close();
    h.sup.kill("SIGTERM");
    await h.sup.exited;
  });
});
