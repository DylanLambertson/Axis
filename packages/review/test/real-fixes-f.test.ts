// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fifth independent review: info/attributes swapped while the attribute reads run (SF-5, closed by REV2-FIX: the reads use a
// snapshot, so the swap is not seen at all), and the two outside-file branches that had no test of their own (a relative
// core.attributesFile, an unreadable info/attributes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitRunRequest } from "@axis/git-ops";
import { ReviewSession } from "../src/index.js";
import { fixture, type Fixture } from "./fixture.js";
import { PASS, REVERSE, withFilter } from "./filters.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");

function vault(): Fixture {
  return fixture({ base: (a) => withFilter(REVERSE, PASS)(a) });
}

/** Runs `swap` once, just before the first check-attr call reaches git: a CLI changing a file while the reads run. */
function racing(f: Fixture, swap: () => void): ReturnType<typeof fixture>["deps"] {
  let done = false;
  const inner = f.deps.git.runner;
  const runner = {
    run: (req: GitRunRequest) => {
      if (!done && req.argv.includes("check-attr")) {
        done = true;
        swap();
      }
      return inner.run(req);
    },
  };
  return { ...f.deps, git: { ...f.deps.git, runner } };
}

test("info/attributes written while the attribute reads run is not seen: the filtered file stays filtered", { skip: !posix }, async () => {
  const f = vault();
  try {
    f.write("vault.dat", "API_PASSWORD=hunter2\n");
    const deps = racing(f, () => {
      mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
      writeFileSync(join(f.repo, ".git", "info", "attributes"), "vault.dat -filter\n");
    });
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("vault.dat").kind, "filtered");
    // The reads used the snapshot taken before the swap, so this is the filter itself, not a refusal of changed sources.
    assert.equal(s.file("vault.dat").fileLevelReason, "filtered_path");
  } finally {
    f.cleanup();
  }
});

test("a harmless change to info/attributes while the reads run changes nothing either", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo, ".git", "info"), { recursive: true });
    writeFileSync(join(f.repo, ".git", "info", "attributes"), "# a comment\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const deps = racing(f, () => writeFileSync(join(f.repo, ".git", "info", "attributes"), "a.txt -text\n"));
    const s = await ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("a.txt").kind, "text");
    assert.equal(s.file("a.txt").fileLevelReason, undefined);
  } finally {
    f.cleanup();
  }
});

test("a relative core.attributesFile is read from the work tree", { skip: !posix }, async () => {
  const f = fixture();
  try {
    f.git("config", "core.attributesFile", "rel-attrs");
    f.write("rel-attrs", "[attr]plain -text\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("a.txt").fileLevelReason, "attributes_untrusted");
  } finally {
    f.cleanup();
  }
});

test("an info/attributes that cannot be read fails closed", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo, ".git", "info", "attributes"), { recursive: true });
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.equal(s.file("a.txt").fileLevelReason, "attributes_untrusted");
  } finally {
    f.cleanup();
  }
});

test("the attribute sources are read a fixed number of times, not once per file", { skip: !posix }, async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 200; i++) f.write(`many/f${i}.txt`, `${i}\n`);
    const before = f.seen.length;
    await ReviewSession.start(f.deps, { worktree: f.wt, against: f.head() });
    assert.ok(f.seen.length - before < 45, `${f.seen.length - before} git calls`);
  } finally {
    f.cleanup();
  }
});
