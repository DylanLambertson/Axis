// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Sample } from "./suite.js";

const T0 = "2026-11-04T10:00:00.000Z";
const T1 = "2026-11-04T10:00:01.500Z";
const T2 = "2026-11-04T10:00:05.000Z";

export const reviewing = { id: "run-1", workspaceId: "ws-1", state: "REVIEWING", reason: null, exitCode: 0, createdAt: T0, updatedAt: T2, startedAt: T1, endedAt: null };
export const queued = { id: "run-2", workspaceId: "ws-1", state: "QUEUED", reason: null, exitCode: null, createdAt: T0, updatedAt: T0, startedAt: null, endedAt: null };
export const failed = { id: "run-3", workspaceId: "ws_2", state: "FAILED", reason: "CLI_EXITED", exitCode: 1, createdAt: T0, updatedAt: T2, startedAt: T1, endedAt: T2 };
export const cancelledEarly = { id: "run-4", workspaceId: "ws-1", state: "CANCELLED", reason: "USER_CANCELLED", exitCode: null, createdAt: T0, updatedAt: T1, startedAt: null, endedAt: T1 };
export const blocked = { id: "run-5", workspaceId: "ws-1", state: "BLOCKED", reason: "INTERRUPTED_BY_RESTART", exitCode: null, createdAt: T0, updatedAt: T2, startedAt: T1, endedAt: null };

/** A nullable field replaced by null stays valid; these are the variants that are. */
const NULLABLE = /^null at (run|runs\.\d+)\.(reason|exitCode)$/;

export const P1C_SAMPLES: readonly Sample[] = [
  { contract: "axis.cli-runs", method: "start", side: "request", name: "start", value: { workspaceId: "ws-1", agentId: "fake" } },
  { contract: "axis.cli-runs", method: "start", side: "response", name: "queued run", value: { run: queued } },
  { contract: "axis.cli-runs", method: "stop", side: "request", name: "stop", value: { runId: "run-1" } },
  { contract: "axis.cli-runs", method: "stop", side: "response", name: "cancelled run", value: { run: cancelledEarly }, toleratedPattern: NULLABLE },
  { contract: "axis.cli-runs", method: "get", side: "request", name: "get", value: { runId: "run-2" } },
  { contract: "axis.cli-runs", method: "get", side: "response", name: "reviewing run", value: { run: reviewing }, toleratedPattern: NULLABLE },
  { contract: "axis.cli-runs", method: "get", side: "response", name: "failed run", value: { run: failed }, toleratedPattern: NULLABLE },
  { contract: "axis.cli-runs", method: "list", side: "request", name: "minimal", value: {} },
  { contract: "axis.cli-runs", method: "list", side: "request", name: "filtered", value: { workspaceId: "ws-1", states: ["RUNNING", "BLOCKED"] } },
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
        { providerId: "mock", displayName: "Mock provider", apiVersion: 1, connectionId: "conn-mock", destination: { description: "Stays on this machine" } },
        {
          providerId: "anthropic",
          displayName: "Anthropic",
          apiVersion: 1,
          connectionId: "conn-1",
          destination: { origin: "https://api.anthropic.com", description: "Anthropic Messages API" },
        },
      ],
    },
  },
];
