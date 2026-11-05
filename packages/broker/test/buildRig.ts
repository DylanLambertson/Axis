// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A broker whose tool runs `prog` from a private bin directory, shared by the program-identity tests.
import { mkdirSync, copyFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ToolBroker, createCommandRunner, nodeBrokerFs, type ApprovalRequest, type BrokerFs, type ToolContext } from "../src/index.js";
import { def, grant, worlds } from "./rig.js";
import { makeWorld } from "./helpers.js";

const lim = { timeoutMs: 5000, maxOutputBytes: 1000 };

export function build(o: { fs?: (flag: { on: boolean }) => BrokerFs; mutate?: (bin: string) => void } = {}) {
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
