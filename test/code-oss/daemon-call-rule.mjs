// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-E0 F2 (review SF1): what the renderer may send to the daemon, checked on the TypeScript syntax tree of every renderer-side
// overlay file. The daemon client's `request` member may only be CALLED, directly, with two string literals forming a pair from
// the allow-list; any other use of it (a reference, an alias, a destructuring, a bracket access, a computed argument) is a
// violation. The connected client's `.call` with an `axis.*` literal is held to the same list, and the audit contract may only be
// read (`status`) through `.call` in the reconnect core, whose one non-literal pass-through is pinned by its arguments.
// Limit: a bracket access with a computed key (`x[k](...)`) cannot be resolved without types; the connected client itself is
// reachable only from the core (pinned by the connectAxisDaemon import test).
import ts from "typescript6";

export const ALLOWED = Object.freeze([
  "axis.approvals pending",
  "axis.approvals resolve",
  "axis.audit status",
  "axis.cli-runs list",
  "axis.projects list",
  "axis.worktrees list",
  "axis.worktrees status",
]);
export const CORE = "services/daemon/common/axisDaemonReconnect.ts";

const literal = (n) => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
const isRequestKey = (n) => n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "request";

/** Violations and the literal pairs found in one file. `file` is the path relative to `vs/axis`. */
export function scanDaemonCalls(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const pairs = [];
  const passThroughs = [];
  const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const checkCall = (call, via) => {
    const contract = literal(call.arguments[0]);
    const method = literal(call.arguments[1]);
    if (contract === undefined || method === undefined) return violations.push(`${at(call)}: ${via} with a non-literal contract or method`);
    const pair = `${contract} ${method}`;
    if (!ALLOWED.includes(pair)) return violations.push(`${at(call)}: ${via} ${pair} is not on the allow-list`);
    if (contract === "axis.audit" && (via !== ".call" || file !== CORE)) return violations.push(`${at(call)}: axis.audit outside the core's .call`);
    pairs.push(pair);
  };
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === "request") {
      const p = n.parent;
      if (ts.isCallExpression(p) && p.expression === n) checkCall(p, ".request");
      else violations.push(`${at(n)}: .request used without being called directly`);
    } else if (ts.isElementAccessExpression(n) && isRequestKey(n.argumentExpression)) {
      violations.push(`${at(n)}: ['request'] bracket access`);
    } else if (ts.isBindingElement(n) && isRequestKey(n.propertyName ?? n.name)) {
      violations.push(`${at(n)}: request destructured`);
    } else if (ts.isPropertyAccessExpression(n) && n.name.text === "call" && ts.isCallExpression(n.parent) && n.parent.expression === n) {
      const first = n.parent.arguments[0];
      const contract = literal(first);
      if (contract !== undefined && contract.startsWith("axis.")) checkCall(n.parent, ".call");
      else if (file === CORE && first !== undefined && ts.isIdentifier(first)) passThroughs.push(n.parent.arguments.slice(0, 3).map((a) => a.getText(sf)).join(", "));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { violations, pairs, passThroughs };
}
