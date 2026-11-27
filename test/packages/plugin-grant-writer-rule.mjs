// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// PV-K2 K2-g3 (docs/design/plugin-grant-contract.md section 8.4): the static half of "no second writer of plugin grants". The
// runtime locks are the guarantee (a single-use token that only the serving journal's mint makes, and that mint taken once by
// the host composition); these rules catch ordinary mistakes in the product source, with the type checker:
//
// - members: `grant`, `setEnabled` and `takeGrantMint` on a `PluginGrantRecords` value (property access, a literal or any
//   non-literal element key, destructuring), and that value passed to a function, only in the files allowed for each;
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
});

/** Who may use each member of the grant store. */
const MEMBER_FILES = new Map([
  ["grant", new Set([FILES.store, FILES.action])],
  ["setEnabled", new Set([FILES.store, FILES.action, FILES.handler])],
  ["takeGrantMint", new Set([FILES.store, FILES.compose])],
]);
/** Who may hold a token or a mint, and who may hold the grant action. */
const TOKEN_FILES = new Set([FILES.store, FILES.action]);
const ACTION_FILES = new Set([FILES.action, FILES.compose, FILES.handler]);

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
    const isStore = (expr) => isNamed(checker.getTypeAtLocation(expr), "PluginGrantRecords");
    if (rel === FILES.action) {
      let values = 0;
      for (const st of sf.statements) {
        const exported = ts.getCombinedModifierFlags?.(st) & ts.ModifierFlags.Export || st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st))) values++;
        if (exported && ts.isVariableStatement(st)) values += st.declarationList.declarations.length;
        if (ts.isExportDeclaration(st) && !st.isTypeOnly) values += st.exportClause === undefined ? 1 : ts.isNamedExports(st.exportClause) ? st.exportClause.elements.filter((e) => !e.isTypeOnly).length : 1;
        if (ts.isExportAssignment(st)) values++;
      }
      if (values !== 1) at(sf, `grant-action.ts must export exactly one value (found ${values})`);
    }
    const visit = (node) => {
      // Members of the grant store.
      if (ts.isPropertyAccessExpression(node) && MEMBER_FILES.has(node.name.text) && isStore(node.expression)) {
        if (!MEMBER_FILES.get(node.name.text).has(rel)) at(node, `${node.name.text} on the grant store`);
      }
      if (ts.isElementAccessExpression(node) && isStore(node.expression) && rel !== FILES.store) {
        const key = node.argumentExpression;
        const literal = ts.isStringLiteralLike(key) ? key.text : undefined;
        if (literal === undefined) at(node, "a computed member of the grant store");
        else if (MEMBER_FILES.has(literal) && !MEMBER_FILES.get(literal).has(rel)) at(node, `${literal} on the grant store`);
      }
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isObjectBindingPattern(node.name) && isStore(node.initializer)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
          if (name === undefined || (MEMBER_FILES.has(name) && !MEMBER_FILES.get(name).has(rel))) at(el, `${name ?? "a computed member"} destructured from the grant store`);
        }
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments !== undefined) {
        const calleeFile = declFile(symbolOf(ts.isCallExpression(node) ? node.expression : node.expression));
        for (const arg of node.arguments) {
          if (isStore(arg) && calleeFile !== FILES.action && rel !== FILES.store && rel !== FILES.journal) at(arg, "the grant store passed to a function outside the grant action");
        }
      }
      // Tokens, mints and the grant action, wherever a value of their type is declared, read or made.
      if (ts.isCallExpression(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAccessExpression(node) || ts.isBindingElement(node)) {
        const target = ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) ? node : node.name;
        const type = checker.getTypeAtLocation(target);
        if ((isNamed(type, "PluginGrantWrite") || returnsNamed(type, "PluginGrantWrite")) && !TOKEN_FILES.has(rel)) {
          // The one allowed taking of the mint: `takeGrantMint()` (and its member reference) inside the composition.
          const taking = (ts.isCallExpression(node) && isTakeMint(node)) || (ts.isPropertyAccessExpression(node) && node.name.text === "takeGrantMint");
          if (!(rel === FILES.compose && taking)) at(node, "a grant token or mint");
        }
        if (isNamed(type, "GrantAction") && !ACTION_FILES.has(rel)) at(node, "the grant action");
      }
      // The mint is taken only in the composition, straight into the grant action; the action is made only there.
      if (ts.isCallExpression(node) && isTakeMint(node) && isStore(node.expression.expression)) {
        const parent = node.parent;
        const direct = rel === FILES.compose && ts.isCallExpression(parent) && parent.arguments.includes(node) && ts.isIdentifier(parent.expression) && parent.expression.text === "createGrantAction";
        if (!direct && rel !== FILES.store) at(node, "takeGrantMint() outside createGrantAction( in the composition");
      }
      if (ts.isCallExpression(node) && symbolOf(node.expression)?.getName() === "createGrantAction" && declFile(symbolOf(node.expression)) === FILES.action && rel !== FILES.compose && rel !== FILES.action) at(node, "createGrantAction( outside the composition");
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
      if (ts.isNewExpression(node) && symbolOf(node.expression)?.getName() === "PluginGrantRecords" && rel !== FILES.journal) at(node, "new PluginGrantRecords outside the journal");
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

function isTakeMint(call) {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "takeGrantMint";
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
