// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The source rules of the pty process's CLI messaging endpoint listener (web-rules.mjs rule 1; ADR 0007 decision 7.1;
// PV-M6 slice 2), on the TypeScript AST that stage-ast.mjs parses, so comments, strings, templates and regular expressions
// are told from code exactly. `scanModules` applies them to `pty-process/endpoint-host.ts` only, so the import lint, the
// staging hook and the staged-tree check all judge the file the same way.
//
// A WHITELIST TEMPLATE (review 2): the file may use the server only in the shapes listed here; anything else is refused,
// whatever it would do.
//   - node:net: exactly the named value `createServer` (type imports aside), under its own name; no default or namespace
//     import, no other value (`connect`, `createConnection`, `Socket`: node:net also opens outbound TCP); modules are loaded
//     by static import only (no `import()`, `require`, `import =`).
//   - Exports: only what the file declares (no `export ... from`, no `export *`, no export of an imported binding).
//   - The server: `createServer` called exactly once, its result bound to a const declared once; that const appears ONLY as
//     the receiver of a direct call of a method named literally in SERVER_METHODS (`server.listen(...)`, `server.on(...)`):
//     never passed, returned, stored, spread, destructured, aliased or read any other way, so no reflection can reach it.
//   - `.listen`: called exactly once in the file, on the server, as an expression statement of a block, after no `return`,
//     `throw`, `break` or `continue` in that block; its first argument a name declared exactly once in the whole file, in any
//     scope and of any kind, as a const initialised by `join(...)`, with `join` imported once from node:path under its own
//     name. A numeric `join` result (`join("80" + "80")`) is not excluded here: the file refuses a non-absolute or numeric
//     path at run time, a gate line of its own (`docs/design/net-gate.md`).
//   - No constant condition anywhere (`if (false)`, `0 ? :`, `true && ...`): dead code cannot hold the allowed listen while
//     something else runs.
//   - Never named: Reflect, Object, Function, eval, globalThis, process, require, module, exports, import.meta; no `enum`,
//     `namespace`/`module`, `declare` or `class`; no computed property access; no identifier written with escapes; no
//     `port`/`host` key; no host, loopback or wildcard address literal.
// LIMIT, stated plainly: a static check of one file. The bundle graph keeps the file out of the desktop bundles
// (web-rules.mjs listenerReachViolations); review covers what the pty process does with it.
import ts from "typescript6";

const K = ts.SyntaxKind;
const ADDRESS = /^(?:0\.0\.0\.0|127\.\d+\.\d+\.\d+|localhost|::|::1|\[::1?\]|::ffff:[0-9a-f.:]*)$/i;
/** What the server const may be the receiver of, each only as a direct call. */
export const SERVER_METHODS = new Set(["listen", "on", "once", "close", "unref", "ref", "address"]);
/** Names the endpoint file never mentions: each reaches objects or code the whitelist could not follow. */
export const ENDPOINT_FORBIDDEN = new Set(["Reflect", "Object", "Function", "eval", "globalThis", "process", "require", "module", "exports"]);
const text = (n) => (n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);

/** The names a binding name declares (an identifier, or every name in an object or array pattern). */
function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const e of name.elements) if (ts.isBindingElement(e)) bindingNames(e.name, out);
  return out;
}

/** A condition that is a constant (a literal, `undefined`, `void x`, or `!` / parentheses around one). */
function constant(n) {
  while (n !== undefined && (ts.isParenthesizedExpression(n) || (ts.isPrefixUnaryExpression(n) && n.operator === K.ExclamationToken))) n = ts.isParenthesizedExpression(n) ? n.expression : n.operand;
  if (n === undefined) return false;
  return [K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.NumericLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.BigIntLiteral].includes(n.kind) || ts.isVoidExpression(n) || (ts.isIdentifier(n) && n.text === "undefined");
}

/** Reasons `sf` (the endpoint listener file) breaks the rules above; `at(n)` names a node's line. */
export function endpointForms(sf, at) {
  const bad = [];
  /** Every declaration of every name in the file, of any kind and in any scope. */
  const decls = new Map();
  const declare = (id, node) => decls.set(id.text, [...(decls.get(id.text) ?? []), node]);
  const imported = new Set();
  let createServer = null;
  let join = null;
  const listens = [];

  const visit = (n) => {
    if (ts.isImportDeclaration(n)) {
      const spec = text(n.moduleSpecifier);
      const c = n.importClause;
      if (c !== undefined && !c.isTypeOnly) {
        if (c.name !== undefined) (declare(c.name, n), imported.add(c.name.text));
        const nb = c.namedBindings;
        if (nb !== undefined && ts.isNamespaceImport(nb)) (declare(nb.name, n), imported.add(nb.name.text));
        if (nb !== undefined && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) (declare(e.name, e), imported.add(e.name.text));
        if (spec === "node:net") {
          if (c.name !== undefined || (nb !== undefined && !ts.isNamedImports(nb))) bad.push(`${at(n)}: node:net is imported by name only (no default or namespace import)`);
          for (const e of nb !== undefined && ts.isNamedImports(nb) ? nb.elements : []) {
            if (e.isTypeOnly) continue;
            if ((e.propertyName ?? e.name).text !== "createServer" || e.propertyName !== undefined) bad.push(`${at(e)}: only createServer, under its own name, may be taken from node:net (it also opens outbound TCP)`);
            else createServer = e.name.text;
          }
        }
        if (spec === "node:path" && nb !== undefined && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly && e.name.text === "join" && e.propertyName === undefined) join = "join";
      }
    }
    if (ts.isExportDeclaration(n) && (n.moduleSpecifier !== undefined || n.exportClause === undefined)) bad.push(`${at(n)}: the endpoint file re-exports nothing (no export ... from, no export *)`);
    if (ts.isExportSpecifier(n) && imported.has((n.propertyName ?? n.name).text)) bad.push(`${at(n)}: ${(n.propertyName ?? n.name).text} is imported: the endpoint file exports only what it declares`);
    if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression) && imported.has(n.expression.text)) bad.push(`${at(n)}: ${n.expression.text} is imported: the endpoint file exports only what it declares`);
    if (ts.isImportEqualsDeclaration(n) || (ts.isCallExpression(n) && n.expression.kind === K.ImportKeyword)) bad.push(`${at(n)}: the endpoint file loads modules only by static import`);
    if (ts.isMetaProperty(n)) bad.push(`${at(n)}: import.meta is not used in the endpoint file`);
    if (ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) bad.push(`${at(n)}: no enum, namespace, module or class in the endpoint file`);
    if (ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === K.DeclareKeyword)) bad.push(`${at(n)}: no declare in the endpoint file`);
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) for (const id of bindingNames(n.name, [])) declare(id, n);
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isEnumDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name !== undefined) declare(n.name, n);
    if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) declare(n.name, n);
    if (ts.isIdentifier(n) && n.getText(sf) !== n.text) bad.push(`${at(n)}: an identifier written with escapes`);
    if (ts.isIdentifier(n) && ENDPOINT_FORBIDDEN.has(n.text)) bad.push(`${at(n)}: ${n.text} is never named in the endpoint file`);
    if (ts.isElementAccessExpression(n)) {
      const key = text(n.argumentExpression);
      if (key === null && !ts.isNumericLiteral(n.argumentExpression)) bad.push(`${at(n)}: computed property access is not allowed in the endpoint file`);
      else if (key === "listen") bad.push(`${at(n)}: listen is called only as .listen(<path>)`);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "listen") listens.push(n);
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isBindingElement(n) || ts.isMethodDeclaration(n)) && ((n.propertyName ?? n.name)?.text ?? "") === "listen") bad.push(`${at(n)}: listen is called only as .listen(<path>)`);
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isEnumMember(n)) && ["port", "host"].includes(ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : "")) bad.push(`${at(n)}: a ${n.name.text} key: the endpoint listens on a path only`);
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ADDRESS.test(n.text)) bad.push(`${at(n)}: a host, loopback or wildcard address`);
    // Dead code: no constant condition anywhere.
    const cond = ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) ? n.expression : ts.isConditionalExpression(n) ? n.condition : ts.isForStatement(n) ? n.condition : undefined;
    if (constant(cond)) bad.push(`${at(n)}: a constant condition (dead code could hold the allowed listen)`);
    if (ts.isBinaryExpression(n) && [K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken].includes(n.operatorToken.kind) && (constant(n.left) || constant(n.right))) bad.push(`${at(n)}: a constant operand of ${ts.tokenToString(n.operatorToken.kind)}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // createServer: called, nothing else, exactly once, its result bound to a const declared once.
  const refs = (name) => {
    const out = [];
    const walk = (n) => {
      if (ts.isIdentifier(n) && n.text === name) out.push(n);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return out;
  };
  let server = null;
  let creates = 0;
  for (const u of createServer === null ? [] : refs(createServer)) {
    if (ts.isImportSpecifier(u.parent)) continue;
    const call = u.parent;
    const holder = ts.isCallExpression(call) && call.expression === u ? call.parent : undefined;
    if (holder === undefined || !ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name) || (holder.parent.flags & ts.NodeFlags.Const) === 0) {
      bad.push(`${at(u)}: createServer is only called, its result bound to a const`);
      continue;
    }
    creates += 1;
    server = holder.name.text;
  }
  if (createServer !== null && creates !== 1) bad.push(`${at(sf)}: createServer is called exactly once in the endpoint file (found ${creates})`);
  if (server !== null && (decls.get(server) ?? []).length !== 1) bad.push(`${at(sf)}: ${server} (the server) is declared more than once`);
  // The server const: only `server.<method in SERVER_METHODS>(...)`, a direct call. Nothing else can receive it.
  for (const r of server === null ? [] : refs(server)) {
    const p = r.parent;
    if (ts.isVariableDeclaration(p) && p.name === r) continue; // its own declaration
    const access = ts.isPropertyAccessExpression(p) && p.expression === r ? p : undefined;
    const called = access !== undefined && ts.isCallExpression(access.parent) && access.parent.expression === access;
    if (!called || !SERVER_METHODS.has(access.name.text)) bad.push(`${at(r)}: the server is used only as server.<${[...SERVER_METHODS].join("|")}>(...)`);
  }

  // listen: exactly once, on the server, in a block, not after a jump, with a path const declared once and made by join.
  if (createServer !== null && listens.length !== 1) bad.push(`${at(sf)}: .listen is called exactly once in the endpoint file (found ${listens.length})`);
  for (const l of listens) {
    const call = l.parent;
    if (!ts.isCallExpression(call) || call.expression !== l || !ts.isIdentifier(l.expression) || l.expression.text !== server) {
      bad.push(`${at(l)}: .listen is only called, on the one createServer result`);
      continue;
    }
    const stmt = call.parent;
    const block = stmt?.parent;
    if (!ts.isExpressionStatement(stmt) || block === undefined || !ts.isBlock(block)) bad.push(`${at(l)}: .listen(...) is a statement of its own in a block`);
    else {
      const before = block.statements.slice(0, block.statements.indexOf(stmt));
      if (before.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s))) bad.push(`${at(l)}: .listen(...) follows a return, throw, break or continue (dead code)`);
    }
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isIdentifier(arg)) {
      bad.push(`${at(l)}: .listen's first argument is a path const (never a port, a host or an options object)`);
      continue;
    }
    const ds = decls.get(arg.text) ?? [];
    const d = ds[0];
    const fromJoin = ds.length === 1 && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && (d.parent.flags & ts.NodeFlags.Const) !== 0 && d.initializer !== undefined && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "join";
    if (!fromJoin) bad.push(`${at(l)}: .listen(${arg.text}): the argument is not a const declared once in the file and initialised by join(...)`);
    else if (join === null || (decls.get("join") ?? []).length !== 1) bad.push(`${at(l)}: join must be imported once from node:path, under its own name, and declared nowhere else`);
  }
  return bad;
}
