// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Module references found by parsing (ADR 0005 D3.1). The staging hook, the verify step and
// test/packages/imports.test.mjs all call this one scanner, so they cannot disagree about what a file imports.
//
// The file is parsed with the TypeScript parser (the `typescript6` dev dependency: TypeScript 7 ships no JavaScript
// parser API), which tells code from comments, strings, templates and regular expressions exactly. Every form that
// can name a module is a syntax node:
//   import ... from "x"            import "x"             import x = require("x")
//   export ... from "x"            import("x")            require("x")             import("x").T (a type)
// A reference is accepted for classification only when its specifier is a string literal (or a template without
// substitutions). Everything else that can load or locate a module is reported in `bad`, which callers refuse:
// a non-literal `import()` or `require()`, `require` used as a value, `import.meta` other than `.url`, `.dirname`
// and `.filename`, triple-slash and AMD directives, and any syntax error (fail closed).
import { posix } from "node:path";
import ts from "typescript6";

const K = ts.SyntaxKind;
const META_OK = new Set(["url", "dirname", "filename"]);

/**
 * Parses `source` (the extension of `file` selects TypeScript or JavaScript rules) and returns
 * `{ refs, bad }`: `refs` are `{ spec, start, end, kind }` (offsets of the text between the quotes), `bad` are
 * human-readable reasons the file cannot be checked.
 */
export function scanModules(source, file = "x.ts") {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const refs = [];
  const bad = [];
  const isLiteral = (n) => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const add = (n, kind) => refs.push({ spec: n.text, start: n.getStart(sf) + 1, end: n.getEnd() - 1, kind });
  const at = (n) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  for (const d of sf.parseDiagnostics ?? []) bad.push(`syntax error at line ${(d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line) + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  if (sf.referencedFiles.length + sf.typeReferenceDirectives.length + sf.libReferenceDirectives.length + sf.amdDependencies.length > 0) {
    bad.push("a triple-slash or AMD directive names a file or module outside the import check");
  }

  const visit = (n) => {
    if (n.kind === K.ImportDeclaration || n.kind === K.ExportDeclaration) {
      if (n.moduleSpecifier !== undefined) {
        if (isLiteral(n.moduleSpecifier)) add(n.moduleSpecifier, n.kind === K.ImportDeclaration ? "import" : "export-from");
        else bad.push(`${at(n)}: module specifier is not a string literal`);
      }
    } else if (n.kind === K.ImportEqualsDeclaration && ts.isExternalModuleReference(n.moduleReference)) {
      if (isLiteral(n.moduleReference.expression)) add(n.moduleReference.expression, "import-equals");
      else bad.push(`${at(n)}: require() specifier is not a string literal`);
    } else if (n.kind === K.ImportType) {
      if (ts.isLiteralTypeNode(n.argument) && isLiteral(n.argument.literal)) add(n.argument.literal, "import-type");
      else bad.push(`${at(n)}: import type argument is not a string literal`);
    } else if (n.kind === K.CallExpression) {
      const callee = n.expression;
      if (callee.kind === K.ImportKeyword) {
        if (n.arguments.length >= 1 && n.arguments.length <= 2 && isLiteral(n.arguments[0])) add(n.arguments[0], "dynamic-import");
        else bad.push(`${at(n)}: import() needs a single string literal specifier`);
      } else if (ts.isIdentifier(callee) && callee.text === "require") {
        if (n.arguments.length === 1 && isLiteral(n.arguments[0])) add(n.arguments[0], "require");
        else bad.push(`${at(n)}: require() needs a single string literal specifier`);
      }
    } else if (n.kind === K.MetaProperty && n.keywordToken === K.ImportKeyword) {
      const p = n.parent;
      if (!(ts.isPropertyAccessExpression(p) && p.expression === n && META_OK.has(p.name.text))) bad.push(`${at(n)}: import.meta can reach modules (only .url, .dirname and .filename are allowed)`);
    } else if (ts.isIdentifier(n) && n.text === "require") {
      const p = n.parent;
      const calledHere = ts.isCallExpression(p) && p.expression === n;
      const propertyName = (ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isShorthandPropertyAssignment(p)) && p.name === n && !ts.isShorthandPropertyAssignment(p));
      if (!calledHere && !propertyName) bad.push(`${at(n)}: require used as a value hides a load from the import check`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { refs, bad };
}

/** Every distinct specifier text found in the source (string literals only). */
export function importSpecifiers(source, file = "x.ts") {
  return [...new Set(scanModules(source, file).refs.map((r) => r.spec))];
}

/** Reasons the source cannot be checked: non-literal loads, `require` as a value, `import.meta`, directives, syntax errors. */
export function nonLiteralLoads(source, file = "x.ts") {
  return scanModules(source, file).bad;
}

/**
 * Rewrites package specifiers to relative paths. `resolveSpec(spec)` returns the staged path (tree-relative, posix)
 * or null to leave the specifier alone. Comments are not code and are left as written.
 */
export function rewriteSpecifiers(source, fromFile, resolveSpec) {
  let out = "";
  let at = 0;
  for (const { spec, start, end } of scanModules(source, fromFile).refs.sort((a, b) => a.start - b.start)) {
    const target = resolveSpec(spec);
    if (target === null) continue;
    let rel = posix.relative(posix.dirname(fromFile), target);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    out += source.slice(at, start) + rel;
    at = end;
  }
  return out + source.slice(at);
}

/** Number of `#name` private-name tokens (declarations and uses) in JavaScript or TypeScript text. */
export function privateNameCount(source, file = "x.ts") {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node) => {
    if (node.kind === K.PrivateIdentifier) n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}
