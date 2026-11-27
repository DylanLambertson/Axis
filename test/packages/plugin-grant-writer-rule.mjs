// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// PV-K2 K2-g3 (docs/design/plugin-grant-contract.md section 8.4): the static half of "no second writer of plugin grants". The
// runtime locks are the guarantee (a single-use token that only the serving journal's mint makes, and that mint taken once by
// the host composition); these rules catch ordinary mistakes in the product source, with the type checker:
//
// - call sites: any access, element access or destructuring of a callable member named `grant`, `setEnabled` or
//   `takeGrantMint`, whatever type the receiver is given (a union, a container, a structural view, a generic), unless the file
//   is allowed for that member, the receiver is the grant action, or it is `setEnabled(…, false)` (a decrease);
// - the store passed to a function not declared in the grant action;
// - values whose type is the token (`PluginGrantWrite`), a function returning one, or the grant action (`GrantAction`), only in
//   the files that make, carry or use them, so a grant laundered through another type is still seen (every grant needs a token);
// - `takeGrantMint()` only in the composition, as the direct argument of `createGrantAction(`; `createGrantAction(` only there;
// - `plugins/grant-action.ts` exports exactly one value, so no wrapper can forward the mint or a token;
// - construction: `Journal.open` and the storage port's `openDatabase` only in the host; the audit package's `openDatabase` only
//   in the node storage; `new PluginGrantRecords` only in the journal.
//
// What a static rule cannot see (an `any` cast, a name built at run time) is the reviewed boundary the design records.
import ts from "typescript6";
import { relative, sep } from "node:path";

export const FILES = Object.freeze({
  store: "packages/journal/src/plugin-grant-store.ts",
  journal: "packages/journal/src/journal.ts",
  action: "packages/daemon-host/src/plugins/grant-action.ts",
  compose: "packages/daemon-host/src/compose-serving.ts",
  handler: "packages/daemon-host/src/handlers/plugins.ts",
  host: "packages/daemon-host/src/host.ts",
  nodeStorage: "packages/daemon-host/src/storage/node-storage.ts",
  auditDb: "packages/audit/src/db.ts",
  // The CLI endpoint switch (PV-M7 slice 2): the same single-use-token pattern, its own store, action and handler.
  switchStore: "packages/journal/src/cli-endpoint-store.ts",
  switchAction: "packages/daemon-host/src/messages/cli-endpoint-action.ts",
  switchHandler: "packages/daemon-host/src/handlers/messages-switch.ts",
});

/** Who may use each member of the grant store. */
const MEMBER_FILES = new Map([
  ["grant", new Set([FILES.store, FILES.action])],
  ["setEnabled", new Set([FILES.store, FILES.action, FILES.handler])],
  ["takeGrantMint", new Set([FILES.store, FILES.compose])],
  // Switching on only through the approved enable action; switching off only in the disable handler; the mint only in the composition.
  ["switchOn", new Set([FILES.switchStore, FILES.switchAction])],
  ["switchOff", new Set([FILES.switchStore, FILES.switchHandler])],
  ["takeSwitchMint", new Set([FILES.switchStore, FILES.compose])],
]);
/** Who may hold a token or a mint, and who may hold the grant action. */
const TOKEN_FILES = new Set([FILES.store, FILES.action]);
const ACTION_FILES = new Set([FILES.action, FILES.compose, FILES.handler]);
/** Each guarded store: its token type, its action type, the files that may hold each, its action file and its mint. */
const GUARDED = Object.freeze([
  { store: "PluginGrantRecords", storeFile: FILES.store, token: "PluginGrantWrite", tokenFiles: TOKEN_FILES, action: "GrantAction", actionFile: FILES.action, actionFiles: ACTION_FILES, mint: "takeGrantMint", create: "createGrantAction" },
  {
    store: "CliEndpointSwitchRecords",
    storeFile: FILES.switchStore,
    token: "CliEndpointSwitchWrite",
    tokenFiles: new Set([FILES.switchStore, FILES.switchAction]),
    action: "CliEndpointSwitchAction",
    actionFile: FILES.switchAction,
    actionFiles: new Set([FILES.switchAction, FILES.compose, FILES.switchHandler]),
    mint: "takeSwitchMint",
    create: "createCliEndpointSwitchAction",
  },
]);
const BY_MINT = new Map(GUARDED.map((g) => [g.mint, g]));

const isNamed = (type, name) => {
  if (type === undefined) return false;
  if (type.isUnion?.()) return type.types.some((t) => isNamed(t, name));
  return type.getSymbol?.()?.getName() === name || type.aliasSymbol?.getName() === name;
};
const returnsNamed = (type, name) => {
  if (type === undefined) return false;
  if (type.isUnion?.()) return type.types.some((t) => returnsNamed(t, name));
  return type.getCallSignatures().some((s) => isNamed(s.getReturnType(), name) || returnsNamed(s.getReturnType(), name));
};

/**
 * Every breach of the rules in the program's checked files. `root` is the repository root; `checked(rel)` decides which files
 * (repository-relative, `/`-separated) are product source to check.
 */
export function grantWriterProblems(program, root, checked) {
  const checker = program.getTypeChecker();
  const out = [];
  const relOf = (sf) => relative(root, sf.fileName).split(sep).join("/");
  const declFile = (sym) => {
    const decl = sym?.declarations?.[0];
    return decl === undefined ? undefined : relOf(decl.getSourceFile());
  };
  const symbolOf = (node) => {
    const s = checker.getSymbolAtLocation(node);
    return s !== undefined && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = relOf(sf);
    if (!checked(rel)) continue;
    const at = (node, what) => out.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`);
    const atNode = at;
    /** The guarded store `expr` may be, or undefined. */
    const storeOf = (expr) => GUARDED.find((g) => isNamed(checker.getTypeAtLocation(expr), g.store));
    const isStore = (expr) => storeOf(expr) !== undefined;
    const knownOther = (_checker, expr) => knownOtherType(checker, checker.getTypeAtLocation(expr), relOf);
    // A destructured member: the pattern's source type is checked like a receiver.
    const destructured = (type, key, at) => {
      if (knownOtherType(checker, type, relOf)) return;
      const name = key === undefined ? undefined : ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (name === undefined) {
        if (STORE_INCREASES.some((n) => callableMemberOf(checker, type, n, at))) atNode(at, "a computed member destructured from a value that may be the grant store");
      } else if (MEMBER_FILES.has(name) && callableMemberOf(checker, type, name, at) && !MEMBER_FILES.get(name).has(rel)) atNode(at, `${name} destructured from a value that may be the grant store`);
    };
    // An assignment pattern ({ grant: g } = x, [{ grant }] = xs, nested): walked against the type assigned to it.
    const assignmentPattern = (pattern, type) => {
      if (ts.isObjectLiteralExpression(pattern)) {
        for (const prop of pattern.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) destructured(type, prop.name, prop);
          else if (ts.isPropertyAssignment(prop)) {
            destructured(type, ts.isComputedPropertyName(prop.name) ? undefined : prop.name, prop);
            const inner = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? checker.getPropertyOfType(checker.getNonNullableType(type), prop.name.text) : undefined;
            const target = ts.isBinaryExpression(prop.initializer) ? prop.initializer.left : prop.initializer;
            if (inner !== undefined && (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target))) assignmentPattern(target, checker.getTypeOfSymbolAtLocation(inner, prop));
          }
        }
      } else if (ts.isArrayLiteralExpression(pattern)) {
        const element = elementTypeOf(checker, type);
        for (const el of pattern.elements) {
          const target = ts.isBinaryExpression(el) ? el.left : el;
          if (element !== undefined && (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target))) assignmentPattern(target, element);
        }
      }
    };
    const actionOf = GUARDED.find((g) => g.actionFile === rel);
    if (actionOf !== undefined) {
      let values = 0;
      for (const st of sf.statements) {
        const exported = ts.getCombinedModifierFlags?.(st) & ts.ModifierFlags.Export || st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st))) values++;
        if (exported && ts.isVariableStatement(st)) values += st.declarationList.declarations.length;
        if (ts.isExportDeclaration(st) && !st.isTypeOnly) values += st.exportClause === undefined ? 1 : ts.isNamedExports(st.exportClause) ? st.exportClause.elements.filter((e) => !e.isTypeOnly).length : 1;
        if (ts.isExportAssignment(st)) values++;
      }
      if (values !== 1) at(sf, `${rel.slice(rel.lastIndexOf("/") + 1)} must export exactly one value (found ${values})`);
    }
    const visit = (node) => {
      // Call sites (review K2-g3 round 2): outside the files allowed for each, ANY access, element access or destructuring of a
      // callable member named grant, setEnabled or takeGrantMint is refused, whatever type the receiver is given, unless the
      // receiver is a known type that is not the store (the grant action) or it is setEnabled(..., false), a decrease.
      if (ts.isPropertyAccessExpression(node) && MEMBER_FILES.has(node.name.text) && callableMember(checker, node.expression, node.name.text) && !knownOther(checker, node.expression) && !isDecrease(node)) {
        if (!MEMBER_FILES.get(node.name.text).has(rel)) at(node, `${node.name.text} on a value that may be the grant store`);
      }
      if (ts.isElementAccessExpression(node) && rel !== FILES.store && !knownOther(checker, node.expression)) {
        const key = node.argumentExpression;
        const literal = ts.isStringLiteralLike(key) ? key.text : undefined;
        if (literal === undefined) {
          if (STORE_INCREASES.some((n) => callableMember(checker, node.expression, n))) at(node, "a computed member of a value that may be the grant store");
        } else if (MEMBER_FILES.has(literal) && callableMember(checker, node.expression, literal) && !MEMBER_FILES.get(literal).has(rel)) at(node, `${literal} on a value that may be the grant store`);
      }
      // Destructuring in every position (review K2-g3 round 3): a binding pattern wherever it appears (a const, a parameter, a
      // for-of, nested in another pattern), checked against the type it destructures; and assignment patterns.
      if (ts.isObjectBindingPattern(node)) {
        const type = checker.getTypeAtLocation(node);
        for (const el of node.elements) destructured(type, el.propertyName ?? (el.dotDotDotToken === undefined ? el.name : undefined) ?? (ts.isIdentifier(el.name) ? el.name : undefined), el);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left))) {
        assignmentPattern(node.left, checker.getTypeAtLocation(node.right));
      }
      if (ts.isForOfStatement(node) && (ts.isObjectLiteralExpression(node.initializer) || ts.isArrayLiteralExpression(node.initializer))) {
        const element = elementTypeOf(checker, checker.getTypeAtLocation(node.expression));
        if (element !== undefined) assignmentPattern(node.initializer, element);
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments !== undefined) {
        const calleeFile = declFile(symbolOf(ts.isCallExpression(node) ? node.expression : node.expression));
        for (const arg of node.arguments) {
          const g = storeOf(arg);
          if (g !== undefined && calleeFile !== g.actionFile && rel !== g.storeFile && rel !== FILES.journal) at(arg, `the ${g.store} passed to a function outside its action`);
        }
      }
      // Tokens, mints and the actions, wherever a value of their type is declared, read or made: by property access, by element
      // access with a literal or computed key (review switch-contract 1 S1: `d["action"]`, `d[k]`, `d?.["action"]`), and through a
      // cast to their type (N4). Only an `any` cast stays outside what a static rule sees (the reviewed boundary).
      const read = ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
      if (read || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isBindingElement(node)) {
        const target = read ? node : node.name;
        const type = checker.getTypeAtLocation(target);
        for (const g of GUARDED) {
          if ((isNamed(type, g.token) || returnsNamed(type, g.token)) && !g.tokenFiles.has(rel)) {
            // The one allowed taking of the mint: `takeGrantMint()` / `takeSwitchMint()` (and its member reference) in the composition.
            const taking = (ts.isCallExpression(node) && isTakeMint(node) === g.mint) || (ts.isPropertyAccessExpression(node) && node.name.text === g.mint);
            if (!(rel === FILES.compose && taking)) at(node, `a ${g.token} token or mint`);
          }
          if (isNamed(type, g.action) && !g.actionFiles.has(rel)) at(node, `the ${g.action}`);
        }
      }
      // The mint is taken only in the composition, straight into the grant action; the action is made only there.
      if (ts.isCallExpression(node) && isTakeMint(node) !== undefined && isStore(node.expression.expression)) {
        const g = BY_MINT.get(isTakeMint(node));
        const parent = node.parent;
        const direct = rel === FILES.compose && ts.isCallExpression(parent) && parent.arguments.includes(node) && ts.isIdentifier(parent.expression) && parent.expression.text === g.create;
        if (!direct && rel !== g.storeFile) at(node, `${g.mint}() outside ${g.create}( in the composition`);
      }
      for (const g of GUARDED) {
        if (ts.isCallExpression(node) && symbolOf(node.expression)?.getName() === g.create && declFile(symbolOf(node.expression)) === g.actionFile && rel !== FILES.compose && rel !== g.actionFile) at(node, `${g.create} outside the composition`);
      }
      // Construction sites.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        const owner = symbolOf(node.expression.expression);
        if (name === "open" && owner?.getName() === "Journal" && rel !== FILES.host) at(node, "Journal.open outside the host");
        if (name === "openDatabase" && declFile(symbolOf(node.expression))?.endsWith("ports/storage.ts") && rel !== FILES.host) at(node, "the storage port's openDatabase outside the host");
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "openDatabase") {
        const from = declFile(symbolOf(node.expression)) ?? "";
        if ((from.includes("packages/audit/") || from.includes("@axis/audit")) && rel !== FILES.nodeStorage && rel !== FILES.auditDb) at(node, "the audit openDatabase outside the node storage");
      }
      for (const g of GUARDED) if (ts.isNewExpression(node) && symbolOf(node.expression)?.getName() === g.store && rel !== FILES.journal) at(node, `new ${g.store} outside the journal`);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

const STORE_INCREASES = ["grant", "setEnabled", "takeGrantMint", "switchOn", "switchOff", "takeSwitchMint"];
/** The receiver's member of that name is callable (or the receiver is untyped): the store's three are methods. A data field is not. */
function callableMember(checker, receiver, name) {
  return callableMemberOf(checker, checker.getTypeAtLocation(receiver), name, receiver);
}
function callableMemberOf(checker, rawType, name, at) {
  const type = checker.getNonNullableType(rawType);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false; // an `any` cast is the reviewed boundary
  const prop = checker.getPropertyOfType(type, name);
  if (prop === undefined) return false;
  return checker.getTypeOfSymbolAtLocation(prop, at).getCallSignatures().length > 0;
}
/** The one receiver type known not to be the store: the grant action (its own rule keeps it in its files). */
function knownOtherType(checker, type, fileOf) {
  const t = checker.getNonNullableType(type);
  if (t.isUnion()) return false;
  const sym = t.aliasSymbol ?? t.getSymbol();
  // By declaration, never by name: only an action type DECLARED in its own action file is known not to be a store.
  return GUARDED.some((g) => sym?.getName() === g.action && (sym.declarations ?? []).length > 0 && sym.declarations.every((d) => fileOf(d.getSourceFile()) === g.actionFile));
}
/** The element type of an array, a tuple or another iterable with a number index. */
function elementTypeOf(checker, type) {
  const t = checker.getNonNullableType(type);
  return checker.getIndexTypeOfType(t, ts.IndexKind.Number) ?? (checker.isTupleType?.(t) ? checker.getTypeArguments(t)[0] : undefined);
}
/** `x.setEnabled(a, b, false)`: a decrease, allowed anywhere. */
const isDecrease = (access) => access.name.text === "setEnabled" && ts.isCallExpression(access.parent) && access.parent.expression === access && access.parent.arguments[2]?.kind === ts.SyntaxKind.FalseKeyword;

/** The mint's name when `call` takes a guarded store's mint (`takeGrantMint()` / `takeSwitchMint()`), else undefined. */
function isTakeMint(call) {
  return ts.isPropertyAccessExpression(call.expression) && BY_MINT.has(call.expression.name.text) ? call.expression.name.text : undefined;
}

/** A type-checked program over `files`, the same options for the product walk and the planted fixtures. */
export function grantWriterProgram(files) {
  return ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
  });
}
