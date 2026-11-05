// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The scan itself: synchronous, bounded by bytes, line length, findings and a deadline, and it reports rule, place and
// nothing else. No finding, error or log line made here holds any part of the text read.
import { PatchReader } from "./diff.js";
import { CONTENT_RULES, firstMatch, isLockFile, isSensitiveFilename, type ContentRule } from "./rules.js";
import type { Finding, IncompleteReason, ScanContext, ScanLimits, ScanOutcome } from "./types.js";

const NON_ASCII = /[^\x00-\x7f]/;
// Soft hyphen, Mongolian vowel separator, zero-width and bidi controls, word joiner and invisible operators, BOM.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,}/g;
const HEX_RUN = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{40,}/g;
const MAX_DECODE_CHARS = 2048;
const CHECK_EVERY = 64;
const SPECIFIC: readonly ContentRule[] = CONTENT_RULES.filter((r) => r.specific);

/** Folds what a naive scan misses: zero-width characters inside a token and full-width or compatibility letters. */
export function normalizeLine(line: string): string {
  if (!NON_ASCII.test(line)) return line;
  return line.replace(INVISIBLE, "").normalize("NFKC");
}

/** Rule names that match one window of one line. Linear in the window; encoded values are decoded once, one level. Each run is decoded for at most MAX_DECODE_CHARS, and the runs of a window do not overlap, so the decoding work is bounded by the window size. */
export function matchWindow(window: string, lockFile: boolean): string[] {
  const out: string[] = [];
  for (const rule of CONTENT_RULES) {
    if (lockFile && rule.skipInLockFiles === true) continue;
    const name = firstMatch(rule, window);
    if (name !== undefined) out.push(name);
  }
  for (const [re, prefix, enc] of [[BASE64_RUN, "base64-", "base64"], [HEX_RUN, "hex-", "hex"]] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(window); m !== null; m = re.exec(window)) {
      const run = m[0].slice(0, MAX_DECODE_CHARS);
      const decoded = Buffer.from(enc === "hex" ? run.slice(0, run.length & ~1) : run, enc).toString("latin1");
      for (const rule of SPECIFIC) {
        const name = firstMatch(rule, decoded);
        if (name !== undefined) out.push(`${prefix}${name}`.slice(0, 64));
      }
    }
    re.lastIndex = 0;
  }
  return out;
}

export function scanText(text: string, ctx: ScanContext, limits: ScanLimits, now: () => number): ScanOutcome {
  const started = now();
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const incomplete = new Set<IncompleteReason>();
  const binary = new Set(ctx.binaryPaths ?? []);
  const binaryBytes = new Map<string, number>();
  const unscanned = new Set<string>();
  const isMessage = ctx.part === "message";
  const reader = isMessage ? undefined : new PatchReader();
  const overlap = Math.min(4096, limits.maxLineLength >> 2);
  const step = Math.max(1, limits.maxLineLength - overlap);

  const add = (rule: string, path: string | undefined, line: number | undefined): void => {
    const key = `${rule}\0${path ?? ""}\0${line ?? ""}`;
    if (seen.has(key)) return;
    if (findings.length >= limits.maxFindings) {
      incomplete.add("findings_capped");
      return;
    }
    seen.add(key);
    const f: { rule: string; path?: string; line?: number; commit?: string } = { rule };
    if (path !== undefined) f.path = path;
    if (line !== undefined && line > 0) f.line = line;
    if (ctx.commit !== undefined) f.commit = ctx.commit;
    findings.push(f);
  };
  const timedOut = (): boolean => now() - started > limits.deadlineMs;

  const content = (raw: string, path: string | undefined, line: number | undefined): void => {
    const lock = isLockFile(path);
    for (let at = 0; at === 0 || at < raw.length; at += step) {
      if (findings.length >= limits.maxFindings || timedOut()) return;
      const window = normalizeLine(raw.slice(at, at + limits.maxLineLength));
      if (window.length >= 8) for (const rule of matchWindow(window, lock)) add(rule, path, line);
      if (at + limits.maxLineLength >= raw.length) break;
    }
  };

  let end = text.length;
  if (end > limits.maxBytes) {
    end = limits.maxBytes;
    incomplete.add("too_large");
  }
  let pos = 0;
  let n = 0;
  let lineNo = 0;
  while (pos < end) {
    if (++n % CHECK_EVERY === 0 && timedOut()) {
      incomplete.add("deadline");
      break;
    }
    if (findings.length >= limits.maxFindings) {
      incomplete.add("findings_capped");
      break;
    }
    let nl = text.indexOf("\n", pos);
    if (nl < 0 || nl > end) nl = end;
    const line = text.slice(pos, nl);
    pos = nl + 1;
    lineNo++;
    if (reader === undefined) {
      content(line.endsWith("\r") ? line.slice(0, -1) : line, undefined, lineNo);
      continue;
    }
    const ev = reader.read(line);
    if (ev === undefined) continue;
    if (ev.t === "file") {
      if (isSensitiveFilename(ev.path)) add("sensitive-filename", ev.path, undefined);
    } else if (ev.t === "binary") {
      add("binary-unscanned", ev.path, undefined);
    } else if (ev.path !== undefined && binary.has(ev.path)) {
      const used = (binaryBytes.get(ev.path) ?? 0) + ev.text.length + 1;
      binaryBytes.set(ev.path, used);
      if (used > limits.maxBinaryBytes) {
        if (!unscanned.has(ev.path)) add("binary-unscanned", ev.path, undefined);
        unscanned.add(ev.path);
      } else content(ev.text, ev.path, ev.line);
    } else content(ev.text, ev.path, ev.line);
  }
  if (incomplete.has("deadline") === false && timedOut()) incomplete.add("deadline");
  return { findings, incomplete: [...incomplete] };
}
