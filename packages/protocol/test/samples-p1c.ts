// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Sample } from "./suite.js";

const T0 = "2026-11-04T10:00:00.000Z";
const T1 = "2026-11-04T10:00:01.500Z";
const T2 = "2026-11-04T10:00:05.000Z";

const live = { live: false, lastOutputAt: null, outputChars: 0, droppedChars: 0, snapshotAfter: "pending" };
export const reviewing = { runId: "run-1", workspaceId: "ws-1", agentId: "fake", state: "REVIEWING", status: "finished", reason: null, exitCode: 0, createdAt: T0, startedAt: T1, endedAt: null, ...live, lastOutputAt: 1_800_000_000_000, outputChars: 1200, droppedChars: 0, snapshotAfter: "ok" };
export const queued = { runId: "run-2", workspaceId: "ws-1", agentId: "fake", state: "QUEUED", status: "starting", reason: null, exitCode: null, createdAt: T0, startedAt: null, endedAt: null, ...live, live: true };
export const failed = { runId: "run-3", workspaceId: "ws_2", agentId: null, state: "FAILED", status: "failed", reason: "EXIT_NONZERO", exitCode: 1, createdAt: T0, startedAt: T1, endedAt: T2, ...live, snapshotAfter: "drift" };
export const cancelledEarly = { runId: "run-4", workspaceId: "ws-1", agentId: "claude", state: "CANCELLED", status: "failed", reason: "SPAWN_FAILED", exitCode: null, createdAt: T0, startedAt: null, endedAt: T1, ...live, snapshotAfter: "unknown" };
export const blocked = { runId: "run-5", workspaceId: "ws-1", agentId: "fake", state: "BLOCKED", status: "interrupted", reason: "INTERRUPTED_BY_RESTART", exitCode: null, createdAt: T0, startedAt: T1, endedAt: null, ...live };

/** A nullable field replaced by null stays valid; these are the variants that are. */
const NULLABLE = /^((null|string) at ((run|runs\.\d+)\.agentId)|null at ((run|runs\.\d+)\.(reason|exitCode|lastOutputAt)))$/;

export const P1C_SAMPLES: readonly Sample[] = [
  { contract: "axis.cli-runs", method: "start", side: "request", name: "start", value: { workspaceId: "ws-1", agentId: "fake" } },
  { contract: "axis.cli-runs", method: "start", side: "response", name: "queued run", toleratedPattern: NULLABLE, value: { run: queued, replayed: false } },
  { contract: "axis.cli-runs", method: "stop", side: "request", name: "stop", value: { runId: "run-1" } },
  { contract: "axis.cli-runs", method: "stop", side: "response", name: "cancelled run", value: { run: cancelledEarly }, toleratedPattern: NULLABLE },
  { contract: "axis.cli-runs", method: "get", side: "request", name: "get", value: { runId: "run-2" } },
  { contract: "axis.cli-runs", method: "get", side: "response", name: "reviewing run", value: { run: reviewing }, toleratedPattern: NULLABLE },
  { contract: "axis.cli-runs", method: "get", side: "response", name: "failed run", value: { run: failed }, toleratedPattern: NULLABLE },
  { contract: "axis.cli-runs", method: "list", side: "request", name: "minimal", value: {} },
  { contract: "axis.cli-runs", method: "list", side: "request", name: "workspace and limit", value: { workspaceId: "ws-1", limit: 500 } },
  {
    contract: "axis.cli-runs",
    method: "list",
    side: "response",
    name: "mixed runs",
    value: { runs: [reviewing, queued, failed, cancelledEarly, blocked].map((r) => structuredClone(r)) },
    toleratedPattern: NULLABLE,
  },
  { contract: "axis.providers", method: "list", side: "request", name: "empty", value: {} },
  {
    contract: "axis.providers",
    method: "list",
    side: "response",
    name: "mock and a network adapter",
    value: {
      providers: [
        { providerId: "mock", displayName: "Mock provider", apiVersion: 1, connectionId: "conn-mock", status: "ready", models: [{ modelId: "mock-model", displayName: "Mock model" }], destination: { description: "Stays on this machine" } },
        {
          providerId: "anthropic",
          displayName: "Anthropic",
          apiVersion: 1,
          connectionId: "conn-1",
          status: "unavailable",
          models: [],
          destination: { origin: "https://api.anthropic.com", description: "Anthropic Messages API" },
        },
      ],
    },
  },
];
