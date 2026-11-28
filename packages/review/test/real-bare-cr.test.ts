// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV-1: a CR ends a line only when an LF follows it. A bare CR at the end of a file's last line is content: the view shows
// it (escaped) or marks the line cut, and the cut-line gate on accept and build counts it the same way. One predicate decides
// all of them, so a byte the view did not show can never be accepted without the acknowledgement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewSession } from "../src/index.js";
import { fixture, refusal, type Fixture } from "./fixture.js";

const WIDTH = 1024; // maxDisplay 256 x 4 code points
const deps = { limits: { maxDisplay: 256 } } as const;
const CONTEXT = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
const EARLY = CONTEXT.replace("line 2\n", "other 2\n");
const show = (f: Fixture, tree: string, path: string): string => f.git("cat-file", "blob", `${tree}:${path}`);

function withLast(): Fixture {
  return fixture({ deps, base: ({ write }) => write("probe", `${CONTEXT}last`) });
}

async function lastHunk(f: Fixture, body: string) {
  f.write("probe", body);
  const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
  const h = (await s.hunks("probe")).hunks ?? [];
  assert.equal(h.length, 2, "an earlier edit keeps the last hunk a partial selection");
  return { s, h: h[1] as NonNullable<(typeof h)[number]> };
}

test("a changed final line of exactly the width plus a bare CR is cut: refused without the acknowledgement, exact bytes with it", async () => {
  const f = withLast();
  try {
    const body = `${EARLY}${"x".repeat(WIDTH)}\r`;
    const { s, h } = await lastHunk(f, body);
    const line = h.lines.at(-1);
    assert.equal(line?.eol, "none");
    assert.equal(line?.truncated, true, "the CR is the code point past the width");
    assert.equal(line?.text, "x".repeat(WIDTH));
    assert.equal(h.truncated, true, "the hunk flag and the line flag agree");
    assert.throws(() => s.acceptHunk("probe", h.id), (e: unknown) => (e as { details?: Record<string, unknown> }).details?.["reason"] === "truncated_hunk");
    s.acceptHunk("probe", h.id, { acceptTruncated: true });
    const b = await s.build();
    assert.equal(show(f, b.reviewedTree, "probe"), `${CONTEXT}${"x".repeat(WIDTH)}\r`, "the CR is in the built blob, the early edit is not");
  } finally {
    f.cleanup();
  }
});

test("one code point under the bound, the bare CR is shown escaped and nothing is cut", async () => {
  const f = withLast();
  try {
    const { s, h } = await lastHunk(f, `${EARLY}${"x".repeat(WIDTH - 1)}\r`);
    const line = h.lines.at(-1);
    assert.equal(line?.eol, "none");
    assert.equal(line?.truncated, false);
    assert.equal(line?.text, `${"x".repeat(WIDTH - 1)}\\r`, "the reviewer sees the CR");
    assert.equal(h.truncated, false);
    s.acceptHunk("probe", h.id);
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("a removed final line with a bare CR past the width needs the acknowledgement too", async () => {
  const f = fixture({ deps, base: ({ write }) => write("probe", `${CONTEXT}${"y".repeat(WIDTH)}\r`) });
  try {
    const { s, h } = await lastHunk(f, `${EARLY}end\n`);
    const removed = h.lines.filter((l) => l.kind === "-");
    assert.equal(removed.at(-1)?.truncated, true);
    assert.equal(h.truncated, true);
    assert.throws(() => s.acceptHunk("probe", h.id), (e: unknown) => (e as { details?: Record<string, unknown> }).details?.["reason"] === "truncated_hunk");
    s.acceptHunk("probe", h.id, { acceptTruncated: true });
    const b = await s.build();
    assert.equal(show(f, b.reviewedTree, "probe"), `${CONTEXT}end\n`);
  } finally {
    f.cleanup();
  }
});

test("a CRLF line of exactly the width is not cut: the CR before the LF is the line end", async () => {
  const f = withLast();
  try {
    const { s, h } = await lastHunk(f, `${EARLY}${"x".repeat(WIDTH)}\r\n`);
    const line = h.lines.at(-1);
    assert.equal(line?.eol, "crlf");
    assert.equal(line?.truncated, false);
    assert.equal(h.truncated, false);
    s.acceptHunk("probe", h.id);
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("a whole added file whose last line is the width plus a bare CR is cut, in the preview and at build", async () => {
  const f = fixture({ deps });
  try {
    f.write("added.txt", `short\n${"z".repeat(WIDTH)}\r`);
    f.write("fits.txt", `short\n${"z".repeat(WIDTH - 1)}\r`);
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    const p = await s.preview("added.txt", "new");
    assert.equal(p.kind === "text" && p.truncatedLines, 1, "the preview counts the line as cut");
    assert.equal(await s.hasCutLines("added.txt"), true);
    s.acceptFile("added.txt");
    assert.equal((await refusal(s.build())).details?.["reason"], "truncated_hunk");
    s.acceptFile("added.txt", { acceptTruncated: true });
    const b = await s.build();
    assert.equal(show(f, b.reviewedTree, "added.txt"), `short\n${"z".repeat(WIDTH)}\r`);

    const q = await s.preview("fits.txt", "new");
    assert.equal(q.kind === "text" && q.text, `short\n${"z".repeat(WIDTH - 1)}\\r`, "the preview shows the CR it does not cut");
    assert.equal(await s.hasCutLines("fits.txt"), false);
  } finally {
    f.cleanup();
  }
});
