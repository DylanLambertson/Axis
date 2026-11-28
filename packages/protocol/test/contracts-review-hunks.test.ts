// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.review/1.hunks and build (DC-2): strict, closed and bounded; the reply bounds hold through the production message walk.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HUNKS_REPLY_INSPECT,
  hunksReplyFits,
  inspectMessage,
  MAX_HUNK_LINE_CHARS,
  MAX_HUNKS_REPLY_CHARS,
  MAX_HUNKS_REPLY_LINES,
  MAX_SELECTION_HUNK_IDS,
  REVIEW_BUILD_REASONS,
  REVIEW_HUNKS_FILE_LEVEL_REASONS,
  REVIEW_HUNKS_REASONS,
  reviewBuildReasonSchema,
} from "../src/index.js";
import type { Sample } from "./suite.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

const HEAD = "a".repeat(40);
const FID = (n: number): string => n.toString(16).repeat(64);
const VID = "d".repeat(64);
const HID = (i: number): string => `${i}:${"0123456789abcdef"}`;
type Line = { kind: " " | "-" | "+"; text: string; eol: "lf" | "crlf" | "none"; truncated: boolean };
const line = (text: string, over: Partial<Line> = {}): Line => ({ kind: "+", text, eol: "lf", truncated: false, ...over });
const hunk = (i: number, lines: Line[], truncated = lines.some((l) => l.kind !== " " && l.truncated)) => ({ id: HID(i), header: "@@ -1,2 +1,3 @@", lines, truncated });
const hunksReply = (hunks: unknown[]) => ({ head: HEAD, fileId: FID(1), versionId: VID, hunks });

const SAMPLES: readonly Sample[] = [
  { contract: "axis.review", method: "hunks", side: "request", name: "one file", value: { workspaceId: "ws-1", fileId: FID(1) } },
  {
    contract: "axis.review", method: "hunks", side: "response", name: "two hunks",
    value: hunksReply([hunk(0, [line("ctx", { kind: " " }), line("old", { kind: "-", eol: "crlf" }), line("new \\u{202e} \\\\")]), hunk(1, [line("last \\r", { eol: "none", truncated: true })])]),
  },
  { contract: "axis.review", method: "hunks", side: "response", name: "a whole-file reason", value: { head: HEAD, fileId: FID(1), versionId: VID, fileLevelReason: "over_view_budget" } },
  {
    contract: "axis.review", method: "build", side: "request", name: "a whole file and two hunks",
    value: { workspaceId: "ws-1", head: HEAD, selection: [{ fileId: FID(1), versionId: VID, whole: true, acknowledged: true }, { fileId: FID(2), versionId: VID, hunkIds: [HID(0), HID(2)], acknowledgedHunkIds: [HID(2)] }] },
  },
  {
    contract: "axis.review", method: "build", side: "response", name: "the tree and what it holds",
    value: { head: HEAD, branch: "axis/feat", treeHash: "c".repeat(40), selection: [{ fileId: FID(1), versionId: VID, whole: true }, { fileId: FID(2), versionId: VID, hunkIds: [HID(0)] }] },
  },
];
runSuite(SAMPLES);

const req = (m: "hunks" | "build") => schemaOf("axis.review", m, "request");
const res = (m: "hunks" | "build") => schemaOf("axis.review", m, "response");

test("a hunks reply has exactly one of hunks and fileLevelReason", () => {
  rejects(res("hunks"), { head: HEAD, fileId: FID(1), versionId: VID }, "neither");
  rejects(res("hunks"), { ...hunksReply([hunk(0, [line("a")])]), fileLevelReason: "binary" }, "both");
  rejects(res("hunks"), hunksReply([]), "an empty hunk list");
  rejects(res("hunks"), hunksReply([hunk(0, [line("a")]), hunk(0, [line("b")])]), "a duplicate hunk id");
});

test("every whole-file reason the core produces is on the wire, and nothing else", () => {
  for (const r of REVIEW_HUNKS_FILE_LEVEL_REASONS) accepts(res("hunks"), { head: HEAD, fileId: FID(1), versionId: VID, fileLevelReason: r }, r);
  for (const r of ["arbitrary_reason", "too large", "", "TOO_LARGE"]) rejects(res("hunks"), { head: HEAD, fileId: FID(1), versionId: VID, fileLevelReason: r }, r);
  for (const r of ["too-large", "too_large", "over_view_budget", "attributes_untrusted", "not_a_regular_file", "type_change"]) assert.ok((REVIEW_HUNKS_FILE_LEVEL_REASONS as readonly string[]).includes(r), r);
});

test("the hunk flag must agree with its added and removed lines; a cut context line does not count", () => {
  rejects(res("hunks"), hunksReply([hunk(0, [line("a", { truncated: true })], false)]), "a cut + line under an uncut hunk");
  rejects(res("hunks"), hunksReply([hunk(0, [line("a")], true)]), "an uncut hunk flagged");
  accepts(res("hunks"), hunksReply([hunk(0, [line("ctx", { kind: " ", truncated: true }), line("a")], false)]), "a cut context line");
});

test("a line holds escapes and a tab, never a raw control, format or invisible character, nor a leading combining mark", () => {
  accepts(res("hunks"), hunksReply([hunk(0, [line("\tok \\u{200b} \\r \\x1b[31m")])]), "escaped text");
  for (const raw of ["a\rb", "a\u0000", "\u001b[31m", "\u202e", "\u200b", "\u2028", "\ufeff", "\u0600", "\u{e0041}", "\u3164", "\ud800"]) {
    rejects(res("hunks"), hunksReply([hunk(0, [line(`x${raw}`)])]), JSON.stringify(raw));
  }
  rejects(res("hunks"), hunksReply([hunk(0, [line("\u0301x")])]), "a combining mark first");
  accepts(res("hunks"), hunksReply([hunk(0, [line("x\u0301")])]), "a combining mark after a base");
});

test("a line of 1,024 escaped U+10FFFF (or U+10FFFE) is exactly the 10,240-unit cap and passes the message walk", () => {
  for (const esc of ["\\u{10ffff}", "\\u{10fffe}"]) {
    const text = esc.repeat(1024);
    assert.equal(text.length, MAX_HUNK_LINE_CHARS);
    const reply = hunksReply([hunk(0, [line(text, { eol: "none" })])]);
    accepts(res("hunks"), reply, esc);
    assert.equal(hunksReplyFits(reply), true, esc);
    rejects(res("hunks"), hunksReply([hunk(0, [line(`${text}x`)])]), `${esc} plus one unit`);
  }
});

test("the reply bounds: 1,500 lines and 131,072 units fit the production walk with headroom, one more is refused", () => {
  const many = (n: number, text = "x") => Array.from({ length: n }, () => line(text));
  // 200 hunks sharing 1,500 lines: the most values a reply can hold.
  const spread = Array.from({ length: 200 }, (_, i) => hunk(i, many(i < 100 ? 8 : 7)));
  assert.equal(spread.reduce((n, h) => n + h.lines.length, 0), MAX_HUNKS_REPLY_LINES);
  const full = hunksReply(spread);
  accepts(res("hunks"), full, "1,500 lines in 200 hunks");
  assert.equal(inspectMessage(full, HUNKS_REPLY_INSPECT).ok, true);
  rejects(res("hunks"), hunksReply([hunk(0, many(MAX_HUNKS_REPLY_LINES + 1))]), "1,501 lines");
  // 131,072 units of three-byte text: the largest reply in bytes.
  const wide = hunksReply([hunk(0, many(128, "\u4e2d".repeat(1024)))]);
  accepts(res("hunks"), wide, "131,072 units");
  assert.equal(hunksReplyFits(wide), true);
  rejects(res("hunks"), hunksReply([hunk(0, [...many(128, "x".repeat(1024)), line("y")])]), "131,073 units");
  assert.ok(MAX_HUNKS_REPLY_CHARS === 128 * 1024);
});

test("a selection is unique, non-empty, acknowledges only what it selects, and holds at most 2,000 hunk ids", () => {
  const item = (n: number, ids = [HID(0)], acked?: string[]) => ({ fileId: FID(n), versionId: VID, hunkIds: ids, ...(acked ? { acknowledgedHunkIds: acked } : {}) });
  const build = (selection: unknown[]) => ({ workspaceId: "ws-1", head: HEAD, selection });
  rejects(req("build"), build([]), "empty");
  rejects(req("build"), build([item(1), item(1)]), "a duplicate file id");
  rejects(req("build"), build([item(1, [HID(0)], [HID(1)])]), "an acknowledged hunk not selected");
  rejects(req("build"), build([item(1, [HID(0), HID(0)])]), "a duplicate hunk id");
  rejects(req("build"), build([{ fileId: FID(1), versionId: VID, whole: false }]), "whole: false");
  rejects(req("build"), build([{ fileId: FID(1), versionId: VID, whole: true, acknowledged: false }]), "acknowledged: false");
  rejects(req("build"), build([{ fileId: FID(1), versionId: VID, whole: true, hunkIds: [HID(0)] }]), "both shapes");
  rejects(req("build"), build([{ fileId: FID(1), whole: true }]), "no version");
  const ids = Array.from({ length: 200 }, (_, i) => HID(i));
  const tenFull = Array.from({ length: 10 }, (_, i) => item(i + 1, [...ids]));
  assert.equal(tenFull.length * 200, MAX_SELECTION_HUNK_IDS);
  accepts(req("build"), build(tenFull), "2,000 ids");
  rejects(req("build"), build([...tenFull.slice(0, 9), item(10, [...ids], [HID(0)])]), "2,001 ids");
  rejects(req("hunks"), { workspaceId: "ws-1", fileId: "not-an-id" }, "a bad file id");
});

test("the refusal reasons are closed sets that hold the new ones", () => {
  for (const r of ["file_not_found"]) assert.ok((REVIEW_HUNKS_REASONS as readonly string[]).includes(r));
  for (const r of ["head_moved", "selection_stale", "no_hunks", "file_not_found", "truncated_hunk", "unsafe_path", "filtered_path", "not_head"]) {
    assert.equal(reviewBuildReasonSchema.safeParse(r).success, true, r);
  }
  assert.equal(reviewBuildReasonSchema.safeParse("anything").success, false);
  assert.equal(new Set(REVIEW_BUILD_REASONS).size, REVIEW_BUILD_REASONS.length, "no duplicate reason");
});
