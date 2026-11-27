// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Redactor } from "@axis/audit";
import type { ShutdownResult } from "@axis/daemon";
import { createLogger, installHostLifecycle, type DisposeResult, type RelayOut } from "../src/index.js";
import { fakeClock } from "./helpers.js";
import { deliveryRig } from "./messages-delivery-rig.js";

// Endpoint gate line 6 (`inter-agent-cli-endpoint.md` section 7): the endpoint token appears nowhere in the journal, the
// audit log, the daemon's log lines or its crash output. The journal and audit half is `messages-endpoint.test.ts`; this
// is the log and crash half. The token is random, so the host redactor does not know it: what keeps it out is that no log
// call takes it, and that an error is logged only as a closed summary and a crash only as its origin.

const CLEAN: ShutdownResult = { reason: "t", graceful: true, escalated: false, cancelled: 0, unsettled: 0, flushed: "done" };
const OK_STOP: DisposeResult = { disposed: 1, failures: [] };

test("gate line 6: an endpoint session, its failures and a crash carrying the token leave it in no log line and no crash output", async (t) => {
  const lines: string[] = [];
  const logger = createLogger({ redactor: new Redactor(), clock: fakeClock(), sink: { write: (l) => void lines.push(l) }, level: "debug" });
  // The binding logs its swallowed failures as the host does (`hostMessagingDeps`): a closed reason.
  const r = await deliveryRig(t, { noDelivery: true, onInternalError: (code) => logger.warn("request.failed", { reason: `delivery_${code}` }) });
  r.c.journal.messages.setAgentSettings("c1", { acceptsFrom: "group", cliMessaging: true, muted: false });
  const runId = r.run("c1");
  const minted = r.m.endpoints.relay.mint(runId);
  assert.ok(minted !== undefined);
  const { endpointId: ep, token } = minted;
  const relay = (m: Parameters<typeof r.m.endpoints.relay.onRelay>[1]): Promise<readonly RelayOut[]> => r.m.endpoints.relay.onRelay(r.m.endpoints.source, m);
  const frame = (conn: string, body: unknown) => relay({ t: "relay-frame", endpoint: ep, conn, frame: typeof body === "string" ? body : JSON.stringify(body) });

  // A good session, failed tokens (one of them the real token with a character changed), a frame that carries the token
  // as text, an oversized frame, a send the service refuses, then revocation and a late frame.
  await relay({ t: "relay-open", endpoint: ep, conn: "c-1" });
  await frame("c-1", { op: "auth", token });
  await frame("c-1", { op: "send", id: "s1", recipients: [{ agent: "a1" }], body: `hello ${token}` });
  await frame("c-1", { op: "read", id: "r1" });
  await frame("c-1", `{"op":"send","id":"s2","recipients":[{"agent":"nobody"}],"body":"${token}"}`);
  for (let i = 0; i < 20; i++) {
    await relay({ t: "relay-open", endpoint: ep, conn: `b-${i}` });
    await frame(`b-${i}`, { op: "auth", token: `${token.slice(0, -1)}${i % 10}` });
  }
  await relay({ t: "relay-open", endpoint: ep, conn: "c-2" });
  await frame("c-2", `not json ${token}`);
  r.m.endpoints.relay.flush();
  r.m.endpoints.relay.revoke(runId);
  await frame("c-1", { op: "auth", token });

  // A handler that throws an error whose text holds the token is logged as the daemon does (`compose.ts`: the error field).
  logger.error("request.failed", { reason: "daemon_internal", error: Object.assign(new Error(`relay failed for ${token}`), { cause: token }) });

  // A crash whose error holds the token, through the host's own crash handler.
  const proc = new EventEmitter();
  const control = new EventEmitter();
  const crash = installHostLifecycle({
    daemon: { shutdown: async () => CLEAN, escalate: () => undefined },
    control: { onShutdown: (h) => (control.on("shutdown", h), () => void control.off("shutdown", h)) },
    stop: async () => OK_STOP,
    logger,
    exit: () => undefined,
    process: proc,
  });
  proc.emit("uncaughtException", new Error(`crashed holding ${token}`));
  await crash.finished;

  assert.ok(lines.length > 0, "the session and the crash did write log lines");
  assert.ok(lines.some((l) => l.includes('"host.crash"')), "the crash was logged");
  const all = lines.join("\n");
  assert.ok(!all.includes(token), "the token is in no log line and no crash output");
  // A part of it neither: a third of the token is long enough to matter and short enough to catch a cut copy.
  assert.ok(!all.includes(token.slice(0, Math.ceil(token.length / 3))), "nor a prefix of it");
});
