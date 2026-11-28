// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV-1 property test, seeded: over random small files of LF, CRLF, bare and mid-line CRs, lines at the width +-1, NEL,
// VT, FF, astral and escaped characters, the five places that judge a cut line agree with each other and with an oracle
// that knows nothing of the package (git's own -U0 diff, and "a CR ends a line only before an LF"): the hunk view's line
// flags, the hunk flag, the hunk gate, the preview's count, `hasCutLines`, and the build recheck. With every
// acknowledgement the built blobs are the worktree's exact bytes. Fixed seeds and a small width keep it near ten seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewError, ReviewSession } from "../src/index.js";
import { fixture, type Fixture } from "./fixture.js";

const MAXD = 4;
const W = MAXD * 4;
const SEEDS = [1, 7, 42];
const ITER = 4;
const TOK = ["a", "b", "\u00e9", "\u{1f600}", "\t", "\r", " ", "\u0085", "\u000b", "\u000c", "\u2028", "\\"];

function rng(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function bodies(rnd: (n: number) => number): () => string {
  const line = (): string => {
    const len = [0, 1, W - 1, W, W, W + 1, W - 2, W + 2, 3, W - 1][rnd(10)] as number;
    let s = "";
    for (let i = 0; i < len; i++) s += TOK[rnd(TOK.length)];
    return s;
  };
  return () => {
    let s = "";
    const n = rnd(6);
    for (let i = 0; i < n; i++) s += line() + (["\n", "\r\n", "\n", "\r\r\n"][rnd(4)] as string);
    if (rnd(4) !== 0) s += line() + (["", "\r", "\r", "\r\r", "x\r"][rnd(5)] as string);
    if (rnd(8) === 0) s = "\r".repeat(rnd(4) + 1);
    return s;
  };
}

// The oracle: git splits on LF only; a CR is the line end only before an LF; the view keeps W code points.
const cps = (s: string): number => Array.from(s).length;
const visible = (text: string, terminated: boolean): string => (terminated && text.endsWith("\r") ? text.slice(0, -1) : text);
function cutCount(body: string): number {
  const parts = body.split("\n");
  const last = parts.pop() as string;
  const lines: [string, boolean][] = parts.map((t) => [t, true]);
  if (last !== "") lines.push([last, false]);
  return lines.filter(([t, term]) => cps(visible(t, term)) > W).length;
}
function changedCut(f: Fixture, path: string): number {
  const lines = f.git("diff", "-U0", "--no-color", "--no-ext-diff", "HEAD", "--", path).split("\n");
  let n = 0;
  let started = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.startsWith("@@")) started = true;
    else if (started && (l.startsWith("+") || l.startsWith("-"))) {
      const noEol = (lines[i + 1] ?? "").startsWith("\\ No newline");
      if (cps(visible(l.slice(1), !noEol)) > W) n++;
    }
  }
  return n;
}
const reasonOf = (e: unknown): unknown => (e instanceof ReviewError ? e.details?.["reason"] : undefined);

for (const seed of SEEDS) {
  test(`every cut-line judgement agrees with the oracle and with each other (seed ${seed}, width ${W})`, async () => {
    const rnd = rng(seed);
    const body = bodies(rnd);
    const bad: unknown[] = [];
    for (let iter = 0; iter < ITER; iter++) {
      const files = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.txt`, old: rnd(4) === 0 ? null : body(), now: body() }));
      const f = fixture({
        deps: { limits: { maxDisplay: MAXD } },
        base: ({ write }) => {
          for (const x of files) if (x.old !== null) write(x.path, x.old);
        },
      });
      try {
        for (const x of files) f.write(x.path, x.now);
        const live = files.filter((x) => x.old !== x.now && !(x.old === null && x.now === ""));
        if (live.length === 0) continue;
        const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
        let anyCut = false;
        for (const x of live) {
          const hk = await s.hunks(x.path);
          const cut = await s.hasCutLines(x.path);
          const prev = await s.preview(x.path, "new");
          if (prev.kind === "text" && prev.truncatedLines !== cutCount(x.now)) bad.push([x.path, "preview", prev.truncatedLines, cutCount(x.now)]);
          if (hk.hunks) {
            const oracle = changedCut(f, x.path);
            let flagged = 0;
            for (const h of hk.hunks) {
              const n = h.lines.filter((l) => l.kind !== " " && l.truncated).length;
              flagged += n;
              if (h.truncated !== n > 0) bad.push([x.path, "hunk flag vs line flags"]);
              if (h.lines.some((l) => /[\r\u000b\u000c\u0085\u2028]/u.test(l.text))) bad.push([x.path, "raw control in view text"]);
              let refused = false;
              try {
                s.acceptHunk(x.path, h.id);
              } catch (e) {
                refused = reasonOf(e) === "truncated_hunk";
                if (!refused) bad.push([x.path, "acceptHunk other error"]);
              }
              if (refused !== h.truncated) bad.push([x.path, "hunk gate vs hunk flag"]);
              s.rejectHunk(x.path, h.id);
            }
            if (flagged !== oracle) bad.push([x.path, "view vs git -U0 oracle", flagged, oracle]);
            if (cut !== oracle > 0) bad.push([x.path, "hasCutLines vs oracle", cut, oracle]);
          } else if (x.old === null && cut !== cutCount(x.now) > 0) {
            bad.push([x.path, `hasCutLines (${hk.fileLevelReason}) vs oracle`]);
          }
          if (cut) anyCut = true;
          s.acceptFile(x.path);
        }
        let refused = false;
        try {
          await s.build();
        } catch (e) {
          refused = reasonOf(e) === "truncated_hunk";
          if (!refused) bad.push(["build other error", String(e)]);
        }
        if (refused !== anyCut) bad.push(["build recheck vs hasCutLines", refused, anyCut]);
        for (const x of live) s.acceptFile(x.path, { acceptTruncated: true });
        const b = await s.build();
        for (const x of live) {
          if (x.now === "" && x.old !== null) continue;
          if (f.git("cat-file", "blob", `${b.reviewedTree}:${x.path}`) !== x.now) bad.push([x.path, "built blob differs"]);
        }
      } finally {
        f.cleanup();
      }
    }
    assert.deepEqual(bad, []);
  });
}
