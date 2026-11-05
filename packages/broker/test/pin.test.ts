// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the fourth review: the program is pinned by file identity, the approved line is unambiguous
// and free of control characters, and the two copies the snapshot depends on are load-bearing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ToolBroker, createCommandRunner, nodeBrokerFs, type ApprovalRequest, type ToolContext } from "../src/index.js";
import { call, cleanupWorlds, def, gitRig, grant, rig, skipSh, why, worlds } from "./rig.js";
import { makeWorld } from "./helpers.js";

after(cleanupWorlds);
const lim = { timeoutMs: 5000, maxOutputBytes: 1000 };
const node = process.execPath;

/** A broker whose PATH is one directory; `mutate` runs after the policy decided and before the user's answer arrives. */
function pinRig(mutate: (bin: string) => void) {
  const w = makeWorld();
  worlds.push(w);
  const bin = join(w.base, "bin");
  mkdirSync(bin);
  const requests: ApprovalRequest[] = [];
  const broker = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: bin, HOME: w.base }),
    approval: { request: async (q: ApprovalRequest) => { requests.push(q); mutate(bin); return grant(q); } },
  });
  broker.register(def({ name: "t", tier: "network", args: z.strictObject({}), argv: () => ["prog"], run: async (ctx: ToolContext) => ctx.run({ command: "prog", args: [], ...lim }) }));
  return { w, bin, broker, requests };
}
const truth = (): string => realpathSync("/bin/true");
const shell = (): string => realpathSync("/bin/sh");

// R4-A -------------------------------------------------------------------------------------------------------------

test("R4-A: a different file renamed over the pinned path while the approval is pending does not run", { skip: skipSh }, async () => {
  const marker = (b: string): string => join(b, "..", "wt", "made.txt");
  const r = pinRig((bin) => {
    // A copy of a shell, the pinned file's own name: its path string is unchanged.
    copyFileSync(shell(), join(bin, "prog.new"));
    renameSync(join(bin, "prog.new"), join(bin, "prog"));
  });
  copyFileSync(truth(), join(r.bin, "prog"));
  chmodSync(join(r.bin, "prog"), 0o755);
  assert.equal(await why(r.broker.invoke(call("t", {}))), "E_POLICY_DENIED/program-changed");
  assert.equal(existsSync(marker(r.bin)), false);
});

test("R4-A: a program edited in place after the decision does not run", { skip: skipSh }, async () => {
  const r = pinRig((bin) => appendFileSync(join(bin, "prog"), "\n"));
  copyFileSync(truth(), join(r.bin, "prog"));
  chmodSync(join(r.bin, "prog"), 0o755);
  assert.equal(await why(r.broker.invoke(call("t", {}))), "E_POLICY_DENIED/program-changed");
});

test("R4-A: a symlink on PATH retargeted after the decision does not run", { skip: skipSh }, async () => {
  const r = pinRig((bin) => { rmSync(join(bin, "prog")); symlinkSync(shell(), join(bin, "prog")); });
  symlinkSync(truth(), join(r.bin, "prog"));
  assert.equal(await why(r.broker.invoke(call("t", {}))), "E_POLICY_DENIED/program-changed");
});

test("R4-A: an unchanged program runs", { skip: skipSh }, async () => {
  const r = pinRig(() => undefined);
  copyFileSync(truth(), join(r.bin, "prog"));
  chmodSync(join(r.bin, "prog"), 0o755);
  assert.equal(await why(r.broker.invoke(call("t", {}))), "no-error");
});

test("R4-A: a script is judged by its #! interpreter: a shell raises the tier, another interpreter is pinned too", { skip: skipSh }, async () => {
  const a = pinRig(() => undefined);
  writeFileSync(join(a.bin, "prog"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await a.broker.invoke(call("t", {}));
  assert.ok(a.requests[0]?.reasons.includes("launcher"), "a script run by a shell is a launcher");
  assert.ok(a.requests[0]?.commands[0]?.includes('interpreter: "'), "the interpreter path is quoted");
  // An interpreter that is not a launcher by name is pinned: replacing it after the decision is refused.
  const b = pinRig((bin) => appendFileSync(join(bin, "..", "interp"), "\n"));
  const interp = join(b.w.base, "interp");
  copyFileSync(truth(), interp);
  chmodSync(interp, 0o755);
  writeFileSync(join(b.bin, "prog"), `#!${interp}\n`, { mode: 0o755 });
  assert.equal(await why(b.broker.invoke(call("t", {}))), "E_POLICY_DENIED/program-changed");
});

// R4-B -------------------------------------------------------------------------------------------------------------

test("R4-B: the approved line is unambiguous and has no control character", async () => {
  const r = rig({ approve: (q) => grant(q) });
  const lines = [["echo", "a b", "c"], ["echo", "a", "b c"], [node, "-e", "1", "\r\u001b[2K\n  \u007f\u0085‮"]];
  lines.forEach((argv, i) => r.broker.register(def({ name: `t${i}`, tier: "network", args: z.strictObject({}), argv: () => argv, run: async () => 1 })));
  for (let i = 0; i < lines.length; i++) await r.broker.invoke(call(`t${i}`, {}));
  assert.notEqual(r.requests[0]?.commands[0]?.split(" [program")[0], r.requests[1]?.commands[0]?.split(" [program")[0]);
  const raw = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202e]");
  for (const q of r.requests) for (const c of q.commands) assert.ok(!raw.test(c), c);
  assert.ok(r.requests[2]?.commands[0]?.includes("\\u001b") && r.requests[2].commands[0].includes("\\u2028"));
});

test("R4-B: a git line is a JSON array", async () => {
  const g = gitRig({ approve: (q) => grant(q) });
  const c = { command: "add", paths: ["a.txt", "b.txt"] } as const;
  g.broker.register(def({ name: "g", tier: "network", args: z.strictObject({}), git: () => [c], run: async () => 1 }));
  await g.broker.invoke(call("g", {}));
  const line = g.requests[0]?.commands[0] ?? "";
  assert.equal(line, '["git","add","--","a.txt","b.txt"]');
});

// R4-C -------------------------------------------------------------------------------------------------------------

test("R4-C: the argv the tool returned is copied: changing its own array afterwards does not change what was approved", async () => {
  const r = rig({ approve: (q) => grant(q) });
  const arr = [node, "-e", "process.stdout.write('approved')"];
  r.broker.register(def({
    name: "t", tier: "network", args: z.strictObject({}), argv: () => arr,
    run: async (ctx: ToolContext) => {
      arr[2] = "process.stdout.write('mutated')";
      return ctx.run({ command: node, args: ["-e", "process.stdout.write('mutated')"], ...lim });
    },
  }));
  assert.equal(await why(r.broker.invoke(call("t", {}))), "E_POLICY_DENIED/undeclared-command");
});

test("R4-C: the arrays of a git call are copied: changing them in place after ctx.git() does not change what runs", async () => {
  const g = gitRig();
  g.broker.register(def({
    name: "t", tier: "write", args: z.strictObject({}), git: () => [{ command: "restore", flags: ["--staged"], paths: ["src/a.ts"] }],
    run: async (ctx: ToolContext) => {
      const flags = ["--staged"];
      const paths = ["src/a.ts"];
      const p = ctx.git({ command: "restore", flags, paths });
      flags[0] = "--worktree";
      paths[0] = ".";
      return p;
    },
  }));
  await g.broker.invoke(call("t", {}));
  const ran = g.gitRuns.find((a) => a.includes("restore")) ?? [];
  assert.ok(ran.includes("--staged") && !ran.includes("--worktree") && !ran.includes("."));
  assert.equal(g.requests.length, 0);
});

// Smaller findings -------------------------------------------------------------------------------------------------

test("a Set or a proxy cannot slip past the target and git-call caps", async () => {
  const r = rig({ approve: (q) => grant(q) });
  r.broker.register(def({ name: "set", tier: "write", args: z.strictObject({}), targets: () => new Set([{ path: "a.txt", access: "read" }]) as never, run: async () => 1 }));
  assert.equal(await why(r.broker.invoke(call("set", {}))), "E_INVALID_ARGUMENT/invalid-args");
  const lying = new Proxy(Array.from({ length: 40 }, (_, i) => ({ path: `f${i}`, access: "read" as const })), { get: (t, k) => (k === "length" ? 1 : Reflect.get(t, k)) });
  r.broker.register(def({ name: "px", tier: "write", args: z.strictObject({}), targets: () => lying, run: async () => 1 }));
  assert.notEqual(await why(r.broker.invoke(call("px", {}))), "no-error");
});

test("vault grants are fetched when the command runs, not for a call the user declines", { skip: skipSh }, async () => {
  const w = makeWorld();
  worlds.push(w);
  let fetched = 0;
  const b = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: process.env["PATH"] ?? "", HOME: w.base }),
    grants: { grantsFor: () => { fetched++; return []; } },
    approval: { request: async () => ({ approved: false }) },
  });
  b.register(def({ name: "t", tier: "network", args: z.strictObject({}), argv: () => ["true"], run: async () => 1 }));
  assert.equal(await why(b.invoke(call("t", {}))), "E_POLICY_DENIED/approval-declined");
  assert.equal(fetched, 0);
});

test("the registered definition is frozen all the way down: a list the tool keeps cannot widen the environment", async () => {
  const w = makeWorld();
  worlds.push(w);
  const b = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: process.env["PATH"] ?? "", HOME: w.base, A_ONE: "1", A_TWO: "2" }),
    approval: { request: async (q: ApprovalRequest) => grant(q) },
  });
  const additions = ["A_ONE"];
  const script = "process.stdout.write(JSON.stringify(Object.keys(process.env)))";
  b.register(def({
    name: "t", tier: "network", args: z.strictObject({}), envAdditions: additions, argv: () => [node, "-e", script],
    run: async (ctx: ToolContext) => ctx.run({ command: node, args: ["-e", script], ...lim }),
  } as never));
  additions.push("A_TWO");
  const keys = JSON.parse(((await b.invoke(call("t", {}))) as { stdout: Buffer }).stdout.toString()) as string[];
  assert.ok(keys.includes("A_ONE") && !keys.includes("A_TWO"));
});
