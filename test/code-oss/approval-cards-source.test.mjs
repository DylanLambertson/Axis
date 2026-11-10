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
const AHEAD = new Set(["prepend", "insertBefore", "before", "after"]);

const callName = (n) => ts.isCallExpression(n) && (ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : undefined);
function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  ts.forEachChild(node, (c) => void find(c, pred, out));
  return out;
}

/** The rule breaks in the source of the approval cards view (empty when fine). */
export function cardViewViolations(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const bad = [];
  let scopeCalls = 0;
  let layouts = 0;
  const visit = (n) => {
    const name = ts.isPropertyAccessExpression(n) ? n.name.text : ts.isIdentifier(n) ? n.text : undefined;
    if (name !== undefined && HTML_SINKS.has(name)) bad.push(`html sink ${name}`);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && FORGERIES.has(n.expression.name.text)) bad.push(`script-made event ${n.expression.name.text}`);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "addDisposableListener") {
      const type = n.arguments[1];
      const kind = type && ts.isStringLiteralLike(type) ? type.text : undefined;
      if (kind === "scroll") {
        // only re-reads card positions
        if (find(n, (c) => callName(c) === "decideApproval").length) bad.push("a scroll listener asks for a decision");
      } else {
        if (kind !== "click") bad.push("listener that is not a click");
        const target = n.arguments[0];
        if (!(target && ts.isIdentifier(target) && target.text === "button")) bad.push("listener not on the card button");
        const decide = find(n, (c) => callName(c) === "decideApproval")[0];
        const placed = find(n, (c) => callName(c) === "approvalPlaced")[0];
        if (decide && !(placed && placed.getStart() < decide.getStart() && /getBoundingClientRect\(\)/.test(n.getText()))) bad.push("click not checked against the card's current position");
      }
    }
    if (callName(n) && AHEAD.has(callName(n))) bad.push(`card inserted ahead of others (${callName(n)})`);
    if (name === "activeElement" || name === "body" || name === "documentElement") bad.push(`view reads ${name} itself (the scope comes from scopeFor)`);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "scopeFor") {
      scopeCalls++;
      const [card, button] = n.arguments;
      if (!(card && ts.isIdentifier(card) && card.text === "cardElement" && button && ts.isIdentifier(button) && button.text === "button")) bad.push("scopeFor not given the card element and its button");
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "layoutApprovals") layouts++;
    if (ts.isPropertyAccessExpression(n) && n.name.text === "approvalCards") bad.push("cards drawn from the unordered listing, not layoutApprovals");
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "decideApproval") {
      const event = n.arguments[2];
      if (!(event && ts.isIdentifier(event) && event.text === "event")) bad.push("decideApproval not given the DOM event itself");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const text = (n) => n.getText().replace(/\s+/g, " ");
  const calls = (name) => find(sf, (c) => callName(c) === name);
  if (calls("appendChild").filter((c) => text(c) === "this.list.appendChild(view.element)").length !== 1) bad.push("new cards are not added last with this.list.appendChild(view.element)");
  const keep = find(sf, (c) => ts.isIfStatement(c) && text(c.expression) === "existing && existing.card.digest === card.digest" && find(c.thenStatement, ts.isContinueStatement).length > 0);
  if (keep.length !== 1) bad.push("a listed card with the same digest is not kept: every card rebuilt on each render");
  if (!find(sf, (c) => ts.isBinaryExpression(c) && text(c) === "button.disabled = true").length) bad.push("buttons do not start disabled");
  const decl = (name) => find(sf, (c) => ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === name)[0];
  const guard = decl("guard");
  const disabled = decl("disabled");
  if (!(guard?.initializer && callName(guard.initializer) === "approvalGuardRemaining" && disabled?.initializer && /^guard > 0 \|\| /.test(text(disabled.initializer)) && find(sf, (c) => ts.isBinaryExpression(c) && text(c) === "button.disabled = disabled").length)) bad.push("buttons are not disabled during the guard time");
  const buttons = calls("addButton").filter((c) => c.arguments.length === 5);
  const decisionOf = (c) => (ts.isStringLiteralLike(c.arguments[3]) ? c.arguments[3].text : undefined);
  if (buttons.map(decisionOf).join(",") !== "deny,approve") bad.push("Deny must come before Approve, one of each");
  const approveLabel = buttons.find((c) => decisionOf(c) === "approve")?.arguments[4];
  if (!(approveLabel && ts.isConditionalExpression(approveLabel) && text(approveLabel.condition) === "native" && /'axis\.approval\.approveNative'/.test(text(approveLabel.whenTrue)))) bad.push("a native card's Approve does not say the dialog follows");
  if (calls("approvalPlaced").length < 2) bad.push("card positions are not reported after drawing");
  if (!calls("approvalPlaced").every((c) => /^\S+, rect\.top, rect\.left, rect\.width, rect\.height$/.test(c.arguments.map(text).join(", ")))) bad.push("a position report leaves out part of the card's box");
  // The position wiring, each link: render schedules a report; the report reads every card and updates the buttons;
  // a ResizeObserver on the parent, the list and every element above the region, and a capture scroll listener on
  // the document, each schedule a report.
  const method = (name) => find(sf, (c) => ts.isMethodDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === name)[0];
  const schedulesPlace = (n) => n !== undefined && find(n, (c) => ts.isCallExpression(c) && text(c) === "this.placeTimer.schedule()").length > 0;
  if (!schedulesPlace(method("render"))) bad.push("render does not schedule a position report");
  if (!find(sf, (c) => ts.isPropertyDeclaration(c) && text(c.name) === "placeTimer" && /new RunOnceScheduler\(\(\) => this\.place\(\)/.test(text(c))).length) bad.push("the position report timer does not run place()");
  const place = method("place");
  if (!(place && find(place, (c) => callName(c) === "approvalPlaced").length && find(place, (c) => ts.isCallExpression(c) && text(c) === "this.updateButtons()").length)) bad.push("place() does not report every card and update the buttons");
  const observers = find(sf, (c) => ts.isNewExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "ResizeObserver");
  if (!observers.length) bad.push("no size watch on what sits above the cards");
  if (!(observers.length === 1 && schedulesPlace(observers[0].arguments?.[0]))) bad.push("the size watch does not schedule a position report");
  const observed = new Set(calls("observe").filter((c) => ts.isPropertyAccessExpression(c.expression) && text(c.expression.expression) === "observer").map((c) => text(c.arguments[0] ?? c)));
  const siblingLoop = find(sf, (c) => ts.isForStatement(c) && c.initializer && /node = parent\.firstElementChild/.test(text(c.initializer)) && c.condition && text(c.condition) === "node && node !== this.element" && c.incrementor && text(c.incrementor) === "node = node.nextElementSibling" && find(c.statement, (d) => ts.isCallExpression(d) && text(d) === "observer.observe(node)").length > 0);
  if (!(observed.has("parent") && observed.has("this.list") && siblingLoop.length === 1)) bad.push("not every element above the cards is watched");
  const scroll = calls("addDisposableListener").filter((c) => c.arguments[1] && ts.isStringLiteralLike(c.arguments[1]) && c.arguments[1].text === "scroll");
  if (!(scroll.length === 1 && text(scroll[0].arguments[0]) === "this.element.ownerDocument" && schedulesPlace(scroll[0].arguments[2]) && scroll[0].arguments[3]?.kind === ts.SyntaxKind.TrueKeyword)) bad.push("no capture scroll listener on the document that schedules a position report");
  const listAt = source.indexOf("$('.axis-approvals-list')");
  const statusAt = source.indexOf("$('.axis-approvals-status')");
  if (!(listAt > 0 && statusAt > listAt)) bad.push("the status line is above the cards");
  if (scopeCalls !== 1) bad.push("the view must build the scope with exactly one scopeFor call");
  if (layouts !== 1) bad.push("the view must draw from one layoutApprovals call");
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

/** Approve drawn before Deny. */
function swapButtons(src) {
  const lines = src.split("\n");
  const deny = lines.findIndex((l) => l.includes("this.addButton(view, actions, name, 'deny'"));
  const approve = lines.findIndex((l) => l.includes("this.addButton(view, actions, name, 'approve'"));
  [lines[deny], lines[approve]] = [lines[approve], lines[deny]];
  return lines.join("\n");
}

/** place() that reports positions but leaves the buttons as they were. */
function placeWithoutButtons(src) {
  const body = src.slice(src.indexOf("\tprivate place(): void {"));
  const end = body.indexOf("\n\t}\n");
  const old = body.slice(0, end);
  return src.replace(old, old.replace("\t\tthis.updateButtons();\n", "").replace(/\n\t\tthis\.updateButtons\(\);$/, ""));
}

/** The status line created above the list again. */
function moveStatusUp(src) {
  const status = "\t\tthis.status = append(this.element, $('.axis-approvals-status')); // below the cards: its text never moves one\n";
  return src.replace(status, "").replace("\t\tthis.list = append(this.element,", `${status}\t\tthis.list = append(this.element,`);
}

test("the approval cards view follows the textContent-only and trusted-gesture rules", () => {
  assert.deepEqual(cardViewViolations(GOOD), []);
});

test("the checker finds each way of breaking the rules", () => {
  const breaks = [
    [GOOD.replace("title.textContent = localize", "title.innerHTML = localize"), "html sink innerHTML"],
    [GOOD.replace("append(fields, $('dd')).textContent = value;", "append(fields, $('dd')).insertAdjacentHTML('beforeend', value);"), "html sink insertAdjacentHTML"],
    [GOOD.replace("const scope = scopeFor(cardElement, button,", "const scope = scopeFor(cardElement.ownerDocument.body, button,"), "scopeFor not given the card element and its button"],
    [GOOD.replace("const scope = scopeFor(cardElement, button,", "const scope = scopeFor(cardElement, cardElement,"), "scopeFor not given the card element and its button"],
    [GOOD.replace("const scope = scopeFor(", "const focus = cardElement.ownerDocument.activeElement; const scope = scopeFor("), "view reads activeElement itself (the scope comes from scopeFor)"],
    [GOOD.replace("this.workspaceService.layoutApprovals()", "this.workspaceService.approvalCards"), "cards drawn from the unordered listing, not layoutApprovals"],
    [GOOD.replace("button.type = 'button';", "button.type = 'button'; button.click();"), "script-made event click"],
    [GOOD.replace("button.type = 'button';", "button.type = 'button'; button.dispatchEvent(new MouseEvent('click'));"), "script-made event dispatchEvent"],
    [GOOD.replace("addDisposableListener(button, 'click'", "addDisposableListener(button, 'keydown'"), "listener that is not a click"],
    [GOOD.replace("addDisposableListener(button, 'click'", "addDisposableListener(cardElement, 'click'"), "listener not on the card button"],
    [GOOD.replace("decideApproval(view.card, decision, event, scope)", "decideApproval(view.card, decision, { isTrusted: true, type: 'click', target: button }, scope)"), "decideApproval not given the DOM event itself"],
    [GOOD.replace("this.list.appendChild(view.element);", "this.list.prepend(view.element);"), "card inserted ahead of others (prepend)"],
    [GOOD.replace("this.list.appendChild(view.element);", "this.list.prepend(view.element);"), "new cards are not added last with this.list.appendChild(view.element)"],
    [GOOD.replace("this.list.appendChild(view.element);", "this.list.insertBefore(view.element, this.list.firstChild);"), "card inserted ahead of others (insertBefore)"],
    [GOOD.replace("if (existing && existing.card.digest === card.digest) {", "if (false) {"), "a listed card with the same digest is not kept: every card rebuilt on each render"],
    [GOOD.replace("button.disabled = true;", "button.disabled = false;"), "buttons do not start disabled"],
    [GOOD.replace("const disabled = guard > 0 || untilExpiry <= 0;", "const disabled = untilExpiry <= 0;"), "buttons are not disabled during the guard time"],
    [GOOD.replace("native ? localize('axis.approval.approveNative', \"Approve, then confirm in the dialog\") : ", ""), "a native card's Approve does not say the dialog follows"],
    [swapButtons(GOOD), "Deny must come before Approve, one of each"],
    [GOOD.replace("this.workspaceService.approvalPlaced(view.card.challengeId, rect.top, rect.left, rect.width, rect.height);", ""), "click not checked against the card's current position"],
    [GOOD.replace("this.workspaceService.approvalPlaced(id, rect.top, rect.left, rect.width, rect.height);", ""), "card positions are not reported after drawing"],
    [GOOD.replace("approvalPlaced(id, rect.top, rect.left, rect.width, rect.height)", "approvalPlaced(id, rect.top, rect.left, 0, 0)"), "a position report leaves out part of the card's box"],
    [GOOD.replace("approvalPlaced(view.card.challengeId, rect.top, rect.left, rect.width, rect.height)", "approvalPlaced(view.card.challengeId, rect.top, rect.left, 0, rect.height)"), "a position report leaves out part of the card's box"],
    [GOOD.replace("\t\tthis.placeTimer.schedule(); // after", "\t\t// after"), "render does not schedule a position report"],
    [GOOD.replace("new RunOnceScheduler(() => this.place(), 0)", "new RunOnceScheduler(() => this.updateButtons(), 0)"), "the position report timer does not run place()"],
    [GOOD.replace("new ResizeObserver(() => this.placeTimer.schedule())", "new ResizeObserver(() => undefined)"), "the size watch does not schedule a position report"],
    [GOOD.replace("\t\t\tobserver.observe(node);\n", ""), "not every element above the cards is watched"],
    [GOOD.replace("node = node.nextElementSibling", "node = null"), "not every element above the cards is watched"],
    [GOOD.replace("\t\tobserver.observe(this.list);\n", ""), "not every element above the cards is watched"],
    [GOOD.replace("\t\tobserver.observe(parent);\n", ""), "not every element above the cards is watched"],
    [placeWithoutButtons(GOOD), "place() does not report every card and update the buttons"],
    [GOOD.replace("\t\tthis._register(addDisposableListener(this.element.ownerDocument, 'scroll', () => this.placeTimer.schedule(), true));\n", ""), "no capture scroll listener on the document that schedules a position report"],
    [GOOD.replace("'scroll', () => this.placeTimer.schedule(), true)", "'scroll', () => this.placeTimer.schedule(), false)"), "no capture scroll listener on the document that schedules a position report"],
    [GOOD.replace("'scroll', () => this.placeTimer.schedule(), true)", "'scroll', () => undefined, true)"), "no capture scroll listener on the document that schedules a position report"],
    [GOOD.replace("new ResizeObserver(", "new Set<unknown>("), "no size watch on what sits above the cards"],
    [moveStatusUp(GOOD), "the status line is above the cards"],
    [GOOD.replace("() => this.placeTimer.schedule(), true)", "() => this.workspaceService.decideApproval(undefined!, 'approve', undefined!, undefined!), true)"), "a scroll listener asks for a decision"],
  ];
  for (const [source, expected] of breaks) {
    assert.notEqual(source, GOOD, `the mutation applies: ${expected}`);
    assert.ok(cardViewViolations(source).includes(expected), expected);
  }
});

test("the cards sit below the workspace list, so a new card cannot move a row (a moved card is guarded again: see the checker)", () => {
  const dash = readFileSync(join(OVERLAY, "contrib/agent/browser/dashboardView.ts"), "utf8");
  const list = dash.indexOf("$('.axis-dashboard-list')");
  const cards = dash.indexOf("new AxisApprovalCards(");
  assert.ok(list > 0 && cards > list, "AxisApprovalCards is created after the list");
  assert.ok(dash.indexOf("$('.axis-dashboard-header')") < list);
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
