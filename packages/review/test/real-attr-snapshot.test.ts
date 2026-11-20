// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV2-FIX second half (RR-13): every attribute read of the review runs in git-ops' private git directory, on one snapshot of
// info/attributes and the user and system files, and reads tracked .gitattributes from indexes built from tree objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRunRequest, SecretScanner } from "@axis/git-ops";
import { ReviewSession, checkFresh, prepareCommit, secretWarnings } from "../src/index.js";
import { fixture, type Fixture } from "./fixture.js";
import { PASS, REVERSE, withFilter } from "./filters.js";

const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

/**
 * A runner that calls `before` just before the first check-attr and `after` at the first call once the check-attr calls are over
 * (before REV2-FIX that was the second read of the attribute sources). Call `finish()` after the review: it runs `after` if no
 * such call came.
 */
function around(f: Fixture, before: () => void, after: () => void = () => undefined): Fixture["deps"] & { finish(): void } {
  let state: "waiting" | "reading" | "done" = "waiting";
  const inner = f.deps.git.runner;
  const runner = {
    run: (req: GitRunRequest) => {
      const attr = req.argv.includes("check-attr");
      if (state === "waiting" && attr) {
        state = "reading";
        before();
      } else if (state === "reading" && !attr && !req.argv.includes("read-tree") && !req.argv.includes("--get-regexp")) {
        state = "done";
        after();
      }
      return inner.run(req);
    },
  };
  const finish = (): void => {
    if (state === "reading") after();
    state = "done";
  };
  return { ...f.deps, git: { ...f.deps.git, runner }, finish };
}

const info = (f: Fixture): string => join(f.repo, ".git", "info", "attributes");
function setInfo(f: Fixture, text: string | undefined): void {
  mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
  if (text === undefined) rmSync(info(f), { force: true });
  else writeFileSync(info(f), text);
}

test("RR-13: a -filter line written into info/attributes for the reads and removed after them is never seen", async () => {
  const f = fixture({ base: (a) => withFilter(REVERSE, PASS)(a) });
  try {
    f.write("vault.dat", "API_PASSWORD=hunter2\n");
    const deps = around(f, () => setInfo(f, "vault.dat -filter\n"), () => setInfo(f, undefined));
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    deps.finish();
    assert.equal(existsSync(info(f)), false, "fixture: the line was removed again");
    // Before REV2-FIX the before/after comparison saw no info/attributes either time and the reads obeyed the line: offered as text.
    assert.equal(s.file("vault.dat").kind, "filtered");
    assert.equal(s.file("vault.dat").fileLevelReason, "filtered_path");
  } finally {
    f.cleanup();
  }
});

test("tracked .gitattributes come from the reviewed worktree tree: removing a filter line from the work tree during the reads is not seen", async () => {
  const f = fixture();
  try {
    f.write(".gitattributes", "secret.bin filter=vault\n");
    f.write("secret.bin", "plain bytes\n");
    const deps = around(f, () => f.write(".gitattributes", "# nothing here\n"));
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("secret.bin").kind, "filtered", "the reviewed tree names the filter, so the file is not offered");
  } finally {
    f.cleanup();
  }
});

test("a filter line added to the work tree's .gitattributes after the snapshot is not read either (the work tree is never asked)", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const deps = around(f, () => f.write(".gitattributes", "a.txt filter=late\n"));
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("a.txt").kind, "text");
    assert.equal(s.files.some((x) => x.path === ".gitattributes"), false, "fixture: the line was written after the worktree tree was taken");
  } finally {
    f.cleanup();
  }
});

/** The system attribute file is wherever `git var GIT_ATTR_SYSTEM` says; the runner answers for git so no real system file is touched. */
function withSystemFile(f: Fixture, path: string): Fixture["deps"] {
  const inner = f.deps.git.runner;
  const runner = { run: (req: GitRunRequest) => (req.argv.includes("var") && req.argv.includes("GIT_ATTR_SYSTEM") ? Promise.resolve({ code: 0, stdout: `${path}\n`, stderr: "" }) : inner.run(req)) };
  return { ...f.deps, git: { ...f.deps.git, runner } };
}

test("a filter set only in the system attribute file is read from its snapshot, and a later edit of the file is not", async () => {
  const f = fixture();
  try {
    const sys = join(f.root, "system-attributes");
    writeFileSync(sys, "a.txt filter=sysf"); // no final line break: the user file must not run into it
    mkdirSync(join(f.home, ".config", "git"), { recursive: true });
    writeFileSync(join(f.home, ".config", "git", "attributes"), "keep.txt text\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    f.write("keep.txt", "changed\n");
    const deps = withSystemFile(f, sys);
    const runner = deps.git.runner;
    let swapped = false;
    const racing = { run: (req: GitRunRequest) => { if (!swapped && req.argv.includes("check-attr")) { swapped = true; writeFileSync(sys, "# emptied\n"); } return runner.run(req); } };
    const s = await ReviewSession.start({ ...deps, git: { ...deps.git, runner: racing } }, { worktree: f.wt, against: f.head() });
    assert.equal(swapped, true);
    assert.equal(s.file("a.txt").kind, "filtered");
    assert.equal(s.file("a.txt").fileLevelReason, "filtered_path");
    assert.equal(s.file("keep.txt").kind, "text", "the user file's rule follows the system file's on its own line");
  } finally {
    f.cleanup();
  }
});

/** A node script (no shell): it records that it ran, then copies its input or its first file argument to the output. */
function driver(f: Fixture, name: string): string {
  const p = join(f.root, `${name}.cjs`);
  writeFileSync(p, `require("node:fs").appendFileSync(${JSON.stringify(f.root + "/marker")}, ${JSON.stringify(name + "\n")});\nconst a=process.argv[2];if(a&&require("node:fs").existsSync(a))process.stdout.write(require("node:fs").readFileSync(a));else process.stdin.pipe(process.stdout);\n`);
  return `"${process.execPath}" "${p}"`;
}

test("planted filter, textconv, diff and merge drivers in the repository and global config, used by hostile .gitattributes, never run", async () => {
  const f = fixture({
    base: (a) => {
      a.write(".gitattributes", "[attr]evil filter=x diff=x merge=x\n*.dat evil\n*.txt diff=x merge=x\n");
      a.write("sub/.gitattributes", "* diff=x\n*.dat filter=x\n");
      a.write("sub/b.txt", BASE);
      a.write("v.dat", "stored\n");
    },
  });
  try {
    const marker = join(f.root, "marker");
    const settings: [string, string][] = [
      ["filter.x.clean", driver(f, "clean")], ["filter.x.smudge", driver(f, "smudge")], ["filter.x.process", driver(f, "process")],
      ["diff.x.textconv", driver(f, "textconv")], ["diff.x.command", driver(f, "diffcmd")], ["diff.external", driver(f, "external")],
      ["merge.x.driver", driver(f, "merge")],
    ];
    for (const [k, v] of settings) f.git("config", k, v);
    const section = (k: string): string => k.split(".").slice(0, -1).map((p, i) => (i === 0 ? p : `"${p}"`)).join(" ");
    writeFileSync(join(f.home, ".gitconfig"), settings.map(([k, v]) => `[${section(k)}]\n\t${k.split(".").pop()} = ${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\n`).join(""));
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    f.write("sub/b.txt", BASE.replace("l3\n", "L3\n"));
    f.write("v.dat", "smudged plaintext\n");
    f.write("sub/w.dat", "new\n");
    rmSync(marker, { force: true });
    const scanner = (async () => []) as SecretScanner;
    const deps = { ...f.deps, git: { ...f.deps.git, scanner } };
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("v.dat").kind, "filtered", "a macro defined in the tracked root file is read from the tree");
    assert.equal(s.file("sub/w.dat").kind, "filtered", "a nested tracked file is read from the tree");
    assert.equal(s.file("a.txt").kind, "text");
    for (const p of ["a.txt", "sub/b.txt"]) assert.ok((await s.hunks(p)).hunks?.length);
    await s.preview("a.txt", "new");
    s.acceptFile("a.txt");
    s.acceptFile("sub/b.txt");
    const b = await s.build();
    await secretWarnings(deps, b, s.files);
    await checkFresh(deps, b);
    await prepareCommit(deps, b);
    assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
    // The drivers are live: git run plainly in this repository (with the same HOME) runs them.
    f.git("diff", "HEAD", "--", "a.txt");
    assert.equal(existsSync(marker), true, "fixture: the planted drivers run outside the review");
  } finally {
    f.cleanup();
  }
});

test("the private git directory is removed after the reads, whether the sources were trusted or not", async () => {
  for (const infoText of [undefined, "a.txt -text\n"]) {
    const f = fixture();
    try {
      if (infoText !== undefined) setInfo(f, infoText);
      f.write("a.txt", BASE.replace("l2\n", "L2\n"));
      const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
      assert.equal(s.file("a.txt").fileLevelReason, infoText === undefined ? undefined : "attributes_untrusted");
      const dirs = new Set(f.seen.flatMap((r) => r.argv.filter((a) => a.startsWith("--git-dir=") && a.includes("axis-attr-")).map((a) => a.slice("--git-dir=".length))));
      assert.ok(dirs.size >= 1, "the attribute read ran in a private git directory");
      for (const d of dirs) assert.equal(existsSync(d), false, `${d} was left behind`);
    } finally {
      f.cleanup();
    }
  }
});
