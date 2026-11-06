// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// ADR 0005 D3.4 / ticket X1-lint: renderer-layer overlay code (browser/, common/, electron-browser/) must not import daemon-side
// packages (@axis/pty-process, @axis/daemon-host, ...), the staged packages tree or the overlay's daemon/ folder. Only the contract
// package @axis/protocol may be imported. The overlay ESLint config runs only inside a Code OSS tree, so the rule is enforced here
// as a source import-graph check over the overlay files (a plain TypeScript parse; no Code OSS tree needed).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript6";

const OVERLAY = fileURLToPath(new URL("../../code-oss/overlay/src", import.meta.url));
const RENDERER_DIRS = new Set(["browser", "common", "electron-browser"]);
const ALLOWED_PACKAGES = new Set(["@axis/protocol"]);

/** Every module specifier a file loads: import/export-from, import(), require(), import-equals. */
export function specifiers(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined) out.push(n.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const a = n.arguments[0];
      out.push(a !== undefined && ts.isStringLiteralLike(a) ? a.text : "<dynamic>");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True for files in a renderer layer (a path segment named browser, common or electron-browser). */
export function isRendererFile(rel) {
  return rel.split(/[\\/]/).slice(0, -1).some((s) => RENDERER_DIRS.has(s));
}

/** The reasons a renderer file's imports are refused (empty when fine). */
export function violations(rel, source) {
  const bad = [];
  for (const s of specifiers(source)) {
    if (s === "<dynamic>") bad.push(`${rel}: non-literal module load`);
    else if (s.startsWith("@axis/") && !ALLOWED_PACKAGES.has(s.split("/").slice(0, 2).join("/"))) bad.push(`${rel}: ${s}`);
    else if (/(^|\/)packages\//.test(s) || /(^|\/)vs\/axis\/daemon(\/|$)/.test(s) || /(^|\/)daemon\/(node|common)(\/|$)/.test(s)) bad.push(`${rel}: ${s}`);
  }
  return bad;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) yield p;
  }
}

test("no renderer-layer overlay file imports a daemon-side package, the packages tree or the daemon folder", () => {
  let seen = 0;
  const bad = [];
  for (const file of walk(OVERLAY)) {
    const rel = relative(OVERLAY, file).split(sep).join("/");
    if (!isRendererFile(rel)) continue;
    seen++;
    bad.push(...violations(rel, readFileSync(file, "utf8")));
  }
  assert.ok(seen > 0, "the walk found renderer-layer files");
  assert.deepEqual(bad, []);
});

test("a planted import in a renderer file is refused, in every import form", () => {
  const f = "vs/axis/browser/x.ts";
  assert.equal(isRendererFile(f), true);
  for (const src of [
    "import { createPtyService } from '@axis/pty-process';",
    "import type { X } from '@axis/daemon-host';",
    "export * from '@axis/runs';",
    "import { a } from '@axis/pty-process/testing/helpers.js';",
    "const m = await import('@axis/daemon-host');",
    "const m = require('@axis/vault');",
    "import m = require('@axis/broker');",
    "import { a } from '../../packages/daemon-host/entry.js';",
    "import { a } from '../daemon/node/axisDaemonMain.js';",
    "import { a } from 'vs/axis/daemon/node/x.js';",
    "const m = import(name);",
  ]) assert.equal(violations(f, src).length, 1, src);
});

test("the contract package and ordinary imports are allowed, and daemon and electron-main files are not renderer files", () => {
  assert.deepEqual(violations("vs/axis/common/x.ts", "import { z } from '@axis/protocol'; import { a } from './b.js'; import { c } from 'vs/base/common/event.js';"), []);
  assert.equal(isRendererFile("vs/axis/daemon/node/axisDaemonMain.ts"), false);
  assert.equal(isRendererFile("vs/axis/code/electron-main/axisMainSeam.ts"), false);
  assert.equal(isRendererFile("vs/axis/common/axisView.ts"), true);
  assert.equal(isRendererFile("vs/axis/services/x/electron-browser/y.ts"), true);
});
