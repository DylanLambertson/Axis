// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The data the push dialog needs, from the scanner git-ops already uses (design §11), and the hardening invariants.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecretScanner } from "@axis/git-ops";
import { ReviewSession, checkFresh, prepareCommit, secretWarnings } from "../src/index.js";
import { fixture, type Fixture } from "./fixture.js";

const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

async function reviewedWith(f: Fixture, scanner: SecretScanner | undefined) {
  const deps = { ...f.deps, git: { ...f.gitOps, ...(scanner ? { scanner } : {}) } };
  f.write("a.txt", BASE.replace("l2\n", "plant-word-one\n").replace("l18\n", "second-edit\n"));
  f.write("blob.bin", Buffer.from([0, 1, 2, 0]));
  const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
  s.acceptHunk("a.txt", (await s.hunks("a.txt")).hunks?.[0]?.id ?? "");
  s.acceptFile("blob.bin");
  return { deps, s, b: await s.build() };
}

test("the scanner sees the patch of what would be committed, and findings carry no matched text", async () => {
  const f = fixture();
  try {
    let seen = "";
    let meta: unknown;
    const scanner: SecretScanner = async (diff, m) => {
      seen = diff;
      meta = m;
      return [
        { rule: "stub-rule", path: "a.txt", line: 3 },
        { rule: "x".repeat(200), path: "we\nird‮.txt", line: -5, matched: "plant-word-one" } as never,
        { rule: "has space and \u001b[31m", line: 1.5 },
      ];
    };
    const { deps, s, b } = await reviewedWith(f, scanner);
    const w = await secretWarnings(deps, b, s.files);
    assert.match(seen, /\+plant-word-one/);
    assert.doesNotMatch(seen, /second-edit/, "an unaccepted hunk is not part of what is scanned");
    assert.equal((meta as { part: string }).part, "patch");
    assert.equal((meta as { commit: string }).commit, b.reviewedTree);
    assert.deepEqual((meta as { binaryPaths: string[] }).binaryPaths, ["blob.bin"]);
    assert.equal(w.scanned, true);
    assert.deepEqual(w.findings, [
      { rule: "stub-rule", displayPath: "a.txt", line: 3 },
      { rule: "unknown-rule", displayPath: "we\\nird\\u{202e}.txt", line: undefined },
      { rule: "unknown-rule", displayPath: undefined, line: undefined },
    ]);
    assert.doesNotMatch(JSON.stringify(w), /plant-word-one|\u001b|‮/);
    assert.equal(w.requiresConfirmation, true);
    assert.deepEqual(w.binaryPaths, ["blob.bin"]);
    assert.match(w.digest, /^[0-9a-f]{64}$/);
  } finally {
    f.cleanup();
  }
});

test("binary content needs confirmation even with no findings, and with no scanner nothing is claimed as checked", async () => {
  const f = fixture();
  try {
    const none = await reviewedWith(f, async () => []);
    const w = await secretWarnings(none.deps, none.b, none.s.files);
    assert.equal(w.findings.length, 0);
    assert.equal(w.requiresConfirmation, true, "a binary file hides content from pattern matching");
    const unscanned = await secretWarnings(f.deps, none.b, none.s.files);
    assert.equal(unscanned.scanned, false);
    assert.notEqual(unscanned.digest, w.digest);
  } finally {
    f.cleanup();
  }
});

test("a patch over the scanner's limit is reported truncated and needs confirmation", async () => {
  const f = fixture();
  try {
    f.write("big.txt", `${"line of text\n".repeat(900_000)}`);
    const deps = { ...f.deps, git: { ...f.gitOps, scanner: (async (d: string, m: { truncated: boolean }) => { assert.ok(d.length <= 8 * 1024 * 1024); assert.equal(m.truncated, true); return []; }) as SecretScanner } };
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    s.acceptFile("big.txt");
    const w = await secretWarnings(deps, await s.build(), s.files);
    assert.equal(w.truncated, true);
    assert.equal(w.requiresConfirmation, true);
  } finally {
    f.cleanup();
  }
});

test("a scanner that returns something else, or throws, is an error and never silently clean", async () => {
  const f = fixture();
  try {
    const bad = await reviewedWith(f, (async () => "nothing found") as unknown as SecretScanner);
    await assert.rejects(secretWarnings(bad.deps, bad.b, bad.s.files), (e: { code?: string }) => e.code === "E_INTERNAL");
    const throwing = { ...bad.deps, git: { ...bad.deps.git, scanner: (async () => { throw new Error("pattern table is at /secret/path"); }) as SecretScanner } };
    await assert.rejects(secretWarnings(throwing, bad.b, bad.s.files), (e: Error & { code?: string }) => e.code === "E_UNAVAILABLE" && !/secret/.test(e.message));
  } finally {
    f.cleanup();
  }
});

test("every git call is daemon-context and hardened, and GIT_INDEX_FILE appears only where a temporary index is named", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    f.write("n.txt", "n\n");
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    await s.hunks("a.txt");
    await s.preview("n.txt", "new");
    s.acceptFile("a.txt");
    const b = await s.build();
    await checkFresh(f.deps, b);
    await prepareCommit(f.deps, b);
    assert.ok(f.seen.length > 10);
    for (const r of f.seen) {
      assert.equal(r.context, "daemon");
      const gitEnv = Object.keys(r.env).filter((k) => k.startsWith("GIT_")).sort();
      const usesIndex = r.argv.includes("core.sparseCheckout=false");
      assert.deepEqual(gitEnv, usesIndex ? ["GIT_INDEX_FILE", "GIT_TERMINAL_PROMPT"] : ["GIT_TERMINAL_PROMPT"], r.argv.join(" "));
      for (const must of ["--no-pager", "--no-replace-objects", "core.fsmonitor=false", "core.hooksPath=/dev/null", "protocol.allow=never", "diff.submodule=short"]) {
        assert.ok(r.argv.includes(must), `${must} missing from ${r.argv.join(" ")}`);
      }
      assert.ok(r.argv.some((a) => a === `--git-dir=${f.wt.gitDir}`) && r.argv.some((a) => a === `--work-tree=${f.wt.workTree}`));
    }
    const diffs = f.seen.filter((r) => r.argv.includes("diff") && !r.argv.includes("diff-tree"));
    assert.ok(diffs.length > 0);
    for (const d of diffs) assert.ok(d.argv.includes("--no-ext-diff") && d.argv.includes("--no-textconv") && d.argv.includes("--no-color"));
  } finally {
    f.cleanup();
  }
});
