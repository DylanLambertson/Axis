// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent review of the broker core: each one fails on the code it was written against.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Redactor } from "@axis/audit";
import { BrokerError, nodeBrokerFs, writeContained, type ApprovalRequest, type BrokerFile, type BrokerFs, type ToolDefinition } from "../src/index.js";
import { makeWorld } from "./helpers.js";
import { call, cleanupWorlds, grant, rig, skipFd, skipLinks, why, worlds, writer } from "./rig.js";

after(cleanupWorlds);

// B1 ---------------------------------------------------------------------------------------------------------------

test("B1: a directory swapped for a symlink to .github/workflows after the decision is refused, nothing is written", { skip: skipLinks }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  const wf = join(r.w.wt, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  mkdirSync(join(r.w.wt, "foo"));
  r.broker.register(writer("swap_write", () => {
    rmSync(join(r.w.wt, "foo"), { recursive: true });
    symlinkSync(wf, join(r.w.wt, "foo"));
  }));
  assert.equal(await why(r.broker.invoke(call("swap_write", { path: "foo/ci.yml", content: "on: push" }))), "E_POLICY_DENIED/path-changed");
  assert.equal(existsSync(join(wf, "ci.yml")), false, "no workflow was written");
  assert.equal(r.requests.length, 0, "the call was never protected at decision time, which is why use time must refuse");
});

test("B1: an approval for one real path cannot be spent on another (retarget after approval)", { skip: skipLinks }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  mkdirSync(join(r.w.wt, ".vscode"));
  mkdirSync(join(r.w.wt, ".github", "workflows"), { recursive: true });
  r.broker.register(writer("retarget", () => undefined, () => ".github/workflows/ci.yml"));
  assert.equal(await why(r.broker.invoke(call("retarget", { path: ".vscode/settings.json", content: "x" }))), "E_POLICY_DENIED/undeclared-path");
  assert.equal(r.requests.length, 1, "the user was asked about .vscode/settings.json only");
  assert.equal(existsSync(join(r.w.wt, ".github", "workflows", "ci.yml")), false);
});

test("B1: a path swapped between two declared names is refused when it resolves elsewhere; the same real path still works", { skip: skipLinks }, async () => {
  const r = rig({ approve: (q) => grant(q) });
  mkdirSync(join(r.w.wt, "a"));
  mkdirSync(join(r.w.wt, "b"));
  symlinkSync(join(r.w.wt, "a"), join(r.w.wt, "link"));
  r.broker.register(writer("plain", () => undefined));
  assert.equal(await r.broker.invoke(call("plain", { path: "link/x.txt", content: "ok" })), "written", "a symlinked directory that does not move is fine");
  assert.equal(readFileSync(join(r.w.wt, "a", "x.txt"), "utf8"), "ok");
  r.broker.register(writer("moving", () => {
    rmSync(join(r.w.wt, "link"));
    symlinkSync(join(r.w.wt, "b"), join(r.w.wt, "link"));
  }));
  assert.equal(await why(r.broker.invoke(call("moving", { path: "link/y.txt", content: "no" }))), "E_POLICY_DENIED/path-changed");
  assert.equal(existsSync(join(r.w.wt, "b", "y.txt")), false);
});

test("B1: a tool that declares no target cannot touch files", async () => {
  const r = rig();
  writeFileSync(join(r.w.wt, "a.txt"), "x");
  r.broker.register({ name: "sneaky", tier: "read", args: z.strictObject({}), run: async (ctx) => (await ctx.readFile("a.txt", 10)).toString() } as ToolDefinition);
  assert.equal(await why(r.broker.invoke(call("sneaky", {}))), "E_POLICY_DENIED/undeclared-path");
});

// S2 / S3 ----------------------------------------------------------------------------------------------------------

/** A file system whose `open` first swaps the parent directory `d` for a symlink to `outside`, as a racing process would. */
function racing(w: ReturnType<typeof makeWorld>, o: { hideFdPath?: boolean; lieAboutParent?: boolean; undoAfterParentCheck?: boolean }): BrokerFs {
  let opened = false;
  const d = join(w.wt, "d");
  return {
    lstat: (p) => nodeBrokerFs.lstat(p),
    async realpath(p) {
      if (opened && p === d && (o.lieAboutParent === true || o.undoAfterParentCheck === true)) {
        if (o.undoAfterParentCheck === true) {
          // The racer swaps the real directory back the moment the parent has been looked at.
          rmSync(d, { force: true });
          renameSync(`${d}.moved`, d);
        }
        return d;
      }
      return nodeBrokerFs.realpath(p);
    },
    async open(p, mode) {
      renameSync(d, `${d}.moved`);
      symlinkSync(w.outside, d);
      const f = await nodeBrokerFs.open(p, mode);
      opened = true;
      const wrapped: BrokerFile = { ...f, fdPath: o.hideFdPath === true ? async () => undefined : f.fdPath };
      return wrapped;
    },
  };
}
const arena = () => {
  const w = makeWorld();
  worlds.push(w);
  mkdirSync(join(w.wt, "d"));
  return w;
};
const wopts = { mode: "upsert", maxBytes: 100 } as const;

test("S2: the parent re-check stops a parent swap when the descriptor path is not available", { skip: skipLinks }, async () => {
  for (const name of ["new.txt", "secret.txt"]) {
    const w = arena();
    const fs = racing(w, { hideFdPath: true });
    await assert.rejects(writeContained(w.deps(fs), "wt1", `d/${name}`, Buffer.from("PWNED"), wopts), (e: unknown) => e instanceof BrokerError && e.reason === "swapped");
    assert.equal(readFileSync(join(w.outside, "secret.txt"), "utf8"), "TOP-SECRET", "an existing outside file is untouched");
    if (existsSync(join(w.outside, "new.txt"))) assert.equal(statSync(join(w.outside, "new.txt")).size, 0, "at most the documented empty file");
  }
});

test("S2: the descriptor path check stops a parent swap even when the parent looks unchanged", { skip: skipFd }, async () => {
  for (const name of ["new.txt", "secret.txt"]) {
    const w = arena();
    const fs = racing(w, { lieAboutParent: true });
    await assert.rejects(writeContained(w.deps(fs), "wt1", `d/${name}`, Buffer.from("PWNED"), wopts), (e: unknown) => e instanceof BrokerError && e.reason === "swapped");
    assert.equal(readFileSync(join(w.outside, "secret.txt"), "utf8"), "TOP-SECRET");
  }
});

test("S3: a swap undone right after the parent check is still seen, because the name is looked at after the parent", { skip: skipLinks }, async () => {
  const w = arena();
  const fs = racing(w, { hideFdPath: true, undoAfterParentCheck: true });
  await assert.rejects(writeContained(w.deps(fs), "wt1", "d/new.txt", Buffer.from("PWNED"), wopts), (e: unknown) => e instanceof BrokerError && e.reason === "swapped");
  if (existsSync(join(w.outside, "new.txt"))) assert.equal(statSync(join(w.outside, "new.txt")).size, 0);
});

// S4 ---------------------------------------------------------------------------------------------------------------

test("S4: a command tool below the approval floor cannot be registered", () => {
  const r = rig();
  const def = (tier: string) => ({ name: `c_${tier}`, tier, args: z.strictObject({}), command: () => "echo", run: async () => null }) as unknown as ToolDefinition;
  for (const t of ["read", "write"]) assert.throws(() => r.broker.register(def(t)), (e: unknown) => e instanceof BrokerError && e.reason === "invalid-tier");
  r.broker.register(def("network"));
});

// S6 ---------------------------------------------------------------------------------------------------------------

test("S6: a call whose signal is already aborted does nothing", async () => {
  const r = rig();
  r.broker.register(writer("w", () => undefined));
  const ac = new AbortController();
  ac.abort();
  assert.equal(await why(r.broker.invoke(call("w", { path: "a.txt", content: "x" }, { signal: ac.signal }))), "E_CANCELLED/aborted");
  assert.equal(existsSync(join(r.w.wt, "a.txt")), false);
});

test("S6: an approval that arrives after the call was cancelled does not start the action", async () => {
  const ac = new AbortController();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => { release = res; });
  const r = rig({ approve: async (q) => { await gate; return grant(q); } });
  mkdirSync(join(r.w.wt, ".vscode"));
  r.broker.register(writer("w", () => undefined));
  const p = why(r.broker.invoke(call("w", { path: ".vscode/tasks.json", content: "x" }, { signal: ac.signal })));
  setImmediate(() => { ac.abort(); release(); });
  assert.equal(await p, "E_CANCELLED/aborted");
  assert.equal(existsSync(join(r.w.wt, ".vscode", "tasks.json")), false);
});

test("S6: file and command operations check the signal before acting", async () => {
  const r = rig();
  const ac = new AbortController();
  r.broker.register(writer("w", () => ac.abort()));
  assert.equal(await why(r.broker.invoke(call("w", { path: "a.txt", content: "x" }, { signal: ac.signal }))), "E_CANCELLED/aborted");
  assert.equal(existsSync(join(r.w.wt, "a.txt")), false);
});

// S7 ---------------------------------------------------------------------------------------------------------------

test("S7: every call field is read once, so the audited actor is the validated one", async () => {
  const r = rig();
  r.broker.register(writer("w", () => undefined));
  let reads = 0;
  const c = { tool: "w", worktreeId: "wt1", args: { path: "a.txt", content: "x" }, get actor(): string { return reads++ < 1 ? "agent:a" : "user\u001b[2Kforged"; } };
  await r.broker.invoke(c);
  assert.equal(reads, 1);
  assert.ok(r.events.length > 0 && r.events.every((e) => e.actor === "agent:a"), "audited as the validated actor");
  let tools = 0;
  const c2 = { worktreeId: "wt1", actor: "agent:a", args: {}, get tool(): string { return tools++ === 0 ? "w" : "nope"; } };
  await why(r.broker.invoke(c2));
  assert.equal(tools, 1);
});

// S8 ---------------------------------------------------------------------------------------------------------------

test("S8: the approval request names the real path and shows the redacted content", { skip: skipLinks }, async () => {
  const redactor = { redactString: (s: string) => s.split("canary-value").join("[redacted]"), redactValue: <T>(v: T): T => v } as unknown as Redactor;
  const r = rig({ approve: (q) => grant(q), redactor });
  mkdirSync(join(r.w.wt, ".vscode"));
  symlinkSync(join(r.w.wt, ".vscode"), join(r.w.wt, "alias"));
  r.broker.register(writer("w", () => undefined));
  await r.broker.invoke(call("w", { path: "alias/tasks.json", content: "run evil.sh canary-value" }));
  const q = r.requests[0] as ApprovalRequest;
  assert.deepEqual(q.operations, [{ access: "write", path: ".vscode/tasks.json" }], "the real path, not the spelling");
  assert.ok(q.preview.includes("run evil.sh"), "the content is shown");
  assert.ok(!q.preview.includes("canary-value") && q.preview.includes("[redacted]"), "and redacted");
  assert.equal(q.previewTruncated, false);
  const big = rig({ approve: (x) => grant(x) });
  mkdirSync(join(big.w.wt, ".vscode"));
  big.broker.register(writer("w", () => undefined));
  await big.broker.invoke(call("w", { path: ".vscode/a.json", content: "z".repeat(10_000) }));
  assert.equal(big.requests[0]?.previewTruncated, true);
  assert.ok((big.requests[0]?.preview.length ?? 0) <= 4096);
});

