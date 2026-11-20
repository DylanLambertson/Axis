// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// REV2-FIX review 1, SF-1 and SF-2: whether a file is text or binary, and so whether hunks are offered, comes from the reviewed
// tree inside the attribute snapshot (not the live work tree or the repository config); a git that cannot name the system
// attribute file has that file read live rather than not at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRunRequest } from "@axis/git-ops";
import { ReviewSession } from "../src/index.js";
import { fixture, type Fixture } from "./fixture.js";

const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

/** Calls `before` just before the first `--numstat` call and `after` at the next git call (or at `finish()`). */
function atNumstat(f: Fixture, before: () => void, after: () => void = () => undefined): Fixture["deps"] & { finish(): void } {
  let state: "waiting" | "armed" | "done" = "waiting";
  const inner = f.deps.git.runner;
  const runner = {
    run: (req: GitRunRequest) => {
      if (state === "waiting" && req.argv.includes("--numstat")) {
        state = "armed";
        before();
      } else if (state === "armed") {
        state = "done";
        after();
      }
      return inner.run(req);
    },
  };
  const finish = (): void => {
    if (state === "armed") after();
    state = "done";
  };
  return { ...f.deps, git: { ...f.deps.git, runner }, finish };
}

const start = (f: Fixture, deps: Fixture["deps"] = f.deps): Promise<ReviewSession> => ReviewSession.start(deps, { worktree: f.wt, against: f.head() });

test("a '* -diff' written to the work tree after the snapshot neither lists the file as binary nor switches its hunks off", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const deps = atNumstat(f, () => f.write(".gitattributes", "* -diff\n"));
    const s = await start(f, deps);
    deps.finish();
    assert.equal(s.files.some((x) => x.path === ".gitattributes"), false, "fixture: written after the worktree tree was taken");
    assert.equal(s.file("a.txt").kind, "text");
    assert.equal(s.file("a.txt").fileLevelReason, undefined);
    f.write(".gitattributes", "* -diff\n"); // and again after start, for the hunk load (git looks the blob ids up as paths)
    const h = await s.hunks("a.txt");
    assert.equal(h.fileLevelReason, undefined);
    assert.ok((h.hunks?.length ?? 0) > 0);
  } finally {
    f.cleanup();
  }
});

test("a -diff line the reviewed tree has still makes the file binary when the work tree drops it after the snapshot", async () => {
  const f = fixture();
  try {
    f.write(".gitattributes", "a.txt -diff\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const deps = atNumstat(f, () => rmSync(join(f.repo, ".gitattributes")));
    const s = await start(f, deps);
    deps.finish();
    assert.equal(s.file("a.txt").kind, "binary");
    assert.equal(s.file("a.txt").fileLevelReason, "binary");
  } finally {
    f.cleanup();
  }
});

test("diff.<x>.binary in the repository config does not make a file binary", async () => {
  const f = fixture({ base: (a) => a.write(".gitattributes", "a.txt diff=x\n") });
  try {
    f.git("config", "diff.x.binary", "true");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    assert.match(f.git("diff", "--numstat", "--", "a.txt"), /^-\t-\t/, "fixture: plain git calls the file binary");
    const s = await start(f);
    assert.equal(s.file("a.txt").kind, "text");
    assert.ok(((await s.hunks("a.txt")).hunks?.length ?? 0) > 0);
  } finally {
    f.cleanup();
  }
});

test("a -diff line put into info/attributes for the line counts and removed right after is not seen", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const info = join(f.repo, ".git", "info", "attributes");
    const deps = atNumstat(f, () => { mkdirSync(join(f.repo, ".git", "info"), { recursive: true }); writeFileSync(info, "a.txt -diff\n"); }, () => rmSync(info, { force: true }));
    const s = await start(f, deps);
    deps.finish();
    assert.equal(s.file("a.txt").kind, "text");
  } finally {
    f.cleanup();
  }
});

/** A git that reports an older version and, like git before 2.42, does not know GIT_ATTR_SYSTEM (or a newer one that names `path`). */
function olderGit(f: Fixture, system: string | undefined): Fixture["deps"] {
  const inner = f.deps.git.runner;
  const runner = {
    run: (req: GitRunRequest) => {
      if (req.argv.includes("--version")) return Promise.resolve({ code: 0, stdout: system === undefined ? "git version 2.39.0\n" : "git version 2.45.0\n", stderr: "" });
      if (req.argv.includes("var") && req.argv.includes("GIT_ATTR_SYSTEM")) {
        return Promise.resolve(system === undefined ? { code: 1, stdout: "", stderr: "usage: git var (-l | <variable>)\n" } : { code: 0, stdout: `${system}\n`, stderr: "" });
      }
      return inner.run(req);
    },
  };
  return { ...f.deps, git: { ...f.deps.git, runner } };
}

test("a git that cannot name the system attribute file reads it live instead of not at all", async () => {
  for (const system of [undefined, "/nonexistent-axis-test/gitattributes"]) {
    const f = fixture();
    try {
      f.write("a.txt", BASE.replace("l2\n", "L2\n"));
      const s = await start(f, olderGit(f, system));
      assert.equal(s.file("a.txt").kind, "text");
      const priv = f.seen.filter((r) => r.argv.some((a) => a.startsWith("--git-dir=") && a.includes("axis-attr-")));
      assert.ok(priv.some((r) => r.argv.includes("check-attr")));
      for (const r of priv) assert.equal("GIT_ATTR_NOSYSTEM" in r.env, system !== undefined, `${system ?? "unknown"}: ${r.argv.join(" ")}`);
    } finally {
      f.cleanup();
    }
  }
});

test("when the snapshot is untrusted, the shown line counts come from it, not from the live attribute files", async () => {
  const f = fixture();
  try {
    const info = join(f.repo, ".git", "info", "attributes");
    mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
    writeFileSync(info, "keep.txt text\n"); // any attribute line there: untrusted
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const deps = atNumstat(f, () => writeFileSync(info, "keep.txt text\na.txt -diff\n"));
    const a = (await start(f, deps)).file("a.txt");
    deps.finish();
    assert.equal(a.fileLevelReason, "attributes_untrusted");
    assert.deepEqual([a.additions, a.deletions], [1, 1]);
    // With no snapshot at all (a source that cannot be read) nothing is counted from live files: the counts are left out.
    const g = fixture();
    try {
      mkdirSync(join(g.repo, ".git", "info", "attributes"), { recursive: true });
      g.write("a.txt", BASE.replace("l2\n", "L2\n"));
      const b = (await start(g)).file("a.txt");
      assert.equal(b.fileLevelReason, "attributes_untrusted");
      assert.deepEqual([b.additions, b.deletions], [undefined, undefined]);
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test("a small core.bigFileThreshold from outside the repository (as the system config could set) does not make a file binary", async () => {
  const f = fixture();
  try {
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    // The lowest-ranked `-c` stands in for the system config, the one config file the private reads still see.
    let lowered = 0;
    const inner = f.deps.git.runner;
    const runner = {
      run: (req: GitRunRequest) => {
        if (!req.argv.includes("--numstat")) return inner.run(req);
        lowered += 1;
        return inner.run({ ...req, argv: ["-c", "core.bigFileThreshold=8", ...req.argv] });
      },
    };
    const a = (await start(f, { ...f.deps, git: { ...f.deps.git, runner } })).file("a.txt");
    assert.ok(lowered > 0, "fixture: the line counts were taken");
    assert.equal(a.kind, "text");
    assert.deepEqual([a.additions, a.deletions], [1, 1]);
  } finally {
    f.cleanup();
  }
});
