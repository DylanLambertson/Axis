// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// A BEST-EFFORT lint for the pty process package (web-rules.mjs rule 1, review 4 of the endpoint template): no shipped source of
// pty-process writes to a shared prototype. The pinned endpoint template never hands out its server or a raw socket, but code
// in the same process could still reach them by patching what they inherit (an `EventEmitter.prototype.once` wrapper, an
// `Object.prototype` setter for a key Node writes on the server). This lint refuses the plain forms of that:
//   - an assignment or `delete` whose target goes through `.prototype` or `__proto__` (`X.prototype.m = f`, `o.__proto__ = p`);
//   - `Object.defineProperty`, `Object.defineProperties`, `Object.setPrototypeOf`, and `Object.assign` onto a `.prototype`;
//   - `Reflect.set`, `Reflect.defineProperty`, `Reflect.setPrototypeOf`, `Reflect.deleteProperty`;
//   - `__defineGetter__`, `__defineSetter__`.
// It is NOT a proof. Forms it does NOT catch (review of the template, Sonnet check): calls through a bracket
// (`Object["defineProperty"](...)`, `Reflect["set"](...)`); an aliased or destructured `Object` or `Reflect` (`const O = Object`,
// `const { defineProperty } = Object`, `globalThis.Object`); a prototype held in a variable (`const p = X.prototype; p.m = f`);
// a computed key (`x[k] = f` with `k` "prototype" at run time); `Object.getPrototypeOf(x).m = f`; any value passed in. The residual is recorded (RR-89); the controls are code review, the pinned template, this lint
// and the supply-chain checks.
import ts from "typescript6";

const K = ts.SyntaxKind;
const OBJECT_WRITERS = new Set(["defineProperty", "defineProperties", "setPrototypeOf"]);
const REFLECT_WRITERS = new Set(["set", "defineProperty", "setPrototypeOf", "deleteProperty"]);

/** Casts, non-null assertions and parentheses change nothing at run time: a chain is read through them. */
const wrapper = (e) => ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e);
/** True when a property chain (`a.b.prototype.c`, `x["__proto__"]`, `(X.prototype as T).m`) passes through a prototype. */
function throughPrototype(n) {
  for (let e = n; e !== undefined && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || wrapper(e)); e = e.expression) {
    const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) && (ts.isStringLiteral(e.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(e.argumentExpression)) ? e.argumentExpression.text : null;
    if (name === "prototype" || name === "__proto__") return true;
  }
  return false;
}
const callOn = (n, object, names) => ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === object && names.has(n.expression.name.text);

/** Reasons `sf` writes to a shared prototype (the plain forms above); `at(n)` names a node's line. */
export function prototypeWrites(sf, at) {
  const bad = [];
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= K.FirstAssignment && n.operatorToken.kind <= K.LastAssignment && throughPrototype(n.left)) bad.push(`${at(n)}: a write through a prototype (shared by every object that inherits it)`);
    if (ts.isDeleteExpression(n) && throughPrototype(n.expression)) bad.push(`${at(n)}: a delete through a prototype`);
    if (ts.isCallExpression(n)) {
      if (callOn(n, "Object", OBJECT_WRITERS)) bad.push(`${at(n)}: Object.${n.expression.name.text} can patch a shared prototype`);
      if (callOn(n, "Object", new Set(["assign"])) && n.arguments[0] !== undefined && throughPrototype(n.arguments[0])) bad.push(`${at(n)}: Object.assign onto a prototype`);
      if (callOn(n, "Reflect", REFLECT_WRITERS)) bad.push(`${at(n)}: Reflect.${n.expression.name.text} can patch a shared prototype`);
    }
    if (ts.isPropertyAccessExpression(n) && (n.name.text === "__defineGetter__" || n.name.text === "__defineSetter__")) bad.push(`${at(n)}: ${n.name.text} defines an accessor on any object`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}
