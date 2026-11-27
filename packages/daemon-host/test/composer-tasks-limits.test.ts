// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATE_TASK, WORKER_CREATES_PER_RUN } from "../src/index.js";
import { denyAll, drive } from "./messages-delivery-rig.js";
import { USER, call, tasksRig } from "./tasks-rig.js";

// The per-run cap (`tasks-store.md` §4.1, RR-93 decision C1) through the real broker and loop: one composer run creates at
// most 25 tasks, and a new run counts from zero. Mutants: no cap, a cap per project (or per worker) instead of per run, a
// counter that survives across runs, the user's own creates counted.

/** `n` create_task calls, at most 13 per reply (the loop takes 16 calls per reply), then the end. */
const creates = (n: number, tag: string) => {
  const all = Array.from({ length: n }, (_, i) => call(CREATE_TASK, { title: `${tag} ${i}`, body: "x" }));
  const turns: (typeof all)[] = [];
  for (let i = 0; i < all.length; i += 13) turns.push(all.slice(i, i + 13));
  return [...turns, []];
};
/** Every tool result of the run, in order. */
const outputs = (d: { results: string[][] }): string[] => d.results.slice(1).flat();
const refusal = (out: string | undefined): string | undefined => /^The call was refused \(([a-z_]+)\)/.exec(out ?? "")?.[1];

test("one run creates at most 25 tasks; the 26th is limit_reached and writes nothing", async (t) => {
  const p = await tasksRig(t);
  assert.equal(WORKER_CREATES_PER_RUN, 25);
  const d = drive(p.r, p.run("w1"), creates(26, "A"));
  assert.equal(await denyAll(p.r, d.end), 0, "an untainted run asks nothing");
  const out = outputs(d);
  assert.equal(out.filter((x) => /^created task t[0-9a-f]{32}, revision 1$/.test(x)).length, 25);
  assert.equal(refusal(out[25]), "limit_reached", "kills no cap");
  assert.equal(p.svc.list({ projectId: "p" }).tasks.length, 25);
});

test("a new run of the same worker counts from zero, and the user's own creates are not counted", async (t) => {
  const p = await tasksRig(t);
  const first = drive(p.r, p.run("w1"), creates(25, "A"));
  await first.end;
  for (let i = 0; i < 5; i++) p.svc.create(USER, { projectId: "p", title: `U ${i}`, body: "x" });
  const second = drive(p.r, p.run("w1"), creates(25, "B"));
  await second.end;
  assert.deepEqual(outputs(second).map(refusal).filter((r) => r !== undefined), [], "kills a cap per project or per worker, and a counter that survives the run");
  assert.equal(p.svc.list({ projectId: "p" }).tasks.length, 55);
});
