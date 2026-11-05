// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The staging allowlist (ADR 0005 D3): everything outside it must make the hook fail, closed, and leave nothing behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_ROOT, stage } from "../../scripts/code-oss/stage-packages.mjs";
import { fixture, put, withFixture } from "./stage-fixture.mjs";

const src = (rel) => `packages/protocol/src/${rel}`;
const restrictedFixture = (repo) => {
  put(repo, "packages/journal/package.json", JSON.stringify({ name: "@axis/journal", exports: { ".": { default: "./dist/src/index.js" }, "./daemon-principal": { default: "./dist/src/daemon-principal.js" } } }));
  put(repo, "packages/journal/src/index.ts", "export const j = 1;\n");
  put(repo, "packages/journal/src/daemon-principal.ts", "export const userPrincipal = 1;\n");
};

/** [name, mutate(repo, base, tree), error pattern] */
const REFUSED = [
  // Not on the file allowlist.
  ["a .js file in src", (r) => put(r, src("x.js"), "export {};\n"), /only \.ts sources/],
  ["a .json file in src", (r) => put(r, src("x.json"), "{}"), /only \.ts sources/],
  ["a .d.ts file in src", (r) => put(r, src("x.d.ts"), "export {};\n"), /only \.ts sources/],
  ["a native addon in src", (r) => put(r, src("x.node"), "ELF"), /only \.ts sources/],
  ["a test file in src", (r) => put(r, src("x.test.ts"), "export {};\n"), /tests belong in test/],
  ["a hidden file", (r) => put(r, src(".secret.ts"), "export {};\n"), /outside the allowlist/],
  ["a name with a space", (r) => put(r, src("a b.ts"), "export {};\n"), /outside the allowlist/],
  ["node_modules inside src", (r) => put(r, src("node_modules/x/index.ts"), "export {};\n"), /never staged/],
  ["dist inside src", (r) => put(r, src("dist/x.ts"), "export {};\n"), /never staged/],
  ["a package directory with an invalid name", (r) => put(r, "packages/Bad_Name/package.json", "{}"), /not a valid package directory name/],
  ["a package whose name field disagrees", (r) => put(r, "packages/protocol/package.json", JSON.stringify({ name: "@axis/other", exports: { ".": { default: "./dist/src/index.js" } } })), /expected @axis\/protocol/],
  ["a dependency outside zod and @axis", (r) => put(r, "packages/protocol/package.json", JSON.stringify({ name: "@axis/protocol", exports: { ".": { default: "./dist/src/index.js" } }, dependencies: { left: "1.0.0" } })), /outside the allowlist/],
  ["a missing index.ts", (r) => rmSync(join(r, "packages/worktrees/src/index.ts")), /index\.ts is missing/],
  ["a non-UTF-8 source", (r) => writeFileSync(join(r, src("bin.ts")), Buffer.from([0xff, 0xfe, 0x00])), /not valid UTF-8|NUL/],
  ["a NUL byte", (r) => writeFileSync(join(r, src("nul.ts")), "export {};\0\n"), /NUL byte/],
  ["an oversized source", (r) => writeFileSync(join(r, src("big.ts")), "x".repeat(5 * 1024 * 1024)), /byte limit/],
  // Links.
  ["a symlinked source file", (r, b) => { put(b, "outside.ts", "export const o = 1;\n"); symlinkSync(join(b, "outside.ts"), join(r, src("link.ts"))); }, /symbolic link/],
  ["a symlinked source directory", (r, b) => { put(b, "outdir/a.ts", "export {};\n"); symlinkSync(join(b, "outdir"), join(r, src("linked"))); }, /symbolic link/],
  ["a symlinked src directory", (r, b) => { put(b, "elsewhere/index.ts", "export {};\n"); rmSync(join(r, "packages/worktrees/src"), { recursive: true }); symlinkSync(join(b, "elsewhere"), join(r, "packages/worktrees/src")); }, /symbolic link/],
  ["a symlinked package directory", (r, b) => { put(b, "pkg/package.json", "{}"); symlinkSync(join(b, "pkg"), join(r, "packages/evil")); }, /symbolic link/],
  ["a symlinked package.json", (r, b) => { put(b, "pj.json", "{}"); rmSync(join(r, "packages/worktrees/package.json")); symlinkSync(join(b, "pj.json"), join(r, "packages/worktrees/package.json")); }, /symbolic link/],
  ["a dangling symlink", (r) => symlinkSync("/nonexistent-axis-target", join(r, src("dangling.ts"))), /symbolic link/],
  ["a symlinked node_modules/zod", (r, b) => { put(b, "realzod/package.json", JSON.stringify({ name: "zod", version: "9.9.9" })); put(b, "realzod/index.js", "export {};\n"); rmSync(join(r, "node_modules/zod"), { recursive: true }); symlinkSync(join(b, "realzod"), join(r, "node_modules/zod")); }, /symbolic link/],
  ["a symlinked file inside zod", (r, b) => { put(b, "o.js", "export {};\n"); rmSync(join(r, "node_modules/zod/v4/core.js")); symlinkSync(join(b, "o.js"), join(r, "node_modules/zod/v4/core.js")); }, /symbolic link|cannot open/],
  ["a named pipe", (r) => execFileSync("mkfifo", [join(r, src("pipe.ts"))]), /not a regular file/],
  // Imports and loads.
  ["a bare Node built-in", (r) => put(r, src("a.ts"), 'import "fs";\n'), /outside the allowlist/],
  ["an electron import", (r) => put(r, src("a.ts"), 'import "electron";\n'), /outside the allowlist/],
  ["a vs/* import", (r) => put(r, src("a.ts"), 'import "vs/base/common/event";\n'), /outside the allowlist/],
  ["an import hidden after a comment on the same line", (r) => put(r, src("a.ts"), 'const u = "x//"; import "electron";\n'), /outside the allowlist/],
  ["an import that only appears in a comment", (r) => put(r, src("a.ts"), '// import x from "vs/base/common/event";\n'), /outside the allowlist/],
  ["a require call", (r) => put(r, src("a.ts"), 'const x = require("left-pad");\n'), /outside the allowlist/],
  ["a zod subpath", (r) => put(r, src("a.ts"), 'import "zod/mini";\n'), /only the "zod" entry/],
  ["an unknown workspace package", (r) => put(r, src("a.ts"), 'import "@axis/nope";\n'), /unknown workspace package/],
  ["a subpath the package does not export", (r) => put(r, src("a.ts"), 'import "@axis/worktrees/dist/src/index.js";\n'), /malformed|not a subpath/],
  ["a subpath that is not exported", (r) => put(r, src("a.ts"), 'import "@axis/worktrees/nope";\n'), /not a subpath the package exports/],
  ["a restricted subpath from a package that may not import it", (r) => { restrictedFixture(r); put(r, src("a.ts"), 'import "@axis/journal/daemon-principal";\n'); }, /may only be imported by: daemon/],
  ["a relative import leaving src", (r) => put(r, src("a.ts"), 'import "../test/t.test.js";\n'), /leaves the package's src/],
  ["a relative import into another package", (r) => put(r, src("a.ts"), 'import "../../worktrees/src/index.js";\n'), /leaves the package's src/],
  ["a relative import without a .js suffix", (r) => put(r, src("a.ts"), 'import "./sub/a";\n'), /\.js suffix/],
  ["a relative import of a missing file", (r) => put(r, src("a.ts"), 'import "./missing.js";\n'), /\.js suffix/],
  ["a non-literal dynamic import", (r) => put(r, src("a.ts"), "await import(name);\n"), /string literal/],
  ["a template dynamic import", (r) => put(r, src("a.ts"), "await import(`./x/${n}.js`);\n"), /string literal/],
  ["createRequire", (r) => put(r, src("a.ts"), 'import { createRequire } from "node:module";\nvoid createRequire;\n'), /hides a load/],
  ["process.getBuiltinModule", (r) => put(r, src("a.ts"), "process.getBuiltinModule('fs');\n"), /hides a load/],
  ["eval", (r) => put(r, src("a.ts"), "eval('1');\n"), /hides a load/],
  ["new Function", (r) => put(r, src("a.ts"), "new Function('return 1');\n"), /hides a load/],
  ["a triple-slash reference", (r) => put(r, src("a.ts"), '/// <reference path="../../../vs/x.d.ts" />\n'), /hides a load/],
  // zod.
  ["a zod file importing outside zod", (r) => put(r, "node_modules/zod/index.js", 'export * from "../../outside.js";\n'), /leaves the package/],
  ["a zod file with a bare import", (r) => put(r, "node_modules/zod/v4/core.js", 'import "left-pad";\n'), /bare specifier/],
  ["a zod package.json that is not zod", (r) => put(r, "node_modules/zod/package.json", JSON.stringify({ name: "zod-evil", version: "9.9.9" })), /not zod/],
  // Time.
  ["a source dated in the future", (r) => { const t = new Date(Date.now() + 3600e3); utimesSync(join(r, src("sub/a.ts")), t, t); }, /modified in the future/],
];

for (const [name, mutate, pattern] of REFUSED) {
  test(`stage refuses ${name}, and leaves no staged output`, () => {
    withFixture(({ repo, tree, base }) => {
      mutate(repo, base, tree);
      assert.throws(() => stage({ repo, tree }), pattern);
      assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
    });
  });
}

test("stage refuses a source changed while it is being staged", () => {
  withFixture(({ repo, tree }) => {
    assert.throws(
      () => stage({ repo, tree, beforeRecheck: () => writeFileSync(join(repo, src("sub/a.ts")), "export const a = 99;\n") }),
      /changed while staging/,
    );
    assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
  });
});

test("stage: a restricted subpath is accepted from the package allowed to import it", () => {
  withFixture(({ repo, tree }) => {
    restrictedFixture(repo);
    put(repo, "packages/daemon/package.json", JSON.stringify({ name: "@axis/daemon", exports: { ".": { default: "./dist/src/index.js" } } }));
    put(repo, "packages/daemon/src/index.ts", 'import { userPrincipal } from "@axis/journal/daemon-principal";\nexport const p = userPrincipal;\n');
    stage({ repo, tree });
  });
});

test("stage: never writes through a link in the tree", () => {
  withFixture(({ repo, tree, base }) => {
    mkdirSync(join(base, "elsewhere"));
    mkdirSync(join(tree, "src/vs"), { recursive: true });
    symlinkSync(join(base, "elsewhere"), join(tree, "src/vs/axis"));
    assert.throws(() => stage({ repo, tree }), /symbolic link/);
    assert.deepEqual(readdirSync(join(base, "elsewhere")), []);
  });
  withFixture(({ repo, tree, base }) => {
    mkdirSync(join(base, "elsewhere"));
    mkdirSync(join(tree, "src/vs/axis"), { recursive: true });
    symlinkSync(join(base, "elsewhere"), join(tree, STAGE_ROOT));
    assert.throws(() => stage({ repo, tree }), /symbolic link/);
    assert.deepEqual(readdirSync(join(base, "elsewhere")), []);
  });
});

test("stage: a leftover staged directory with a file the manifest does not list is refused and kept", () => {
  withFixture(({ repo, tree }) => {
    stage({ repo, tree });
    put(tree, `${STAGE_ROOT}/protocol/planted.ts`, "export {};\n");
    assert.throws(() => stage({ repo, tree }), /unexpected file/);
    assert.equal(existsSync(join(tree, STAGE_ROOT, "protocol/planted.ts")), true);
  });
});

test("stage: a failing run after a good one removes the old output", () => {
  const { base, repo, tree } = fixture();
  try {
    stage({ repo, tree });
    put(repo, src("a.ts"), 'import "electron";\n');
    assert.throws(() => stage({ repo, tree }), /outside the allowlist/);
    assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---- Review round: tokenizer-based import scan, zod tree links, hard links, atomic write ----

const REFUSED_2 = [
  ["a string-named binding from a Node built-in", (r) => put(r, src("a.ts"), 'import { "execSync" as e } from "child_process";\n'), /outside the allowlist/],
  ["a string-named re-export from vs/*", (r) => put(r, src("a.ts"), 'export { "default" as ev } from "vs/base/common/event";\n'), /outside the allowlist/],
  ["a quote inside a comment before the specifier", (r) => put(r, src("a.ts"), "import /* ' */ { execSync } from \"child_process\";\n"), /outside the allowlist/],
  ["a specifier written with escapes", (r) => put(r, src("a.ts"), 'import "\\x65lectron";\n'), /outside the allowlist/],
  ["a package named vendor", (r) => { put(r, "packages/vendor/package.json", JSON.stringify({ name: "@axis/vendor", exports: { ".": { default: "./dist/src/index.js" } } })); put(r, "packages/vendor/src/index.ts", "export {};\n"); }, /reserved for vendored code/],
  ["a hard link to a file outside the repository", (r, b) => { put(b, "outside/creds.ts", "export const secret = 1;\n"); linkSync(join(b, "outside/creds.ts"), join(r, src("creds.ts"))); }, /hard links/],
  ["a hard link inside zod", (r, b) => { put(b, "outside/core.js", "export const z = 1;\n"); rmSync(join(r, "node_modules/zod/v4/core.js")); linkSync(join(b, "outside/core.js"), join(r, "node_modules/zod/v4/core.js")); }, /hard links/],
  ["a symlinked directory inside zod", (r, b) => { put(b, "elsewhere/core.js", "export const z = 'outside';\n"); put(b, "elsewhere/core.d.ts", "export declare const z: string;\n"); rmSync(join(r, "node_modules/zod/v4"), { recursive: true }); symlinkSync(join(b, "elsewhere"), join(r, "node_modules/zod/v4")); }, /symbolic link/],
  ["a symlinked zod declaration file", (r, b) => { put(b, "o.d.ts", "export {};\n"); rmSync(join(r, "node_modules/zod/v4/core.d.ts")); symlinkSync(join(b, "o.d.ts"), join(r, "node_modules/zod/v4/core.d.ts")); }, /symbolic link/],
  ["a symlink anywhere in the zod tree, even an unused one", (r) => symlinkSync("/etc", join(r, "node_modules/zod/v3/loop")), /symbolic link/],
  ["two sources that differ only in case", (r) => { put(r, src("Dup.ts"), "export {};\n"); put(r, src("dup.ts"), "export {};\n"); }, /differ only in case/],
];

for (const [name, mutate, pattern] of REFUSED_2) {
  test(`stage refuses ${name}, and leaves no staged output`, () => {
    withFixture(({ repo, tree, base }) => {
      mutate(repo, base, tree);
      assert.throws(() => stage({ repo, tree }), pattern);
      assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
      assert.equal(existsSync(join(tree, `${STAGE_ROOT}.staging`)), false);
    });
  });
}

test("stage rewrites a string-named zod binding to the vendored copy instead of leaving a bare import", () => {
  withFixture(({ repo, tree }) => {
    put(repo, src("quoted.ts"), 'import { "z" as zq } from "zod";\nexport const q = zq;\n');
    stage({ repo, tree });
    const text = readFileSync(join(tree, STAGE_ROOT, "protocol/quoted.ts"), "utf8");
    assert.match(text, /from "\.\.\/vendor\/zod\/index\.js"/);
    assert.doesNotMatch(text, /from "zod"/);
  });
});

test("stage refuses an input reached through a directory link swapped in after it was read", () => {
  withFixture(({ repo, tree }) => {
    assert.throws(
      () => stage({
        repo,
        tree,
        beforeRecheck: () => {
          renameSync(join(repo, src("sub")), join(repo, src("sub-real")));
          symlinkSync(join(repo, src("sub-real")), join(repo, src("sub")));
        },
      }),
      /changed while staging|resolves outside the repository through a link/,
    );
    assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
  });
});

test("stage fails cleanly when writing fails: no partial tree, no temporary, and the next run works", () => {
  withFixture(({ repo, tree }) => {
    assert.throws(
      () => stage({ repo, tree, beforeWrite: (tmp) => put(tmp, "protocol/index.ts", "planted\n") }),
      /writing the staged tree failed/,
    );
    assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
    assert.equal(existsSync(join(tree, `${STAGE_ROOT}.staging`)), false);
    assert.ok(stage({ repo, tree }).files.length > 0);
  });
});

test("stage removes a stale temporary left by a run that died", () => {
  withFixture(({ repo, tree }) => {
    put(tree, `${STAGE_ROOT}.staging/leftover.ts`, "export {};\n");
    stage({ repo, tree });
    assert.equal(existsSync(join(tree, `${STAGE_ROOT}.staging`)), false);
  });
});

test("stage removes everything when the final verification of the written tree fails", () => {
  withFixture(({ repo, tree }) => {
    assert.throws(() => stage({ repo, tree, afterWrite: (tmp) => writeFileSync(join(tmp, "protocol/sub/a.ts"), "export const a = 2;\n") }), /does not match the manifest/);
    assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
    assert.equal(existsSync(join(tree, `${STAGE_ROOT}.staging`)), false);
  });
});

test("stage enforces the total input size cap", () => {
  withFixture(({ repo, tree }) => {
    assert.throws(() => stage({ repo, tree, maxTotalBytes: 500 }), /inputs exceed 500 bytes/);
    assert.equal(existsSync(join(tree, STAGE_ROOT)), false);
  });
});

test("the vendored zod package.json is a minimal one, without scripts or an exports map", () => {
  withFixture(({ repo, tree }) => {
    put(repo, "node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "9.9.9", license: "MIT", scripts: { clean: "git clean -xdf ." }, exports: { ".": "./nowhere.js" } }));
    stage({ repo, tree });
    const pj = JSON.parse(readFileSync(join(tree, STAGE_ROOT, "vendor/zod/package.json"), "utf8"));
    assert.deepEqual(Object.keys(pj).sort(), ["description", "license", "name", "type", "version"]);
    assert.equal(pj.version, "9.9.9");
  });
});
