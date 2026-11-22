// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// The source rules of the pty process's CLI messaging endpoint listener (web-rules.mjs rule 1; ADR 0007 decision 7.1;
// PV-M6 slice 2), on the TypeScript AST that stage-ast.mjs parses, so comments, strings, templates and regular expressions
// are told from code exactly. `scanModules` applies them to `pty-process/endpoint-host.ts` only, so the import lint, the
// staging hook and the staged-tree check all judge the file the same way. The file:
//   - takes from node:net exactly the named value `createServer` (type imports aside): no default or namespace import, no
//     alias, no `connect`, `createConnection` or `Socket` value (node:net also opens outbound TCP), no dynamic import or
//     require of it;
//   - exports only what it declares itself: no `export ... from`, no `export *`, no export of an imported binding, so the
//     capability cannot be re-exported to another file;
//   - calls `createServer` exactly once, its result bound to a const that is declared once, and calls `.listen` exactly once,
//     on that const, with a first argument that is a const declared once in the file and initialised by `join(...)`, with
//     `join` imported once from node:path (a path: never a port, a host or an options object; the runtime check that the
//     path is absolute and not numeric is in the file itself, PV-M6 review);
//   - names `listen` nowhere else (no other property, no computed access at all, no identifier written with escapes);
//   - holds no `port` or `host` key and no host, loopback or wildcard address literal.
// LIMIT, stated plainly: a static check of one file. The bundle graph keeps the file out of the desktop bundles
// (web-rules.mjs listenerReachViolations); review covers what the pty process does with it.
import ts from "typescript6";

const K = ts.SyntaxKind;
const ADDRESS = /^(?:0\.0\.0\.0|127\.\d+\.\d+\.\d+|localhost|::|::1|\[::1?\]|::ffff:[0-9a-f.:]*)$/i;
const text = (n) => (n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);

/** The names a binding name declares (an identifier, or every name in an object or array pattern). */
function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const e of name.elements) if (ts.isBindingElement(e)) bindingNames(e.name, out);
  return out;
}

/** Reasons `sf` (the endpoint listener file) breaks the rules above; `at(n)` names a node's line. */
export function endpointForms(sf, at) {
  const bad = [];
  /** Every declaration of every name in the file. */
  const decls = new Map();
  const declare = (id, node) => decls.set(id.text, [...(decls.get(id.text) ?? []), node]);
  const imported = new Set();
  let createServer = null;
  let join = null;
  const creates = [];
  const listens = [];

  const visit = (n) => {
    const p = n.parent;
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
    if (ts.isImportEqualsDeclaration(n) || (ts.isCallExpression(n) && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")))) {
      bad.push(`${at(n)}: the endpoint file loads modules only by static import`);
    }
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
      if (!ts.isBindingElement(n)) for (const id of bindingNames(n.name, [])) declare(id, n);
    }
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name !== undefined) declare(n.name, n);
    if (ts.isIdentifier(n) && n.getText(sf) !== n.text) bad.push(`${at(n)}: an identifier written with escapes`);
    if (ts.isElementAccessExpression(n)) {
      const key = text(n.argumentExpression);
      if (key === null && !ts.isNumericLiteral(n.argumentExpression)) bad.push(`${at(n)}: computed property access is not allowed in the endpoint file`);
      else if (key === "listen") bad.push(`${at(n)}: listen is called only as .listen(<path>)`);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "listen") listens.push(n);
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isBindingElement(n)) && ["listen"].includes(((n.propertyName ?? n.name)?.text) ?? "")) bad.push(`${at(n)}: listen is called only as .listen(<path>)`);
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ["port", "host"].includes(ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : "")) bad.push(`${at(n)}: a ${n.name.text} option: the endpoint listens on a path only`);
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ADDRESS.test(n.text)) bad.push(`${at(n)}: a host, loopback or wildcard address`);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // createServer: called, nothing else, exactly once, its result bound to a const declared once.
  const uses = [];
  const collect = (n) => {
    if (ts.isIdentifier(n) && n.text === createServer && !ts.isImportSpecifier(n.parent)) uses.push(n);
    ts.forEachChild(n, collect);
  };
  if (createServer !== null) collect(sf);
  let server = null;
  for (const u of uses) {
    const call = u.parent;
    const holder = ts.isCallExpression(call) && call.expression === u ? call.parent : undefined;
    if (holder === undefined || !ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name) || (holder.parent.flags & ts.NodeFlags.Const) === 0) {
      bad.push(`${at(u)}: createServer is only called, its result bound to a const`);
      continue;
    }
    creates.push(holder);
    server = holder.name.text;
  }
  if (createServer !== null && creates.length !== 1) bad.push(`${at(sf)}: createServer is called exactly once in the endpoint file (found ${creates.length})`);
  if (server !== null && (decls.get(server) ?? []).length !== 1) bad.push(`${at(sf)}: ${server} (the server) is declared more than once`);

  // listen: exactly one `.listen(<path const>)` on that server.
  if (createServer !== null && listens.length !== 1) bad.push(`${at(sf)}: .listen is called exactly once in the endpoint file (found ${listens.length})`);
  for (const l of listens) {
    const call = l.parent;
    if (!ts.isCallExpression(call) || call.expression !== l || !ts.isIdentifier(l.expression) || l.expression.text !== server) {
      bad.push(`${at(l)}: .listen is only called, on the one createServer result`);
      continue;
    }
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isIdentifier(arg)) {
      bad.push(`${at(l)}: .listen's first argument is a path const (never a port, a host or an options object)`);
      continue;
    }
    const ds = decls.get(arg.text) ?? [];
    const d = ds[0];
    const fromJoin = ds.length === 1 && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && (d.parent.flags & ts.NodeFlags.Const) !== 0 && d.initializer !== undefined && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "join";
    if (!fromJoin) bad.push(`${at(l)}: .listen(${arg.text}): the argument is not a const declared once and initialised by join(...)`);
    else if (join === null || (decls.get("join") ?? []).length !== 1) bad.push(`${at(l)}: join must be imported once from node:path, under its own name, and declared nowhere else`);
  }
  return bad;
}
