// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// PV-N1d's first test (ADR 0009 decision 4, "[I]: that the agent connects only to the addresses the `lookup` returned, with
// `autoSelectFamily`, at Node 24.22.1"). The egress client (slice B) relies on this Node behaviour: a dedicated agent whose
// `lookup` answers with checked addresses connects to those and to nothing else, never asks the system resolver, and keeps
// SNI and the certificate check on the original host name. If this ever fails, the egress design must change first.

function opensslMissing(): string | false {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return false;
  } catch {
    return "openssl is needed to make the test certificate";
  }
}

const HOST = "pinned.invalid"; // `.invalid` never resolves: a connection here proves the agent used our lookup
const listen = (server: Server | https.Server, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as { port: number }).port));
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
  const port = await listen(server, "127.0.0.1");
  // A decoy on an address the lookup never returns, same port: any connection there is a connection the agent chose itself.
  const strays: string[] = [];
  const decoy = createServer((s) => (strays.push(String(s.localAddress)), s.destroy()));
  await listen(decoy, "::1").catch(() => undefined);
  t.after(() => (server.close(), decoy.close()));

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
