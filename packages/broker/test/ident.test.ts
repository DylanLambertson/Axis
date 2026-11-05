// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the fifth review: every field of a program's identity is load-bearing on its own, an unreadable
// or chained script is not judged as a plain program, and invisible characters are shown as code points.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ToolBroker, createCommandRunner, nodeBrokerFs, type ApprovalRequest, type BrokerFs, type FileStat, type ToolContext } from "../src/index.js";
import { call, cleanupWorlds, def, grant, rig, skipSh, why, worlds } from "./rig.js";
import { makeWorld } from "./helpers.js";

after(cleanupWorlds);
const lim = { timeoutMs: 5000, maxOutputBytes: 1000 };

function build(o: { fs?: (flag: { on: boolean }) => BrokerFs; mutate?: (bin: string) => void } = {}) {
  const w = makeWorld();
  worlds.push(w);
  const bin = join(w.base, "bin");
  mkdirSync(bin);
  const flag = { on: false };
  const requests: ApprovalRequest[] = [];
  const broker = new ToolBroker({
    registry: w.registry, fs: o.fs?.(flag) ?? nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: () => ({ PATH: bin, HOME: w.base }),
    approval: { request: async (q: ApprovalRequest) => { requests.push(q); flag.on = true; o.mutate?.(bin); return grant(q); } },
  });
  broker.register(def({ name: "t", tier: "network", args: z.strictObject({}), argv: () => ["prog"], run: async (ctx: ToolContext) => ctx.run({ command: "prog", args: [], ...lim }) }));
  const install = (name = "prog"): string => {
    copyFileSync(realpathSync("/bin/true"), join(bin, name));
    chmodSync(join(bin, name), 0o755);
    return join(bin, name);
  };
  return { w, bin, broker, requests, install };
}

// R5-A: each identity field, alone -----------------------------------------------------------------------------------

for (const field of ["id", "size", "mtime", "ctime"] as const) {
  test(`R5-A: a program whose ${field} alone differs at the time of use does not run`, { skip: skipSh }, async () => {
    // The file system reports the same file with one field changed after the decision: the only detector is that field.
    const t = build({
      fs: (flag) => ({
        realpath: (p) => nodeBrokerFs.realpath(p), open: (p, m) => nodeBrokerFs.open(p, m),
        async lstat(p): Promise<FileStat> {
          const st = await nodeBrokerFs.lstat(p);
          if (!flag.on || !p.endsWith("/prog")) return st;
          return { ...st, [field]: typeof st[field] === "number" ? (st[field] as number) + 1 : `${st[field]}1` };
        },
      }),
    });
    t.install();
    assert.equal(await why(t.broker.invoke(call("t", {}))), "E_POLICY_DENIED/program-changed");
  });
}

test("R5-A: a same-size rewrite in place with the modification time put back does not run", { skip: skipSh }, async () => {
  let old: { atime: Date; mtime: Date } | undefined;
  const t = build({
    mutate: (bin) => {
      const p = join(bin, "prog");
      const bytes = readFileSync(p);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
      writeFileSync(p, bytes);
      if (old !== undefined) utimesSync(p, old.atime, old.mtime);
    },
  });
  const p = t.install();
  const st = statSync(p);
  old = { atime: st.atime, mtime: st.mtime };
  assert.equal(await why(t.broker.invoke(call("t", {}))), "E_POLICY_DENIED/program-changed");
});

test("R5-A: an unchanged program still runs (the fake file system is transparent)", { skip: skipSh }, async () => {
  const t = build({ fs: () => ({ realpath: (p) => nodeBrokerFs.realpath(p), open: (p, m) => nodeBrokerFs.open(p, m), lstat: (p) => nodeBrokerFs.lstat(p) }) });
  t.install();
  assert.equal(await why(t.broker.invoke(call("t", {}))), "no-error");
});

// R5-B / N-3 -------------------------------------------------------------------------------------------------------

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("R5-B: a script whose #! line cannot be read is not judged a plain program", { skip: skipSh || (asRoot ? "root can read mode 0111" : false) }, async () => {
  const t = build();
  writeFileSync(join(t.bin, "prog"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(t.bin, "prog"), 0o111);
  await t.broker.invoke(call("t", {}));
  assert.equal(t.requests[0]?.tier, "privileged");
  assert.ok(t.requests[0]?.reasons.includes("opaque-program"));
});

test("N-3: an interpreter that is itself a script is not followed: the call is privileged", { skip: skipSh }, async () => {
  const t = build();
  const runner = join(t.w.base, "runner");
  writeFileSync(runner, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(t.bin, "prog"), `#!${runner}\n`, { mode: 0o755 });
  await t.broker.invoke(call("t", {}));
  assert.equal(t.requests[0]?.tier, "privileged");
  assert.ok(t.requests[0]?.reasons.includes("opaque-program"));
  // A plain binary is not opaque.
  const plain = build();
  plain.install();
  await plain.broker.invoke(call("t", {}));
  assert.ok(!plain.requests[0]?.reasons.includes("opaque-program"));
});

// N-1 / N-2 --------------------------------------------------------------------------------------------------------

test("N-1 / N-2: invisible format characters are shown as code points, and paths in the line are quoted", async () => {
  const r = rig({ approve: (q) => grant(q) });
  r.broker.register(def({ name: "t", tier: "network", args: z.strictObject({}), argv: () => [process.execPath, "-e", "1", "a​", "b\u{e0041}", "c﻿"], run: async () => 1 }));
  await r.broker.invoke(call("t", {}));
  const line = r.requests[0]?.commands[0] ?? "";
  const invisible = new RegExp("[\\u200b\\ufeff\\u{e0041}]", "u");
  assert.ok(!invisible.test(line));
  assert.ok(line.includes("\\u200b") && line.includes("\\u{e0041}") && line.includes("\\ufeff"));
  assert.ok(line.includes(`program: ${JSON.stringify(realpathSync(process.execPath))}`));
});
