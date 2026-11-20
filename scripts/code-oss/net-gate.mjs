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

/**
 * ALLOWLIST (reviewed): the only bare (non-relative) module specifiers an overlay file may load, `node:` prefix ignored.
 * Relative specifiers are Axis or upstream code and are judged by WEB_SPEC. Anything else, a socket module or a server
 * package included, is a violation until it is named here after review.
 */
export const ALLOWED_BARE = new Set(["assert", "crypto", "electron", "fs", "os", "path", "url", "util", "vscode"]);
/** Reviewed per-file exceptions (overlay path relative to the repository root -> extra bare specifiers). */
export const FILE_ALLOW = new Map([
  ["code-oss/overlay/src/vs/axis/pty/node/axisPtyMain.ts", new Set(["node-pty"])],
  ["code-oss/overlay/src/vs/axis/services/workspaces/test/node/axisDiscoveryDisk.test.ts", new Set(["child_process"])],
]);
/** Reviewed files that call an element of an array of functions (`shapes[i](...)`): a member chosen at run time is refused elsewhere. */
export const ELEMENT_CALL_ALLOW = new Set(["code-oss/overlay/src/vs/axis/services/workspaces/common/axisSampleRuns.ts"]);
/** Specifier fragments that name the web host, the reh server or the staged web directory. */
const WEB_SPEC = /daemon-host\/(?:web|index)|\/web\/(?:index|server)|vs\/server\/|serverMain|server-main|reh-web|ipc\.net/;
/** Text that enables a debugging port or an inspector (case-insensitive). */
const DEBUG_TEXT = /(?:^|[\s"'`=])--?(?:inspect|debug)|remote-debugging/i;
const LISTEN_TEXT = /\b(?:startWebHost|createServer|createWebHost)\b|\.listen\s*\(/;
/** Names that load modules or reach built-ins by a route the specifier check cannot see. */
const LOADER_NAMES = new Set(["require", "createRequire", "getBuiltinModule", "binding", "_linkedBinding", "dlopen"]);
/** Called names (also as a string element access) that start a listener. */
const LISTENER_CALLS = new Set(["listen", "createServer", "startWebHost", "createWebHost"]);
/** Patches allowed to name debugging flags, because their purpose is to refuse them (none yet: see the design doc). */
export const FLAG_REFUSAL_PATCHES = new Set();

const bare = (spec) => !spec.startsWith(".") && !spec.startsWith("/");
const normal = (spec) => spec.replace(/^node:/, "").replace(/\/.*$/, "");
/** Why `spec`, loaded by overlay file `file`, is refused, or null. */
function specRefusal(spec, file) {
  if (WEB_SPEC.test(spec)) return `loads ${spec}: the web host, the reh server and the daemon-host index are not for desktop code`;
  if (bare(spec) && !ALLOWED_BARE.has(normal(spec)) && !(FILE_ALLOW.get(file)?.has(normal(spec)) ?? false)) {
    return `loads ${spec}, which is not on the reviewed allowlist (net-gate.mjs ALLOWED_BARE / FILE_ALLOW)`;
  }
  return null;
}

/** Violations in one overlay source text. `file` is the repository-relative path (it selects FILE_ALLOW) and labels them. */
export function scanOverlaySource(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = [];
  const add = (node, text) => out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  const spec = (node, value) => {
    const why = specRefusal(value, file);
    if (why !== null) add(node, why);
  };
  /** The literal text of a `+` chain of strings (non-literal operands dropped), or null when the node is not one. */
  const joined = (node) => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return joined(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = joined(node.left);
      const r = joined(node.right);
      return l === null && r === null ? null : `${l ?? ""}${r ?? ""}`;
    }
    return null;
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) spec(node, node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) spec(node, node.moduleReference.expression.text);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg !== undefined && ts.isStringLiteralLike(arg)) spec(node, arg.text);
        else add(node, "loads a module by a computed name");
      }
      if (ts.isElementAccessExpression(callee)) {
        const key = callee.argumentExpression;
        if (!ts.isStringLiteralLike(key)) { if (!ELEMENT_CALL_ALLOW.has(file)) add(node, "calls a member chosen at run time"); }
        else if (LISTENER_CALLS.has(key.text)) add(node, `calls ${key.text}`);
      }
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (LISTENER_CALLS.has(name)) add(node, `calls ${name}`);
      if (name === "open" && /inspector/i.test(callee.getText(sf))) add(node, "calls inspector.open");
    } else if (ts.isIdentifier(node) && LOADER_NAMES.has(node.text) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      add(node, `uses ${node.text}, a route to built-ins the import check cannot see`);
    } else if (ts.isIdentifier(node) && node.text === "startWebHost") add(node, "names startWebHost");
    // String text: judged once per outermost string chain, concatenations joined, so a split flag is still seen.
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
      const outer = ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
      const text = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((x) => x.literal.text).join("") : joined(node);
      if (!outer && text !== null && DEBUG_TEXT.test(` ${text}`)) add(node, `names a debugging flag (${JSON.stringify(text.slice(0, 40))})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The lines a unified diff adds, with their 1-based line in the patch. Hunks are tracked by their `@@` counts, so only the
 * file header lines before a hunk are headers: an added line that itself starts with `++` is content. A hunk header that
 * does not parse is reported (`bad`), never skipped.
 */
export function addedLines(text) {
  const added = [];
  const bad = [];
  let oldLeft = 0;
  let newLeft = 0;
  text.split("\n").forEach((line, i) => {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) { newLeft--; added.push({ line: i + 1, text: line.slice(1) }); }
      else if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith(" ") || line === "") { oldLeft--; newLeft--; }
      return;
    }
    if (!line.startsWith("@@")) return;
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (m === null) bad.push({ line: i + 1, text: line });
    else { oldLeft = m[1] === undefined ? 1 : Number(m[1]); newLeft = m[2] === undefined ? 1 : Number(m[2]); }
  });
  return { added, bad };
}

/** The same rules as the source scan, as text rules for one added line (a diff fragment is not parseable on its own). */
export function scanAddedLine(added) {
  const text = added.replace(/['"`]\s*\+\s*['"`]/g, "");
  const imports = [...text.matchAll(/(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (LISTEN_TEXT.test(text) || /\[\s*['"](?:listen|createServer)['"]\s*\]/.test(text)) return "starts a listener";
  if (/\[[^\]'"]*\]\s*\(/.test(text) && !/^\s*(?:\/\/|\*)/.test(text)) return "calls a member chosen at run time";
  if (DEBUG_TEXT.test(text)) return "names a debugging flag";
  if (/\brequire\s*\(|\b(?:createRequire|getBuiltinModule|_linkedBinding|dlopen)\b|\bbinding\s*\(/.test(text)) return "uses a loader route the import check cannot see";
  for (const spec of imports) {
    const why = specRefusal(spec, "");
    if (why !== null && !/^(?:\.|\/)/.test(spec) && !/^vs\//.test(spec)) return why;
    if (WEB_SPEC.test(spec)) return `loads ${spec}`;
  }
  return null;
}

/** Violations in the lines one patch adds. */
export function scanPatchText(text, file) {
  const { added, bad } = addedLines(text);
  const out = bad.map((b) => ({ file, line: b.line, text: "has a hunk header that does not parse: the patch cannot be checked" }));
  const flagsAllowed = FLAG_REFUSAL_PATCHES.has(file);
  for (const { line, text: content } of added) {
    const why = scanAddedLine(content);
    if (why === null || (flagsAllowed && why === "names a debugging flag")) continue;
    out.push({ file, line, text: `adds ${JSON.stringify(content.trim().slice(0, 80))}: ${why}` });
  }
  return out;
}

const isOverlaySource = (name) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name);

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
      else if (isOverlaySource(path)) {
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
