// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ACTIVITY_TEXT, MAX_PROMPT_CHARS, MAX_RUN_EVENTS, REFUSED_ACTIVITY } from "../src/index.js";
import { accepts, rejects, runSuite, schemaOf, type Sample } from "./suite.js";

const T0 = "2026-11-05T10:00:00.000Z";
const T1 = "2026-11-05T10:00:01.000Z";
const T2 = "2026-11-05T10:00:09.000Z";
const D = "c".repeat(64);

const running = { runId: "run-1", workspaceId: "ws-1", mode: "agent", providerId: "mock", modelId: "mock-model", state: "RUNNING", reason: null, createdAt: T0, startedAt: T1, endedAt: null, live: true, awaitingApproval: true, usage: { inputTokens: 10, outputTokens: 4, requests: 1 } };
const failed = { ...running, runId: "run-2", state: "FAILED", reason: "BUDGET_TOKENS", endedAt: T2, live: false, awaitingApproval: false };
const blocked = { ...running, runId: "run-3", mode: null, providerId: null, modelId: null, state: "BLOCKED", reason: "INTERRUPTED_BY_RESTART", live: false, awaitingApproval: false, usage: null };
const queued = { ...running, runId: "run-4", state: "QUEUED", startedAt: null, live: true, awaitingApproval: false, usage: null };

const events = [
  { seq: 1, at: T1, type: "state", state: "RUNNING", reason: null },
  { seq: 2, at: T1, type: "text", text: "line one\n\tline two" },
  { seq: 3, at: T1, type: "approval", tool: "write_file", state: "requested", digest: D, reasons: ["protected:github"], paths: [{ access: "write", path: ".github/workflows/ci.yml" }] },
  { seq: 4, at: T1, type: "tool", tool: "write_file", outcome: "error", reason: "approval_declined" },
  { seq: 5, at: T2, type: "usage", usage: { inputTokens: 10, outputTokens: 4, requests: 1 } },
];

const NULLABLE = /^((null|string) at (run|runs\.\d+)\.(mode|providerId|modelId|reason|usage))|null at events\.\d+\.reason$/;

const SAMPLES: readonly Sample[] = [
  { contract: "axis.runs", method: "start", side: "request", name: "start", value: { workspaceId: "ws-1", mode: "agent", prompt: "Fix the bug", providerId: "mock", modelId: "mock-model" } },
  { contract: "axis.runs", method: "start", side: "response", name: "running", value: { run: running, replayed: false }, toleratedPattern: NULLABLE },
  { contract: "axis.runs", method: "cancel", side: "request", name: "cancel", value: { runId: "run-1" } },
  { contract: "axis.runs", method: "get", side: "response", name: "failed", value: { run: failed }, toleratedPattern: NULLABLE },
  { contract: "axis.runs", method: "list", side: "request", name: "list", value: { workspaceId: "ws-1", limit: 200 } },
  { contract: "axis.runs", method: "list", side: "response", name: "mixed", value: { runs: [running, failed, blocked, queued].map((r) => structuredClone(r)) }, toleratedPattern: NULLABLE },
  { contract: "axis.runs", method: "events", side: "request", name: "events", value: { runId: "run-1", afterSeq: 0, limit: 200 } },
  { contract: "axis.runs", method: "events", side: "response", name: "all kinds", value: { events: structuredClone(events), nextSeq: 5, complete: false, available: true }, toleratedPattern: NULLABLE },
];

runSuite(SAMPLES);

const startReq = () => schemaOf("axis.runs", "start", "request");
const runRes = () => schemaOf("axis.runs", "get", "response");
const eventsRes = () => schemaOf("axis.runs", "events", "response");
const eventsReq = () => schemaOf("axis.runs", "events", "request");

test("runs.start: no path, command, credential or tool can ride along; mode, prompt and ids are bounded", () => {
  const ok = { workspaceId: "ws-1", mode: "ask", prompt: "p", providerId: "mock", modelId: "mock-model" };
  accepts(startReq(), ok, "minimal");
  for (const k of ["cwd", "path", "command", "argv", "env", "apiKey", "tools", "system", "actor", "windowId", "budget"]) rejects(startReq(), { ...ok, [k]: "x" }, k);
  for (const mode of ["Ask", "plan", "", null]) rejects(startReq(), { ...ok, mode }, `mode ${String(mode)}`);
  rejects(startReq(), { ...ok, prompt: "" }, "empty prompt");
  accepts(startReq(), { ...ok, prompt: "p".repeat(MAX_PROMPT_CHARS) }, "prompt at the cap");
  rejects(startReq(), { ...ok, prompt: "p".repeat(MAX_PROMPT_CHARS + 1) }, "prompt over the cap");
  for (const providerId of ["Mock", "../mock", "mock provider", ""]) rejects(startReq(), { ...ok, providerId }, `provider ${providerId}`);
  for (const modelId of ["a b", "", "m".repeat(257), "m\n"]) rejects(startReq(), { ...ok, modelId }, `model ${JSON.stringify(modelId)}`);
  rejects(startReq(), { ...ok, workspaceId: "../ws" }, "workspace id");
});

test("runs: a run is terminal exactly when it has an end, only a live run waits for approval", () => {
  accepts(runRes(), { run: running }, "running");
  rejects(runRes(), { run: { ...running, endedAt: T2 } }, "running with an end");
  rejects(runRes(), { run: { ...failed, endedAt: null } }, "failed without an end");
  rejects(runRes(), { run: { ...failed, awaitingApproval: true } }, "a dead run waiting for approval");
  rejects(runRes(), { run: { ...running, startedAt: null } }, "running without a start");
  rejects(runRes(), { run: { ...failed, reason: "budget tokens" } }, "free-text reason");
  rejects(runRes(), { run: { ...running, usage: { inputTokens: -1, outputTokens: 0, requests: 0 } } }, "negative usage");
});

test("runs.events: text is bounded and free of control and invisible characters except tab and newline", () => {
  const text = (t: string) => ({ events: [{ seq: 1, at: T1, type: "text", text: t }], nextSeq: 1, complete: false, available: true });
  accepts(eventsRes(), text("a\nb\tc"), "tab and newline");
  accepts(eventsRes(), text("x".repeat(MAX_ACTIVITY_TEXT)), "at the cap");
  rejects(eventsRes(), text("x".repeat(MAX_ACTIVITY_TEXT + 1)), "over the cap");
  rejects(eventsRes(), text(""), "empty");
  for (const bad of ["\r", "\u0000", "\u001b[31m", "\u007f", "\u0085", "‮", "​", " ", " ", "﻿", "\ud800"]) {
    rejects(eventsRes(), text(`a${bad}b`), JSON.stringify(bad));
    assert.equal(REFUSED_ACTIVITY.test(bad), true, JSON.stringify(bad));
  }
});

test("runs.events: order, cursor and availability are consistent", () => {
  const ev = (seq: number) => ({ seq, at: T1, type: "state", state: "RUNNING", reason: null });
  accepts(eventsRes(), { events: [], nextSeq: 7, complete: false, available: true }, "nothing new");
  rejects(eventsRes(), { events: [ev(2), ev(1)], nextSeq: 1, complete: false, available: true }, "out of order");
  rejects(eventsRes(), { events: [ev(1), ev(1)], nextSeq: 1, complete: false, available: true }, "repeated seq");
  rejects(eventsRes(), { events: [ev(1), ev(2)], nextSeq: 5, complete: false, available: true }, "cursor past the last event");
  accepts(eventsRes(), { events: [], nextSeq: 0, complete: true, available: false }, "unavailable");
  rejects(eventsRes(), { events: [], nextSeq: 0, complete: false, available: false }, "unavailable but not complete");
  rejects(eventsRes(), { events: [ev(1)], nextSeq: 1, complete: true, available: false }, "unavailable with events");
  rejects(eventsRes(), { events: Array.from({ length: MAX_RUN_EVENTS + 1 }, (_, i) => ev(i + 1)), nextSeq: MAX_RUN_EVENTS + 1, complete: false, available: true }, "over the cap");
  rejects(eventsReq(), { runId: "run-1", limit: MAX_RUN_EVENTS + 1 }, "limit over the cap");
  rejects(eventsReq(), { runId: "run-1", afterSeq: -1 }, "negative cursor");
});

test("runs.events: an approval names display paths and closed reasons only", () => {
  const ap = (over: Record<string, unknown>) => ({ events: [{ ...structuredClone(events[2] as object), ...over }], nextSeq: 3, complete: false, available: true });
  accepts(eventsRes(), ap({}), "as built");
  rejects(eventsRes(), ap({ paths: [{ access: "write", path: "a‮b" }] }), "bidi in a path");
  rejects(eventsRes(), ap({ paths: [{ access: "write", path: "" }] }), "empty path");
  rejects(eventsRes(), ap({ paths: [{ access: "exec", path: "a" }] }), "unknown access");
  rejects(eventsRes(), ap({ reasons: ["Protected: anything the model said"] }), "free-text reason");
  rejects(eventsRes(), ap({ digest: "C".repeat(64) }), "digest case");
  rejects(eventsRes(), ap({ state: "approvedByAgent" }), "unknown state");
  rejects(eventsRes(), ap({ tool: "Write File" }), "tool name");
  rejects(eventsRes(), ap({ preview: "{\"content\":\"...\"}" }), "argument preview");
});
