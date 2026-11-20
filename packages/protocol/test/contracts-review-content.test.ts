// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.review/1.content (ticket RV-CONTENT): strict, closed and bounded views; nothing raw reaches a client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_REFUSED, MAX_CONTENT_FILE_CHARS, MAX_CONTENT_FILES, MAX_CONTENT_LINE, MAX_CONTENT_LINES, MAX_CONTENT_TEXT_BYTES, viewChars } from "../src/index.js";
import { binary, contentResponse, deleted, FID, gitlink, HEAD, link, longText, REVIEW_CONTENT_SAMPLES, textFile, tooLarge, unavailable } from "./samples-review-content.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

runSuite(REVIEW_CONTENT_SAMPLES);

const req = () => schemaOf("axis.review", "content", "request");
const res = () => schemaOf("axis.review", "content", "response");
type F = Record<string, unknown> & { view: Record<string, unknown> };
const reply = (...files: F[]) => ({ head: HEAD, files, notFound: [] as string[] });
const withView = (f: F, view: Record<string, unknown>): F => ({ ...f, view: { ...f.view, ...view } });
const text = (first: string[], extra: Record<string, unknown> = {}): F =>
  withView(longText as F, { size: 10, lines: first.length, first, last: [], omittedLines: 0, cutLines: 0, finalNewline: true, ...extra });

test("the reference reply holds every view and passes", () => {
  accepts(res(), contentResponse, "every view");
  for (const f of [textFile, longText, tooLarge, binary, link, gitlink, deleted, unavailable] as F[]) accepts(res(), reply(f), String(f.view["kind"]));
});

test("a shown line may hold a tab and escapes, but no raw control, terminal sequence, bidi, zero-width or invisible character", () => {
  accepts(res(), reply(text(["\tindented", "a \\u{1b}[31m b", "\\xff\\xfe", "plain é 中 \u{1f600}"])), "escaped text");
  const raw: Array<[string, string]> = [
    ["NUL", "a\u0000b"], ["ESC (ANSI CSI)", "\u001b[31mred"], ["OSC hyperlink", "\u001b]8;;https://x\u0007x"], ["BEL", "\u0007"], ["CR", "a\rb"],
    ["LF", "a\nb"], ["DEL", "\u007f"], ["C1 NEL", "\u0085"], ["C1 CSI", "\u009b31m"], ["RLO", "‮"], ["RLI", "⁧"], ["LRM", "‎"],
    ["ZWSP", "​"], ["ZWJ", "‍"], ["BOM", "﻿"], ["word joiner", "⁠"], ["LS", " "], ["PS", " "], ["tag", "\u{e0041}"],
    ["variation selector", "️"], ["Hangul filler", "ㅤ"], ["lone surrogate", "\ud800"], ["soft hyphen", "­"], ["Arabic letter mark", "؜"],
  ];
  for (const [name, line] of raw) {
    assert.equal(CONTENT_REFUSED.test(line), true, name);
    rejects(res(), reply(text(["ok", line])), `${name} in a text line`);
    rejects(res(), reply(withView(tooLarge as F, { first: [line] })), `${name} in an excerpt`);
    rejects(res(), reply(withView(link as F, { target: line })), `${name} in a link target`);
  }
  assert.equal(CONTENT_REFUSED.test("\t"), false, "TAB is the one control a line keeps");
});

test("per line, per file and per reply bounds", () => {
  accepts(res(), reply(text(["x".repeat(MAX_CONTENT_LINE)])), "a line at the bound");
  rejects(res(), reply(text(["x".repeat(MAX_CONTENT_LINE + 1)])), "a line over the bound");
  rejects(res(), reply(withView(link as F, { target: "x".repeat(MAX_CONTENT_LINE + 1) })), "a link target over the bound");
  const many = Array.from({ length: MAX_CONTENT_LINES + 1 }, () => "a");
  rejects(res(), reply(text(many)), "more lines than a file may show");
  accepts(res(), reply(text(many.slice(1))), "exactly the most lines");
  rejects(res(), reply(withView(tooLarge as F, { first: many.slice(0, 200), last: many.slice(0, 57) })), "too many excerpt lines");
  // 64 lines of 512 units = 32768 units: at the per-file bound; one unit more is refused.
  const full = Array.from({ length: 64 }, () => "y".repeat(MAX_CONTENT_LINE));
  accepts(res(), reply(text(full)), "a file at the text bound");
  rejects(res(), reply(text([...full, "z"])), "a file over the text bound");
  assert.equal(viewChars((text(full) as { view: never }).view), MAX_CONTENT_FILE_CHARS);
  // Five full files are over the per-reply bound; four are at it.
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ ...structuredClone(text(full)), fileId: FID(i + 1) }));
  accepts(res(), reply(...files(4)), "a reply at the bound");
  rejects(res(), reply(...files(5)), "a reply over the bound");
});

test("text and excerpt counts must agree, and a size picks the kind", () => {
  rejects(res(), reply(text(["a"], { lines: 2 })), "lines without omitted ones");
  rejects(res(), reply(text(["a"], { last: ["b"], lines: 2 })), "a last part with nothing omitted");
  accepts(res(), reply(text(["a"], { last: ["b"], lines: 3, omittedLines: 1 })), "a gap");
  rejects(res(), reply(text(["a"], { cutLines: 2 })), "more cut lines than shown");
  rejects(res(), reply(text(["a"], { size: MAX_CONTENT_TEXT_BYTES + 1 })), "text over the text bound");
  rejects(res(), reply(withView(tooLarge as F, { size: MAX_CONTENT_TEXT_BYTES })), "too-large at the text bound");
  rejects(res(), reply(withView(tooLarge as F, { readComplete: false })), "an end excerpt from an unfinished read");
  accepts(res(), reply(withView(tooLarge as F, { readComplete: false, last: [] })), "an unfinished read shows the start only");
  rejects(res(), reply(withView(tooLarge as F, { cutLines: 3 })), "too-large cut count");
});

test("closed kinds: no raw bytes, no extra field, prefixes and ids in their exact form", () => {
  rejects(res(), reply(withView(binary as F, { bytes: "AAAA" })), "binary with bytes");
  rejects(res(), reply(withView(binary as F, { first: ["x"] })), "binary with lines");
  rejects(res(), reply(withView(deleted as F, { first: [] })), "deleted with lines");
  rejects(res(), reply(withView(binary as F, { kind: "image" })), "an unknown kind");
  for (const p of ["0123456789a", "0123456789abc", "0123456789AB", "0123456789ag"]) rejects(res(), reply(withView(binary as F, { objectPrefix: p })), `prefix ${p}`);
  rejects(res(), reply(withView(gitlink as F, { commit: "B".repeat(40) })), "an upper-case commit");
  rejects(res(), reply(withView(unavailable as F, { reason: "secret" })), "an open reason");
  rejects(res(), reply({ ...binary, displayPath: "a‮b" } as F), "a raw display path");
});

test("a content id exactly for what is shown; protected files first and flagged consistently", () => {
  rejects(res(), reply({ ...binary, contentId: null } as F), "a shown file without a content id");
  rejects(res(), reply({ ...unavailable, contentId: "c".repeat(64) } as F), "an unavailable file with a content id");
  rejects(res(), reply({ ...binary, contentId: "C".repeat(64) } as F), "an upper-case content id");
  rejects(res(), reply(binary as F, textFile as F), "a protected file after an ordinary one");
  accepts(res(), reply(textFile as F, binary as F), "protected first");
  rejects(res(), reply({ ...binary, protectedPath: true } as F), "a flag without rules");
  rejects(res(), reply({ ...binary, protectedRules: ["x"] } as F), "rules without the flag");
});

test("ids: unique across files and not-found ids, never more than were asked for", () => {
  rejects(res(), reply(binary as F, binary as F), "a file twice");
  rejects(res(), { head: HEAD, files: [binary], notFound: [binary.fileId] }, "found and not found");
  rejects(res(), { head: HEAD, files: [], notFound: [FID(1), FID(1)] }, "not found twice");
  const nine = Array.from({ length: MAX_CONTENT_FILES + 1 }, (_, i) => (i + 1).toString(16).padStart(2, "0").repeat(32));
  rejects(res(), { head: HEAD, files: [], notFound: nine }, "nine not found");
  rejects(res(), { head: HEAD, files: [binary], notFound: nine.slice(1) }, "one found and eight not found");
  accepts(req(), { workspaceId: "ws-1", fileIds: nine.slice(1) }, "eight ids");
  rejects(req(), { workspaceId: "ws-1", fileIds: nine }, "nine ids");
  rejects(req(), { workspaceId: "ws-1", fileIds: [] }, "no id");
  rejects(req(), { workspaceId: "ws-1", fileIds: [FID(1), FID(1)] }, "a duplicate id");
  rejects(req(), { workspaceId: "ws-1", fileIds: ["A".repeat(64)] }, "an upper-case id");
  rejects(req(), { workspaceId: "ws-1", fileIds: [FID(1)], path: "src/a.ts" }, "a path in the request");
});
