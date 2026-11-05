// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLI_RUNS_CONTRACT,
  MAX_CLI_RUNS_LIST,
  MAX_PROVIDERS,
  RUN_STATUS_VALUES,
  SNAPSHOT_AFTER_VALUES,
  cliRunSchema,
  contractIdSchema,
  lookupMethod,
} from "../src/index.js";
import { P1C_SAMPLES, blocked, cancelledEarly, failed, queued, reviewing } from "./samples-p1c.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(P1C_SAMPLES);

const C = "axis.cli-runs";
const startReq = () => schemaOf(C, "start", "request");
const stopReq = () => schemaOf(C, "stop", "request");
const getReq = () => schemaOf(C, "get", "request");
const getRes = () => schemaOf(C, "get", "response");
const listReq = () => schemaOf(C, "list", "request");
const listRes = () => schemaOf(C, "list", "response");
const providersRes = () => schemaOf("axis.providers", "list", "response");

const run = (patch: Record<string, unknown> = {}) => ({ ...structuredClone(reviewing), ...patch });
const provider = (patch: Record<string, unknown> = {}) => ({
  providerId: "mock",
  displayName: "Mock",
  apiVersion: 1,
  connectionId: "conn-1",
  destination: { description: "Local" },
  ...patch,
});

test("the design's name axis.cliRuns is not a legal contract id, so the contract is axis.cli-runs", () => {
  assert.equal(CLI_RUNS_CONTRACT, "axis.cli-runs");
  assert.equal(contractIdSchema.safeParse("axis.cliRuns").success, false);
  assert.equal(contractIdSchema.safeParse("axis.cli-runs").success, true);
  assert.equal(lookupMethod("axis.cliRuns", 1, "start"), undefined);
  assert.notEqual(lookupMethod("axis.cli-runs", 1, "start"), undefined);
});

test("cli-runs.start: a workspace id and a CLI agent id, nothing else", () => {
  accepts(startReq(), { workspaceId: "ws-1", agentId: "claude" }, "claude");
  accepts(startReq(), { workspaceId: "ws-1", agentId: "a.b_c-1" }, "all allowed characters");
  accepts(startReq(), { workspaceId: "ws-1", agentId: "a".repeat(64) }, "agent id at 64");
  for (const k of ["command", "args", "env", "path", "cwd", "executable", "actor", "approval", "model"]) {
    rejects(startReq(), { workspaceId: "ws-1", agentId: "fake", [k]: "x" }, k);
  }
  for (const agentId of ["", "A", "Claude", "-x", ".x", "a b", "a/b", "../x", "a;b", "a$(x)", "a\nb", "a".repeat(65), 1, null]) {
    rejects(startReq(), { workspaceId: "ws-1", agentId }, JSON.stringify(agentId));
  }
  for (const workspaceId of ["", "../x", "a/b", "a b", "x".repeat(65), 1, null, undefined]) {
    rejects(startReq(), { workspaceId, agentId: "fake" }, JSON.stringify(workspaceId));
  }
  rejects(startReq(), { workspaceId: "ws-1" }, "agentId missing");
  rejects(startReq(), { agentId: "fake" }, "workspaceId missing");
});

test("cli-runs.stop and get take one run id", () => {
  for (const req of [stopReq(), getReq()]) {
    accepts(req, { runId: "run-1" }, "run id");
    for (const runId of ["", "../x", "a/b", "x".repeat(65), 1, null]) rejects(req, { runId }, JSON.stringify(runId));
    rejects(req, { runId: "run-1", force: true }, "force");
    rejects(req, { runId: "run-1", signal: "SIGKILL" }, "signal");
    rejects(req, {}, "empty");
  }
});

test("cli-runs.list request: workspace, a bounded limit and an opaque bounded cursor", () => {
  accepts(listReq(), { workspaceId: "ws-1" }, "workspace only");
  accepts(listReq(), { limit: 1 }, "limit 1");
  accepts(listReq(), { limit: MAX_CLI_RUNS_LIST }, "limit at the cap");
  accepts(listReq(), { cursor: "a".repeat(128) }, "cursor at 128");
  for (const limit of [0, -1, MAX_CLI_RUNS_LIST + 1, 1000, 1_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
    rejects(listReq(), { limit }, `limit ${String(limit)}`);
  }
  for (const cursor of ["", "a".repeat(129), "a b", "../x", "a/b", "a\nb", "\u00e9", 1, null, { a: 1 }]) {
    rejects(listReq(), { cursor }, JSON.stringify(cursor));
  }
  for (const k of ["states", "offset", "page", "before", "after", "afterId"]) rejects(listReq(), { [k]: 1 }, k);
  rejects(listReq(), { workspaceId: "../x" }, "bad workspace");
});

test("cli-runs.list: a workspace with more runs than one page pages instead of failing", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...structuredClone(reviewing), runId: `run-${i}` }));
  accepts(listRes(), { runs: many(MAX_CLI_RUNS_LIST), next: "older-501" }, "a full page with a cursor for the 501st run");
  accepts(listRes(), { runs: many(1), next: null }, "the last page");
  rejects(listRes(), { runs: many(MAX_CLI_RUNS_LIST + 1), next: null }, "501 runs in one reply");
  rejects(listRes(), { runs: many(1) }, "next missing");
  for (const next of ["", "a b", "x".repeat(129), 5, undefined]) rejects(listRes(), { runs: many(1), next }, JSON.stringify(next));
});

test("cli-runs run: the fields and enums are those of @axis/runs RunSummary", () => {
  assert.deepEqual([...RUN_STATUS_VALUES], ["starting", "running", "quiet", "finished", "failed", "killed", "interrupted", "stopping"]);
  assert.deepEqual([...SNAPSHOT_AFTER_VALUES], ["pending", "ok", "drift", "unknown"]);
  assert.deepEqual(Object.keys(cliRunSchema.def.shape ?? {}).sort(), [
    "agentId", "createdAt", "droppedChars", "endedAt", "exitCode", "lastOutputAt", "live", "outputChars", "reason", "runId",
    "snapshotAfter", "startedAt", "state", "status", "workspaceId",
  ]);
  for (const status of RUN_STATUS_VALUES) accepts(getRes(), { run: run({ status }) }, status);
  for (const status of ["done", "exited", "RUNNING", "", null, 1]) rejects(getRes(), { run: run({ status }) }, String(status));
  for (const snapshotAfter of SNAPSHOT_AFTER_VALUES) accepts(getRes(), { run: run({ snapshotAfter }) }, snapshotAfter);
  for (const snapshotAfter of ["true", "false", "changed", "", null, true]) rejects(getRes(), { run: run({ snapshotAfter }) }, String(snapshotAfter));
  rejects(getRes(), { run: run({ id: "run-1" }) }, "id beside runId");
  const { runId: _r, ...noRunId } = run();
  rejects(getRes(), { run: { ...noRunId, id: "run-1" } }, "id instead of runId");
  rejects(getRes(), { run: run({ updatedAt: "2026-11-04T10:00:05.000Z" }) }, "updatedAt is not a field of RunSummary");
  for (const [k, v] of [["live", "yes"], ["lastOutputAt", -1], ["lastOutputAt", 1.5], ["outputChars", -1], ["droppedChars", Number.NaN], ["agentId", "Bad Id"], ["agentId", 5]] as const) {
    rejects(getRes(), { run: run({ [k]: v }) }, `${k} ${String(v)}`);
  }
  accepts(getRes(), { run: run({ agentId: null, lastOutputAt: null }) }, "unknown agent, no output yet");
});

test("cli-runs.start response says whether the idempotency key replayed", () => {
  const res = schemaOf(C, "start", "response");
  accepts(res, { run: queued, replayed: true }, "replayed");
  rejects(res, { run: queued }, "replayed missing");
  rejects(res, { run: queued, replayed: "no" }, "replayed as string");
});

test("cli-runs run: state, reason, exit code and timestamps", () => {
  for (const r of [reviewing, queued, failed, cancelledEarly, blocked]) accepts(getRes(), { run: structuredClone(r) }, r.state);
  const bad: Record<string, Record<string, unknown>> = {
    "unknown state": { state: "DONE" },
    "lower-case state": { state: "running" },
    "reason with a space": { reason: "not a code" },
    "reason lower-case": { reason: "cli_exited" },
    "reason 65 chars": { reason: `A${"B".repeat(64)}` },
    "exit code 256": { exitCode: 256 },
    "exit code -256": { exitCode: -256 },
    "exit code fraction": { exitCode: 1.5 },
    "exit code NaN": { exitCode: Number.NaN },
    "exit code as string": { exitCode: "0" },
    "createdAt date only": { createdAt: "2026-11-04" },
    "createdAt not a real date": { createdAt: "2026-99-99T99:99:99.999Z" },
    "createdAt year zero": { createdAt: "0000-00-00T00:00:00.000Z" },
    "createdAt 30 February": { createdAt: "2026-02-30T10:00:00.000Z" },
    "createdAt offset": { createdAt: "2026-11-04T10:00:05.000+00:00" },
    "startedAt without millis": { startedAt: "2026-11-04T10:00:01Z" },
    "extra field": { pid: 4242 },
    "path field": { worktree: "/tmp/x" },
  };
  for (const [name, patch] of Object.entries(bad)) rejects(getRes(), { run: run(patch) }, name);
  accepts(getRes(), { run: run({ exitCode: 255 }) }, "exit code 255");
  accepts(getRes(), { run: run({ exitCode: -255 }) }, "exit code -255");
  accepts(getRes(), { run: run({ reason: `A${"B".repeat(63)}` }) }, "reason at 64");
  rejects(getRes(), { run: reviewing, extra: 1 }, "extra top-level field");
  rejects(getRes(), reviewing, "run not wrapped");
  rejects(getRes(), {}, "no run");
});

test("cli-runs run: endedAt is set exactly when the run is terminal, and only queued or cancelled runs can lack a start", () => {
  for (const state of ["COMPLETED", "FAILED", "CANCELLED"]) {
    accepts(getRes(), { run: run({ state, endedAt: "2026-11-04T10:00:05.000Z" }) }, `${state} ended`);
    rejects(getRes(), { run: run({ state, endedAt: null }) }, `${state} without endedAt`);
  }
  for (const state of ["QUEUED", "RUNNING", "REVIEWING", "BLOCKED"]) {
    accepts(getRes(), { run: run({ state, endedAt: null }) }, `${state} open`);
    rejects(getRes(), { run: run({ state, endedAt: "2026-11-04T10:00:05.000Z" }) }, `${state} with endedAt`);
  }
  for (const state of ["RUNNING", "REVIEWING", "BLOCKED"]) rejects(getRes(), { run: run({ state, startedAt: null }) }, `${state} never started`);
  for (const state of ["COMPLETED", "FAILED"]) rejects(getRes(), { run: run({ state, startedAt: null, endedAt: "2026-11-04T10:00:05.000Z" }) }, `${state} never started`);
  accepts(getRes(), { run: run({ state: "QUEUED", startedAt: "2026-11-04T10:00:01.500Z" }) }, "re-queued after a restart keeps its start");
  accepts(getRes(), { run: run({ state: "CANCELLED", startedAt: null, endedAt: "2026-11-04T10:00:05.000Z" }) }, "cancelled before it started");
});

test("cli-runs.list response: cap and unique ids", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...structuredClone(queued), runId: `run-${i}` }));
  accepts(listRes(), { runs: [], next: null }, "empty");
  accepts(listRes(), { runs: many(MAX_CLI_RUNS_LIST), next: null }, "at the cap");
  rejects(listRes(), { runs: many(MAX_CLI_RUNS_LIST + 1), next: null }, "over the cap");
  rejects(listRes(), { runs: [{ ...queued }, { ...queued }], next: null }, "duplicate run id (separate objects)");
});

test("providers.list: request takes nothing; response names adapters and destinations, never a credential", () => {
  rejects(schemaOf("axis.providers", "list", "request"), { connectionId: "c" }, "request with a field");
  accepts(providersRes(), { providers: [] }, "empty");
  accepts(providersRes(), { providers: [provider()] }, "mock");
  accepts(providersRes(), { providers: [provider({ destination: { origin: "http://localhost:11434", description: "Local server" } })] }, "http origin with a port");
  const bad: Record<string, Record<string, unknown>> = {
    "provider id upper": { providerId: "Anthropic" },
    "provider id with dot": { providerId: "a.b" },
    "provider id leading digit": { providerId: "1a" },
    "provider id 65": { providerId: `a${"b".repeat(64)}` },
    "display name empty": { displayName: "" },
    "display name bidi": { displayName: "a\u202eb" },
    "display name zero width": { displayName: "a\u200bb" },
    "display name newline": { displayName: "a\nb" },
    "display name line separator": { displayName: "a\u2028b" },
    "display name paragraph separator": { displayName: "a\u2029b" },
    "display name leading space": { displayName: " Mock" },
    "display name trailing space": { displayName: "Mock " },
    "display name 81": { displayName: "n".repeat(81) },
    "api version 0": { apiVersion: 0 },
    "api version NaN": { apiVersion: Number.NaN },
    "api version 1.5": { apiVersion: 1.5 },
    "connection id empty": { connectionId: "" },
    "connection id 257": { connectionId: "c".repeat(257) },
    "connection id with newline": { connectionId: "a\nb" },
    "connection id leading space": { connectionId: " c" },
    "connection id bidi": { connectionId: "a\u202eb" },
    "origin with a path": { destination: { origin: "https://api.example.com/v1", description: "d" } },
    "origin with credentials": { destination: { origin: "https://user@api.example.com", description: "d" } },
    "origin with a query": { destination: { origin: "https://api.example.com?x=1", description: "d" } },
    "origin with another scheme": { destination: { origin: "ftp://api.example.com", description: "d" } },
    "origin empty": { destination: { origin: "", description: "d" } },
    "origin 301": { destination: { origin: `https://${"a".repeat(293)}`, description: "d" } },
    "description empty": { destination: { description: "" } },
    "description trailing space": { destination: { description: "d " } },
    "description bidi": { destination: { description: "a\u202eb" } },
    "description 257": { destination: { description: "d".repeat(257) } },
    "destination extra field": { destination: { description: "d", token: "x" } },
    "no destination": { destination: undefined },
    "extra field": { apiKey: "x" },
    "credential field": { credential: "x" },
  };
  for (const [name, patch] of Object.entries(bad)) rejects(providersRes(), { providers: [provider(patch)] }, name);
  accepts(providersRes(), { providers: [provider({ providerId: `a${"b".repeat(63)}`, displayName: "n".repeat(80), connectionId: "c".repeat(256) })] }, "ids at their caps");
  const many = (n: number) => Array.from({ length: n }, (_, i) => provider({ connectionId: `conn-${i}` }));
  accepts(providersRes(), { providers: many(MAX_PROVIDERS) }, "at the cap");
  rejects(providersRes(), { providers: many(MAX_PROVIDERS + 1) }, "over the cap");
  rejects(providersRes(), { providers: [provider(), provider()] }, "duplicate connection id (separate objects)");
});
