// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Redactor } from "@axis/audit";
import { createLogger, LOG_EVENTS, type LogFields, type LoggerOptions, type LogSink } from "../src/index.js";
import { fakeClock, processSnapshot } from "./helpers.js";

/** Credential-shaped canaries, assembled at runtime so the source holds no literal. */
const githubToken = (): string => ["gh", "p_"].join("") + "Ab1".repeat(12);
const anthropicKey = (): string => ["sk", "ant", "api03", "Zq".repeat(20)].join("-");

function rig(over: Partial<LoggerOptions> = {}, sink?: LogSink) {
  const lines: string[] = [];
  const redactor = new Redactor();
  const logger = createLogger({
    redactor, clock: fakeClock(), sink: sink ?? { write: (l) => void lines.push(l) }, level: "debug", ...over,
  });
  return { lines, logger, redactor, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test("a record is one JSON line with ts, level, event and the allowed fields", () => {
  const { logger, parsed } = rig();
  logger.info("host.ready", { correlationId: "c-1", workspaceId: "ws-1", count: 3, durationMs: 12.5 });
  assert.deepEqual(parsed(), [{ ts: "2023-11-14T22:13:20.000Z", level: "info", event: "host.ready", correlationId: "c-1", workspaceId: "ws-1", count: 3, durationMs: 12.5 }]);
});

test("levels below the threshold are dropped", () => {
  const { logger, lines } = rig({ level: "warn" });
  logger.debug("host.starting");
  logger.info("host.starting");
  logger.warn("host.degraded");
  logger.error("host.crash");
  assert.equal(lines.length, 2);
});

test("the event set is closed: an unknown event becomes log.invalid and its text is not logged", () => {
  const { logger, parsed } = rig();
  logger.info(`evil-${anthropicKey()}` as never);
  assert.deepEqual(parsed().map((r) => r["event"]), ["log.invalid"]);
  assert.ok(!JSON.stringify(parsed()).includes("evil"));
});

test("the field set is closed: unknown names are counted, never copied", () => {
  const { logger, parsed } = rig();
  const fields = { workspaceId: "ws-1", payload: { a: 1 }, path: "/home/user/project", message: "text", [anthropicKey()]: "v" } as unknown as LogFields;
  logger.info("request.failed", fields);
  const r = parsed()[0] as Record<string, unknown>;
  assert.equal(r["workspaceId"], "ws-1");
  assert.equal(r["fieldsDropped"], 4);
  const text = JSON.stringify(r);
  assert.ok(!text.includes("/home/user") && !text.includes("text") && !text.includes("sk-ant"));
});

test("string fields are redacted: patterns and registered secrets", () => {
  const { logger, redactor, lines } = rig();
  const registered = randomBytes(24).toString("hex");
  redactor.registerSecret(registered);
  logger.info("request.failed", { reason: `got ${githubToken()} and ${anthropicKey()} and ${registered}`, correlationId: registered });
  const text = lines.join("\n");
  for (const secret of [githubToken(), anthropicKey(), registered]) assert.ok(!text.includes(secret));
  assert.match(text, /REDACTED/);
});

test("an error is summarised, never serialised: no message, cause or stack", () => {
  const { logger, lines } = rig();
  const err = Object.assign(new Error(`failed with ${anthropicKey()}`), { code: "ENOENT", cause: new Error(githubToken()) });
  logger.error("request.failed", { error: err, correlationId: "c" });
  const text = lines.join("\n");
  assert.ok(!text.includes("failed with") && !text.includes("sk-ant") && !text.includes("ghp_") && !text.includes("at "));
  assert.deepEqual(JSON.parse(text), { ts: "2023-11-14T22:13:20.000Z", level: "error", event: "request.failed", correlationId: "c", errorName: "Error", errno: "ENOENT" });
});

test("hostile values: getters are never run and count as dropped", () => {
  const { logger, parsed } = rig();
  let ran = 0;
  const fields = {};
  Object.defineProperty(fields, "workspaceId", { enumerable: true, get: () => (ran++, anthropicKey()) });
  Object.defineProperty(fields, "error", { enumerable: true, get: () => (ran++, new Error(anthropicKey())) });
  Object.defineProperty(fields, "count", { enumerable: true, value: 2 });
  logger.info("request.failed", fields);
  assert.equal(ran, 0);
  assert.deepEqual(parsed()[0], { ts: "2023-11-14T22:13:20.000Z", level: "info", event: "request.failed", count: 2, fieldsDropped: 2 });
});

test("hostile values: a Proxy as the fields object is not read at all", () => {
  const { logger, parsed } = rig();
  let trapped = 0;
  const trap = (): never => { trapped++; throw new Error(anthropicKey()); };
  const proxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  logger.warn("request.failed", proxy as LogFields);
  assert.equal(trapped, 0);
  assert.deepEqual(parsed()[0], { ts: "2023-11-14T22:13:20.000Z", level: "warn", event: "request.failed", reason: "fields_unreadable" });
  // A Proxy as an error value is summarised without a trap too.
  logger.warn("request.failed", { error: proxy });
  assert.equal(trapped, 0);
});

test("hostile values: cyclic and object values are dropped, not walked", () => {
  const { logger, lines } = rig();
  const cyc: Record<string, unknown> = { a: anthropicKey() };
  cyc["self"] = cyc;
  logger.info("request.failed", { workspaceId: cyc, runId: [cyc], projectId: () => 1, contract: Symbol("x"), method: 5n } as unknown as LogFields);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]?.includes("sk-ant"));
  assert.equal((JSON.parse(lines[0] as string) as Record<string, unknown>)["fieldsDropped"], 5);
});

test("hostile values: a huge string is cut before it is redacted and cost stays bounded", () => {
  const { logger, lines } = rig();
  const huge = "x".repeat(50_000_000);
  const started = process.hrtime.bigint();
  logger.info("request.failed", { reason: huge, correlationId: huge + anthropicKey() });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1_000, `took ${ms} ms`);
  assert.ok((lines[0] as string).length <= 2048);
  assert.ok(!(lines[0] as string).includes("sk-ant"));
});

test("hostile values: non-finite numbers, lone surrogates, control characters, a __proto__ field", () => {
  const { logger, lines } = rig();
  logger.info("request.failed", { count: NaN, durationMs: Infinity, reason: "a\ud800b\u0000c\nd" });
  logger.info("request.failed", JSON.parse('{"__proto__": {"workspaceId": "x"}, "runId": "r"}') as LogFields);
  for (const l of lines) JSON.parse(l);
  const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
  assert.equal(second["runId"], "r");
  assert.equal(second["fieldsDropped"], 1);
  assert.equal(second["workspaceId"], undefined);
  assert.equal(({} as Record<string, unknown>)["workspaceId"], undefined);
});

test("every field and event used by a record is ASCII-safe JSON on one line", () => {
  const { logger, lines } = rig();
  for (const event of LOG_EVENTS) logger.info(event, { reason: "line1\nline2\r\n " });
  assert.equal(lines.length, LOG_EVENTS.length);
  for (const l of lines) assert.ok(!/[\r\n]/.test(l));
});

test("an oversized record is replaced by a minimal one", () => {
  const { logger, parsed } = rig();
  const long = (): string => Array.from({ length: 200 }, (_, i) => `v${i}`).join(",");
  logger.info("request.failed", { correlationId: long(), reason: long(), workspaceId: long(), projectId: long(), runId: long(), windowId: long(), connectionId: long(), contract: long(), method: long() });
  const r = parsed()[0] as Record<string, unknown>;
  assert.ok(r["truncated"] === true || JSON.stringify(r).length <= 2048);
});

test("a throwing sink never throws into the caller and is counted", () => {
  const { logger } = rig({}, { write: () => { throw new Error(anthropicKey()); } });
  assert.doesNotThrow(() => logger.error("host.crash", { error: new Error("x") }));
  assert.equal(logger.stats().sinkErrors, 1);
  assert.equal(logger.stats().queued, 0);
});

test("a throwing clock or redactor does not throw into the caller", () => {
  const lines: string[] = [];
  const clock = { now: () => { throw new Error("clock"); }, monotonic: () => 0 };
  const logger = createLogger({ redactor: new Redactor(), clock, sink: { write: (l) => void lines.push(l) } });
  logger.info("host.ready");
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /1970-01-01/);
  const bad = { redactString: () => { throw new Error("x"); } } as unknown as Redactor;
  const logger2 = createLogger({ redactor: bad, clock: fakeClock(), sink: { write: () => undefined } });
  assert.doesNotThrow(() => logger2.info("host.ready", { reason: "x" }));
});

test("backpressure: records are held in a bounded queue and written on drain, oldest low levels dropped first", () => {
  const lines: string[] = [];
  let open = false;
  const { logger } = rig({ queueSize: 16 }, { write: (l) => { lines.push(l); return open ? undefined : false; } });
  logger.info("host.starting"); // written, and the sink asks for a pause
  assert.equal(lines.length, 1);
  logger.error("host.crash", { reason: "keep-me" });
  for (let i = 0; i < 100; i++) logger.debug("request.failed", { count: i });
  assert.equal(logger.stats().queued, 16);
  assert.equal(logger.stats().dropped, 85);
  open = true;
  logger.drain();
  assert.equal(logger.stats().queued, 0);
  const all = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(all.some((r) => r["event"] === "host.crash" && r["reason"] === "keep-me"), "the error record survived the overflow");
  const dropped = all.find((r) => r["event"] === "log.dropped");
  assert.equal(dropped?.["count"], 85);
  assert.equal(all.filter((r) => r["event"] === "log.dropped").length, 1);
  // The surviving debug records are the newest ones.
  const counts = all.filter((r) => r["event"] === "request.failed").map((r) => r["count"] as number);
  assert.deepEqual(counts, Array.from({ length: 15 }, (_, i) => 85 + i));
});

test("a sink that logs from inside write does not recurse", () => {
  const lines: string[] = [];
  let depth = 0;
  let max = 0;
  const holder: { logger?: ReturnType<typeof createLogger> } = {};
  const logger = createLogger({
    redactor: new Redactor(), clock: fakeClock(), level: "debug",
    sink: { write: (l) => { depth++; max = Math.max(max, depth); lines.push(l); if (lines.length < 5) holder.logger?.info("host.ready"); depth--; } },
  });
  holder.logger = logger;
  logger.info("host.starting");
  assert.equal(lines.length, 5);
  assert.equal(max, 1);
});

test("a flood is bounded in memory even when the sink never accepts", () => {
  const { logger } = rig({ queueSize: 32 }, { write: () => false });
  for (let i = 0; i < 200_000; i++) logger.info("request.failed", { count: i });
  assert.ok(logger.stats().queued <= 32);
  assert.ok(logger.stats().dropped > 199_000);
});

test("no timers, immediates or process listeners are created", () => {
  const before = processSnapshot();
  const { logger } = rig({}, { write: () => false });
  for (let i = 0; i < 1000; i++) logger.info("host.ready", { error: new Error("x") });
  logger.drain();
  assert.deepEqual(processSnapshot(), before);
});
