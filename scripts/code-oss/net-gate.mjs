// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The static half of ticket NET-GATE (docs/design/net-gate.md, gates 1a/L29 and L33, residual RR-19): no Axis-owned desktop
// code path can open a listener, start the web host or enable a debugging port. It reads the overlay sources
// (code-oss/overlay/src) and the lines the patch series adds (code-oss/patches), with the TypeScript parser for sources, and
// reports violations as { file, line, text }. The staged packages are covered by web-rules.mjs; this covers the files
// that rule cannot see. Usage: node scripts/code-oss/net-gate.mjs [--root <repo root>]  (exit 1 on any violation)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { LISTENER_BUILTINS } from "./web-rules.mjs";

/** Modules that open a socket or an inspector, with and without the `node:` prefix. */
const SOCKET_MODULES = new Set([...LISTENER_BUILTINS, "node:inspector", "node:inspector/promises", "node:dns"].flatMap((m) => [m, m.slice(5)]));
/** Specifier fragments that name the web host, the reh server or the staged web directory. */
const WEB_SPEC = /daemon-host\/(?:web|index)|\/web\/(?:index|server)|vs\/server\/|serverMain|server-main|reh-web/;
/** Text that enables a debugging port or an inspector. */
const DEBUG_TEXT = /(?:^|[\s"'`=])--?(?:inspect|debug)|remote-debugging/;
const LISTEN_TEXT = /\b(?:startWebHost|createServer|createWebHost)\b|\.listen\s*\(/;
/** Patches allowed to name debugging flags, because their purpose is to refuse them (none yet: see the design doc). */
export const FLAG_REFUSAL_PATCHES = new Set();

export const PATCH_FORBIDDEN = new RegExp(
  `${LISTEN_TEXT.source}|${DEBUG_TEXT.source}|daemon-host/web|startWebHost|node:(?:net|http|https|http2|tls|dgram|inspector|dns)\\b|from ['"](?:net|http|https|http2|tls|dgram|inspector|dns)['"]`
);

/** Violations in one overlay source text. `file` is only used to label them. */
export function scanOverlaySource(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = [];
  const add = (node, text) => out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  const spec = (node, value) => {
    if (SOCKET_MODULES.has(value)) add(node, `loads ${value}, which opens sockets or an inspector`);
    else if (WEB_SPEC.test(value)) add(node, `loads ${value}: the web host, the reh server and the daemon-host index are not for desktop code`);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) spec(node, node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) spec(node, node.moduleReference.expression.text);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      const isLoader = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      if (isLoader) {
        if (arg !== undefined && ts.isStringLiteralLike(arg)) spec(node, arg.text);
        else add(node, "loads a module by a computed name");
      }
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name === "listen" || name === "createServer" || name === "startWebHost" || name === "open" && /inspector/i.test(callee.getText(sf))) add(node, `calls ${name}`);
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = ts.isTemplateExpression(node) ? node.head.text : node.text;
      if (DEBUG_TEXT.test(` ${text}`) && !ts.isImportDeclaration(node.parent)) add(node, `names a debugging flag (${JSON.stringify(text.slice(0, 40))})`);
    } else if (ts.isIdentifier(node) && node.text === "startWebHost" && !ts.isCallExpression(node.parent)) add(node, "names startWebHost");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Violations in the lines one patch adds (a `+` line outside the file header). */
export function scanPatchText(text, file) {
  const out = [];
  const lines = text.split("\n");
  const flagsAllowed = FLAG_REFUSAL_PATCHES.has(file);
  lines.forEach((line, i) => {
    if (!line.startsWith("+") || line.startsWith("+++")) return;
    const added = line.slice(1);
    if (flagsAllowed && DEBUG_TEXT.test(added) && !LISTEN_TEXT.test(added)) return;
    if (PATCH_FORBIDDEN.test(added)) out.push({ file, line: i + 1, text: `adds ${JSON.stringify(added.trim().slice(0, 80))}` });
  });
  return out;
}

const isOverlaySource = (name) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name);
const isTest = (rel) => /(?:^|\/)test\//.test(rel) || /\.test\.[cm]?[tj]s$/.test(rel);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push({ path, link: true });
    else if (entry.isDirectory()) out.push(...walk(path));
    else out.push({ path });
  }
  return out;
}

/** The whole static check for a repository root. A missing overlay or patch directory is itself a violation (fail closed). */
export function checkNetGate(root) {
  const out = [];
  const overlay = join(root, "code-oss", "overlay", "src");
  const patches = join(root, "code-oss", "patches");
  let scanned = 0;
  for (const [dir, what] of [[overlay, "overlay sources"], [patches, "patch series"]]) {
    if (!existsSync(dir)) out.push({ file: relative(root, dir), line: 0, text: `${what} directory is missing: nothing was checked` });
  }
  if (existsSync(overlay)) {
    for (const { path, link } of walk(overlay)) {
      const rel = relative(root, path);
      if (link) out.push({ file: rel, line: 0, text: "is a symbolic link: the scan does not follow links" });
      else if (isOverlaySource(path) && !isTest(relative(overlay, path))) {
        scanned++;
        out.push(...scanOverlaySource(readFileSync(path, "utf8"), rel));
      }
    }
    if (scanned === 0) out.push({ file: relative(root, overlay), line: 0, text: "holds no source files: nothing was checked" });
  }
  if (existsSync(patches)) {
    for (const name of readdirSync(patches).filter((n) => n.endsWith(".patch")).sort()) {
      out.push(...scanPatchText(readFileSync(join(patches, name), "utf8"), name));
    }
  }
  out.push(...checkWebHostGuards(root));
  return out;
}

/** Guards on the daemon-host side: the web host starts only for `enabled: true`, and nothing outside src/web names startWebHost. */
export function checkWebHostGuards(root) {
  const out = [];
  const src = join(root, "packages", "daemon-host", "src");
  const config = join(src, "web", "config.ts");
  if (!existsSync(config)) return [{ file: relative(root, config), line: 0, text: "web host config is missing" }];
  const text = readFileSync(config, "utf8");
  if (!/enabled:\s*z\.literal\(true\)/.test(text)) out.push({ file: relative(root, config), line: 0, text: "the web host configuration no longer requires enabled: true" });
  if (/enabled:\s*z\.literal\(true\)\s*\.(?:default|optional|catch)/.test(text) || /export const DEFAULT_WEB_(?:HOST|CONFIG)\b/.test(text)) out.push({ file: relative(root, config), line: 0, text: "the web host configuration has a default that could start it" });
  for (const { path } of walk(src)) {
    const rel = relative(root, path);
    if (!/\.ts$/.test(path) || rel.startsWith(join("packages", "daemon-host", "src", "web") + "/")) continue;
    readFileSync(path, "utf8").split("\n").forEach((l, i) => {
      if (/\b(?:startWebHost|from\s+["'][^"']*\/web\/)/.test(l)) out.push({ file: rel, line: i + 1, text: "names the web host outside src/web" });
    });
  }
  return out;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const violations = checkNetGate(root);
  for (const v of violations) console.error(`net-gate: ${v.file}${v.line > 0 ? `:${v.line}` : ""}: ${v.text}`);
  console.log(violations.length === 0 ? "net-gate (static): ok" : `net-gate (static): ${violations.length} violation(s)`);
  process.exit(violations.length === 0 ? 0 : 1);
}
