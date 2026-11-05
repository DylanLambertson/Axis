// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shared rig for the review regression tests.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { AuditEventInput, Redactor } from "@axis/audit";
import { BrokerError, ToolBroker, createCommandRunner, nodeBrokerFs, type ApprovalRequest, type ToolContext, type ToolDefinition } from "../src/index.js";
import { canSymlink, makeWorld } from "./helpers.js";

export const worlds: Array<{ cleanup(): void }> = [];
export const cleanupWorlds = (): void => worlds.forEach((w) => w.cleanup());
export const skipLinks = canSymlink() ? false : "symlinks are not available on this host";
export const skipSh = process.platform !== "win32" && existsSync("/bin/sh") ? false : "needs /bin/sh";
export const skipFd = process.platform === "linux" && canSymlink() ? false : "needs Linux and symlinks";

export const grant = (r: ApprovalRequest) => ({ approved: true, approvedBy: "user", approvalId: `id-${Math.random().toString(36).slice(2, 12)}`, digest: r.digest, expiresAt: Date.now() + 30_000 });

export interface Rig {
  broker: ToolBroker;
  w: ReturnType<typeof makeWorld>;
  events: AuditEventInput[];
  requests: ApprovalRequest[];
}
export function rig(o: { approve?: (r: ApprovalRequest) => unknown | Promise<unknown>; redactor?: Redactor } = {}): Rig {
  const w = makeWorld();
  worlds.push(w);
  const events: AuditEventInput[] = [];
  const requests: ApprovalRequest[] = [];
  const broker = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: (i) => { events.push(i); return {} as never; } },
    runner: createCommandRunner({ killGraceMs: 200 }), parentEnv: () => ({ PATH: process.env["PATH"] ?? "", HOME: w.base }),
    ...(o.approve === undefined ? {} : { approval: { request: async (r) => { requests.push(r); return o.approve?.(r); } } }),
    ...(o.redactor === undefined ? {} : { redactor: o.redactor }),
  });
  return { broker, w, events, requests };
}
export type WArgs = { path: string; content: string };
export const writer = (name: string, before: (a: WArgs) => unknown | Promise<unknown>, writePath?: (a: WArgs) => string): ToolDefinition => {
  const def: ToolDefinition<WArgs> = {
    name, tier: "write", args: z.strictObject({ path: z.string(), content: z.string() }),
    targets: (a) => [{ path: a.path, access: "write" }],
    run: async (ctx, a) => { await before(a); await ctx.writeFile(writePath?.(a) ?? a.path, Buffer.from(a.content), { mode: "upsert", maxBytes: 1_000_000 }); return "written"; },
  };
  return def as unknown as ToolDefinition;
};
export const call = (tool: string, args: unknown, extra: object = {}) => ({ tool, worktreeId: "wt1", actor: "agent:composer-1", args, ...extra });
export async function why(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BrokerError);
    return `${e.code}/${e.reason}`;
  }
  return "no-error";
}

/** A loosely typed tool definition, for tests that build deliberately odd tools. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = { name: string; tier: string; args: z.ZodType; command?: (a: any) => string | undefined; argv?: (a: any) => readonly string[] | undefined; git?: (a: any) => readonly unknown[]; targets?: (a: any) => { path: string; access: "read" | "write" }[]; run: (ctx: ToolContext, a: any) => Promise<unknown> };
export const def = (d: Loose): ToolDefinition => d as unknown as ToolDefinition;

/** A broker with a fake git runner (it answers `--version`) that records every argv it is given. */
export function gitRig(o: { approve?: (r: ApprovalRequest) => unknown; env?: () => Record<string, string>; onGit?: (argv: readonly string[]) => void } = {}) {
  const w = makeWorld();
  worlds.push(w);
  const gitRuns: string[][] = [];
  const requests: ApprovalRequest[] = [];
  const broker = new ToolBroker({
    registry: w.registry, fs: nodeBrokerFs, audit: { append: () => ({}) as never }, runner: createCommandRunner({ killGraceMs: 200 }),
    parentEnv: o.env ?? (() => ({ PATH: process.env["PATH"] ?? "", HOME: w.base })),
    gitRunner: { async run(req) { gitRuns.push([...req.argv]); o.onGit?.(req.argv); return { code: 0, stdout: req.argv.includes("--version") ? "git version 2.40.0" : "", stderr: "" }; } },
    assertNoDrift: async () => undefined,
    ...(o.approve === undefined ? {} : { approval: { request: async (q: ApprovalRequest) => { requests.push(q); return o.approve?.(q); } } }),
  });
  return { broker, w, gitRuns, requests };
}
