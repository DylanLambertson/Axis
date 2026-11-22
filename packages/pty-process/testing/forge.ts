// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyService, type ExecFn, type ExecRequest, type ForgeListConfig, type PtyService } from "../src/index.js";
import { pipeExec } from "./exec.js";
import { channelPair, ManualClock, until, type ChannelPair } from "./helpers.js";

/** TEST ONLY. A real `gh` version line. */
export const GH_VERSION_OK = 'process.stdout.write("gh version 2.45.0 (2024-03-04)\\nhttps://github.com/cli/cli/releases/tag/v2.45.0\\n");';

/**
 * TEST ONLY, POSIX: writes an executable fake `gh` (a Node script) into `dir`. Each run appends `{ args, pid, cwd }` to `log`, and
 * runs a planted `gh-pr` extension under `$XDG_DATA_HOME` as `gh` would. `list` and `version` are the JavaScript bodies run for
 * a list call and for `--version`. Every run ends itself after 8 s, so a broken kill leaves nothing behind.
 */
export function writeFakeGh(dir: string, log: string, list: string, version = GH_VERSION_OK): string {
  const path = join(dir, "gh");
  const body = [
    `#!${process.execPath}`,
    '"use strict";',
    "setTimeout(() => process.exit(97), 8000).unref();",
    'const fs = require("fs"), path = require("path"), cp = require("child_process");',
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, pid: process.pid, cwd: process.cwd() }) + "\\n");`,
    'const ext = path.join(process.env.XDG_DATA_HOME || "/nonexistent", "gh", "extensions", "gh-pr", "gh-pr");',
    "if (fs.existsSync(ext)) cp.execFileSync(ext);",
    `if (args[0] === "--version") { ${version} } else { ${list} }`,
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export interface ForgeRig {
  readonly service: PtyService;
  readonly pair: ChannelPair;
  readonly clock: ManualClock;
  readonly dir: string;
  readonly scratchParent: string;
  readonly ghPath: string;
  readonly ghLog: string;
  /** Every exec request the forge path made. */
  readonly execs: ExecRequest[];
  readonly replies: Array<Record<string, unknown>>;
  /** The fake `gh` runs so far. */
  runs(): Array<{ args: string[]; pid: number; cwd: string }>;
  send(m: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Replaces the fake `gh` (same path). */
  rewrite(list: string, version?: string): void;
  cleanup(): void;
}

let reqN = 0;
export const forgeReq = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ t: "forge-list", req: `f${++reqN}`, host: "github.com", owner: "acme", repo: "app", ...over });

/**
 * TEST ONLY: a pty service whose forge path runs a fake `gh` through `pipeExec` (or `exec`, given the inner `pipeExec` and the
 * fake's path: `(_, gh) => createNodeExec(new Set([gh]), platform)` runs it through the production exec function), on a manual clock.
 */
export function forgeRig(opts: { list?: string; version?: string; exec?: (inner: ExecFn, ghPath: string) => ExecFn; config?: Partial<ForgeListConfig>; baseEnv?: Record<string, string | undefined>; before?: (scratchParent: string) => void } = {}): ForgeRig {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-forge-")));
  const scratchParent = join(dir, "scratch");
  const ghLog = join(dir, "gh.log");
  writeFileSync(ghLog, "");
  const ghPath = writeFakeGh(dir, ghLog, opts.list ?? 'process.stdout.write("[]");', opts.version);
  mkdirSync(scratchParent, { mode: 0o700 });
  opts.before?.(scratchParent);
  const execs: ExecRequest[] = [];
  const inner = pipeExec(execs);
  const clock = new ManualClock();
  const pair = channelPair();
  const service = createPtyService({
    spawn: () => {
      throw new Error("no spawn in this rig");
    },
    clock,
    forge: { exec: opts.exec === undefined ? inner : opts.exec(inner, ghPath), ghPath, scratchParent, baseEnv: opts.baseEnv ?? { PATH: "/usr/bin:/bin", HOME: dir }, ...opts.config },
  });
  service.serveControl(pair.b);
  const replies: Array<Record<string, unknown>> = [];
  pair.a.onMessage((m) => void replies.push(m as Record<string, unknown>));
  return {
    service, pair, clock, dir, scratchParent, ghPath, ghLog, execs, replies,
    runs: () => readFileSync(ghLog, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { args: string[]; pid: number; cwd: string }),
    async send(m) {
      pair.a.send(m);
      await until(() => replies.some((r) => r["req"] === m["req"]), 400_000);
      return replies.find((r) => r["req"] === m["req"]) as Record<string, unknown>;
    },
    rewrite(list, version) {
      writeFakeGh(dir, ghLog, list, version);
    },
    cleanup() {
      service.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
