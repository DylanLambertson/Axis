// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Enforces the ADR 0005 D2 boundary on packages/*: what each package may import,
// and which dependencies its package.json may declare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isScriptFile } from "./loaders.mjs";
import { importSpecifiers, unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";
import { LOADER_BUILTINS } from "../../scripts/code-oss/stage-scan.mjs";
import { listenerBuiltinRefusal, webHostEdgeRefusal } from "../../scripts/code-oss/web-rules.mjs";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));

/** Packages that must stay free of Node imports (contracts shared with the web target). */
const NO_NODE = new Set(["protocol"]);

// The scanners imported above are the staging hook's own (scripts/code-oss/stage-ast.mjs, a TypeScript parse), so the lint and the
// hook cannot disagree about what a file imports.
/**
 * Subpaths of @axis/journal and the only packages that may import them. The user principal is minted by the
 * daemon's connection layer from the attested connection; nothing else may be able to create one. Any other
 * `@axis/journal/...` deep import is refused. Other packages' subpaths (for example `@axis/providers/contract`)
 * are unrestricted, as before.
 */
const JOURNAL_SUBPATHS = new Map([["@axis/journal/daemon-principal", new Set(["daemon"])]]);

/** The trust attestation is minted by the daemon's connection layer from main's attestation (threat model TRU-2). */
const RUNS_SUBPATHS = new Map([["@axis/runs/daemon-attestation", new Set(["daemon"])]]);

/**
 * The composition root (docs/design/daemon-host.md section 2.1). It is the only package that may import every other
 * package, and nothing imports it. Some packages are reachable only from named files of `daemon-host`, relative to its
 * directory; `@axis/journal/daemon-principal` is also kept for the daemon package, as above.
 */
const HOST_PACKAGE = "daemon-host";
const HOST_FILE_RULES = new Map([
  ["@axis/journal/daemon-principal", ["src/handlers/review.ts"]],
  ["@axis/git-snapshot", ["src/bindings/snapshot.ts"]],
  ["@axis/worktrees", ["src/bindings/worktrees.ts"]],
  ["@axis/worktrees/daemon-confirm", ["src/gate/worktrees-confirm.ts"]],
  ["@axis/runs/daemon-attestation", ["src/gate/run-trust.ts"]],
]);
/**
 * The files that may load the two minter modules (`gate/worktrees-confirm.ts`, `gate/run-trust.ts`): the public index (which re-exports
 * their closed-over factories) and the composition root (ticket H12), the one place that builds the gate and hands handler code only
 * the registrar. A handler, a service, a binding or another composition part may not.
 */
/** The files that may load the composition root: the public index, and the utility process entry (it calls `composeDaemonHost` and nothing else of it). */
const COMPOSE_IMPORTERS = new Set(["src/index.ts", "src/entry.ts"]);
const COMPOSITION_FILES = new Set(["src/index.ts", "src/compose.ts"]);
/** Packages whose bindings live in `src/bindings/*.ts` of the host (they land with their own changes). */
const HOST_BINDING_PACKAGES = ["@axis/broker", "@axis/runs", "@axis/review"];

/** Judge the host-only rules; null means no host rule applies and the general rules decide. */
function hostViolation(pkg, spec, file, pkgDir) {
  if (spec === "@axis/daemon-host" || spec.startsWith("@axis/daemon-host/")) {
    return "nothing in packages/* may import the daemon host";
  }
  const files = HOST_FILE_RULES.get(spec);
  const binding = HOST_BINDING_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
  if (files === undefined && !binding) return null;
  // Other packages keep their existing rules for these specifiers (checked by the caller after this returns null).
  if (pkg !== HOST_PACKAGE) return null;
  if (file === null || pkgDir === null) return "this specifier is allowed only in named files of the daemon host";
  const rel = relative(pkgDir, file).split(sep).join("/");
  if (files !== undefined) return files.includes(rel) ? "ok" : `only ${files.join(", ")} may import this`;
  // A type test may import the real types to compile the port against them (type-only, never shipped).
  return /^src\/bindings\/[^/]+\.ts$/.test(rel) || /^test\/types\/[^/]+\.ts$/.test(rel) ? "ok" : "only src/bindings/*.ts may import this";
}

/**
 * Why a specifier is not allowed in `pkg`, or null when it is. The node:*
 * ban for contract packages (D2.4) applies to shipped sources under `src/`;
 * tests and test-support entry points (`test/`, `contract/`) may use node:*.
 * A call without a file is judged as `src/`.
 */
export function violation(pkg, spec, file = null, pkgDir = null) {
  const inSrc = file === null || pkgDir === null || relative(pkgDir, file).split(sep)[0] === "src";
  if (spec.startsWith("./") || spec.startsWith("../")) {
    if (file === null || pkgDir === null) return null;
    const target = resolve(dirname(file), spec);
    const rel = relative(pkgDir, target);
    // Shipped code stays inside src/: a src file importing test/, testing/ or contract/ could launder a minter through a
    // test-support module (those may import the minters), so the rule holds for every package.
    if (relative(pkgDir, file).split(sep)[0] === "src" && !(rel === "src" || rel.startsWith(`src${sep}`)) && !(rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel)) {
      return "src/ may not import outside src/ (test/, testing/ or contract/)";
    }
    // The module that mints the discard token: inside the host's src/, only the public index may load it (a handler
    // or a service reaching it by a relative path could mint a token with no spent approval).
    // The public index re-exports the wiring that closes over it: nothing inside src/ may load the index (a barrel hop).
    if (pkg === HOST_PACKAGE && /^src[\\/]index(\.[cm]?[jt]s)?$/.test(rel)) {
      const from = relative(pkgDir, file).split(sep).join("/");
      if (from.startsWith("src/")) return "nothing inside src/ may import the public index";
    }
    // The web host (docs/design/web-host-entry.md): only src/web/ may load src/web/, so no desktop entry can reach the listener.
    const fromSrc = relative(pkgDir, file).split(sep).join("/");
    if (fromSrc.startsWith("src/")) {
      const web = webHostEdgeRefusal(`${pkg}/${fromSrc.slice(4)}`, `${pkg}/${rel.split(sep).join("/").slice(4)}`);
      if (web !== null && rel.startsWith(`src${sep}`)) return web;
    }
    // The process entry reaches the composition root, so it is a composition point: nothing inside src/ may load it, only the overlay entry.
    if (pkg === HOST_PACKAGE && /^src[\\/]entry(\.[cm]?[jt]s)?$/.test(rel)) {
      const from = relative(pkgDir, file).split(sep).join("/");
      if (from.startsWith("src/")) return "nothing inside src/ may import the process entry src/entry.ts";
    }
    // The composition root loads both minters, so it is as privileged as the public index: only the index may load it.
    if (pkg === HOST_PACKAGE && /^src[\\/]compose(\.[cm]?[jt]s)?$/.test(rel)) {
      const from = relative(pkgDir, file).split(sep).join("/");
      if (from.startsWith("src/") && !COMPOSE_IMPORTERS.has(from)) return "only src/index.ts and the process entry src/entry.ts may import the composition root";
    }
    if (pkg === HOST_PACKAGE && /^src[\\/]gate[\\/]worktrees-confirm(\.[cm]?[jt]s)?$/.test(rel)) {
      const from = relative(pkgDir, file).split(sep).join("/");
      if (from.startsWith("src/") && !COMPOSITION_FILES.has(from)) return "only src/index.ts and the composition root src/compose.ts may import the discard token minter";
    }
    if (pkg === HOST_PACKAGE && /^src[\\/]gate[\\/]run-trust(\.[cm]?[jt]s)?$/.test(rel)) {
      const from = relative(pkgDir, file).split(sep).join("/");
      if (from.startsWith("src/") && !COMPOSITION_FILES.has(from)) return "only src/index.ts and the composition root src/compose.ts may import the run trust minter";
    }
    return rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel
      ? "relative import leaves the package directory"
      : null;
  }
  if (spec === "zod" || spec.startsWith("zod/")) return null;
  const host = hostViolation(pkg, spec, file, pkgDir);
  if (host === "ok") return null;
  if (host !== null) return host;
  if (spec === "@axis/worktrees/daemon-confirm" && pkg !== HOST_PACKAGE) {
    return "this subpath may only be imported by the daemon host gate adapter";
  }
  if (spec.startsWith("@axis/journal/")) {
    const allowed = JOURNAL_SUBPATHS.get(spec);
    if (allowed === undefined) return "deep imports into @axis/journal are not allowed";
    return allowed.has(pkg) ? null : "this subpath may only be imported by the daemon integration code";
  }
  if (spec.startsWith("@axis/runs/")) {
    const allowed = RUNS_SUBPATHS.get(spec);
    if (allowed === undefined) return "deep imports into @axis/runs are not allowed";
    return allowed.has(pkg) ? null : "this subpath may only be imported by the daemon integration code";
  }
  if (spec.startsWith("@axis/")) return null;
  if (spec.startsWith("node:")) {
    if (NO_NODE.has(pkg) && inSrc) return "node:* is not allowed in this package";
    const only = LOADER_BUILTINS.get(spec.replace(/\/.*$/, ""));
    if (only !== undefined && !only.has(pkg) && inSrc) return "this built-in loads or runs code without a module specifier";
    const staged = file === null || pkgDir === null ? null : `${pkg}/${relative(pkgDir, file).split(sep).join("/").slice(4)}`;
    return inSrc ? listenerBuiltinRefusal(spec, staged) : null;
  }
  return "only relative, zod, @axis/* and node:* imports are allowed";
}

/** Directories never scanned: build output and installed dependencies. */
const SKIP_DIRS = new Set(["dist", "node_modules"]);

/**
 * Every script file in a package (.js, .mjs, .cjs, .ts, .mts, .cts, .tsx, .jsx; not declaration files), not only `src/`: `contract/` is a
 * published entry point other packages import, and `test/` runs in CI (N9).
 */
export function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(p);
      continue;
    }
    if (isScriptFile(p)) yield p;
  }
}

const packages = readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory());

test("there is at least one package", () => assert.ok(packages.length > 0));

for (const pkg of packages) {
  test(`${pkg}: imports stay inside the allowlist (whole package)`, () => {
    const bad = [];
    const pkgDir = join(packagesDir, pkg);
    for (const file of sourceFiles(pkgDir)) {
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source, file)) {
        const why = violation(pkg, spec, file, pkgDir);
        if (why) bad.push(`${file}: ${spec} (${why})`);
      }
      for (const call of unsafeForms(source, file, { pkg, shipped: relative(pkgDir, file).split(sep)[0] === "src" })) bad.push(`${file}: ${call}`);
    }
    assert.deepEqual(bad, []);
  });

  test(`${pkg}: package.json declares only zod and @axis/* dependencies`, () => {
    const json = JSON.parse(readFileSync(join(packagesDir, pkg, "package.json"), "utf8"));
    assert.equal(json.type, "module");
    assert.equal(json.private, true);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(json[field] ?? {})) {
        assert.ok(name === "zod" || name.startsWith("@axis/"), `${field}.${name}`);
      }
    }
    if (json.dependencies?.zod !== undefined) assert.equal(json.dependencies.zod, "4.6.6");
  });
}

test("scanner: finds every import form and ignores comments", () => {
  const src = `
    import a from "zod";
    import type { B } from '../b.js';
    export * from "./c.js";
    export { d } from "node:fs";
    import "vs/base/common/lifecycle";
    const e = await import("electron");
    // import x from "ignored";
    /* import y from "ignored2"; */
    const s = "https://example.com//not-a-comment";
  `;
  assert.deepEqual(importSpecifiers(src).sort(), [
    "../b.js", "./c.js", "electron", "node:fs", "vs/base/common/lifecycle", "zod",
  ]);
});

test("scanner: string-named bindings and a quote in a comment do not hide a specifier", () => {
  assert.deepEqual(importSpecifiers('import { "z" as z } from "zod";\nexport { "default" as e } from "vs/base/common/event";\nimport /* \' */ { x } from "child_process";').sort(), ["child_process", "vs/base/common/event", "zod"]);
});

test("scanner: a regex literal after a closing parenthesis does not hide a specifier", () => {
  const trick = `if (Date.now() < 0) /'/.test(""); export { "z" as zTree } from "zod";`;
  assert.deepEqual(importSpecifiers(trick), ["zod"]);
  assert.deepEqual(importSpecifiers(`if (a) /'/.test(b); export * from "electron";`), ["electron"]);
  assert.deepEqual(importSpecifiers(`if (a) /'/.test(b); const m = import("electron");`), ["electron"]);
  assert.deepEqual(importSpecifiers(`if (a) /'/.test(b); import fs = require("fs");`), ["fs"]);
  assert.deepEqual(importSpecifiers(`const x = (a) / 2; import { y } from "./y.js";`), ["./y.js"]);
});

test("scanner: policy", () => {
  assert.equal(violation("protocol", "vs/base/common/event"), "only relative, zod, @axis/* and node:* imports are allowed");
  assert.equal(violation("protocol", "electron") !== null, true);
  assert.equal(violation("protocol", "node:fs") !== null, true);
  assert.equal(violation("worktrees", "node:fs"), null);
  assert.equal(violation("worktrees", "@axis/protocol"), null);
  assert.equal(violation("worktrees", "zod"), null);
  assert.equal(violation("worktrees", "fs") !== null, true);
});

test("scanner: relative imports must stay inside the package", () => {
  const dir = join(packagesDir, "protocol");
  const file = join(dir, "src", "a.ts");
  assert.equal(violation("protocol", "./b.js", file, dir), null);
  assert.notEqual(violation("protocol", "../test/x.js", file, dir), null, "src may not import test/");
  assert.notEqual(violation("protocol", "../testing/x.js", file, dir), null, "src may not import testing/");
  assert.notEqual(violation("protocol", "../contract/x.js", file, dir), null);
  assert.notEqual(violation("protocol", "../src/../testing/x.js", file, dir), null, "a detour through src does not hide it");
  assert.equal(violation("protocol", "../src/x.js", file, dir), null, "src may name itself");
  assert.equal(violation("protocol", "../src/x.js", join(dir, "test", "a.test.ts"), dir), null, "tests import src");
  assert.equal(violation("protocol", "../testing/x.js", join(dir, "test", "a.test.ts"), dir), null, "tests import testing/");
  assert.notEqual(violation("protocol", "../../worktrees/src/x.js", file, dir), null);
  assert.notEqual(violation("protocol", "../../../vendor/code-oss/x.js", file, dir), null);
  assert.notEqual(violation("protocol", "../../protocol-evil/x.js", file, dir), null);
});

test("scanner: dynamic loads need a string literal", () => {
  assert.deepEqual(unsafeForms(`const a = await import("zod"); const b = require('./x.js');`), []);
  assert.equal(unsafeForms("await import(name)").length, 1);
  assert.equal(unsafeForms("await import(`./x/${n}.js`)").length, 1);
  assert.equal(unsafeForms("await import('./x/' + n)").length, 1);
  assert.equal(unsafeForms("require(path)").length, 1);
  assert.deepEqual(unsafeForms('// import(name)\n/* require(x) */'), []);
});

test("scanner: walks the whole package except dist and node_modules", () => {
  const dir = join(packagesDir, "protocol");
  const files = [...sourceFiles(dir)].map((f) => relative(dir, f));
  assert.ok(files.some((f) => f.startsWith(`src${sep}`)));
  assert.ok(files.some((f) => f.startsWith(`test${sep}`)), "tests are scanned");
  assert.ok(files.every((f) => !f.startsWith(`dist${sep}`) && !f.startsWith(`node_modules${sep}`)));
});

test("scanner: node:* is banned in protocol src, allowed in its tests and test-support entry points", () => {
  const dir = join(packagesDir, "protocol");
  assert.notEqual(violation("protocol", "node:fs", join(dir, "src", "a.ts"), dir), null);
  assert.equal(violation("protocol", "node:test", join(dir, "test", "a.test.ts"), dir), null);
  assert.equal(violation("protocol", "node:test", join(dir, "contract", "index.ts"), dir), null);
  assert.notEqual(violation("protocol", "electron", join(dir, "contract", "index.ts"), dir), null, "the rest of the allowlist still applies");
  assert.notEqual(violation("protocol", "vs/base/common/event", join(dir, "test", "a.test.ts"), dir), null);
});

test("scanner: the user-principal subpath is restricted to the daemon; other journal deep imports are refused", () => {
  assert.equal(violation("journal", "@axis/audit"), null);
  assert.equal(violation("daemon", "@axis/journal"), null);
  assert.equal(violation("daemon", "@axis/journal/daemon-principal"), null);
  for (const pkg of ["protocol", "audit", "journal", "worktrees", "git-ops", "git-snapshot", "pty-policy", "providers", "challenge"]) {
    assert.notEqual(violation(pkg, "@axis/journal/daemon-principal"), null, pkg);
  }
  assert.notEqual(violation("daemon", "@axis/journal/dist/src/principal.js"), null);
  assert.notEqual(violation("daemon", "@axis/journal/src/principal"), null);
  // Other packages' own subpaths stay allowed, as on main.
  assert.equal(violation("daemon", "@axis/providers/contract"), null);
});

test("scanner: the trust-attestation subpath is restricted to the daemon; other runs deep imports are refused", () => {
  assert.equal(violation("daemon", "@axis/runs"), null);
  assert.equal(violation("daemon", "@axis/runs/daemon-attestation"), null);
  for (const pkg of ["protocol", "audit", "journal", "runs", "git-ops", "pty-policy", "providers", "challenge"]) {
    assert.notEqual(violation(pkg, "@axis/runs/daemon-attestation"), null, pkg);
  }
  assert.notEqual(violation("daemon", "@axis/runs/dist/src/attestation.js"), null);
  assert.notEqual(violation("daemon", "@axis/runs/src/attestation"), null);
});

test("the runs package root does not export the attestation minting function", () => {
  const json = JSON.parse(readFileSync(join(packagesDir, "runs", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(json.exports).sort(), [".", "./daemon-attestation"]);
  const index = readFileSync(join(packagesDir, "runs", "src", "index.ts"), "utf8");
  assert.ok(!/attestTrust|daemon-attestation|MINT/.test(index), "src/index.ts must not expose the minting function");
});

test("the journal package root exports the principal subpath only through package.json exports", () => {
  const json = JSON.parse(readFileSync(join(packagesDir, "journal", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(json.exports).sort(), [".", "./daemon-principal"]);
  const index = readFileSync(join(packagesDir, "journal", "src", "index.ts"), "utf8");
  assert.ok(!/principal/i.test(index), "src/index.ts must not mention the principal module");
});

test("scanner: every script extension is read, declaration files are not", () => {
  for (const f of ["a.js", "a.mjs", "a.cjs", "a.ts", "a.mts", "a.cts", "a.tsx", "a.jsx", "dir/deep/x.mts"]) assert.equal(isScriptFile(f), true, f);
  for (const f of ["a.d.ts", "a.d.mts", "a.d.cts", "a.json", "a.map", "a.js.map", "a.md", "a.mtsx", "ts"]) assert.equal(isScriptFile(f), false, f);
});

test("scanner: sourceFiles yields .mts, .cts, .tsx, .jsx, .mjs and .cjs files, and skips dist and node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "axis-scan-"));
  try {
    for (const f of ["src/a.ts", "src/b.mts", "src/c.cts", "src/d.tsx", "src/e.jsx", "scripts/f.mjs", "scripts/g.cjs", "h.js", "src/i.d.ts", "src/j.d.mts", "src/k.json", "dist/l.js", "node_modules/m/n.js"]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    const found = [...sourceFiles(root)].map((p) => relative(root, p).split(sep).join("/")).sort();
    assert.deepEqual(found, ["h.js", "scripts/f.mjs", "scripts/g.cjs", "src/a.ts", "src/b.mts", "src/c.cts", "src/d.tsx", "src/e.jsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanner: a .mts file that imports and re-exports the principal is caught end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "axis-scan-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const file = join(root, "src", "leak.mts");
    writeFileSync(file, 'import { userPrincipal } from "@axis/journal/daemon-principal";\nexport { userPrincipal };\nconst r = createRequire(import.meta.url);\n');
    const bad = [];
    for (const f of sourceFiles(root)) {
      const source = readFileSync(f, "utf8");
      for (const spec of importSpecifiers(source, f)) {
        const why = violation("providers", spec, f, root);
        if (why) bad.push(spec);
      }
      bad.push(...unsafeForms(source, f).map((m) => m.replace(/^line \d+: /, "")));
    }
    assert.equal(bad[0], "@axis/journal/daemon-principal");
    assert.equal(bad.length, 3);
    assert.match(bad[1], /createRequire/);
    assert.match(bad[2], /userPrincipal comes from a mint module and may only be called/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanner: the daemon host is imported by nothing and imports the restricted packages only from named files", () => {
  const dir = join(packagesDir, "daemon-host");
  const at = (rel) => join(dir, ...rel.split("/"));
  // Nothing imports the host.
  for (const pkg of ["daemon", "runs", "protocol", "daemon-host"]) {
    assert.notEqual(violation(pkg, "@axis/daemon-host"), null, pkg);
    assert.notEqual(violation(pkg, "@axis/daemon-host/dist/src/index.js"), null, pkg);
  }
  // The host imports the ordinary packages anywhere.
  for (const spec of ["@axis/protocol", "@axis/daemon", "@axis/challenge", "@axis/audit", "@axis/journal", "@axis/git-ops", "@axis/pty-policy", "@axis/providers", "zod", "node:fs"]) {
    assert.equal(violation("daemon-host", spec, at("src/config.ts"), dir), null, spec);
  }
  // The user principal: only src/handlers/review.ts of the host, and still the daemon package.
  assert.equal(violation("daemon-host", "@axis/journal/daemon-principal", at("src/handlers/review.ts"), dir), null);
  assert.notEqual(violation("daemon-host", "@axis/journal/daemon-principal", at("src/handlers/git.ts"), dir), null);
  assert.notEqual(violation("daemon-host", "@axis/journal/daemon-principal", at("test/review.test.ts"), dir), null);
  assert.notEqual(violation("daemon-host", "@axis/journal/daemon-principal"), null, "a call without a file is judged strictly");
  assert.equal(violation("daemon", "@axis/journal/daemon-principal"), null);
  // Worktrees: the package only from the binding, the confirm subpath only from the gate file.
  assert.equal(violation("daemon-host", "@axis/worktrees", at("src/bindings/worktrees.ts"), dir), null);
  for (const f of ["src/handlers/worktrees.ts", "src/ports/worktrees.ts", "src/host.ts", "src/bindings/runs.ts"]) {
    assert.notEqual(violation("daemon-host", "@axis/worktrees", at(f), dir), null, f);
  }
  // GIT-SNAP-1 (H13): the run snapshotter binding is the host's one importer of @axis/git-snapshot.
  assert.equal(violation("daemon-host", "@axis/git-snapshot", at("src/bindings/snapshot.ts"), dir), null);
  for (const f of ["src/compose.ts", "src/entry.ts", "src/handlers/cli-runs.ts", "src/bindings/runs.ts"]) assert.notEqual(violation("daemon-host", "@axis/git-snapshot", at(f), dir), null, f);
  // The trust attestation: only src/gate/run-trust.ts of the host (the binding and the handler cannot mint one).
  assert.equal(violation("daemon-host", "@axis/runs/daemon-attestation", at("src/gate/run-trust.ts"), dir), null);
  for (const f of ["src/bindings/runs.ts", "src/handlers/cli-runs.ts", "src/gate/approvals.ts", "test/runs-rig.ts"]) {
    assert.notEqual(violation("daemon-host", "@axis/runs/daemon-attestation", at(f), dir), null, f);
  }
  assert.notEqual(violation("daemon-host", "@axis/runs/daemon-attestation"), null, "a call without a file is judged strictly");
  // The run trust minter module (a relative import): only the public index, never a handler, binding or gate neighbour.
  assert.equal(violation("daemon-host", "./gate/run-trust.js", at("src/index.ts"), dir), null);
  assert.equal(violation("daemon-host", "./gate/run-trust.js", at("src/compose.ts"), dir), null, "the composition root");
  assert.notEqual(violation("daemon-host", "./gate/run-trust.js", at("src/compose-parts.ts"), dir), null, "its helper file is not the root");
  // The launder (review daemon-host-runs-review2 N2): a handler imports a testing/ module that re-exports the minter.
  assert.notEqual(violation("daemon-host", "../../testing/zz-launder.js", at("src/handlers/zz-a.ts"), dir), null, "src importing testing/");
  assert.notEqual(violation("daemon-host", "../../test/zz-launder.js", at("src/handlers/zz-a.ts"), dir), null, "src importing test/");
  assert.equal(violation("daemon-host", "../testing/zz-launder.js", at("test/a.test.ts"), dir), null, "a test may import testing/");
  for (const [f, spec] of [
    ["src/handlers/cli-runs.ts", "../gate/run-trust.js"],
    ["src/bindings/runs.ts", "../gate/run-trust.js"],
    ["src/gate/approvals.ts", "./run-trust.js"],
    ["src/handlers/git.ts", "../gate/run-trust"],
  ]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, f);
  }
  assert.equal(violation("daemon-host", "../src/gate/run-trust.js", at("test/run-trust.test.ts"), dir), null, "tests may");
  assert.equal(violation("daemon-host", "@axis/worktrees/daemon-confirm", at("src/gate/worktrees-confirm.ts"), dir), null);
  assert.notEqual(violation("daemon-host", "@axis/worktrees/daemon-confirm", at("src/bindings/worktrees.ts"), dir), null);
  // The minter itself (a relative import): only the public index, never a handler, service, binding or the gate neighbours.
  assert.equal(violation("daemon-host", "./gate/worktrees-confirm.js", at("src/index.ts"), dir), null);
  assert.equal(violation("daemon-host", "./gate/worktrees-confirm.js", at("src/compose.ts"), dir), null, "the composition root");
  assert.notEqual(violation("daemon-host", "./gate/worktrees-confirm.js", at("src/compose-parts.ts"), dir), null, "its helper file is not the root");
  for (const [f, spec] of [
    ["src/handlers/worktrees.ts", "../gate/worktrees-confirm.js"],
    ["src/worktrees/service.ts", "../gate/worktrees-confirm.js"],
    ["src/bindings/worktrees.ts", "../gate/worktrees-confirm.ts"],
    ["src/gate/approvals.ts", "./worktrees-confirm"],
  ]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, f);
  }
  assert.equal(violation("daemon-host", "../src/gate/worktrees-confirm.js", at("test/worktrees-unit.test.ts"), dir), null, "tests may");
  // The composition root (it loads both minters): only the public index, never a handler, binding, gate or helper file.
  assert.equal(violation("daemon-host", "./compose.js", at("src/index.ts"), dir), null);
  assert.equal(violation("daemon-host", "./compose.js", at("src/entry.ts"), dir), null, "the process entry calls composeDaemonHost");
  assert.equal(violation("daemon-host", "../src/compose.js", at("test/compose.test.ts"), dir), null, "tests may");
  for (const [f, spec] of [["src/handlers/projects.ts", "../compose.js"], ["src/compose-parts.ts", "./compose.js"], ["src/bindings/runs.ts", "../compose"], ["src/gate/approvals.ts", "../compose.ts"], ["src/host.ts", "./compose.js"]]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, f);
  }
  // The process entry is a composition point loadable by no staged file (the overlay entry is outside the package).
  for (const [f, spec] of [["src/handlers/worktrees.ts", "../entry.js"], ["src/index.ts", "./entry.js"], ["src/compose.ts", "./entry"], ["src/supervisor.ts", "./entry.ts"], ["src/bindings/runs.ts", "../entry.js"]]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, `${f} -> ${spec}`);
  }
  assert.equal(violation("daemon-host", "../src/entry.js", at("test/entry.test.ts"), dir), null, "tests may");
  // The barrel hop: a handler loading the public index could reach whatever it exports.
  for (const [f, spec] of [["src/handlers/worktrees.ts", "../index.js"], ["src/worktrees/service.ts", "../index"], ["src/gate/approvals.ts", "../index.ts"]]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, f);
  }
  assert.notEqual(violation("runs", "@axis/worktrees/daemon-confirm"), null);
  assert.notEqual(violation("daemon", "@axis/worktrees/daemon-confirm"), null);
  // Runs and review: bindings only.
  for (const spec of ["@axis/runs", "@axis/review"]) {
    assert.equal(violation("daemon-host", spec, at("src/bindings/runs.ts"), dir), null, spec);
    assert.notEqual(violation("daemon-host", spec, at("src/handlers/cliRuns.ts"), dir), null, spec);
    assert.notEqual(violation("daemon-host", spec, at("src/bindings/deep/runs.ts"), dir), null, spec);
    assert.equal(violation("daemon-host", spec, at("test/types/runs-port.test.ts"), dir), null, spec);
    assert.notEqual(violation("daemon-host", spec, at("test/unit.test.ts"), dir), null, spec);
  }
  // Other packages keep their existing rules for the worktrees root.
  assert.equal(violation("daemon", "@axis/worktrees"), null);
});

test("scanner: only the web host listener loads a socket built-in, and only src/web/ loads src/web/ (docs/design/web-host-entry.md)", () => {
  const dir = join(packagesDir, "daemon-host");
  const at = (rel) => join(dir, ...rel.split("/"));
  for (const spec of ["node:http", "node:net", "node:https", "node:http2", "node:tls", "node:dgram"]) {
    assert.equal(violation("daemon-host", spec, at("src/web/server.ts"), dir), null, spec);
    for (const f of ["src/web/session.ts", "src/web/index.ts", "src/entry.ts", "src/supervisor.ts", "src/host.ts", "src/compose.ts"]) assert.notEqual(violation("daemon-host", spec, at(f), dir), null, `${f} ${spec}`);
    assert.notEqual(violation("daemon-host", spec), null, "a call without a file is judged strictly");
    assert.notEqual(violation("git-ops", spec, join(packagesDir, "git-ops", "src", "web", "server.ts"), join(packagesDir, "git-ops")), null, "another package's web/server.ts is not the listener");
    assert.equal(violation("daemon-host", spec, at("test/web-host.test.ts"), dir), null, "tests may");
  }
  for (const [f, spec] of [["src/index.ts", "./web/index.js"], ["src/entry.ts", "./web/server.js"], ["src/compose.ts", "./web/index"], ["src/supervisor.ts", "./web/config.js"], ["src/transport/mux.ts", "../web/session.js"]]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, `${f} -> ${spec}`);
  }
  assert.equal(violation("daemon-host", "./server.js", at("src/web/index.ts"), dir), null);
  assert.equal(violation("daemon-host", "../control/attestation.js", at("src/web/server.ts"), dir), null);
  assert.equal(violation("daemon-host", "../src/web/index.js", at("test/web-host.test.ts"), dir), null, "tests may");
  // The web host is not a composition point: it may not load the composition root, the process entry, the index or a minter.
  for (const spec of ["../compose.js", "../entry.js", "../index.js", "../gate/run-trust.js", "../gate/worktrees-confirm.js"]) assert.notEqual(violation("daemon-host", spec, at("src/web/server.ts"), dir), null, spec);
});
