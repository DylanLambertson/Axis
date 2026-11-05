// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the H1 review: redact-before-cut, the host key as a log field, nested Proxy in the init
// message, and the unref contract of Disposables timers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AxisError, Redactor } from "@axis/audit";
import { createLogger, parseHostConfig, type LogFields } from "../src/index.js";
import { fakeClock, validConfig } from "./helpers.js";

const anthropicKey = (): string => ["sk", "ant", "api03", "Aa1Bb2".repeat(6)].join("-");

function rig(redactor = new Redactor()) {
  const lines: string[] = [];
  const logger = createLogger({ redactor, clock: fakeClock(), sink: { write: (l) => void lines.push(l) } });
  return { redactor, logger, lines };
}

test("S1: a secret straddling the 256 and 4096 boundaries is never logged in part", () => {
  const registered = randomBytes(24).toString("hex");
  for (const offset of [200, 230, 240, 250, 255, 256, 257, 4000, 4080, 4090, 4096, 4097]) {
    for (const secret of [anthropicKey(), registered]) {
      const { redactor, logger, lines } = rig();
      redactor.registerSecret(registered);
      logger.info("request.failed", { reason: "x".repeat(offset) + " " + secret + " " + "y".repeat(50) });
      const text = lines.join("\n");
      for (let n = 8; n <= secret.length; n += 4) {
        assert.ok(!text.includes(secret.slice(0, n)), `offset ${offset}: ${n} leading characters of the secret were logged`);
      }
      assert.ok(!text.includes(secret.slice(-12)));
      JSON.parse(lines[0] as string);
    }
  }
});

test("S1: long text is cut after redaction, on code points, and over the scan bound becomes a marker", () => {
  const { logger, lines } = rig();
  logger.info("request.failed", { reason: "a".repeat(255) + "\u{1F600}" + "b".repeat(10) });
  const reason = (JSON.parse(lines[0] as string) as { reason: string }).reason;
  assert.ok(reason.endsWith("[cut]"));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(reason), "no lone surrogate from the cut");
  logger.info("request.failed", { reason: "z".repeat(100_000_000) });
  assert.equal((JSON.parse(lines[1] as string) as { reason: string }).reason, "[truncated]");
});

test("S1b: parseHostConfig registers the attestation key in every shape, so a log field cannot carry it", () => {
  const key = randomBytes(32);
  const redactor = new Redactor();
  const config = parseHostConfig(validConfig({ attestationKey: key.toString("base64url") }), redactor);
  assert.deepEqual(Buffer.from(config.attestationKey), key);
  const b64u = key.toString("base64url");
  const shapes = [
    b64u, key.toString("base64"), key.toString("base64").replace(/=+$/, ""), key.toString("hex"), key.toString("hex").toUpperCase(),
    encodeURIComponent(key.toString("base64")), JSON.stringify(key.toString("base64")).slice(1, -1),
    Buffer.from(b64u).toString("hex"), Buffer.from(b64u).toString("base64"),
    `Bearer ${b64u}`, `{"key":"${b64u}"}`, `prefix-${b64u}-suffix`, "q".repeat(230) + b64u, "q".repeat(250) + b64u,
  ];
  for (const shape of shapes) {
    const { logger, lines } = rig(redactor);
    logger.info("request.failed", { reason: shape, correlationId: shape, workspaceId: shape });
    const text = lines.join("\n");
    for (const form of [b64u, key.toString("hex"), key.toString("base64").replace(/=+$/, ""), b64u.slice(0, 16), key.toString("hex").slice(0, 16)]) {
      assert.ok(!text.includes(form), `${shape.slice(0, 20)}...: leaked ${form.slice(0, 8)}`);
    }
  }
  // The same key in an error summary or an unknown field never reaches the line either.
  const { logger, lines } = rig(redactor);
  logger.error("request.failed", { error: new Error(b64u), [b64u]: b64u } as unknown as LogFields);
  assert.ok(!lines.join("").includes(b64u.slice(0, 12)));
});

test("S1b: a rejected config registers nothing and the redactor argument is required", () => {
  const redactor = new Redactor();
  const bad = validConfig({ dataDir: "relative" });
  assert.throws(() => parseHostConfig(bad, redactor), AxisError);
  const { logger, lines } = rig(redactor);
  logger.info("request.failed", { reason: bad["attestationKey"] as string });
  assert.ok(lines.join("").includes((bad["attestationKey"] as string).slice(0, 20)), "nothing was registered for a refused message");
});

test("N2: the key is a copy on every read; changing a copy does not change the host's", () => {
  const config = parseHostConfig(validConfig(), new Redactor());
  const first = config.attestationKey;
  const snapshot = Buffer.from(first);
  first.fill(0);
  assert.deepEqual(Buffer.from(config.attestationKey), snapshot);
  assert.notEqual(config.attestationKey, config.attestationKey);
  assert.ok(Object.isFrozen(config));
});

test("S3: a Proxy, accessor or class instance at any depth is refused and no trap or getter runs", () => {
  let ran = 0;
  const trap = (): never => { ran++; throw new Error("ran"); };
  const proxy = (): object => new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap, getPrototypeOf: trap });
  const refuse = (over: Record<string, unknown>): void => {
    assert.throws(() => parseHostConfig(validConfig(over), new Redactor()), (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT");
  };
  refuse({ limits: proxy() });
  refuse({ limits: { maxConnections: proxy() } });
  refuse({ contracts: proxy() });
  refuse({ contracts: new Proxy(["axis.audit"], { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap }) });
  refuse({ contracts: [proxy()] });
  refuse({ extra: { deep: { deeper: [proxy()] } } });
  refuse({ dataDir: proxy() });
  refuse({ limits: Object.defineProperty({}, "maxConnections", { enumerable: true, get: () => (ran++, 4) }) });
  refuse({ contracts: Object.defineProperty([], "0", { enumerable: true, get: () => (ran++, "axis.audit") }) });
  refuse({ limits: new Map() });
  refuse({ limits: Object.create({ maxConnections: 4 }) });
  refuse({ limits: new Date() });
  assert.equal(ran, 0);
});

test("S3: a cyclic or enormous init message is refused quickly", () => {
  const cyc: Record<string, unknown> = {};
  cyc["self"] = cyc;
  assert.throws(() => parseHostConfig(validConfig({ limits: cyc }), new Redactor()), AxisError);
  let deep: unknown = {};
  for (let i = 0; i < 1_000; i++) deep = { d: deep };
  assert.throws(() => parseHostConfig(validConfig({ limits: deep }), new Redactor()), AxisError);
  const wide: Record<string, number> = {};
  for (let i = 0; i < 100_000; i++) wide[`k${i}`] = i;
  const started = Date.now();
  assert.throws(() => parseHostConfig(validConfig({ limits: wide }), new Redactor()), AxisError);
  assert.ok(Date.now() - started < 1_000);
});

test("N4: the logger refuses an unbounded queue size", () => {
  for (const queueSize of [NaN, -1, 0, 1.5, Infinity, 100_001]) {
    assert.throws(() => createLogger({ redactor: new Redactor(), clock: fakeClock(), sink: { write: () => undefined }, queueSize }), AxisError, String(queueSize));
  }
});

test("N7: an object with huge numbers of unknown keys costs a bounded walk", () => {
  const { logger, lines } = rig();
  const fields: Record<string, number> = { count: 1 };
  for (let i = 0; i < 300_000; i++) fields[`junk${i}`] = i;
  const started = Date.now();
  logger.info("request.failed", fields);
  assert.ok(Date.now() - started < 500);
  assert.ok((JSON.parse(lines[0] as string) as Record<string, number>)["fieldsDropped"]! >= 1000);
});

/** Run `body` in a fresh process and report how it ended. */
function child(body: string): Promise<{ code: number | null; timedOut: boolean }> {
  const url = new URL("../src/index.js", import.meta.url).href;
  const script = `import { Disposables } from ${JSON.stringify(url)};\n${body}`;
  return new Promise((resolve) => {
    const proc = execFile(process.execPath, ["--input-type=module", "-e", script], { timeout: 4_000, killSignal: "SIGKILL" }, (err) => {
      const code = err === null ? 0 : ((err as { code?: number | string }).code as number | string);
      resolve({ code: typeof code === "number" ? code : null, timedOut: proc.killed });
    });
  });
}

test("N1: unref'ed timers let the process exit by draining; the check fails without unref", async () => {
  const ok = await child("const d = new Disposables(); d.setInterval(() => {}, 60000); d.setTimeout(() => {}, 60000);");
  assert.deepEqual(ok, { code: 0, timedOut: false });
  // The control: a plain ref'ed timer keeps the same process alive until the harness kills it.
  const control = await child("setInterval(() => {}, 60000);");
  assert.equal(control.timedOut, true, "the harness detects a process that cannot drain");
});
