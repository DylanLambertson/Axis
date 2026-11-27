// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D2 §5: the two-stage parse with the filter first, the reductions, and the display text of hostile pull requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayTextSchema, FORGE_BRANCH_CHARS, FORGE_TITLE_CHARS, forgePullRequestSchema } from "@axis/protocol";
import { forgeDisplay, parseForgeList, reduceChecks, reduceReview } from "../src/index.js";

const PIN = { host: "github.com", owner: "Acme", repo: "app" } as const;
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: "Add the thing",
  headRefName: "axis/add-thing",
  author: { login: "octo", id: "x", is_bot: false },
  isDraft: false,
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme", id: "y" },
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
  updatedAt: "2026-11-20T10:00:00Z",
  ...over,
});
const parse = (rows: unknown): ReturnType<typeof parseForgeList> => parseForgeList(JSON.stringify(rows), PIN);
const ok = (rows: unknown) => {
  const r = parse(rows);
  assert.equal(r.kind, "ok");
  return r as Extract<typeof r, { kind: "ok" }>;
};

test("the filter runs first: a fork row with a hostile branch and a huge title cannot deny the list", () => {
  const fork = row({ isCrossRepository: true, headRefName: "axis/é‮", title: "x".repeat(5000), number: -1, author: null });
  const r = ok([fork, row()]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.invalidRows, 0, "a dropped row is not an invalid row");
  assert.equal(r.rows[0]?.number, 7);
});

test("only same-repository rows of the pinned owner on axis/ branches are kept", () => {
  const dropped = [
    row({ isCrossRepository: true }),
    row({ isCrossRepository: "false" }),
    row({ isCrossRepository: undefined }),
    row({ headRepositoryOwner: { login: "evil" } }),
    row({ headRepositoryOwner: "acme" }),
    row({ headRepositoryOwner: null }),
    row({ headRefName: "main" }),
    row({ headRefName: "xaxis/a" }),
    row({ headRefName: "Axis/a" }),
  ];
  assert.equal(ok(dropped).rows.length, 0);
  assert.equal(ok([row({ headRepositoryOwner: { login: "ACME" } })]).rows.length, 1, "owners compare case-insensitively");
  // ASCII only: no Unicode case or compatibility fold can make another login equal the pin (review S1a SF-1).
  const kelvin = parseForgeList(JSON.stringify([row({ headRepositoryOwner: { login: "\u212aelvin" } })]), { host: "github.com", owner: "kelvin", repo: "app" });
  assert.deepEqual(kelvin.kind === "ok" ? kelvin.rows.length : -1, 0, "Kelvin sign");
  for (const login of ["\uff21cme", "acme\u0301", "acm\u0435", "acme ", "ac_me"]) assert.equal(ok([row({ headRepositoryOwner: { login } })]).rows.length, 0, login);
  // A "__proto__" key in the JSON is an own property named so, never the row's fields.
  const smuggled = `[{"__proto__":${JSON.stringify(row())}}]`;
  assert.equal(ok(JSON.parse(smuggled)).rows.length, 0);
});

test("a kept row that fails the strict check is dropped and counted, never fatal", () => {
  const bad = [
    row({ number: 0 }),
    row({ number: 1.5 }),
    row({ title: "t".repeat(1025) }),
    row({ headRefName: "axis/bad..ref" }),
    row({ author: { login: "-x" } }),
    row({ author: { login: "a b" } }),
    row({ isDraft: "no" }),
    row({ reviewDecision: 5 }),
  ];
  const r = ok([...bad, row({ number: 9 })]);
  assert.deepEqual([r.rows.map((x) => x.number), r.invalidRows], [[9], bad.length]);
});

test("the outer layer is strict: one array of at most 50 objects", () => {
  for (const s of ["", "nope", "{}", "null", "[1]", "[null]", "[[]]", `[${JSON.stringify(row())},"x"]`]) assert.deepEqual(parseForgeList(s, PIN), { kind: "invalid" }, s);
  assert.deepEqual(parse(Array.from({ length: 51 }, () => row())), { kind: "invalid" });
  assert.equal(ok(Array.from({ length: 50 }, () => row())).incomplete, true);
  assert.equal(ok(Array.from({ length: 49 }, () => row())).incomplete, false);
  // The window is the gh output, not the kept rows: 50 rows with forks among them is still a full window (review S1a SF-4).
  const mixed = ok([...Array.from({ length: 45 }, () => row({ isCrossRepository: true })), ...Array.from({ length: 5 }, () => row())]);
  assert.deepEqual([mixed.rows.length, mixed.incomplete], [5, true]);
});

test("bots are accepted as app/<slug> and login[bot]", () => {
  assert.equal(ok([row({ author: { login: "app/dependabot" } })]).rows[0]?.author, "app/dependabot");
  assert.equal(ok([row({ author: { login: "renovate[bot]" } })]).rows[0]?.author, "renovate[bot]");
  assert.equal(ok([row({ author: { login: "app/Bad" } })]).invalidRows, 1);
});

test("display text: controls, ANSI and OSC 8, bidi, zero-width and separators are removed; NFC; cut with an ellipsis", () => {
  const hostile = "a\u001b[31mred\u001b[0m \u001b]8;;https://evil\u0007link\u001b]8;;\u0007 ‮evil‬ ​z \u0085é";
  const shown = forgeDisplay(hostile, FORGE_TITLE_CHARS);
  assert.equal(shown, "a[31mred[0m ]8;;https://evillink]8;; evil zé");
  assert.equal(displayTextSchema(FORGE_TITLE_CHARS).safeParse(shown).success, true);
  const long = forgeDisplay("y".repeat(500), FORGE_TITLE_CHARS);
  assert.equal(long, `${"y".repeat(FORGE_TITLE_CHARS)}…`);
  // An astral character is never split at the cut.
  const astral = forgeDisplay("\u{1f600}".repeat(150), FORGE_TITLE_CHARS);
  assert.equal(astral, `${"\u{1f600}".repeat(100)}…`);
  assert.equal(forgeDisplay("y".repeat(FORGE_TITLE_CHARS), FORGE_TITLE_CHARS), "y".repeat(FORGE_TITLE_CHARS), "exactly the limit is not cut");
  // An astral character straddling the 200th UTF-16 unit is left out whole: no lone surrogate (review S1a SF-4).
  const straddle = forgeDisplay(`${"y".repeat(FORGE_TITLE_CHARS - 1)}\u{1f600}tail`, FORGE_TITLE_CHARS);
  assert.equal(straddle, `${"y".repeat(FORGE_TITLE_CHARS - 1)}\u2026`);
  assert.equal(displayTextSchema(FORGE_TITLE_CHARS + 1).safeParse(straddle).success, true);
  // Strip, then compose: a zero-width character between a base and its mark leaves the composed form (review S1a N1).
  assert.equal(forgeDisplay("e\u200b\u0301", FORGE_TITLE_CHARS), "\u00e9");
  const r = ok([row({ title: hostile, headRefName: `axis/${"b".repeat(240)}` })]);
  assert.equal(r.rows[0]?.title, shown);
  assert.equal(r.rows[0]?.branch.length, FORGE_BRANCH_CHARS + 1);
  assert.equal(forgePullRequestSchema.safeParse(r.rows[0]).success, true);
});

test("the link is built from the pin and the number, never taken from gh", () => {
  const r = ok([row({ url: "https://evil.example/phish", number: 42 })]);
  assert.equal(r.rows[0]?.url, "https://github.com/Acme/app/pull/42");
});

test("checks reduce to one closed value, reading at most 200 entries", () => {
  const run = (status: string, conclusion = "") => ({ __typename: "CheckRun", status, conclusion });
  const ctx = (state: string) => ({ __typename: "StatusContext", state });
  assert.equal(reduceChecks(undefined), "none");
  assert.equal(reduceChecks(null), "none");
  assert.equal(reduceChecks([]), "none");
  assert.equal(reduceChecks("x"), "unknown");
  assert.equal(reduceChecks([run("COMPLETED", "SUCCESS"), ctx("SUCCESS"), run("COMPLETED", "SKIPPED")]), "passing");
  assert.equal(reduceChecks([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")]), "pending");
  assert.equal(reduceChecks([ctx("PENDING"), run("COMPLETED", "FAILURE")]), "failing");
  assert.equal(reduceChecks([ctx("ERROR")]), "failing");
  assert.equal(reduceChecks([run("COMPLETED", "SUCCESS"), { weird: 1 }]), "unknown");
  assert.equal(reduceChecks([run("COMPLETED", "SUCCESS"), null]), "unknown");
  const many = [...Array.from({ length: 200 }, () => run("COMPLETED", "SUCCESS")), run("COMPLETED", "FAILURE")];
  assert.equal(reduceChecks(many), "passing", "entry 201 is not read");
});

test("review decisions map to closed values; anything else is unknown", () => {
  assert.deepEqual(
    ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "", null, undefined, "DISMISSED", "__proto__", "toString"].map((d) => reduceReview(d)),
    ["approved", "changes_requested", "review_required", "none", "none", "none", "unknown", "unknown", "unknown"],
  );
});
