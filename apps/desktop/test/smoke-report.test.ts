// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { PAGE_PROBE, SMOKE_MARKER, smokeLine, smokeReport, type SmokeTarget } from "../main/smoke.js";

function target(answers: unknown[], waits: number[] = []): SmokeTarget {
  let i = 0;
  return {
    title: () => "T",
    probe: async () => answers[Math.min(i++, answers.length - 1)],
    wait: async (ms) => {
      waits.push(ms);
    },
  };
}

const notYet = { mounted: false, node: false };
const ready = { mounted: true, node: false };

test("polls until the page mounts, waiting between polls only", async () => {
  const waits: number[] = [];
  assert.deepEqual(await smokeReport(target([notYet, notYet, notYet, ready], waits), 10, 7), { mounted: true, title: "T", nodeInPage: false });
  assert.deepEqual(waits, [7, 7, 7]);
});

test("gives up after the tries and reports not mounted", async () => {
  const waits: number[] = [];
  assert.equal((await smokeReport(target([notYet], waits), 4, 1)).mounted, false);
  assert.equal(waits.length, 4);
});

test("a Node global in the page is reported; a malformed probe reads as not mounted with Node visible", async () => {
  assert.equal((await smokeReport(target([{ mounted: true, node: true }]), 1, 1)).nodeInPage, true);
  for (const bad of [null, undefined, "x", { mounted: "yes" }, { mounted: true }]) {
    const r = await smokeReport(target([bad]), 1, 1);
    assert.equal(r.nodeInPage, true, String(bad));
    if (bad === null || typeof bad !== "object" || (bad as { mounted?: unknown }).mounted !== true) assert.equal(r.mounted, false);
  }
});

test("the page probe sees the mount marker and any of require, process or module", () => {
  const page = (mounted: boolean, extra: Record<string, unknown> = {}) =>
    runInNewContext(PAGE_PROBE, { document: { documentElement: { dataset: mounted ? { axisShell: "mounted" } : {} } }, ...extra });
  assert.deepEqual({ ...page(true) }, { mounted: true, node: false });
  assert.deepEqual({ ...page(false) }, { mounted: false, node: false });
  for (const g of ["require", "process", "module"]) assert.equal(page(true, { [g]: {} }).node, true, g);
});

test("the line is the marker and the JSON report", () => {
  const r = { mounted: true, title: "T", nodeInPage: false };
  assert.equal(smokeLine(r), `${SMOKE_MARKER} ${JSON.stringify(r)}`);
  assert.equal(SMOKE_MARKER, "AXIS_DESKTOP_SMOKE");
});
