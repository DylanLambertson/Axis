// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The grant dialog's short plugin id, widened before K2-enable (review K2-g2 N2, plugin-grant-contract.md section 3.1): ids of 22
// units or fewer are shown whole, longer ones as 6 characters, "…" and 15 hex of the whole id's SHA-256, and the worst-case line
// still fits with the project's minimum. The pairs below were found in a few thousand tries against the earlier 24-bit form.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DANGER_MARKER, DIALOG_DETAIL_UNITS, GRANT_WORDING, ENABLE_WORDING, ID_HASH_HEX, ID_UNITS, MIN_PROJECT_UNITS, grantLine, shortPluginId } from "../src/plugins/grant-line.js";

const hex = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex");
/** The form before the widening: 12 characters, "…", 6 hex (24 bits). */
const before = (id: string): string => (id.length <= 19 ? id : `${id.slice(0, 12)}…${hex(id).slice(0, 6)}`);

const SHORT_PAIR = ["acme.board-tools-2484", "acme.board-tools-7157"] as const;
const LONG_PAIR = ["acme.board-tools-extended-6164", "acme.board-tools-extended-16094"] as const;

test("two ids that shared the earlier short form are told apart now", () => {
  for (const [a, b] of [SHORT_PAIR, LONG_PAIR]) {
    assert.equal(before(a), before(b), `the fixture collides under the earlier form: ${a} ${b}`);
    assert.notEqual(shortPluginId(a), shortPluginId(b), `${a} ${b}`);
  }
  // The short pair now fits whole; the long pair differs in the hash part.
  assert.deepEqual(SHORT_PAIR.map(shortPluginId), [...SHORT_PAIR]);
  assert.deepEqual(LONG_PAIR.map(shortPluginId), ["acme.b…5fb96136b9e94bf", "acme.b…5fb9610906f6795"]);
});

test("whole up to 22 units; longer is 6 characters, an ellipsis and 15 hex of the whole id, 22 units", () => {
  assert.equal(ID_UNITS, 22);
  assert.equal(ID_HASH_HEX, 15);
  const at = "a".repeat(22);
  assert.equal(shortPluginId(at), at);
  for (const id of ["a".repeat(23), `acme.${"b".repeat(59)}`]) {
    const s = shortPluginId(id);
    assert.equal(s.length, ID_UNITS, id);
    assert.equal(s, `${id.slice(0, 6)}…${hex(id).slice(0, 15)}`);
  }
  // Two ids that differ only after the shown prefix differ in the short form (by the whole id's hash).
  assert.notEqual(shortPluginId(`acme.${"b".repeat(58)}c`), shortPluginId(`acme.${"b".repeat(58)}d`));
});

test("the worst case fits: the danger marker, the longest wording and a 64-character id leave the project its minimum", () => {
  const longest = [...Object.values(GRANT_WORDING), ENABLE_WORDING].reduce((a, b) => (b.length > a.length ? b : a));
  assert.ok(longest.length <= 28, "the wording budget the constant assumes");
  const wording = "w".repeat(28);
  const line = grantLine({ wording, dangerous: true, pluginId: `acme.${"b".repeat(59)}`, projectName: "P".repeat(40) });
  assert.equal(line.length, DIALOG_DETAIL_UNITS);
  const head = `${DANGER_MARKER}${wording}: ${shortPluginId(`acme.${"b".repeat(59)}`)} in `;
  assert.ok(line.startsWith(head), "the marker, the wording and the id are whole");
  assert.equal(DIALOG_DETAIL_UNITS - head.length, MIN_PROJECT_UNITS, "exactly the project's minimum is left");
});

test("audit A L3: a wording-like project name or plugin id lands only after the fixed wording, which stays first and whole", () => {
  for (const [pluginId, projectName] of [["acme.board", "demo - nothing granted - OK is safe"], ["only-reads-pages", "demo"], ["may-read-pages", "SENDS DATA OUT: no"]] as const) {
    const line = grantLine({ wording: GRANT_WORDING["runs.start"], dangerous: false, pluginId, projectName });
    assert.ok(line.startsWith(`${GRANT_WORDING["runs.start"]}: ${shortPluginId(pluginId)} in `), line);
    assert.ok(line.length <= DIALOG_DETAIL_UNITS, line);
  }
  const marked = grantLine({ wording: GRANT_WORDING["files.read"], dangerous: true, pluginId: "only-reads-pages", projectName: "nothing sent out" });
  assert.ok(marked.startsWith(`${DANGER_MARKER}${GRANT_WORDING["files.read"]}: `), marked);
});
