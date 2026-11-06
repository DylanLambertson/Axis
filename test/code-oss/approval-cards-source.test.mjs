// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shell A4 (docs/design/axis-shell-a4.md): the approval cards of the Agent view are written with textContent only and
// answer only through the trusted-gesture path. The view needs a real DOM, which the overlay mocha runner cannot give
// the common tests, so these rules are checked on the source (a plain TypeScript parse) and the checker is itself
// tested with sources that break each rule.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript6";

const OVERLAY = fileURLToPath(new URL("../../code-oss/overlay/src/vs/axis", import.meta.url));
const VIEW = "contrib/agent/browser/approvalCards.ts";
const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement", "createContextualFragment", "DOMParser", "write", "writeln", "srcdoc"]);
const FORGERIES = new Set(["click", "dispatchEvent", "requestSubmit", "submit"]);

/** The rule breaks in the source of the approval cards view (empty when fine). */
export function cardViewViolations(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const bad = [];
  const visit = (n) => {
    const name = ts.isPropertyAccessExpression(n) ? n.name.text : ts.isIdentifier(n) ? n.text : undefined;
    if (name !== undefined && HTML_SINKS.has(name)) bad.push(`html sink ${name}`);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && FORGERIES.has(n.expression.name.text)) bad.push(`script-made event ${n.expression.name.text}`);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "addDisposableListener") {
      const type = n.arguments[1];
      if (!(type && ts.isStringLiteralLike(type) && type.text === "click")) bad.push("listener that is not a click");
      const target = n.arguments[0];
      if (!(target && ts.isIdentifier(target) && target.text === "button")) bad.push("listener not on the card button");
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "decideApproval") {
      const event = n.arguments[2];
      if (!(event && ts.isIdentifier(event) && event.text === "event")) bad.push("decideApproval not given the DOM event itself");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

function overlayFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) overlayFiles(join(dir, e.name), out);
    else if (e.name.endsWith(".ts")) out.push(join(dir, e.name));
  }
  return out;
}

const GOOD = readFileSync(join(OVERLAY, VIEW), "utf8");

test("the approval cards view follows the textContent-only and trusted-gesture rules", () => {
  assert.deepEqual(cardViewViolations(GOOD), []);
});

test("the checker finds each way of breaking the rules", () => {
  const breaks = [
    [GOOD.replace("title.textContent = localize", "title.innerHTML = localize"), "html sink innerHTML"],
    [GOOD.replace("append(fields, $('dd')).textContent = value;", "append(fields, $('dd')).insertAdjacentHTML('beforeend', value);"), "html sink insertAdjacentHTML"],
    [GOOD.replace("button.type = 'button';", "button.type = 'button'; button.click();"), "script-made event click"],
    [GOOD.replace("button.type = 'button';", "button.type = 'button'; button.dispatchEvent(new MouseEvent('click'));"), "script-made event dispatchEvent"],
    [GOOD.replace("addDisposableListener(button, 'click'", "addDisposableListener(button, 'keydown'"), "listener that is not a click"],
    [GOOD.replace("addDisposableListener(button, 'click'", "addDisposableListener(cardElement, 'click'"), "listener not on the card button"],
    [GOOD.replace("decideApproval(card, decision, event, scope)", "decideApproval(card, decision, { isTrusted: true, type: 'click', target: button }, scope)"), "decideApproval not given the DOM event itself"],
  ];
  for (const [source, expected] of breaks) {
    assert.notEqual(source, GOOD, `the mutation applies: ${expected}`);
    assert.ok(cardViewViolations(source).includes(expected), expected);
  }
});

test("only the approval cards view asks the service for a decision", () => {
  const callers = overlayFiles(OVERLAY)
    .filter((f) => !f.includes(`${join("test", "")}`) && /\.decideApproval\(/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(OVERLAY.length + 1).replace(/\\/g, "/"));
  assert.deepEqual(callers, [VIEW]);
});

test("no keybinding or command in the overlay answers an approval", () => {
  const hits = overlayFiles(OVERLAY).filter((f) => /resolveApproval|decideApproval/.test(readFileSync(f, "utf8")) && /registerAction2|KeybindingsRegistry|CommandsRegistry/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});
