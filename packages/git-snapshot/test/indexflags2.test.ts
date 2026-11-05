// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, renameSync, utimesSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeDrift, parseSnapshot, takeSnapshot, type TakeOptions } from "../src/index.js";
import { resolveGit } from "../src/git.js";
import { canSkipClassification, classifyPath } from "../src/protected.js";
import { identityOf } from "../src/indexflags.js";
import { git, makeFixture, type Fixture } from "./helpers.js";

const posix = process.platform !== "win32";
const realPath = process.env["PATH"] ?? "";
const opts = (f: Fixture, more: Partial<TakeOptions> = {}): TakeOptions => ({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home, ...more });

function track(f: Fixture, ...files: string[]): void {
  for (const p of files) {
    mkdirSync(join(f.wt, p, ".."), { recursive: true });
    writeFileSync(join(f.wt, p), "{}\n");
  }
  git(f.wt, "add", ...files);
  git(f.wt, "commit", "-q", "-m", "files");
}

/** A `git` that answers `ls-files` from a file in `chunks` (split after the given byte offset) and runs the real one otherwise. */
function listing(f: Fixture, data: Buffer, split: number | null): string {
  const real = resolveGit(realPath, []) as string;
  const dir = join(f.root, `bin${split ?? "x"}`);
  mkdirSync(dir, { recursive: true });
  const dataFile = join(dir, "data");
  writeFileSync(dataFile, data);
  const out = split === null ? `cat '${dataFile}'` : `head -c ${split} '${dataFile}'; sleep 0.03; tail -c +${split + 1} '${dataFile}'`;
  writeFileSync(join(dir, "git"), `#!/bin/sh\ncase "$*" in *ls-files*) ${out}; exit 0;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  return join(dir, "git");
}

// A whole second, so that restoring an mtime restores every nanosecond of it.
const SECOND = 1_700_000_000;

const digestOf = async (f: Fixture, g: string): Promise<string | null> =>
  (await takeSnapshot(opts(f, { gitPath: g }))).entries.find((e) => e.id === "index/flags")?.sha256 ?? null;

test("the digest does not depend on where the pipe splits the listing", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const data = Buffer.from("S src/a.ts\0h docs/b.txt\0H plain.ts\0S x/y/z.ts\0S last.ts\0");
    const whole = await digestOf(f, listing(f, data, null));
    assert.ok(whole !== null);
    for (let k = 1; k < data.length; k += 3) assert.equal(await digestOf(f, listing(f, data, k)), whole, `split at ${k}`);
    // An over-long record is dropped whole wherever it is split, and blocks.
    const long = Buffer.concat([Buffer.from("S a.ts\0S "), Buffer.alloc(5000, 0x61), Buffer.from("\0S b.ts\0")]);
    const ref = await digestOf(f, listing(f, long, null));
    // A record whose tail looks like a record: after a split past the bound, that tail must not be taken as one.
    const tail = Buffer.concat([Buffer.from("S a.ts\0S "), Buffer.alloc(4300, 0x61), Buffer.from("S x.ts\0S b.ts\0")]);
    const tailRef = await digestOf(f, listing(f, tail, null));
    assert.equal(await digestOf(f, listing(f, tail, 7 + 2 + 4300)), tailRef, "a fragment of an over-long record was hashed");
    for (const k of [3, 9, 4090, 4096, 4100, 5005]) {
      const g = listing(f, long, k);
      assert.equal(await digestOf(f, g), ref, `long split at ${k}`);
      assert.ok((await takeSnapshot(opts(f, { gitPath: g }))).incomplete.some((i) => i.id === "index" && i.blocking), `blocks at ${k}`);
    }
  } finally {
    f.cleanup();
  }
});

test("identity: an edit of the same size with the mtime put back still changes the digest", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, "src/main.ts");
    git(f.wt, "update-index", "--skip-worktree", "src/main.ts");
    const p = join(f.wt, "src", "main.ts");
    utimesSync(p, SECOND, SECOND);
    const st = statSync(p);
    const before = await takeSnapshot(opts(f));
    writeFileSync(p, "[]\n");
    assert.equal(readFileSync(p).length, st.size);
    utimesSync(p, st.atime, st.mtime);
    const after = await takeSnapshot(opts(f));
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("identity: a rename-replace with the same size and mtime changes the digest", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, "src/main.ts");
    git(f.wt, "update-index", "--skip-worktree", "src/main.ts");
    const p = join(f.wt, "src", "main.ts");
    utimesSync(p, SECOND, SECOND);
    const st = statSync(p);
    const before = await takeSnapshot(opts(f));
    writeFileSync(`${p}.new`, "{}\n");
    utimesSync(`${p}.new`, st.atime, st.mtime);
    renameSync(`${p}.new`, p);
    const after = await takeSnapshot(opts(f));
    assert.equal(judgeDrift({ baseline: before, current: after }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("identity: a flagged file that cannot be examined is not 'absent', and the snapshot is incomplete", { skip: !posix || process.getuid?.() === 0 }, async () => {
  const f = makeFixture();
  try {
    track(f, "locked/main.ts");
    git(f.wt, "update-index", "--skip-worktree", "locked/main.ts");
    const open = await takeSnapshot(opts(f));
    chmodSync(join(f.wt, "locked"), 0);
    const shut = await takeSnapshot(opts(f));
    chmodSync(join(f.wt, "locked"), 0o755);
    assert.ok(shut.incomplete.some((i) => i.id === "index" && i.blocking && /could not be examined/.test(i.reason)), JSON.stringify(shut.incomplete));
    assert.notEqual(shut.entries.find((e) => e.id === "index/flags")?.sha256, open.entries.find((e) => e.id === "index/flags")?.sha256);
    assert.equal(judgeDrift({ baseline: shut, current: shut }).status, "refused");
  } finally {
    chmodSync(join(f.wt, "locked"), 0o755);
    f.cleanup();
  }
});

test("the flag kind is part of the digest: skip-worktree to assume-unchanged on the same file", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    track(f, "src/main.ts");
    git(f.wt, "update-index", "--skip-worktree", "src/main.ts");
    const a = await takeSnapshot(opts(f));
    git(f.wt, "update-index", "--no-skip-worktree", "src/main.ts");
    git(f.wt, "update-index", "--assume-unchanged", "src/main.ts");
    const b = await takeSnapshot(opts(f));
    assert.notEqual(a.entries.find((e) => e.id === "index/flags")?.sha256, b.entries.find((e) => e.id === "index/flags")?.sha256);
  } finally {
    f.cleanup();
  }
});

test("a text limit above the schema bound is clamped, and the snapshot still loads", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const files: string[] = [];
    for (let i = 0; i < 2500; i++) files.push(`pkg${i}/package.json`);
    track(f, ...files);
    git(f.wt, "update-index", "--skip-worktree", ...files);
    const s = await takeSnapshot(opts(f, { limits: { maxTextChars: 1_000_000, maxSettings: 4000 } }));
    assert.equal(parseSnapshot(JSON.parse(JSON.stringify(s))).digest, s.digest);
  } finally {
    f.cleanup();
  }
});

test("100,000 flagged files are scanned in a few seconds", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const real = resolveGit(realPath, []) as string;
    const dir = join(f.root, "bin-big");
    mkdirSync(dir);
    writeFileSync(join(dir, "git"), `#!/bin/sh\ncase "$*" in *ls-files*) seq 1 100000 | sed 's/.*/S src\\/m&\\/x.ts/' | tr '\\n' '\\0'; exit 0;; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(dir, "git"), 0o755);
    const t0 = Date.now();
    const s = await takeSnapshot(opts(f, { gitPath: join(dir, "git") }));
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
    assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
    assert.match(s.entries.find((e) => e.id === "index/flags")?.text ?? "", /^100000 flagged\n/);
  } finally {
    f.cleanup();
  }
});

test("the pre-filter only skips paths that classifyPath would not mark (generated corpus, case and Unicode variants)", () => {
  let seed = 12345;
  const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const words = ["src", "lib", "a", "b", "x1", "my-mod", "under_score", "docs", "package.json", "makefile", "dockerfile", "docker-compose.yml", "compose.yaml", ".github", "workflows", "vscode", ".vscode", "husky", ".husky", "readme.md", "notes.md", "conftest.py", "build.rs", "pyproject.toml", "lefthook.yml", "jenkinsfile", ".npmrc", ".env", "gitx~1", "toolx.local.md", "TOOLX.md", "Src", "SRC", "ıx", "Kelvin", "a.b", "..", ".", "a ", "b.", "c:d", "\\", "setup.py", "tsconfig.json", "index.ts", "pkg", "cargo.toml", ".cargo", "config", "justfile", "rakefile", "build.gradle", "noxfile.py", "Package.json", "Makefile", "Dockerfile", "ContainerFile", "Containerfile.dev", "COMPOSE.yaml", "Docker-Compose.yml", "README.MD", "Lefthook.yml", "Jenkinsfile", "GitHub", "Vscode", "CamelCase", "SomeModule", "MyFile.TS", "Conftest.py", "BUILD.RS"];
  let skipped = 0;
  for (let n = 0; n < 60_000; n++) {
    const parts: string[] = [];
    for (let k = 1 + (rnd(20) === 0 ? rnd(300) : rnd(4)); k > 0; k--) parts.push(words[rnd(words.length)] as string);
    const p = parts.join(rnd(9) === 0 ? "\\" : "/");
    if (canSkipClassification(p)) {
      skipped++;
      assert.equal(classifyPath(p), null, `skipped but protected: ${JSON.stringify(p)}`);
    }
  }
  assert.ok(skipped > 1000, `the corpus exercised the skip ${skipped} times`);
  for (const p of ["src/main.ts", "lib/a/b.ts"]) assert.equal(canSkipClassification(p), true, p);
  for (const p of ["package.json", "src/Makefile", ".github/x", "a/dockerfile", "README.md", "src/Dockerfile.dev", "x/compose.yaml"]) assert.equal(canSkipClassification(p), false, p);
});

test("the pre-filter ignores ASCII case, so capitalised paths are skipped, but never a protected name in any case", () => {
  for (const p of ["Src/Main.ts", "Lib/CamelCase/SomeModule.ts", "A/B/C.TS"]) assert.equal(canSkipClassification(p), true, p);
  for (const p of ["Package.json", "PACKAGE.JSON", "src/Makefile", "a/DockerFile", "a/ContainerFile", "x/Compose.YAML", "README.MD", "Jenkinsfile"]) {
    assert.equal(canSkipClassification(p), false, p);
  }
});

test("the pre-filter never skips a path the matcher calls invalid: 258 components, or more than 4096 characters", () => {
  const deep = Array.from({ length: 258 }, () => "a").join("/");
  assert.equal(classifyPath(deep)?.category, "invalid-path");
  assert.equal(canSkipClassification(deep), false);
  const long = `${"a".repeat(5000)}/b`;
  assert.equal(classifyPath(long)?.category, "invalid-path");
  assert.equal(canSkipClassification(long), false);
});

test("a flagged path with 258 components is a listed high setting, end to end", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const deep = Array.from({ length: 258 }, () => "a").join("/");
    const s = await takeSnapshot(opts(f, { gitPath: listing(f, Buffer.from(`S ${deep}\0`), null) }));
    const setting = s.settings.find((x) => x.label === "index flag hides changes" && x.key !== "index.flagged-count");
    assert.ok(setting, JSON.stringify(s.settings.map((x) => x.key)));
    assert.equal(setting.severity, "high");
  } finally {
    f.cleanup();
  }
});

test("every field of the identity matters on its own", () => {
  const base = { size: 1n, mtimeNs: 2n, ctimeNs: 3n, ino: 4n, dev: 5n, mode: 6n, uid: 7n, gid: 8n };
  const id = identityOf(base);
  for (const k of Object.keys(base) as (keyof typeof base)[]) {
    assert.notEqual(identityOf({ ...base, [k]: (base[k] as bigint) + 100n }), id, `${k} is not part of the identity`);
  }
  assert.equal(identityOf({ ...base }), id);
});

test("100,000 capitalised flagged files are scanned in a few seconds", { skip: !posix }, async () => {
  const f = makeFixture();
  try {
    const real = resolveGit(realPath, []) as string;
    const dir = join(f.root, "bin-camel");
    mkdirSync(dir);
    writeFileSync(join(dir, "git"), `#!/bin/sh\ncase "$*" in *ls-files*) seq 1 100000 | sed 's/.*/S Src\\/Mod&\\/CamelCase.ts/' | tr '\\n' '\\0'; exit 0;; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(dir, "git"), 0o755);
    const t0 = Date.now();
    const s = await takeSnapshot(opts(f, { gitPath: join(dir, "git") }));
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
    assert.equal(s.incomplete.length, 0, JSON.stringify(s.incomplete));
  } finally {
    f.cleanup();
  }
});
