// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// PV-N1d's first test (ADR 0009 decision 4, "[I]: that the agent connects only to the addresses the `lookup` returned, with
// `autoSelectFamily`, at Node 24.22.1"). The egress client (slice B) relies on this Node behaviour: a dedicated agent whose
// `lookup` answers with checked addresses connects to those and to nothing else, never asks the system resolver, and keeps
// SNI and the certificate check on the original host name. If this ever fails, the egress design must change first.

/**
 * Without openssl the test cannot make its certificate. On a dev machine it is skipped with a loud reason; under the gate
 * (which sets AXIS_REQUIRE_PINNING_TEST=1) and in CI it FAILS, so ADR 0009's first test never passes by not running.
 */
export function opensslMissing(env: NodeJS.ProcessEnv = process.env, probe: () => void = () => execFileSync("openssl", ["version"], { stdio: "ignore" })): string | false {
  try {
    probe();
    return false;
  } catch {
    if (env.AXIS_REQUIRE_PINNING_TEST === "1" || env.CI !== undefined) throw new Error("openssl is missing: ADR 0009's pinning test is required here (gate or CI) and cannot run without it");
    return "SKIPPED ADR 0009's pinning test: openssl is needed to make the test certificate (the gate and CI require it)";
  }
}

const HOST = "pinned.invalid"; // `.invalid` never resolves: a connection here proves the agent used our lookup
const listen = (server: Server | https.Server, host: string, port = 0): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as { port: number }).port));
  });
const closeServer = (server: Server | https.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

test("without openssl the pinning test fails under the gate and in CI, and skips loudly elsewhere", () => {
  const missing = (): void => {
    throw new Error("ENOENT");
  };
  assert.throws(() => opensslMissing({ AXIS_REQUIRE_PINNING_TEST: "1" }, missing), /required here/);
  assert.throws(() => opensslMissing({ CI: "true" }, missing), /required here/);
  assert.match(String(opensslMissing({}, missing)), /^SKIPPED ADR 0009's pinning test/);
  assert.equal(opensslMissing({ CI: "true" }, () => undefined), false);
});

test("a dedicated agent connects only to the addresses its lookup returns, with SNI and the certificate on the original host", { skip: opensslMissing() }, async (t) => {
  assert.equal(process.version, "v24.22.1", "this pins the behaviour of the Node the daemon ships with");
  const dir = mkdtempSync(join(tmpdir(), "axis-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "c.pem"));
  const served: string[] = [];
  const server = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert }, (req, res) => {
    served.push(`${req.socket.localAddress} ${(req.socket as { servername?: string }).servername ?? ""}`);
    res.end("ok");
  });
  // A decoy on ::1, an address the lookup never returns, at the SAME port as the server: a connection the agent chose by
  // itself (the other family of "localhost", say) would land there. A busy ::1 port retries with a new pair, bounded.
  const strays: string[] = [];
  let decoy = createServer((s) => (strays.push(String(s.localAddress)), s.destroy()));
  let port = 0;
  for (let attempt = 0; ; attempt++) {
    port = await listen(server, "127.0.0.1");
    try {
      await listen(decoy, "::1", port);
      break;
    } catch (e) {
      await closeServer(server);
      decoy = createServer((s) => (strays.push(String(s.localAddress)), s.destroy()));
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw e;
    }
  }
  t.after(() => (server.close(), decoy.close()));
  // Control: the decoy really listens and records a connection; then it is cleared.
  await new Promise<void>((resolve, reject) => connect({ host: "::1", port }).on("connect", function (this: import("node:net").Socket) { this.destroy(); resolve(); }).on("error", reject));
  for (let i = 0; i < 50 && strays.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(strays, ["::1"], "the decoy listens on ::1 at the server's port");
  strays.length = 0;

  for (const autoSelectFamily of [true, false]) {
    const asked: Array<{ hostname: string; all: boolean }> = [];
    const lookup = (hostname: string, options: { all?: boolean }, cb: (...a: unknown[]) => void): void => {
      asked.push({ hostname, all: options.all === true });
      if (options.all === true) cb(null, [{ address: "127.0.0.1", family: 4 }]);
      else cb(null, "127.0.0.1", 4);
    };
    const agent = new https.Agent({ lookup: lookup as never, autoSelectFamily, ca: cert, rejectUnauthorized: true, keepAlive: false });
    const status = await new Promise<number | string>((resolve) => {
      const req = https.request({ host: HOST, port, path: "/", agent }, (res) => (res.resume(), res.on("end", () => resolve(res.statusCode ?? 0))));
      req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      req.end();
    });
    assert.equal(status, 200, `autoSelectFamily ${autoSelectFamily}`);
    assert.deepEqual(asked.map((a) => a.hostname), [HOST], "the lookup was asked for the original host, once");
    if (autoSelectFamily) assert.equal(asked[0]?.all, true, "with autoSelectFamily the agent asks for every address");
    agent.destroy();
  }
  assert.deepEqual(served, [`127.0.0.1 ${HOST}`, `127.0.0.1 ${HOST}`], "both requests reached the checked address with SNI on the original host");
  assert.deepEqual(strays, [], "nothing connected anywhere else");

  // The certificate is checked against the original host: one for another name fails even at the checked address.
  const wrong = new https.Agent({ lookup: ((h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all === true ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never, autoSelectFamily: true, ca: cert, rejectUnauthorized: true });
  const err = await new Promise<string>((resolve) => {
    const req = https.request({ host: "other.invalid", port, path: "/", agent: wrong }, () => resolve("connected"));
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    req.end();
  });
  assert.equal(err, "ERR_TLS_CERT_ALTNAME_INVALID");
  wrong.destroy();
});
