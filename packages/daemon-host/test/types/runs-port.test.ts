// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Compile-time check that the host's RunsService mirrors the real RunSupervisor. Only this file and the runs binding
// import @axis/runs; if the supervisor's shapes drift from the port, `tsc` fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSummary as RealSummary, RunSupervisor, StartRequest } from "@axis/runs";
import type { RunSummary, RunsService, RunsStartRequest } from "../../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <T extends true>(): T | undefined => undefined;

yes<Equal<RunSummary, RealSummary>>();
// The request, without the trust attestation (a class in the real package, an opaque brand in the port): same
// fields, same types, both directions.
yes<Equal<Omit<RunsStartRequest, "trust">, Omit<StartRequest, "trust">>>();
yes<Equal<Parameters<RunsService["start"]>[0], RunsStartRequest>>();
yes<Equal<Omit<Parameters<RunSupervisor["start"]>[0], "trust">, Omit<StartRequest, "trust">>>();
// Every method of the port exists on the supervisor with the same parameters and result (the supervisor's `start`
// takes a `TrustAttestation` class where the port holds an opaque brand, so `start` is compared without it).
yes<Equal<Parameters<RunsService["stop"]>, Parameters<RunSupervisor["stop"]>>>();
yes<Equal<ReturnType<RunsService["stop"]>, ReturnType<RunSupervisor["stop"]>>>();
yes<Equal<Parameters<RunsService["get"]>, Parameters<RunSupervisor["get"]>>>();
yes<Equal<ReturnType<RunsService["get"]>, ReturnType<RunSupervisor["get"]>>>();
yes<Equal<Parameters<RunsService["hasActiveRun"]>, Parameters<RunSupervisor["hasActiveRun"]>>>();
yes<Equal<ReturnType<RunsService["hasActiveRun"]>, ReturnType<RunSupervisor["hasActiveRun"]>>>();
yes<Equal<Parameters<RunsService["list"]>[0], Parameters<RunSupervisor["list"]>[0]>>();
yes<Equal<readonly RealSummary[], ReturnType<RunsService["list"]>>>();
yes<Equal<Awaited<ReturnType<RunsService["start"]>>["replayed"], Awaited<ReturnType<RunSupervisor["start"]>>["replayed"]>>();
yes<Equal<Awaited<ReturnType<RunsService["start"]>>["run"], RealSummary>>();

test("the RunsService port compiles against the real RunSupervisor", () => {
  assert.ok(true);
});
