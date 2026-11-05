// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, parse } from "node:path";
import { displayValue } from "./display.js";
import { baseArgs, snapshotGitEnv, type AskInput } from "./git.js";
import { canSkipClassification, classifyPath } from "./protected.js";
import type { Setting } from "./types.js";

const MAX_RECORD = 4096;
const COUNT_KEY = "index.flagged-count";

export interface IndexFlags {
  readonly settings: readonly Setting[];
  /** Every flagged path, whether or not it is listed. */
  readonly total: number;
  /** SHA-256 over every flagged path, its flag and the identity of the file in the worktree, in index order. */
  readonly digest: string;
  /** Bytes hashed. */
  readonly bytes: number;
  /** Display lines for the first flagged paths, within the text bound. */
  readonly lines: readonly string[];
  /** Fixed-text reason the flags could not all be read; null when they were. */
  readonly problem: string | null;
}

/**
 * `skip-worktree` and `assume-unchanged` make git stop looking at a tracked file: an edit to it is then in neither
 * `git status` nor `git diff`. The index holds the flags, outside every file this package hashes, so they are read
 * from `git ls-files -v` as a stream (a large repository is not held in memory). Sparse checkouts set the same flag
 * on files that are legitimately absent, so a flagged path is listed one by one only when the protected-path matcher
 * marks it. EVERY flagged path is hashed, with its flag and the file's identity in the worktree (size, mtime, mode,
 * or absent), so moving a flag to another file, or editing a flagged file, changes the digest.
 */
export async function readIndexFlags(i: AskInput): Promise<IndexFlags> {
  i.budget.tick();
  const env = snapshotGitEnv(i.env, i.home, i.worktree);
  const argv = [...baseArgs(i), "ls-files", "-v", "-z"];
  const settings: Setting[] = [];
  let counted = 0;
  let total = 0;
  let bytes = 0;
  let textChars = 0;
  const lines: string[] = [];
  const hash = createHash("sha256");
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
    let listed = 0;
    let seen = 0;
    let dropping = false;
    let unreadable = 0;
    const take = (rec: Buffer): void => {
      if (rec.length < 3 || rec[1] !== 0x20) return;
      const tag = String.fromCharCode(rec[0] as number);
      if (tag !== "S" && !(tag >= "a" && tag <= "z")) return;
      // git prints `S` for skip-worktree and a lower-case letter for assume-unchanged; with both set it prints the
      // lower-case letter, so a file with both flags reads as assume-unchanged. Either hides the file.
      const kind = tag === "S" ? "skip-worktree" : "assume-unchanged";
      const path = rec.toString("utf8", 2);
      // What git's own stat check looks at, and more: size, mtime, ctime, inode, device and mode. Only a missing file
      // (ENOENT, ENOTDIR) reads as absent; any other error is its own state, and the snapshot is then incomplete.
      let identity: string;
      try {
        const st = lstatSync(join(i.worktree, path), { bigint: true, throwIfNoEntry: false });
        identity = st === undefined ? "absent" : `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}:${st.dev}:${st.mode}`;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "ERR";
        identity = code === "ENOENT" || code === "ENOTDIR" ? "absent" : `unreadable:${code}`;
        if (identity !== "absent") unreadable++;
      }
      hash.update(rec);
      hash.update(`\0${identity}\n`);
      total++;
      bytes += rec.length + identity.length + 2;
      // Text and settings are formatted only for what is shown; the digest above uses the raw fields.
      if (textChars < i.limits.maxTextChars) {
        const shown = `${kind} ${displayValue(path, 300)}`;
        if (textChars + shown.length < i.limits.maxTextChars) {
          lines.push(shown);
          textChars += shown.length + 1;
        } else {
          textChars = i.limits.maxTextChars;
        }
      }
      if (!canSkipClassification(path) && settings.length < i.limits.maxSettings && classifyPath(path) !== null) {
        settings.push({ key: `index.flag.${displayValue(path, 300)}`, value: kind, origin: "index/flags", label: "index flag hides changes", severity: "high", note: null });
      } else {
        counted++;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      listed += chunk.length;
      if (listed > i.limits.maxIndexBytes) {
        problem = "the index listing is too large to scan";
        child.kill();
        return;
      }
      let buf = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      for (let nul = buf.indexOf(0, start); nul >= 0; nul = buf.indexOf(0, start)) {
        // Records are reassembled across chunks before anything is hashed; an over-long one is dropped whole and blocks,
        // so the digest never depends on where the pipe happened to split the output.
        if (dropping || nul - start > MAX_RECORD) {
          problem ??= "a flagged path is too long to read";
          dropping = false;
        } else {
          take(buf.subarray(start, nul));
        }
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
      if (buf.length > MAX_RECORD) {
        dropping = true;
        carry = Buffer.alloc(0);
      } else {
        carry = Buffer.from(buf);
      }
    });
    child.on("error", () => {
      problem ??= "git could not list the index flags";
      finish();
    });
    child.on("close", (code) => {
      if (dropping) problem ??= "a flagged path is too long to read";
      if (unreadable > 0) problem ??= "a flagged file could not be examined";
      if (problem === null && code !== 0) problem = "git could not list the index flags";
      finish();
    });
  });
  i.budget.tick();
  if (counted > 0) {
    settings.push({ key: COUNT_KEY, value: String(counted), origin: "index/flags", label: "index flag hides changes", severity: "medium", note: null });
  }
  return { settings, total, digest: hash.digest("hex"), bytes, lines, problem };
}
