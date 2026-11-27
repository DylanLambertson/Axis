// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// ADR 0005 D3.4 / ticket X1-lint: renderer-layer overlay code must not import daemon-side packages (@axis/pty-process,
// @axis/daemon-host, ...), the staged packages tree or the overlay's daemon/ folder. Only the contract package @axis/protocol may be
// imported. Renderer files are those in a browser/, common/, electron-browser/, electron-sandbox/ or worker/ folder and the entry
// files at the overlay root (axis.*.main.ts). The overlay ESLint config only runs inside a Code OSS tree, so the rule is enforced
// here as a source import-graph check (a plain TypeScript parse). Limit: an indirect `require` (alias, createRequire) is not seen.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript6";

const OVERLAY = fileURLToPath(new URL("../../code-oss/overlay/src", import.meta.url));
const RENDERER_DIRS = new Set(["browser", "common", "electron-browser", "electron-sandbox", "worker"]);
const ALLOWED_PACKAGES = new Set(["@axis/protocol"]);

/** Every module specifier a file loads: import/export-from, import(), require(), import-equals, import types, reference directives. */
export function specifiers(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const out = [];
  for (const r of [...sf.referencedFiles, ...sf.typeReferenceDirectives, ...sf.libReferenceDirectives]) out.push(r.fileName);
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined) out.push(n.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    else if (ts.isImportTypeNode(n)) out.push(ts.isLiteralTypeNode(n.argument) && ts.isStringLiteralLike(n.argument.literal) ? n.argument.literal.text : "<dynamic>");
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const a = n.arguments[0];
      out.push(a !== undefined && ts.isStringLiteralLike(a) ? a.text : "<dynamic>");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True for files in a renderer layer folder and for the entry files at the overlay root. */
export function isRendererFile(rel) {
  const parts = rel.split(/[\\/]/);
  return /^axis\.[a-z.]+\.main(\.internal)?\.ts$/.test(parts[parts.length - 1]) || parts.slice(0, -1).some((s) => RENDERER_DIRS.has(s));
}

/** True when the specifier, resolved against the importing file, reaches the daemon folder or a package other than protocol (ADR 0005 D3.4: the renderer client may import the staged protocol package only). */
function refusedTarget(rel, spec) {
  const flat = spec.replace(/\\/g, "/").toLowerCase();
  const t = posix.normalize(flat.startsWith(".") ? posix.join(posix.dirname(rel.toLowerCase()), flat) : flat);
  if (/(^|\/)vs\/axis\/daemon(\/|$)/.test(t)) return true;
  const pkg = /(^|\/)packages\/([^/]*)/.exec(t);
  return pkg !== null && pkg[2] !== "protocol";
}

/** The reasons a renderer file's imports are refused (empty when fine). */
export function violations(rel, source) {
  const bad = [];
  for (const s of specifiers(source)) {
    if (s === "<dynamic>") bad.push(`${rel}: non-literal module load`);
    else if (s.startsWith("@axis/") && (!ALLOWED_PACKAGES.has(s.split("/").slice(0, 2).join("/")) || s.split("/").some((x) => x === ".." || x === "."))) bad.push(`${rel}: ${s}`);
    else if (refusedTarget(rel, s)) bad.push(`${rel}: ${s}`);
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

/** Checks every renderer file under `root`: the renderer files seen and the violations found. */
export function checkTree(root) {
  const seen = [];
  const bad = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (!isRendererFile(rel)) continue;
    seen.push(rel);
    bad.push(...violations(rel, readFileSync(file, "utf8")));
  }
  return { seen, bad };
}

test("no renderer-layer overlay file imports a daemon-side package, the packages tree or the daemon folder", () => {
  const { seen, bad } = checkTree(OVERLAY);
  for (const f of ["vs/axis/axis.common.main.ts", "vs/axis/axis.desktop.main.ts", "vs/axis/common/axisView.ts"]) assert.ok(seen.includes(f), `${f} is checked`);
  assert.deepEqual(bad, []);
});

test("the tree walk reports a violating file, in a layer folder and at the root, from a fixture tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-renderer-imports-"));
  try {
    const put = (rel, src) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), src); };
    put("axis/common/ok.ts", "import { z } from '@axis/protocol';\n");
    put("axis/browser/bad.ts", "import { s } from '@axis/pty-process';\n");
    put("axis.desktop.main.ts", "import './x.js'; import '@axis/daemon-host';\n");
    put("axis/daemon/node/main.ts", "import '@axis/daemon-host';\n");
    const { seen, bad } = checkTree(dir);
    assert.deepEqual(seen.sort(), ["axis.desktop.main.ts", "axis/browser/bad.ts", "axis/common/ok.ts"]);
    assert.deepEqual(bad.sort(), ["axis.desktop.main.ts: @axis/daemon-host", "axis/browser/bad.ts: @axis/pty-process"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    "import { a } from '../../../packages/pty-process/x.js';",
    "import { a } from '../../../packages/protocol/../daemon-host/x.js';",
    "import { a } from '..\\\\..\\\\..\\\\packages\\\\pty-process\\\\x.js';",
    "import { a } from '../DAEMON/node/x.js';",
    "import { a } from 'vs/axis/services/../daemon/node/x.js';",
    "/// <reference path=\"../../../packages/pty-process/src/index.ts\" />\nexport {};",
    "type T = import('@axis/pty-process').PtyService;",
    "/// <reference types=\"@axis/pty-process\" />\nexport {};",
    "import { a } from '@axis/protocol/../pty-process';",
  ]) assert.equal(violations(f, src).length, 1, src);
});

test("the contract package and ordinary imports are allowed, and daemon and electron-main files are not renderer files", () => {
  assert.deepEqual(violations("vs/axis/common/x.ts", "import { z } from '@axis/protocol'; import { a } from './b.js'; import { c } from 'vs/base/common/event.js';"), []);
  assert.equal(isRendererFile("vs/axis/daemon/node/axisDaemonMain.ts"), false);
  assert.equal(isRendererFile("vs/axis/code/electron-main/axisMainSeam.ts"), false);
  assert.equal(isRendererFile("vs/axis/common/axisView.ts"), true);
  assert.equal(isRendererFile("vs/axis/services/x/electron-browser/y.ts"), true);
  assert.equal(isRendererFile("vs/axis/axis.common.main.ts"), true);
  assert.equal(isRendererFile("vs/axis/services/x/electron-sandbox/y.ts"), true);
  assert.equal(isRendererFile("vs/axis/services/x/worker/y.ts"), true);
  assert.equal(isRendererFile("vs/axis/daemon/node/main.ts"), false);
});

test("the renderer client may import the staged protocol package and no other package", () => {
  const from = "vs/axis/services/daemon/electron-browser/x.ts";
  assert.deepEqual(violations(from, "import { c } from '../../../packages/protocol/client.js'; import { d } from '../../../packages/protocol/src/index.js';"), []);
  assert.equal(violations(from, "import { c } from '../../../packages/protocol-extra/client.js';").length, 1);
});

test("the renderer daemon client under services/daemon/common is allowed, the daemon folder is refused by resolved path", () => {
  const from = "vs/axis/services/workspaces/common/x.ts";
  assert.deepEqual(violations(from, "import { c } from '../../daemon/common/axisDaemonClient.js'; import { d } from '../../daemon/browser/y.js';"), []);
  assert.equal(violations("vs/axis/browser/x.ts", "import { a } from '../daemon/node/axisDaemonMain.js';").length, 1);
  assert.equal(violations("vs/axis/common/x.ts", "import { a } from '../daemon/common/y.js';").length, 1);
  assert.equal(violations("vs/axis/services/a/common/x.ts", "import { a } from '../../../daemon/node/y.js';").length, 1);
});
