// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rebrand readiness (docs/design/rebrand-readiness.md) for the own shell: the product name appears in code only in
// packages/ui/src/brand.ts and colour literals only in packages/ui/src/tokens.ts. Scanned: the desktop app's main,
// preload and renderer, and the renderer packages' src. TypeScript is read with the compiler's parser (strings,
// templates and JSX text; comments never count); HTML and CSS with their comments removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript6";
import { appDir } from "../scripts/bundle.mjs";

const repo = join(appDir, "..", "..");
const BRAND_FILE = "packages/ui/src/brand.ts";
const TOKENS_FILE = "packages/ui/src/tokens.ts";
const ROOTS = ["apps/desktop/main", "apps/desktop/preload", "apps/desktop/renderer", ...["shell-core", "shell-sdk", "ui", "ui-editor"].map((p) => `packages/${p}/src`)];
const NAME = /\bAxis\b/;
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** The user-visible text of a TypeScript source: every string, template part and JSX text. */
export function tsTexts(source, file = "a.tsx") {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** HTML and CSS without their comments. */
export function markupText(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function problems(rel, source) {
  const ext = extname(rel);
  const texts = [".ts", ".tsx"].includes(ext) ? tsTexts(source, rel) : [markupText(source)];
  const found = [];
  if (rel !== BRAND_FILE && texts.some((t) => NAME.test(t))) found.push(`${rel}: the product name outside ${BRAND_FILE}`);
  if (rel !== TOKENS_FILE && texts.some((t) => COLOUR.test(t))) found.push(`${rel}: a colour literal outside ${TOKENS_FILE}`);
  return found;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* walk(join(dir, e.name));
    else if ([".ts", ".tsx", ".html", ".css"].includes(extname(e.name))) yield join(dir, e.name);
  }
}

test("the product name only in the brand module, colours only in the tokens module", () => {
  const files = ROOTS.flatMap((r) => [...walk(join(repo, r))]);
  assert.ok(files.length >= 10, "the scan reaches the sources");
  const rels = files.map((f) => relative(repo, f).split("\\").join("/"));
  assert.ok(rels.includes(BRAND_FILE) && rels.includes(TOKENS_FILE) && rels.includes("apps/desktop/renderer/shell.css"));
  assert.deepEqual(files.flatMap((f) => problems(relative(repo, f).split("\\").join("/"), readFileSync(f, "utf8"))), []);
});

test("the scanner: strings, templates and JSX text count; comments and identifiers do not", () => {
  assert.deepEqual(problems("x.tsx", 'const t = "Axis";'), ["x.tsx: the product name outside packages/ui/src/brand.ts"]);
  assert.equal(problems("x.tsx", "const t = `in ${a} Axis`;").length, 1);
  assert.equal(problems("x.tsx", "const t = `Axis ${a}`;").length, 1);
  assert.equal(problems("x.tsx", "const e = <h1>Axis</h1>;").length, 1);
  assert.equal(problems("x.tsx", "const e = <h1 title='Axis' />;").length, 1);
  assert.deepEqual(problems("x.ts", "// Axis #fff\n/* rgb(0,0,0) */ const axisShell = 1;"), []);
  assert.deepEqual(problems("x.ts", 'const c = "axis-shell";'), []);
  assert.deepEqual(problems(BRAND_FILE, 'const n = "Axis";'), []);
  for (const c of ["#fff", "#5823F6", "#5823F680", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "hsl(1 2% 3%)", "oklch(0.5 0.1 200)"]) {
    assert.deepEqual(problems("x.ts", `const c = "${c}";`), ["x.ts: a colour literal outside packages/ui/src/tokens.ts"], c);
  }
  assert.deepEqual(problems(TOKENS_FILE, 'const c = "#5823F6";'), []);
});

test("the scanner: HTML and CSS are read without their comments", () => {
  assert.equal(problems("a.css", ".a { color: #fff; }").length, 1);
  assert.equal(problems("a.css", ".a { color: rgb(0 0 0); }").length, 1);
  assert.deepEqual(problems("a.css", "/* #fff Axis */ .axis-a { color: var(--axis-text); }"), []);
  assert.equal(problems("a.html", "<title>Axis</title>").length, 1);
  assert.deepEqual(problems("a.html", "<!-- Axis --><div id=\"root\"></div>"), []);
});
