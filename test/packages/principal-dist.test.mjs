// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Scans the EMITTED JavaScript (packages/*/dist), after `npm run build`, for the same hazards the source scan covers.
// This stands in for a bundle-time check (an esbuild metafile) until the daemon bundle exists: it looks at what is
// actually shipped, so an import the TypeScript scan could not see (generated code, a path the compiler rewrote)
// still shows up. `npm test` builds before it runs this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PRINCIPAL_SUBPATH, isScriptFile } from "./loaders.mjs";
import { unsafeForms } from "../../scripts/code-oss/stage-ast.mjs";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));
/** The only package whose emitted code may import the principal subpath: the daemon's connection layer. */
const MAY_MINT = new Set(["daemon"]);
const PRINCIPAL_FILES = ["src/principal.js", "src/daemon-principal.js"];

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") yield* jsFiles(p);
    } else if (isScriptFile(p)) yield p;
  }
}

/** Every import and re-export specifier in emitted ESM: static, `export ... from`, side-effect and dynamic with a literal. */
export function emittedSpecifiers(source) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1]);
  return found;
}

/** Why `spec`, imported by `file` in package `pkg`, is not allowed, or null. */
export function distViolation(pkg, file, spec) {
  if (spec === PRINCIPAL_SUBPATH || spec.startsWith(`${PRINCIPAL_SUBPATH}/`)) {
    return MAY_MINT.has(pkg) ? null : "only the daemon package may import the user-principal subpath";
  }
  if (spec.startsWith("@axis/journal/")) return "deep imports into @axis/journal are not allowed";
  if ((spec.startsWith("./") || spec.startsWith("../")) && pkg !== "journal") {
    const target = resolve(dirname(file), spec);
    const journal = join(packagesDir, "journal", "dist");
    for (const f of PRINCIPAL_FILES) {
      if (relative(join(journal, f), target) === "") return "reaches into the journal's principal module by path";
    }
  }
  return null;
}

const packages = readdirSync(packagesDir).filter((n) => existsSync(join(packagesDir, n, "dist")));

test("the emitted code is built (run `npm run build` first)", { skip: packages.length > 0 ? false : "no packages/*/dist yet" }, () => {
  assert.ok(packages.includes("journal"));
});

for (const pkg of packages) {
  test(`${pkg}: emitted code does not import, re-export or reach the user principal, and hides no loader`, () => {
    const bad = [];
    for (const file of jsFiles(join(packagesDir, pkg, "dist"))) {
      const source = readFileSync(file, "utf8");
      for (const spec of emittedSpecifiers(source)) {
        const why = distViolation(pkg, file, spec);
        if (why) bad.push(`${relative(packagesDir, file)}: ${spec} (${why})`);
      }
      for (const why of unsafeForms(source, file)) bad.push(`${relative(packagesDir, file)}: ${why}`);
    }
    assert.deepEqual(bad, []);
  });
}

test("dist scanner: specifiers, the principal subpath, relative reaches and loaders", () => {
  const journalFile = join(packagesDir, "journal", "dist", "src", "daemon-principal.js");
  assert.deepEqual(
    emittedSpecifiers('import a from "zod";\nexport * from "./x.js";\nexport { b } from "@axis/audit";\nimport "./y.js";\nconst c = await import("@axis/protocol");').sort(),
    ["./x.js", "./y.js", "@axis/audit", "@axis/protocol", "zod"],
  );
  assert.equal(distViolation("daemon", "/x/daemon/dist/a.js", PRINCIPAL_SUBPATH), null);
  assert.notEqual(distViolation("providers", "/x/providers/dist/a.js", PRINCIPAL_SUBPATH), null);
  assert.notEqual(distViolation("daemon", "/x/daemon/dist/a.js", "@axis/journal/dist/src/principal.js"), null);
  const fromDaemon = join(packagesDir, "daemon", "dist", "src", "a.js");
  assert.notEqual(distViolation("daemon", fromDaemon, "../../../journal/dist/src/daemon-principal.js"), null);
  assert.equal(distViolation("journal", journalFile, "./principal.js"), null);
  assert.equal(distViolation("daemon", fromDaemon, "./local.js"), null);
});
