// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn } from "node:child_process";
import { parse } from "node:path";
import { displayValue } from "./display.js";
import { baseArgs, snapshotGitEnv, type AskInput } from "./git.js";
import { classifyPath } from "./protected.js";
import type { Setting } from "./types.js";

const MAX_RECORD = 4096;
// A repository with millions of files is read as a stream; this many bytes of listing is the most that is scanned.
const MAX_BYTES = 512 * 1024 * 1024;
const COUNT_KEY = "index.flagged-count";

export interface IndexFlags {
  readonly settings: readonly Setting[];
  /** Fixed-text reason the flags could not all be read; null when they were. */
  readonly problem: string | null;
}

/**
 * `skip-worktree` and `assume-unchanged` make git stop looking at a tracked file: an edit to it is then in neither
 * `git status` nor `git diff`. The index holds the flags, outside every file this package hashes, so they are read
 * from `git ls-files -v` as a stream (a large repository is not held in memory). Sparse checkouts set the same flag
 * on files that are legitimately absent, so a flagged path is listed one by one only when the protected-path matcher
 * marks it; the others are counted, and a change in that count is drift.
 */
export async function readIndexFlags(i: AskInput): Promise<IndexFlags> {
  i.budget.tick();
  const env = snapshotGitEnv(i.env, i.home, i.worktree);
  const argv = [...baseArgs(i), "ls-files", "-v", "-z"];
  const settings: Setting[] = [];
  let counted = 0;
  let problem: string | null = null;
  await new Promise<void>((done) => {
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    i.budget.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), Math.max(1, Math.floor(i.budget.remaining())));
    const finish = (): void => {
      clearTimeout(timer);
      i.budget.signal?.removeEventListener("abort", onAbort);
      done();
    };
    let child;
    try {
      child = spawn(i.gitPath, argv, { cwd: parse(i.worktree).root, env, stdio: ["ignore", "pipe", "ignore"], signal: ac.signal, windowsHide: true });
    } catch {
      problem = "git could not list the index flags";
      return finish();
    }
    let carry = Buffer.alloc(0);
    let total = 0;
    let seen = 0;
    const take = (rec: Buffer): void => {
      if (rec.length < 3 || rec[1] !== 0x20) return;
      const tag = String.fromCharCode(rec[0] as number);
      if (tag !== "S" && !(tag >= "a" && tag <= "z")) return;
      const kind = tag === "S" || tag === "s" ? "skip-worktree" : "assume-unchanged";
      const path = rec.toString("utf8", 2);
      if (classifyPath(path) !== null && settings.length < i.limits.maxSettings) {
        settings.push({ key: `index.flag.${displayValue(path, 300)}`, value: kind, origin: "index/flags", label: "index flag hides changes", severity: "high", note: null });
      } else {
        counted++;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        problem = "the index listing is too large to scan";
        child.kill();
        return;
      }
      let buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      for (let nul = buf.indexOf(0, start); nul >= 0; nul = buf.indexOf(0, start)) {
        if (nul - start <= MAX_RECORD) take(buf.subarray(start, nul));
        start = nul + 1;
        if ((++seen & 0xffff) === 0) {
          try {
            i.budget.tick();
          } catch {
            problem = "the time budget ended while the index flags were read";
            child.kill();
            return;
          }
        }
      }
      buf = buf.subarray(start);
      carry = buf.length > MAX_RECORD ? Buffer.alloc(0) : Buffer.from(buf);
    });
    child.on("error", () => {
      problem ??= "git could not list the index flags";
      finish();
    });
    child.on("close", (code) => {
      if (problem === null && code !== 0) problem = "git could not list the index flags";
      finish();
    });
  });
  i.budget.tick();
  if (counted > 0) {
    settings.push({ key: COUNT_KEY, value: String(counted), origin: "index/flags", label: "index flag hides changes", severity: "medium", note: null });
  }
  return { settings, problem };
}
