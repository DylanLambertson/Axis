// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: the run snapshotter the headless slice host uses. It is the production one (`gitSnapshotRunSnapshotter`, the real
// GIT-SNAP-1 snapshot of ticket H13) with a longer wall-clock bound per take: a slice runs real git children on a host that may be
// running many other builds, and 3 s (the production bound) failed `cli-runs.start` with `snapshot_failed` there. The bound is a hang
// guard, not a condition: a take ends when git does.
import { createRunSnapshotter, type RunSnapshotterFactory, type SnapshotTaker } from "../src/index.js";

export const SLICE_SNAPSHOT_TAKE_MS = 60_000;

/** `takeSnapshot` is the library seam of `createRunSnapshotter`, for the test that pins the bound. */
export function sliceSnapshotter(takeSnapshot?: SnapshotTaker): RunSnapshotterFactory {
  return (deps) => createRunSnapshotter({ ...deps, takeMs: SLICE_SNAPSHOT_TAKE_MS }, undefined, takeSnapshot);
}
