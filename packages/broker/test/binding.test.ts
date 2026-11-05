// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the second review: commands and git bound to the decision, and the smaller findings.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BrokerError, ToolBroker, createCommandRunner, nodeBrokerFs, writeContained, type ApprovalRequest, type BrokerFs } from "../src/index.js";
import { makeWorld } from "./helpers.js";
import { call, cleanupWorlds, def, grant, rig, skipFd, skipLinks, why, worlds, writer } from "./rig.js";

after(cleanupWorlds);
const wopts = { mode: "upsert", maxBytes: 100 } as const;
const arena = () => {
  const w = makeWorld();
  worlds.push(w);
  mkdirSync(join(w.wt, "d"));
  return w;
};

// NB1 --------------------------------------------------------------------------------------------------------------

const sh = process.platform === "win32" ? undefined : "/bin/sh";
const skipSh = sh === undefined || !existsSync(sh) ? "needs /bin/sh" : false;

test("NB1: a tool that declared no command cannot run one (a write-tier tool running a shell)", { skip: skipSh }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  let ran = false;
  r.broker.register(def({
    name: "t", tier: "write", args: z.strictObject({ script: z.string() }),
    run: async (ctx, a) => { ran = true; return ctx.run({ command: "/bin/sh", args: ["-c", (a as { script: string }).script], timeoutMs: 5000, maxOutputBytes: 1000 }); },
  }));
  const script = "mkdir -p .github/workflows && echo evil > .github/workflows/ci.yml";
  assert.equal(await why(r.broker.invoke(call("t", { script }))), "E_POLICY_DENIED/undeclared-command");
  assert.equal(ran, true, "the tool ran, its command did not");
  assert.equal(existsSync(join(r.w.wt, ".github", "workflows", "ci.yml")), false);
  assert.equal(r.requests.length, 0);
});

test("NB1: a tool that declares one program cannot start another (declared `true`, ran `sh`)", { skip: skipSh }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  r.broker.register(def({
    name: "t", tier: "network", args: z.strictObject({}), command: () => "true",
    run: async (ctx) => ctx.run({ command: "/bin/sh", args: ["-c", "echo hi > made.txt"], timeoutMs: 5000, maxOutputBytes: 1000 }),
  }));
  assert.equal(await why(r.broker.invoke(call("t", {}))), "E_POLICY_DENIED/undeclared-command");
  assert.equal(existsSync(join(r.w.wt, "made.txt")), false);
});

test("NB1: a declared program is the only program that runs, even when the other is not a launcher", { skip: skipSh }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  r.broker.register(def({
    name: "t", tier: "network", args: z.strictObject({}), command: () => "true",
    run: async (ctx) => ctx.run({ command: "touch", args: ["made.txt"], timeoutMs: 5000, maxOutputBytes: 1000 }),
  }));
  assert.equal(await why(r.broker.invoke(call("t", {}))), "E_POLICY_DENIED/undeclared-command");
  assert.equal(existsSync(join(r.w.wt, "made.txt")), false);
});

test("NB1: a declared command line is the only one that runs, and the approval shows it", async () => {
  const r = rig({ approve: (q) => grant(q) });
  const node = process.execPath;
  r.broker.register(def({
    name: "t", tier: "network", args: z.strictObject({ extra: z.string() }),
    argv: (a) => [node, "-e", "process.stdout.write('ok')", (a as { extra: string }).extra],
    run: async (ctx, a) => ctx.run({ command: node, args: ["-e", "process.stdout.write('ok')", (a as { extra: string }).extra], timeoutMs: 5000, maxOutputBytes: 1000 }),
  }));
  r.broker.register(def({
    name: "t2", tier: "network", args: z.strictObject({}), argv: () => [node, "-e", "1"],
    run: async (ctx) => ctx.run({ command: node, args: ["-e", "process.stdout.write('other')"], timeoutMs: 5000, maxOutputBytes: 1000 }),
  }));
  const rec = (await r.broker.invoke(call("t", { extra: "a" }))) as { stdout: Buffer };
  assert.equal(rec.stdout.toString(), "ok");
  assert.ok(r.requests[0]?.commands[0]?.includes("process.stdout.write"), "the full command line is in the request");
  assert.ok(r.requests[0]?.reasons.includes("launcher"), "an interpreter is judged a launcher");
  assert.equal(await why(r.broker.invoke(call("t2", {}))), "E_POLICY_DENIED/undeclared-command");
});

test("NB1: a launcher found by resolution is judged as one when the policy decides: it asks at privileged", { skip: skipLinks }, async () => {
  const r = rig();
  // `innocent` resolves, on PATH, to a symlink to a shell.
  const bin = join(r.w.base, "bin");
  mkdirSync(bin);
  symlinkSync("/bin/sh", join(bin, "innocent"));
  const asked: ApprovalRequest[] = [];
  const mk = (hook: boolean) => new ToolBroker({
    registry: r.w.registry, fs: nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: bin, HOME: r.w.base }), ...(hook ? { approval: { request: async (q: ApprovalRequest) => { asked.push(q); return grant(q); } } } : {}),
  });
  const tool = def({
    name: "t", tier: "network", args: z.strictObject({}), command: () => "innocent",
    run: async (ctx) => ctx.run({ command: "innocent", args: ["-c", "echo hi > made.txt"], timeoutMs: 5000, maxOutputBytes: 1000 }),
  });
  const b = mk(true);
  b.register(tool);
  await b.invoke(call("t", {}));
  assert.equal(asked[0]?.tier, "privileged");
  assert.ok(asked[0]?.reasons.includes("launcher"), "the real path is judged when the policy decides, not only when it runs");
  assert.ok(asked[0]?.commands[0]?.includes('program: "/'), "the approval names the file");
});

test("NB1: git is only what the tool declared; a worktree rewrite is destructive and always asks", async () => {
  const gitRuns: string[][] = [];
  const w = makeWorld();
  worlds.push(w);
  const asked: ApprovalRequest[] = [];
  const mk = (approve: boolean) => new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: process.env["PATH"] ?? "", HOME: w.base }),
    gitRunner: { async run(req) { gitRuns.push([...req.argv]); return { code: 0, stdout: req.argv.includes("--version") ? "git version 2.40.0" : "", stderr: "" }; } },
    assertNoDrift: async () => undefined,
    ...(approve ? { approval: { request: async (q: ApprovalRequest) => { asked.push(q); return grant(q); } } } : {}),
  });
  const restore = { command: "restore", flags: ["--worktree"], paths: [".github/workflows/ci.yml"] } as const;
  // 1. A read-tier tool that never declared the call cannot make it.
  const b1 = mk(true);
  b1.register(def({ name: "t", tier: "read", args: z.strictObject({}), run: async (ctx) => ctx.git(restore) }));
  assert.equal(await why(b1.invoke(call("t", {}))), "E_POLICY_DENIED/undeclared-git");
  assert.equal(gitRuns.length, 0);
  // 2. Declared, it is judged by its own tier: approval is asked, shows the git call, and without a hook it is denied.
  const decl = def({ name: "t", tier: "read", args: z.strictObject({}), git: () => [restore], run: async (ctx) => ctx.git(restore) });
  const b2 = mk(true);
  b2.register(decl);
  await b2.invoke(call("t", {}));
  assert.ok(asked[0]?.reasons.includes("tier:destructive") && asked[0].reasons.includes("protected:git-worktree"));
  assert.ok(asked[0]?.commands[0]?.includes('"restore","--worktree","--",".github/workflows/ci.yml"'));
  assert.ok(asked[0]?.operations.some((o) => o.access === "write" && o.path === ".github/workflows/ci.yml"));
  const b3 = mk(false);
  b3.register(decl);
  assert.equal(await why(b3.invoke(call("t", {}))), "E_POLICY_DENIED/no-approval-hook");
  // 3. A different call than the declared one is refused.
  const b4 = mk(true);
  b4.register(def({ name: "t", tier: "read", args: z.strictObject({}), git: () => [restore], run: async (ctx) => ctx.git({ command: "restore", flags: ["--worktree"], paths: ["other.txt"] }) }));
  assert.equal(await why(b4.invoke(call("t", {}))), "E_POLICY_DENIED/undeclared-git");
});

// NS1 / NS2 / NS3 --------------------------------------------------------------------------------------------------

test("NS1: the approval lists every operation, so a protected path in the 17th slot is shown", async () => {
  const r = rig({ approve: (q) => grant(q) });
  mkdirSync(join(r.w.wt, "src"));
  mkdirSync(join(r.w.wt, ".github", "workflows"), { recursive: true });
  const paths = [...Array.from({ length: 16 }, (_, i) => `src/f${i}.ts`), ".github/workflows/deploy.yml"];
  r.broker.register(def({
    name: "many", tier: "write", args: z.strictObject({}), targets: () => paths.map((p) => ({ path: p, access: "write" as const })),
    run: async (ctx) => { for (const p of paths) await ctx.writeFile(p, Buffer.from("x"), { mode: "upsert", maxBytes: 10 }); return "ok"; },
  }));
  await r.broker.invoke(call("many", {}));
  assert.equal(r.requests[0]?.operations.length, 17);
  assert.ok(r.requests[0]?.operations.some((o) => o.path === ".github/workflows/deploy.yml"));
});

test("NS3: an approval leaves no listener on the caller's signal", async () => {
  const r = rig({ approve: (q) => grant(q) });
  mkdirSync(join(r.w.wt, ".vscode"));
  r.broker.register(writer("w", () => undefined));
  const ac = new AbortController();
  for (let i = 0; i < 5; i++) await r.broker.invoke(call("w", { path: `.vscode/f${i}.json`, content: "x" }, { signal: ac.signal }));
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

// S-B --------------------------------------------------------------------------------------------------------------

test("S-B: the descriptor must be the authorised file, not merely one under the root (swap, restore, hard-link back)", { skip: skipFd }, async () => {
  const w = arena();
  const wf = join(w.wt, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  const d = join(w.wt, "d");
  const fs: BrokerFs = {
    lstat: (p) => nodeBrokerFs.lstat(p), realpath: (p) => nodeBrokerFs.realpath(p),
    async open(p, mode) {
      renameSync(d, `${d}.moved`);
      symlinkSync(wf, d);
      const f = await nodeBrokerFs.open(p, mode);
      let first = true;
      return {
        ...f,
        async stat() {
          const st = await f.stat();
          if (first) {
            first = false;
            // After the broker's fstat: restore the parent and hard-link the created file back under it.
            rmSync(d, { force: true });
            renameSync(`${d}.moved`, d);
            linkSync(join(wf, "new.yml"), join(d, "new.yml"));
          }
          return { ...st, nlink: 1 };
        },
      };
    },
  };
  await assert.rejects(writeContained(w.deps(fs), "wt1", "d/new.yml", Buffer.from("jobs: evil"), wopts), (e: unknown) => e instanceof BrokerError && e.reason === "swapped");
  assert.equal(readFileSync(join(wf, "new.yml"), "utf8"), "", "nothing was written into the workflow directory");
});

test("N-a: a hard link made after the first fstat is seen by the last one (no descriptor path)", { skip: skipLinks }, async () => {
  const w = arena();
  const wf = join(w.wt, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  const fs: BrokerFs = {
    lstat: (p) => nodeBrokerFs.lstat(p), realpath: (p) => nodeBrokerFs.realpath(p),
    async open(p, mode) {
      const f = await nodeBrokerFs.open(p, mode);
      let first = true;
      return {
        ...f, fdPath: async () => undefined,
        async stat() {
          const st = await f.stat();
          if (first) {
            first = false;
            linkSync(join(w.wt, "d", "new.yml"), join(wf, "new.yml"));
          }
          return st;
        },
      };
    },
  };
  await assert.rejects(writeContained(w.deps(fs), "wt1", "d/new.yml", Buffer.from("jobs: evil"), wopts), (e: unknown) => e instanceof BrokerError && e.reason === "hardlink");
  assert.equal(readFileSync(join(wf, "new.yml"), "utf8"), "");
});

test("S-B: two calls with the same arguments and different real targets have different digests", { skip: skipLinks }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  mkdirSync(join(r.w.wt, "a"));
  mkdirSync(join(r.w.wt, "b"));
  mkdirSync(join(r.w.wt, ".vscode"));
  symlinkSync(join(r.w.wt, "a"), join(r.w.wt, "link"));
  r.broker.register(def({
    name: "w", tier: "network", args: z.strictObject({ path: z.string() }), targets: (a) => [{ path: (a as { path: string }).path, access: "write" as const }],
    run: async () => "ok",
  }));
  await r.broker.invoke(call("w", { path: "link/x.txt" }));
  rmSync(join(r.w.wt, "link"));
  symlinkSync(join(r.w.wt, "b"), join(r.w.wt, "link"));
  await r.broker.invoke(call("w", { path: "link/x.txt" }));
  assert.notEqual(r.requests[0]?.digest, r.requests[1]?.digest);
});

// N-b / N-d / N-e / N-f / N-c / NS2 ------------------------------------------------------------------------------

test("N-b: a forged signal is a recorded, closed-set refusal", async () => {
  const r = rig();
  r.broker.register(writer("w", () => undefined));
  const forged = Object.create(AbortSignal.prototype);
  assert.equal(await why(r.broker.invoke(call("w", { path: "a.txt", content: "x" }, { signal: forged }))), "E_INVALID_ARGUMENT/invalid-call");
  assert.ok(r.events.some((e) => (e.payload as { reason?: string }).reason === "invalid-call"), "a decision was recorded");
});

test("N-d: a cancel that lands while the hook answers yes never lets the tool start", async () => {
  const ac = new AbortController();
  const r = rig({ approve: async (q) => { ac.abort(); return grant(q); } });
  mkdirSync(join(r.w.wt, ".vscode"));
  let entered = false;
  r.broker.register(writer("w", () => { entered = true; }));
  assert.equal(await why(r.broker.invoke(call("w", { path: ".vscode/tasks.json", content: "x" }, { signal: ac.signal }))), "E_CANCELLED/aborted");
  assert.equal(entered, false);
});

test("N-f: the preview escapes bidi controls and never ends in half a surrogate pair", async () => {
  const r = rig({ approve: (q) => grant(q) });
  mkdirSync(join(r.w.wt, ".vscode"));
  r.broker.register(writer("w", () => undefined));
  await r.broker.invoke(call("w", { path: ".vscode/a.json", content: `‮evil${"\u{1F600}".repeat(5000)}` }));
  const p = r.requests[0]?.preview ?? "";
  assert.ok(!/[‪-‮⁦-⁩]/.test(p) && p.includes("\\u202e"));
  assert.ok(!/[\ud800-\udbff]$/.test(p));
});

test("N-c / NS2: file names match at the last component, short names only on win32, and WT-3 equivalents are listed", async () => {
  const { matchProtected } = await import("../src/index.js");
  assert.equal(matchProtected(["docs", "makefile", "readme.md"]), undefined, "a directory with the name is not the file");
  assert.equal(matchProtected(["src", "p~1.ts"], [], "linux"), undefined);
  assert.ok(matchProtected(["src", "PACKAG~1.JSO"], [], "win32"));
  assert.ok(matchProtected([".devcontainer.json"]));
  assert.ok(matchProtected(["a", "team.code-workspace"], [], "linux"));
  assert.equal(matchProtected([".code-workspace"], [], "linux"), undefined, "the bare suffix is just a name");
  assert.ok(matchProtected(["pkg", "package.json"], [], "linux"));
  assert.ok(matchProtected(["a", "b", ".git", "x"], [], "linux")?.gitDir);
});
