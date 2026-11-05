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

/**
 * The only properties staged code may read directly off the process and global objects. Any other use of these
 * names (an alias, an argument, a cast, a computed key, a property outside this list such as `binding`,
 * `_linkedBinding` or `mainModule`) is refused: the structural rule is "a direct read of a known-safe property".
 */
const PROCESS_SAFE = new Set(["platform", "env", "stdout", "stderr", "stdin", "execPath", "getuid", "getgid", "geteuid", "pid", "ppid", "kill", "on", "once", "off", "removeListener", "listenerCount", "eventNames", "memoryUsage", "exit", "exitCode", "cwd", "argv", "umask", "chdir", "hrtime", "cpuUsage", "uptime", "arch", "version", "versions", "getActiveResourcesInfo", "parentPort", "emitWarning", "nextTick"]);
const GLOBAL_SAFE = new Set(["fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "structuredClone", "queueMicrotask", "AbortController", "AbortSignal", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "performance"]);
const GUARDED = new Map([["process", PROCESS_SAFE], ["globalThis", GLOBAL_SAFE], ["global", GLOBAL_SAFE], ["module", new Set()]]);

/** Packages that hold a mint symbol in a module named principal, attestation or lock. */
const MINT_HOLDER_PACKAGES = new Set(["journal", "runs", "audit"]);
/** Mint functions: the only things that turn a private symbol into a principal or an attestation. Calls only. */
export const MINT_FUNCTIONS = new Set(["mintUserPrincipal", "mintTrustAttestation"]);
/** Every name under which a mint function is reachable (the holder-module functions and the daemon-only wrappers). */
const MINT_NAMES = new Set([...MINT_FUNCTIONS, "userPrincipal", "attestTrust"]);
/** The only files that may import a mint function from a holder module: the daemon entry files of the holder packages. */
const DAEMON_ENTRY_FILE = /(^|[\\/])daemon-(?:principal|attestation)\.[mc]?[jt]s$/;

/** True for a specifier naming a mint module (the daemon-only principal and attestation minting functions). */
export const isMintModuleSpec = (spec) => /(^|\/)daemon-(?:principal|attestation)(?:\.js)?$/.test(spec);

/**
 * Parses `source` (the extension of `file` selects TypeScript or JavaScript rules) and returns
 * `{ refs, bad }`: `refs` are `{ spec, start, end, kind }` (offsets of the text between the quotes), `bad` are
 * human-readable reasons the file cannot be checked.
 */
export function scanModules(source, file = "x.ts", { vendored = false, shipped = true, pkg = null } = {}) {
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
  const inType = (n) => {
    for (let a = n.parent; a !== undefined; a = a.parent) if (ts.isTypeNode(a) && !ts.isExpressionWithTypeArguments(a)) return true;
    return false;
  };
  const isNamePosition = (n) => {
    const p = n.parent;
    if (p === undefined) return false;
    if (ts.isBindingElement(p) && p.propertyName === n) return true;
    return p.name === n && !ts.isShorthandPropertyAssignment(p);
  };
  const hiddenForms = (n) => {
    const p = n.parent;
    if (ts.isIdentifier(n) && HIDDEN_NAMES.has(n.text)) bad.push(`${at(n)}: ${n.text} reaches code without a visible import specifier`);
    if (ts.isIdentifier(n) && n.text === "Function" && !inType(n)) bad.push(`${at(n)}: the Function constructor builds code the import check cannot see`);
    // `.constructor` reaches the Function constructor from any function value: only `x.constructor.name` and a write are allowed.
    const ctorRead = (ts.isPropertyAccessExpression(n) && n.name.text === "constructor") || (ts.isElementAccessExpression(n) && keyText(n.argumentExpression) === "constructor");
    if (ctorRead && shipped) {
      const isName = p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === "name";
      const isWrite = p !== undefined && ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === K.EqualsToken;
      if (!isName && !isWrite) bad.push(`${at(n)}: .constructor read reaches the Function constructor (only .constructor.name is allowed)`);
    }
    if (ts.isElementAccessExpression(n)) {
      const key = keyText(n.argumentExpression);
      if (key !== null && (HIDDEN_NAMES.has(key) || key === "Function")) bad.push(`${at(n)}: ["${key}"] reaches code without a visible import specifier`);
    }
    // Reflect.get / getOwnPropertyDescriptor(s) with the constant key "constructor", and assignment destructuring of it.
    if (shipped && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["get", "getOwnPropertyDescriptor"].includes(n.expression.name.text) && ts.isIdentifier(n.expression.expression) && ["Reflect", "Object"].includes(n.expression.expression.text) && keyText(n.arguments[1]) === "constructor") {
      bad.push(`${at(n)}: reading "constructor" through ${n.expression.expression.text}.${n.expression.name.text} reaches the Function constructor`);
    }
    if (shipped && (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name.text === "constructor" && ts.isObjectLiteralExpression(n.parent) && ts.isBinaryExpression(n.parent.parent) && n.parent.parent.left === n.parent) {
      bad.push(`${at(n)}: destructuring assignment of constructor reaches the Function constructor`);
    }
    if (shipped && ts.isCallExpression(n) && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && keyText(n.arguments[0]) === "node:worker_threads") {
      bad.push(`${at(n)}: node:worker_threads is imported statically, with only MessageChannel and MessagePort`);
    }
    if (shipped && ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined && keyText(n.moduleSpecifier) === "node:worker_threads") {
      bad.push(`${at(n)}: node:worker_threads is never re-exported`);
    }
    if (shipped && ts.isBindingElement(n) && (n.propertyName ?? n.name).text === "constructor") bad.push(`${at(n)}: destructuring constructor reaches the Function constructor`);
    // process, globalThis, global and module: only a direct read of a known-safe property.
    if (shipped && ts.isIdentifier(n) && GUARDED.has(n.text) && !isNamePosition(n) && !inType(n)) {
      const safe = GUARDED.get(n.text);
      const key = p !== undefined && ts.isElementAccessExpression(p) && p.expression === n ? keyText(p.argumentExpression) : null;
      const ok = (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n && safe.has(p.name.text))
        || (key !== null && safe.has(key))
        || (p !== undefined && ts.isTypeOfExpression(p));
      if (!ok) {
        const computed = p !== undefined && ts.isElementAccessExpression(p) && p.expression === n && key === null;
        bad.push(`${at(n)}: ${n.text}${computed ? "[...] with a computed key can reach any global or loader" : " used other than as a direct read of a known-safe property (an alias, argument, cast or unlisted property can reach loaders)"}`);
      }
    }
    // Only MessageChannel and MessagePort may be taken from node:worker_threads (Worker would run code from a string or data: URL).
    if (shipped && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === "node:worker_threads") {
      const nb = n.importClause?.namedBindings;
      const names = nb !== undefined && ts.isNamedImports(nb) ? nb.elements.map((e) => (e.propertyName ?? e.name).text) : null;
      if (n.importClause?.name !== undefined || names === null || names.some((x) => x !== "MessageChannel" && x !== "MessagePort")) bad.push(`${at(n)}: only MessageChannel and MessagePort may be imported from node:worker_threads`);
    }
  };
  visit(sf);
  if (!vendored) bad.push(...mintUses(sf, at, !shipped, pkg, file));
  return { refs, bad };
}

/** Every distinct specifier text found in the source (string literals only). */
export function importSpecifiers(source, file = "x.ts") {
  return [...new Set(scanModules(source, file).refs.map((r) => r.spec))];
}

/**
 * Reasons the source cannot be checked or must be refused: non-literal loads, `require` as a value, `import.meta`,
 * directives, syntax errors, hidden names, Function constructors and the mint rules. `{ vendored: true }` (pinned
 * third-party code such as zod, which builds validators with `new Function`) keeps only the module-loading rules.
 */
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
 * Mint rules, structural and per file (a chain through several files needs no tracking, because every file obeys them):
 *   1. The raw symbols never leave their module: no file imports or exports a binding named `MINT`.
 *   2. A mint function (anything imported from a `daemon-principal` or `daemon-attestation` module, and
 *      `mintUserPrincipal` / `mintTrustAttestation` wherever imported) may appear only as the callee of a call (or
 *      `ns.fn(...)` for a namespace import) or in a type position. An assignment, argument, return, property value,
 *      spread, export, alias, `export import x = ns.fn` or class field holding it is refused, so it cannot be
 *      forwarded, stored or re-exported. Test files are exempt from this rule only (they introspect).
 *   3. No `export ... from` a mint module; no `export *` or `export * as` from a module holding a mint symbol
 *      (`principal`, `attestation`, `lock`); no `export { mintUserPrincipal | mintTrustAttestation } from`.
 *   4. No dynamic `import()` or `require()` of a mint module.
 */
function mintUses(sf, at, testFile, pkg, file) {
  const inHolderPackage = pkg === null || MINT_HOLDER_PACKAGES.has(pkg);
  const bad = [];
  const bound = new Set();
  const namespaces = new Set(); // bindings of a whole module: `ns.fn(...)` is a call of fn, `fn.bind(...)` is not
  const isLiteral = (n) => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
  const holder = (spec) => /^\.\.?\/(?:.*\/)?(?:principal|attestation|lock)(?:\.js)?$/.test(spec);
  const specOf = (e) => (isLiteral(e) ? e.text : null);
  const collect = (n) => {
    if (ts.isImportDeclaration(n) && isLiteral(n.moduleSpecifier)) {
      const mint = isMintModuleSpec(n.moduleSpecifier.text);
      const c = n.importClause;
      if (mint && c?.name) bound.add(c.name.text);
      if (holder(n.moduleSpecifier.text) && inHolderPackage && c !== undefined && (c.name !== undefined || (c.namedBindings !== undefined && ts.isNamespaceImport(c.namedBindings)))) {
        bad.push(`${at(n)}: a default or namespace import of ${n.moduleSpecifier.text} would carry its mint function out of the module (import the names you need)`);
      }
      const nb = c?.namedBindings;
      if (mint && nb && ts.isNamespaceImport(nb)) {
        bound.add(nb.name.text);
        namespaces.add(nb.name.text);
      }
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) {
          const imported = (e.propertyName ?? e.name).text;
          if (imported === "MINT") bad.push(`${at(e)}: the raw mint symbol is never exported, so it cannot be imported`);
          if (mint || MINT_FUNCTIONS.has(imported)) bound.add(e.name.text);
          if (MINT_FUNCTIONS.has(imported) && !testFile && !DAEMON_ENTRY_FILE.test(file)) bad.push(`${at(e)}: ${imported} may be imported only by the daemon-principal and daemon-attestation entry files`);
        }
      }
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isMintModuleSpec(specOf(n.moduleReference.expression) ?? "")) {
      bound.add(n.name.text);
      namespaces.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const exportedName = (n) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === K.ExportKeyword);
  const calleeOf = (n) => {
    const p = n.parent;
    return p !== undefined && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n;
  };
  const inType = (n) => {
    for (let a = n.parent; a !== undefined; a = a.parent) if (ts.isTypeNode(a) && !ts.isExpressionWithTypeArguments(a)) return true;
    return false;
  };
  const visit = (n) => {
    if (ts.isExportDeclaration(n)) {
      const spec = specOf(n.moduleSpecifier);
      if (spec !== null && isMintModuleSpec(spec) && !n.isTypeOnly && !(n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.every((e) => e.isTypeOnly))) bad.push(`${at(n)}: re-exports a mint module (${spec})`);
      if (spec !== null && holder(spec) && inHolderPackage && (n.exportClause === undefined || ts.isNamespaceExport(n.exportClause))) bad.push(`${at(n)}: export * from ${spec} would re-export the module's mint symbol`);
      if (n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) {
          const names = [(e.propertyName ?? e.name).text, e.name.text];
          if (names.includes("MINT")) bad.push(`${at(e)}: the raw mint symbol is never exported`);
          if (spec !== null && names.some((x) => MINT_FUNCTIONS.has(x))) bad.push(`${at(e)}: a mint function is never re-exported`);
        }
      }
    } else if ((ts.isVariableStatement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && exportedName(n)) {
      const names = ts.isVariableStatement(n) ? n.declarationList.declarations.map((d) => d.name.getText(sf)) : [n.name?.text];
      if (names.includes("MINT")) bad.push(`${at(n)}: the raw mint symbol is never exported`);
    } else if (ts.isCallExpression(n) && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && isLiteral(n.arguments[0]) && isMintModuleSpec(n.arguments[0].text)) {
      bad.push(`${at(n)}: a mint module is imported statically only`);
    } else if (ts.isCallExpression(n) && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && isLiteral(n.arguments[0]) && holder(n.arguments[0].text) && inHolderPackage && !testFile) {
      bad.push(`${at(n)}: a holder module is imported statically, by name, only`);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && exportedName(n) && isMintModuleSpec(specOf(n.moduleReference.expression) ?? "")) {
      bad.push(`${at(n)}: re-exports a mint module`);
    } else if (!testFile && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && MINT_NAMES.has(ts.isPropertyAccessExpression(n) ? n.name.text : (isLiteral(n.argumentExpression) ? n.argumentExpression.text : "")) && !calleeOf(n)) {
      bad.push(`${at(n)}: a mint function reached through a property may only be called`);
    } else if (!testFile && ts.isIdentifier(n) && bound.has(n.text)) {
      const p = n.parent;
      const declaration = p !== undefined && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || (ts.isImportEqualsDeclaration(p) && p.name === n));
      const propertyName = p !== undefined && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertyDeclaration(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n));
      const viaNamespace = namespaces.has(n.text) && p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n && calleeOf(p);
      if (!declaration && !propertyName && !inType(n) && !calleeOf(n) && !viaNamespace) {
        bad.push(`${at(n)}: ${n.text} comes from a mint module and may only be called, never stored, passed, returned or exported`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}
