// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Output a lying or broken git could produce, and failures of the runner itself (scripted runner, design §4, §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewSession, ReviewError } from "../src/index.js";
import { parseNumstat, parseRaw } from "../src/changes.js";
import { fakeFixture, Z40 } from "./fake.js";
import { refusal } from "./fixture.js";

const oid = (n: number): string => n.toString(16).padStart(40, "0");
const OLD = "1\n2\n3\n4\n5\n";
const start = (f: ReturnType<typeof fakeFixture>) => ReviewSession.start(f.deps, { worktree: f.wt, against: f.against });
const blobs = { [oid(1)]: OLD };

test("a hunk header that lies about its line counts leaves the file whole-file only", async () => {
  for (const patch of [
    "@@ -1,5 +1,5 @@\n-1\n+X\n",
    "@@ -1,1 +1,1 @@\n-1\n+X\n+Y\n",
    "@@ -1,1 +1,3 @@\n-1\n+X\n",
    "@@ -99999999,1 +1,1 @@\n-1\n+X\n",
    "@@ -1,2 +1,2 @@\n 1\n-2\n+X\n 3\n",
  ]) {
    const f = fakeFixture([["M", "f.txt"]], { patch, blobs });
    const s = await start(f);
    const h = await s.hunks("f.txt");
    assert.equal(h.hunks, undefined, patch);
    assert.match(h.fileLevelReason ?? "", /malformed|not_reproducible/, patch);
    assert.throws(() => s.acceptHunk("f.txt", "0:0000000000000000"));
  }
});

test("a consistent hunk at the wrong place, or one that does not rebuild the new file, is not offered", async () => {
  for (const patch of ["@@ -2,1 +2,1 @@\n-1\n+X\n", "@@ -1,1 +1,1 @@\n-nope\n+X\n", "@@ -1,1 +1,1 @@\n-1\n+X\n"]) {
    const f = fakeFixture([["M", "f.txt"]], { patch, blobs });
    const h = await (await start(f)).hunks("f.txt");
    assert.equal(h.fileLevelReason, "not_reproducible", patch);
  }
});

test("a failing diff, a binary patch and an empty patch each degrade to whole-file", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ patch: "", patchCode: 128 }, "diff_failed"],
    [{ patch: "Binary files a and b differ\n" }, "binary"],
    [{ patch: "diff --git a/x b/x\n" }, "no_content_change"],
    [{ patch: "@@ -1 +1\n-1\n+2\n" }, "malformed"],
  ];
  for (const [opts, why] of cases) {
    const f = fakeFixture([["M", "f.txt"]], { blobs, ...opts });
    assert.equal((await (await start(f)).hunks("f.txt")).fileLevelReason, why);
  }
});

test("a path with a leading dash, a newline, a quote or an escape sequence is listed escaped and never used raw", async () => {
  const names = ["-rf", "--upload-pack=x", 'a"b\nc', "e\u001b[31m", "bidi‮gpj.exe", "tab\there"];
  const f = fakeFixture(names.map((n) => ["M", n] as const));
  const s = await start(f);
  assert.deepEqual(s.files.map((x) => x.path), names);
  for (const x of s.files) assert.doesNotMatch(x.displayPath, /[\u0000-\u001f\u007f‮\n]/);
  assert.equal(s.file("--upload-pack=x").unsafePath, false);
  // Every argv the package built keeps user-controlled values out of option position: none carries a path at all.
  for (const c of f.calls) for (const a of c.argv) assert.ok(!names.includes(a), `path ${JSON.stringify(a)} reached an argv`);
});

test("diff paths that traverse, name .git or are absolute are listed, flagged and refused for accept", async () => {
  const verifyRaw = `:100644 100644 ${oid(4)} ${oid(103)} M\0ok.txt\0`;
  const f = fakeFixture([["A", "../../.ssh/authorized_keys"], ["A", ".git/config"], ["A", "x/../../y"], ["M", "ok.txt"]], { verifyRaw });
  const s = await start(f);
  assert.deepEqual(s.files.filter((x) => x.unsafePath).map((x) => x.path), ["../../.ssh/authorized_keys", ".git/config", "x/../../y"]);
  assert.throws(() => s.acceptFile(".git/config"), (e: ReviewError) => e.code === "E_POLICY_DENIED");
  s.acceptFile("ok.txt");
  const calls = f.calls.filter((c) => c.argv.includes("update-index"));
  assert.equal(calls.length, 0, "nothing was built yet");
  const b = await s.build();
  const upd = f.calls.find((c) => c.argv.includes("update-index"));
  assert.ok(upd);
  assert.equal(upd.stdin?.includes(".git"), false, "no unsafe path reached the index input");
  assert.equal(b.accepted.length, 1);
});

test("malformed records from git are an error, not a guess", () => {
  const meta = `:100644 100644 ${oid(1)} ${oid(2)} M`;
  assert.throws(() => parseRaw(`${meta}\0`, 10), (e: ReviewError) => e.code === "E_UNAVAILABLE");
  assert.throws(() => parseRaw("garbage\0x\0", 10), (e: ReviewError) => e.code === "E_UNAVAILABLE");
  assert.throws(() => parseRaw(`:100644 100644 ${oid(1)} ${oid(2)} U\0p\0`, 10), (e: ReviewError) => e.code === "E_UNAVAILABLE");
  assert.throws(() => parseRaw(`:100644 100644 ${oid(1)} ${oid(2)} R90\0only-one\0`, 10), (e: ReviewError) => e.code === "E_UNAVAILABLE");
  assert.deepEqual(parseRaw("", 10), { entries: [], overflow: false });
  assert.equal(parseRaw(`${meta}\0a\0${meta}\0b\0${meta}\0c\0`, 2).overflow, true);
  assert.equal(parseRaw(`:000000 100644 ${Z40} ${oid(2)} A\0we\nird\0`, 2).entries[0]?.path, "we\nird");
  assert.throws(() => parseNumstat("1\t1\0"), (e: ReviewError) => e.code === "E_UNAVAILABLE");
  assert.equal(parseNumstat("-\t-\tbin\0").get("bin")?.binary, true);
  assert.equal(parseNumstat("1\t0\t\0old\0new\0").get("new")?.additions, 1);
});

test("git older than 2.24 or an unreadable version is E_UNAVAILABLE", async () => {
  for (const version of ["git version 2.23.9", "git version nonsense", "git version 1.8.3"]) {
    const f = fakeFixture([["M", "a"]], { version });
    assert.equal((await refusal(start(f))).code, "E_UNAVAILABLE", version);
  }
  assert.ok(await start(fakeFixture([["M", "a"]], { version: "git version 2.24.0" })));
});

test("a failing git call is a protocol error with no git text from outside, and the temporary index is released", async () => {
  const f = fakeFixture([["M", "a"]], { failOn: "add" });
  const e = await refusal(start(f));
  assert.equal(e.code, "E_CONFLICT");
  assert.equal(e.details?.["reason"], "snapshot_failed");
  assert.equal(f.counts.created, f.counts.disposed);
  assert.equal(f.counts.created, 1);
});

test("what a runner throws never reaches the caller: a fixed message, a short code at most", async () => {
  const planted = "/home/someone/credentials-in-a-path";
  const hostile: unknown[] = [
    Object.assign(new Error(planted), { code: "ENOENT", cause: new Error(planted) }),
    { get code(): string { throw new Error(planted); }, message: planted },
    new Proxy({}, { get() { throw new Error(planted); }, getPrototypeOf() { throw new Error(planted); } }),
    Object.assign(new Error(planted), { code: planted }),
    "a string",
    null,
  ];
  for (const error of hostile) {
    const f = fakeFixture([["M", "a"]], { throwOn: "write-tree", error });
    const e = await refusal(start(f));
    assert.equal(e.code, "E_UNAVAILABLE");
    assert.doesNotMatch(`${e.message} ${JSON.stringify(e.details ?? {})} ${String(e.stack)}`, /credentials|someone/);
    assert.equal(e.cause, undefined);
    assert.equal(f.counts.created, f.counts.disposed);
  }
});

test("the reviewed tree is never trusted as written: git silently dropping, adding or altering a path is caught", async () => {
  const ok = `:100644 100644 ${oid(4)} ${oid(103)} M\0ok.txt\0`;
  const cases: Array<[string, string]> = [
    ["an accepted path that git ignored", ""],
    ["an extra path nobody accepted", `${ok}:000000 100644 ${Z40} ${oid(5)} A\0extra.txt\0`],
    ["the wrong content for the accepted path", `:100644 100644 ${oid(4)} ${oid(55)} M\0ok.txt\0`],
    ["the wrong mode for the accepted path", `:100644 100755 ${oid(4)} ${oid(103)} M\0ok.txt\0`],
    ["a deletion instead of the change", `:100644 000000 ${oid(4)} ${Z40} D\0ok.txt\0`],
  ];
  for (const [what, verifyRaw] of cases) {
    const f = fakeFixture([["M", "x.txt"], ["M", "y.txt"], ["M", "z.txt"], ["M", "ok.txt"]], { verifyRaw });
    const s = await start(f);
    s.acceptFile("ok.txt");
    const e = await refusal(s.build());
    assert.equal(e.code, "E_INTERNAL", what);
    assert.equal(f.counts.created, f.counts.disposed + 0, "the index was released");
  }
  const good = fakeFixture([["M", "x.txt"], ["M", "y.txt"], ["M", "z.txt"], ["M", "ok.txt"]], { verifyRaw: ok });
  const s = await start(good);
  s.acceptFile("ok.txt");
  assert.equal((await s.build()).reviewedTree, oid(9));
});

test("git refusing a path in the index input is a conflict, never a tree", async () => {
  const f = fakeFixture([["M", "ok.txt"]], { failOn: "update-index" });
  const s = await start(f);
  s.acceptFile("ok.txt");
  const e = await refusal(s.build());
  assert.equal(e.code, "E_CONFLICT");
  assert.equal(e.details?.["reason"], "index_refused");
});
