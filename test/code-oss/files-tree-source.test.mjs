// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The Files tree of the workspace view shows file names from the worktree, which an agent writes. Every name it
// shows (row text, accessible name, hover title) must come from fileRowText, which cleans and clamps it (the overlay
// unit test axisFileTreeText.test.ts covers the hostile names). The view needs a workbench, so this is checked on the
// source (a plain TypeScript parse), and the checker is tested with sources that break each rule.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript6";

const FILE = fileURLToPath(new URL("../../code-oss/overlay/src/vs/axis/contrib/agent/browser/fileTree.ts", import.meta.url));
const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "DOMParser", "srcdoc"]);
const TEXT_SINKS = new Set(["textContent", "title", "innerText", "nodeValue"]);

const text = (n) => n.getText().replace(/\s+/g, " ");
function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  ts.forEachChild(node, (c) => void find(c, pred, out));
  return out;
}

/** The rule breaks in the Files tree source (empty when fine). */
export function filesTreeViolations(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const bad = [];
  for (const n of find(sf, (c) => ts.isPropertyAccessExpression(c) || ts.isIdentifier(c))) {
    const name = ts.isPropertyAccessExpression(n) ? n.name.text : n.text;
    if (HTML_SINKS.has(name)) bad.push(`html sink ${name}`);
  }
  // A name is read for display only once, by fileRowText; sorting and filtering read it as data.
  const nameReads = find(sf, (c) => ts.isPropertyAccessExpression(c) && c.name.text === "name" && text(c.expression) === "node");
  const shown = nameReads.filter((c) => !(ts.isCallExpression(c.parent) && text(c.parent.expression) === "fileRowText"));
  if (shown.length) bad.push(`a name shown without fileRowText: ${shown.map((c) => text(c.parent)).join("; ")}`);
  if (!find(sf, (c) => ts.isCallExpression(c) && text(c) === "fileRowText(node.name, node.isDirectory)").length) bad.push("rows do not get their text from fileRowText");
  // Every text sink is fed from that result or fixed text.
  for (const n of find(sf, (c) => ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(c.left) && TEXT_SINKS.has(c.left.name.text))) {
    const rhs = text(n.right);
    if (!(/^text\.(name|title)$/.test(rhs) || /^localize\(/.test(rhs) || /^node\.isDirectory \? \(node\.expanded \? '.' : '.'\) : ''$/.test(rhs))) bad.push(`text set from something else: ${text(n)}`);
  }
  const labels = find(sf, (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "setAttribute" && ts.isStringLiteralLike(c.arguments[0]) && c.arguments[0].text === "aria-label");
  for (const c of labels) {
    const value = text(c.arguments[1]);
    if (!(value === "text.label" || /^localize\(/.test(value))) bad.push(`accessible name from something else: ${value}`);
  }
  if (!/row\.title = text\.title;/.test(source)) bad.push("a row has no cleaned hover title");
  return bad;
}

const GOOD = readFileSync(FILE, "utf8");

test("the Files tree shows names only through fileRowText", () => {
  assert.deepEqual(filesTreeViolations(GOOD), []);
});

test("the checker finds each way of breaking the rules", () => {
  const breaks = [
    [GOOD.replace(".textContent = text.name;", ".textContent = node.name;"), "a name shown without fileRowText: append(row, $('span.name')).textContent = node.name"],
    [GOOD.replace(".textContent = text.name;", ".textContent = node.name;"), "text set from something else: append(row, $('span.name')).textContent = node.name"],
    [GOOD.replace(".textContent = text.name;", ".innerHTML = text.name;"), "html sink innerHTML"],
    [GOOD.replace("row.setAttribute('aria-label', text.label);", "row.setAttribute('aria-label', node.name);"), "accessible name from something else: node.name"],
    [GOOD.replace("row.title = text.title;", "row.title = node.resource.fsPath;"), "text set from something else: row.title = node.resource.fsPath"],
    [GOOD.replace("row.title = text.title;", ""), "a row has no cleaned hover title"],
    [GOOD.replace("const text = fileRowText(node.name, node.isDirectory);", "const text = { name: node.name, label: node.name, title: node.name };"), "rows do not get their text from fileRowText"],
  ];
  for (const [source, expected] of breaks) {
    assert.notEqual(source, GOOD, `the mutation applies: ${expected}`);
    assert.ok(filesTreeViolations(source).includes(expected), `${expected}\n  got: ${filesTreeViolations(source).join("; ")}`);
  }
});
