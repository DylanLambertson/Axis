// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The headless slice host's snapshotter: the production one with a hang-guard bound for a loaded host. A fixed 3 s take failed
// `cli-runs.start` with `snapshot_failed` when many builds ran at once; the bound must stay far above that and the config it
// reaches the supervisor through must stay wired.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SNAPSHOT_TAKE_MS, SUPERVISOR_SNAPSHOT_MS } from "../src/index.js";
import { SLICE_SNAPSHOT_TAKE_MS } from "../testing/slice-snapshotter.js";

test("the slice host raises the supervisor's bound through the host config, and the composition wires it to the runs binding", () => {
  assert.ok(SLICE_SNAPSHOT_TAKE_MS >= 10 * SNAPSHOT_TAKE_MS, "far above the production bound");
  assert.ok(SLICE_SNAPSHOT_TAKE_MS * 2 <= 300_000, "inside the config's ceiling for the supervisor bound");
  assert.ok(SUPERVISOR_SNAPSHOT_MS < SLICE_SNAPSHOT_TAKE_MS * 2, "above the supervisor's own default");
  const host = readFileSync(new URL("../../testing/slice-host.ts", import.meta.url), "utf8");
  assert.match(host, /runSnapshotTimeoutMs: SLICE_SNAPSHOT_TAKE_MS \* 2/);
  assert.match(host, /snapshotter: sliceSnapshotter\(\)/);
  const compose = readFileSync(new URL("../../src/compose.ts", import.meta.url), "utf8");
  assert.match(compose, /limits: \{ snapshotTimeoutMs: config\.limits\.runSnapshotTimeoutMs \}/);
});
