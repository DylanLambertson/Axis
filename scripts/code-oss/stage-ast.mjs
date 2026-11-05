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
//   - a non-literal `import()` or `require()`, `require` used as a value, `import.meta` other than `.url`,
//     `.dirname` and `.filename`, triple-slash and AMD directives, and any syntax error (fail closed);
//   - names that reach code without a visible specifier (HIDDEN_NAMES), whether written as an identifier, a property
//     name, a string key (`o["eval"]`) or with unicode escapes (the parser decodes them), and element access with a
//     computed key on `process`, `globalThis`, `global` and `module`;
//   - the Function constructors (`Function`, `AsyncFunction`, ... and `.constructor` reached through a value);
//   - a re-export of a mint module (`daemon-principal`, `daemon-attestation`): `export ... from`, or importing one
//     and exporting what it gave (see mintReexports).
// LIMIT, stated plainly: this is a static check. Calls through the process global or any other indirect form
// (`Reflect.get(globalThis, k)`, a value smuggled through a parameter, native addons) cannot be blocked here. The
// module-graph check on the real bundle and code review of what the daemon package exports are the other layers.
import { posix } from "node:path";
import ts from "typescript6";

const K = ts.SyntaxKind;
const META_OK = new Set(["url", "dirname", "filename"]);

/** Names that reach code or modules without a visible specifier. Packages have no use for any of them. */
export const HIDDEN_NAMES = new Set(["createRequire", "getBuiltinModule", "dlopen", "eval", "mainModule", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]);
const GLOBAL_OBJECTS = new Set(["process", "globalThis", "global", "module"]);
const MODULE_PROPS = new Set(["require", "constructor", "children", "parent", "paths", "_load"]);

/** True for a specifier naming a mint module (the daemon-only principal and attestation minting functions). */
export const isMintModuleSpec = (spec) => /(^|\/)daemon-(?:principal|attestation)(?:\.js)?$/.test(spec);

/**
 * Parses `source` (the extension of `file` selects TypeScript or JavaScript rules) and returns
 * `{ refs, bad }`: `refs` are `{ spec, start, end, kind }` (offsets of the text between the quotes), `bad` are
 * human-readable reasons the file cannot be checked.
 */
export function scanModules(source, file = "x.ts", { vendored = false } = {}) {
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
    if (!vendored) hiddenForms(n);
    ts.forEachChild(n, visit);
  };
  const keyText = (k) => (k !== undefined && (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) ? k.text : null);
  // `(() => {}).constructor`, `f.constructor("code")` and `x.constructor.constructor` build code; `err.constructor.name` does not.
  const strip = (e) => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) ? strip(e.expression) : e);
  const reachesFunctionConstructor = (n) => {
    const recv = strip(n.expression);
    const p = n.parent;
    if (ts.isFunctionExpression(recv) || ts.isArrowFunction(recv) || ts.isClassExpression(recv)) return true;
    if (p !== undefined && ts.isCallExpression(p) && p.expression === n) return true;
    const isCtor = (e) => (ts.isPropertyAccessExpression(e) && e.name.text === "constructor") || (ts.isElementAccessExpression(e) && keyText(e.argumentExpression) === "constructor");
    return isCtor(recv);
  };
  const hiddenForms = (n) => {
    const p = n.parent;
    if (ts.isIdentifier(n) && HIDDEN_NAMES.has(n.text)) bad.push(`${at(n)}: ${n.text} reaches code without a visible import specifier`);
    if (ts.isIdentifier(n) && n.text === "Function" && !(p !== undefined && ts.isTypeReferenceNode(p))) bad.push(`${at(n)}: the Function constructor builds code the import check cannot see`);
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (name === "constructor" && reachesFunctionConstructor(n)) bad.push(`${at(n)}: .constructor reaches the Function constructor`);
      if (n.expression.kind === K.Identifier && n.expression.text === "process" && name === "binding") bad.push(`${at(n)}: process.binding reaches native code`);
      if (n.expression.kind === K.Identifier && n.expression.text === "module" && MODULE_PROPS.has(name)) bad.push(`${at(n)}: module.${name} reaches the module loader`);
    }
    if (ts.isElementAccessExpression(n)) {
      const key = keyText(n.argumentExpression);
      const base = ts.isIdentifier(n.expression) ? n.expression.text : null;
      if (key !== null) {
        if (key === "constructor" && reachesFunctionConstructor(n)) bad.push(`${at(n)}: ["constructor"] reaches the Function constructor`);
        if (HIDDEN_NAMES.has(key) || key === "Function") bad.push(`${at(n)}: ["${key}"] reaches code without a visible import specifier`);
        if (base === "process" && key === "binding") bad.push(`${at(n)}: process["binding"] reaches native code`);
        if (base === "module" && MODULE_PROPS.has(key)) bad.push(`${at(n)}: module["${key}"] reaches the module loader`);
      } else if (base !== null && GLOBAL_OBJECTS.has(base)) {
        bad.push(`${at(n)}: ${base}[...] with a computed key can reach any global or loader`);
      }
    }
  };
  visit(sf);
  if (!vendored) bad.push(...mintReexports(sf, at));
  return { refs, bad };
}

/**
 * `{ vendored: true }` (pinned third-party code, for example zod, which builds validators with `new Function`) keeps
 * the module-loading rules and skips the hidden-name, Function-constructor and mint re-export rules.
 */
/** Every distinct specifier text found in the source (string literals only). */
export function importSpecifiers(source, file = "x.ts") {
  return [...new Set(scanModules(source, file).refs.map((r) => r.spec))];
}

/** Reasons the source cannot be checked: non-literal loads, `require` as a value, `import.meta`, directives, syntax errors. */
export function unsafeForms(source, file = "x.ts", opts) {
  return scanModules(source, file, opts).bad;
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

/**
 * Re-exports of a mint module, found on the syntax tree so no comment or string can hide them. Importing a mint
 * module is restricted to the daemon, and re-exporting it (or what it gave) would hand the minting function to
 * whoever imports the re-exporter, so no file may: neither `export ... from` a mint specifier (any form, type-only
 * included), nor importing one (`import`, `import x = require`) and exporting a binding (`export { x }`,
 * `export default x`, `export = x`, an exported variable whose initializer mentions it outside a function body),
 * nor exporting the result of a dynamic `import()` of one.
 */
function mintReexports(sf, at) {
  const bad = [];
  const bound = new Set();
  const isLiteral = (n) => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const collect = (n) => {
    if (ts.isImportDeclaration(n) && isLiteral(n.moduleSpecifier) && isMintModuleSpec(n.moduleSpecifier.text)) {
      const c = n.importClause;
      if (c?.name) bound.add(c.name.text);
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bound.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) bound.add(e.name.text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isLiteral(n.moduleReference.expression) && isMintModuleSpec(n.moduleReference.expression.text)) {
      bound.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const exported = (n) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === K.ExportKeyword);
  const mentions = (n) => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return false; // a body runs later and is not an export of the binding
    if (ts.isIdentifier(n) && bound.has(n.text)) return true;
    if (n.kind === K.CallExpression && n.expression.kind === K.ImportKeyword && isLiteral(n.arguments[0]) && isMintModuleSpec(n.arguments[0].text)) return true;
    return ts.forEachChild(n, (c) => (mentions(c) ? true : undefined)) === true;
  };
  const visit = (n) => {
    if (ts.isExportDeclaration(n)) {
      if (isLiteral(n.moduleSpecifier) && isMintModuleSpec(n.moduleSpecifier.text)) bad.push(`${at(n)}: re-exports a mint module (${n.moduleSpecifier.text})`);
      else if (n.moduleSpecifier === undefined && n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) if (bound.has((e.propertyName ?? e.name).text)) bad.push(`${at(n)}: exports ${(e.propertyName ?? e.name).text}, which came from a mint module`);
      }
    } else if (ts.isExportAssignment(n) && mentions(n.expression)) {
      bad.push(`${at(n)}: exports a value built from a mint module`);
    } else if (ts.isImportEqualsDeclaration(n) && exported(n) && ts.isExternalModuleReference(n.moduleReference) && isLiteral(n.moduleReference.expression) && isMintModuleSpec(n.moduleReference.expression.text)) {
      bad.push(`${at(n)}: re-exports a mint module (${n.moduleReference.expression.text})`);
    } else if (ts.isVariableStatement(n) && exported(n)) {
      for (const d of n.declarationList.declarations) if (d.initializer !== undefined && mentions(d.initializer)) bad.push(`${at(n)}: exports a value built from a mint module`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}
