// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fourth independent review: macros written the way git reads them (quoted, octal, indented), which outside attribute files
// block and which do not, git's own choice of the user file, the system file, and the cut-text decision for type changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitOpsDeps } from "@axis/git-ops";
import { ReviewSession } from "../src/index.js";
import { attributePattern } from "../src/attrtrust.js";
import { PATHS, fixture, refusal, type Fixture } from "./fixture.js";
import { PASS, REVERSE, withFilter } from "./filters.js";

const posix = process.platform !== "win32";
const BASE = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`).join("");
const LONG = `${"a".repeat(2048)}PAYLOAD`;

/** A repository whose `*.dat` files use the macro `crypt`, defined in the user's attributes file when the base was committed. */
function macroRepo(): Fixture {
  return fixture({
    base: (a) => {
      withFilter(REVERSE, PASS)(a);
      const home = join(a.repo, "..", "home");
      mkdirSync(join(home, ".config", "git"), { recursive: true });
      writeFileSync(join(home, ".config", "git", "attributes"), "[attr]crypt filter=vault\n");
      a.write(".gitattributes", "*.dat crypt\n");
    },
  });
}

function userFile(f: Fixture, text: string): void {
  writeFileSync(join(f.home, ".config", "git", "attributes"), text);
}

async function start(f: Fixture, deps = f.deps): Promise<ReviewSession> {
  return ReviewSession.start(deps, { worktree: f.wt, against: f.head() });
}

for (const [name, line] of [
  ["a quoted macro name", '"[attr]crypt" binary\n'],
  ["an octal-escaped macro name", '"\\133attr]crypt" binary\n'],
  ["an indented macro", "  \t[attr]crypt binary\n"],
  ["an unquoted macro", "[attr]crypt binary\n"],
] as const) {
  test(`${name} in the user's attributes file redefines a macro the tree uses and is not trusted`, { skip: !posix }, async () => {
    const f = macroRepo();
    try {
      userFile(f, line);
      f.write("vault.dat", "API_PASSWORD=hunter2\n");
      const s = await start(f);
      assert.equal(s.file("vault.dat").kind, "filtered");
      assert.equal(s.file("vault.dat").fileLevelReason, "attributes_untrusted");
    } finally {
      f.cleanup();
    }
  });
}

test("a quoted line git cannot decode in the user's attributes file counts as a macro (fail closed)", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".config", "git"), { recursive: true });
    userFile(f, '"\\x[attr]m" binary\n');
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    assert.equal((await start(f)).file("a.txt").fileLevelReason, "attributes_untrusted");
  } finally {
    f.cleanup();
  }
});

test("attribute lines are read the way git reads them", () => {
  assert.deepEqual(attributePattern("  \tfoo bar"), { pattern: "foo", bad: false });
  assert.deepEqual(attributePattern("# [attr]x"), { pattern: undefined, bad: false });
  assert.deepEqual(attributePattern(""), { pattern: undefined, bad: false });
  assert.deepEqual(attributePattern('"a b" text'), { pattern: "a b", bad: false });
  assert.deepEqual(attributePattern('"\\133attr]m" x'), { pattern: "[attr]m", bad: false });
  assert.deepEqual(attributePattern('"\\x" x'), { pattern: undefined, bad: true });
  assert.deepEqual(attributePattern('"unterminated'), { pattern: undefined, bad: true });
});

test("a line that only names a filter, or a pattern with 'filter' in it, does not block a review", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".config", "git"), { recursive: true });
    userFile(f, "*.ipynb filter=nbstripout\nsrc/filters/*.c text\n# filter\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await start(f);
    assert.equal(s.file("a.txt").kind, "text");
    s.acceptFile("a.txt");
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

function withXdg(f: Fixture): GitOpsDeps {
  const env = { PATH: PATHS, HOME: f.home, XDG_CONFIG_HOME: join(f.root, "xdg") };
  return { ...f.deps.git, env: { daemon: env, pty: env } };
}

test("the default user file is under $XDG_CONFIG_HOME when that is set", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "xdg", "git"), { recursive: true });
    writeFileSync(join(f.root, "xdg", "git", "attributes"), "[attr]plain -text\n");
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await start(f, { ...f.deps, git: withXdg(f) });
    assert.equal(s.file("a.txt").fileLevelReason, "attributes_untrusted");
  } finally {
    f.cleanup();
  }
});

test("core.attributesFile replaces the default file, as in git: a macro in the default is not read", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".config", "git"), { recursive: true });
    userFile(f, "[attr]plain -text\n");
    writeFileSync(join(f.root, "other"), "*.log text\n");
    f.git("config", "core.attributesFile", join(f.root, "other"));
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    assert.equal((await start(f)).file("a.txt").kind, "text");
  } finally {
    f.cleanup();
  }
});

test("a macro in the system attributes file is not trusted", { skip: !posix }, async () => {
  const f = fixture();
  try {
    const sys = join(f.root, "system-attributes");
    writeFileSync(sys, '"[attr]plain" -text\n');
    const inner = f.deps.git.runner;
    const runner = { run: (req: Parameters<typeof inner.run>[0]) => (req.argv.includes("var") && req.argv.includes("GIT_ATTR_SYSTEM") ? Promise.resolve({ code: 0, stdout: `${sys}\n`, stderr: "" }) : inner.run(req)) };
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    const s = await start(f, { ...f.deps, git: { ...f.deps.git, runner } });
    assert.equal(s.file("a.txt").fileLevelReason, "attributes_untrusted");
  } finally {
    f.cleanup();
  }
});

test("an outside attribute file that exists but cannot be read fails closed", { skip: !posix }, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "a-directory"));
    f.git("config", "core.attributesFile", join(f.root, "a-directory"));
    f.write("a.txt", BASE.replace("l2\n", "L2\n"));
    assert.equal((await start(f)).file("a.txt").fileLevelReason, "attributes_untrusted");
  } finally {
    f.cleanup();
  }
});

async function needsAck(f: Fixture, path: string): Promise<void> {
  const s = await start(f);
  assert.equal(await s.hasCutLines(path), true, `${path} has cut text`);
  s.acceptFile(path);
  assert.equal((await refusal(s.build())).details?.["reason"], "truncated_hunk", path);
  s.acceptFile(path, { acceptTruncated: true });
  assert.ok((await s.build()).reviewedTree);
}

test("a symlink replaced by a regular file with a long line needs the acknowledgement", { skip: !posix }, async () => {
  const f = fixture({ base: ({ repo }) => symlinkSync("keep.txt", join(repo, "ln")) });
  try {
    rmSync(join(f.repo, "ln"));
    f.write("ln", `${LONG}\n`);
    assert.equal((await start(f)).file("ln").status, "T");
    await needsAck(f, "ln");
  } finally {
    f.cleanup();
  }
});

test("a regular file replaced by a symlink with a long target needs the acknowledgement", { skip: !posix }, async () => {
  const f = fixture();
  try {
    rmSync(join(f.repo, "keep.txt"));
    symlinkSync(`${"d/".repeat(600)}PAYLOAD`, join(f.repo, "keep.txt"));
    assert.equal((await start(f)).file("keep.txt").status, "T");
    await needsAck(f, "keep.txt");
  } finally {
    f.cleanup();
  }
});

test("a binary file replaced by text with a long line needs the acknowledgement", async () => {
  const f = fixture({ base: ({ write }) => write("bin.dat", Buffer.from([0, 1, 2, 0, 255, 0, 3])) });
  try {
    f.write("bin.dat", `${LONG}\n`);
    await needsAck(f, "bin.dat");
  } finally {
    f.cleanup();
  }
});

test("a mode change alone on a file that already had a long line is not asked about", { skip: !posix }, async () => {
  const f = fixture({ base: ({ write }) => write("long.txt", `${LONG}\n`) });
  try {
    chmodSync(join(f.repo, "long.txt"), 0o755);
    const s = await start(f);
    assert.equal(await s.hasCutLines("long.txt"), false);
    s.acceptFile("long.txt");
    assert.ok((await s.build()).reviewedTree);
  } finally {
    f.cleanup();
  }
});

test("new binary content is not treated as text with cut lines", async () => {
  const f = fixture();
  try {
    f.write("keep.txt", Buffer.concat([Buffer.from([0]), Buffer.alloc(5000, 97), Buffer.from([0])]));
    const s = await start(f);
    assert.equal(s.file("keep.txt").kind, "binary");
    assert.equal(await s.hasCutLines("keep.txt"), false);
  } finally {
    f.cleanup();
  }
});
