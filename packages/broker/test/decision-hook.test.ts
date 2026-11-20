// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AuditEventInput } from "@axis/audit";
import { ToolBroker, ToolPolicy, createCommandRunner, nodeBrokerFs, type ApprovalRequest, type DecisionHook } from "../src/index.js";
import { makeWorld } from "./helpers.js";
import { call, grant, why } from "./rig.js";

// The decision hook (ticket PV-M0, IAC-T): asked for every call, it can only raise a call to approval, and it wins over
// the floor; anything it answers that is not a clean answer denies the call.

const worlds: Array<{ cleanup(): void }> = [];
after(() => worlds.forEach((w) => w.cleanup()));

const input = (o: object = {}) => ({ tool: "t", tier: "write", protectedHit: false, protectedLabels: [], ...o });
const raise: DecisionHook = { decide: ({ tier }) => ({ approve: tier !== "read", reasons: tier === "read" ? [] : ["taint"] }) };

test("PV-M0: a raising hook makes a call need approval whatever the floor (a standing allow does not bypass it)", () => {
  // `privileged` is the most permissive floor there is: every lower tier runs without asking.
  const lax = new ToolPolicy({ approvalFloor: "privileged", hook: raise });
  assert.deepEqual(lax.decide(input({ tier: "write" })), { effect: "approve", tier: "write", reasons: ["taint"] });
  assert.deepEqual(lax.decide(input({ tier: "network" })), { effect: "approve", tier: "network", reasons: ["taint"] });
  assert.deepEqual(lax.decide(input({ tier: "read" })), { effect: "allow", tier: "read", reasons: [] });
  assert.equal(new ToolPolicy({ approvalFloor: "privileged" }).decide(input({ tier: "write" })).effect, "allow", "without the hook the floor allows it");
});

test("PV-M0: the hook never lowers: an answer of no keeps a protected or floor-level call at approve", () => {
  const no: DecisionHook = { decide: () => ({ approve: false, reasons: [] }) };
  const p = new ToolPolicy({ hook: no });
  assert.equal(p.decide(input({ tier: "network" })).effect, "approve");
  assert.equal(p.decide(input({ tier: "write", protectedHit: true, protectedLabels: ["github"] })).effect, "approve");
  assert.equal(p.decide(input({ tier: "write" })).effect, "allow");
});

test("PV-M0: the hook sees the tier the policy decided (raised by the launcher list), and its reasons are closed labels", () => {
  const seen: string[] = [];
  const p = new ToolPolicy({ hook: { decide: (c) => (seen.push(`${c.tool}:${c.tier}`), { approve: false, reasons: [] }) } });
  p.decide(input({ tool: "run", tier: "write", argv0: "/bin/sh" }));
  assert.deepEqual(seen, ["run:privileged"]);
});

test("PV-M0: a hook that throws or answers any other shape denies the call (fail closed)", () => {
  const bad: unknown[] = [
    undefined, null, "yes", { approve: "true", reasons: [] }, { approve: true }, { approve: true, reasons: "taint" },
    { approve: true, reasons: ["Taint!"] }, { approve: true, reasons: [7] }, { approve: false, reasons: Array(9).fill("x") },
  ];
  for (const out of bad) {
    const p = new ToolPolicy({ hook: { decide: () => out as never } });
    assert.deepEqual(p.decide(input()), { effect: "deny", reason: "decision-hook", reasons: ["the call could not be judged"] }, JSON.stringify(out));
  }
  const thrower = new ToolPolicy({ hook: { decide: () => { throw new Error("boom"); } } });
  assert.equal(thrower.decide(input()).effect, "deny");
});

function rig(hook: DecisionHook, approve: (r: ApprovalRequest) => unknown) {
  const w = makeWorld();
  worlds.push(w);
  const events: AuditEventInput[] = [];
  const requests: ApprovalRequest[] = [];
  const broker = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: (i) => (events.push(i), {} as never) }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: process.env["PATH"] ?? "", HOME: w.base }),
    approval: { request: async (r) => (requests.push(r), approve(r)) },
    policy: { approvalFloor: "privileged", hook },
  });
  broker.register({ name: "read_file", tier: "read", args: z.strictObject({ path: z.string() }), targets: (a) => [{ path: a.path, access: "read" }], run: async () => "text" });
  broker.register({
    name: "write_file", tier: "write", args: z.strictObject({ path: z.string() }), targets: (a) => [{ path: a.path, access: "write" }],
    run: async (ctx, a) => (await ctx.writeFile(a.path, Buffer.from("x"), { mode: "upsert", maxBytes: 10 }), "written"),
  });
  return { broker, w, events, requests };
}

test("PV-M0: the broker asks the hook for every call; a raised write is put to the user and the decision row records tier and reason", async () => {
  let asked = 0;
  const counted: DecisionHook = { decide: (c) => (asked++, raise.decide(c)) };
  const r = rig(counted, grant);
  writeFileSync(join(r.w.wt, "b.txt"), "b");
  assert.equal(await r.broker.invoke(call("read_file", { path: "b.txt" })), "text");
  assert.equal(await r.broker.invoke(call("write_file", { path: "a.txt" })), "written");
  assert.equal(asked, 2, "asked for the read as well as the write");
  assert.equal(r.requests.length, 1, "only the write needed the user");
  assert.deepEqual([r.requests[0]?.tool, r.requests[0]?.tier, r.requests[0]?.reasons], ["write_file", "write", ["taint"]]);
  const rows = r.events.filter((e) => e.action === "broker.decision").map((e) => e.payload as Record<string, unknown>);
  assert.deepEqual(rows.map((p) => [p["tool"], p["tier"], p["decision"], p["reasons"]]), [["read_file", "read", "allow", ""], ["write_file", "write", "approved", "taint"]]);
});

test("PV-M0: a declined raised write writes nothing; a failing hook refuses the call before anything runs", async () => {
  const declined = rig(raise, () => ({ approved: false }));
  assert.equal(await why(declined.broker.invoke(call("write_file", { path: "a.txt" }))), "E_POLICY_DENIED/approval-declined");
  assert.equal(existsSync(join(declined.w.wt, "a.txt")), false);
  const broken = rig({ decide: () => { throw new Error("boom"); } }, grant);
  writeFileSync(join(broken.w.wt, "b.txt"), "b");
  assert.equal(await why(broken.broker.invoke(call("write_file", { path: "a.txt" }))), "E_POLICY_DENIED/decision-hook");
  assert.equal(await why(broken.broker.invoke(call("read_file", { path: "b.txt" }))), "E_POLICY_DENIED/decision-hook", "a read too: the hook is asked for every call");
  assert.deepEqual([broken.requests.length, existsSync(join(broken.w.wt, "a.txt"))], [0, false]);
  const denied = broken.events.filter((e) => e.action === "broker.decision").map((e) => (e.payload as Record<string, unknown>)["reason"]);
  assert.deepEqual(denied, ["decision-hook", "decision-hook"]);
});

test("review N1: the hook's answer is read once: a getter that changes its answer after the check cannot lower the call", () => {
  let reads = 0;
  const shifty = { get approve() { return reads++ === 0; }, reasons: ["taint"] };
  const p = new ToolPolicy({ hook: { decide: () => shifty as never } });
  assert.deepEqual(p.decide(input({ tier: "write" })), { effect: "approve", tier: "write", reasons: ["taint"] });
  assert.equal(reads, 1);
});
