// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The Files tree of the workspace view shows file names from the worktree, which an agent writes. Every name it
// shows (row text, accessible name, hover title) must come from fileRowText, which cleans and clamps it (the overlay
// unit test axisFileTreeText.test.ts covers the hostile names). The view needs a workbench, so this is checked on the
// source (a plain TypeScript parse) with allow-lists, and the checker is tested with sources that break each rule:
// - a name or path (.name, .resource, .path, .fsPath) is read only where the tree uses it as data (listing, sorting,
//   opening) or as the argument of fileRowText (reads of fileRowText's own result, `text.name`, are the cleaned
//   text); a tree node variable is never aliased or destructured;
// - every write to a text sink, with any assignment operator, takes fileRowText's result or fixed text;
// - setAttribute sets only known attributes, each from an allowed value; no other way to put text in the DOM;
// - no bracket member access except index lookups into the row and node arrays (a string or computed key could
//   reach a sink by name).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript6";

const FILE = fileURLToPath(new URL("../../code-oss/overlay/src/vs/axis/contrib/agent/browser/fileTree.ts", import.meta.url));
const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "DOMParser", "srcdoc"]);
/** Other ways to put text into the DOM: none is used, so none is allowed. */
const OTHER_TEXT_APIS = new Set(["createTextNode", "insertAdjacentText", "setAttributeNS", "dataset", "replaceWith", "before", "after", "prepend", "outerText"]);
const TEXT_SINKS = new Set(["textContent", "title", "innerText", "nodeValue", "placeholder", "ariaLabel", "ariaDescription"]);
const NAME_OR_PATH = new Set(["name", "resource", "path", "fsPath"]);
/** Where the tree reads a name or path as data, by the enclosing expression: anything else is a display path. */
const DATA_READS = new Set([
  "fileRowText(node.name, node.isDirectory)",
  "this.fileService.resolve(node.resource)",
  "HIDDEN_NAMES.has(child.name)",
  "a.name.localeCompare(b.name)",
  "resource: child.resource",
  "name: child.name",
  "this._onDidOpen.fire(node.resource)",
]);
/** setAttribute: attribute -> allowed value expressions. */
const ATTRIBUTES = new Map([
  ["role", (v) => /^'(tree|treeitem)'$/.test(v)],
  ["aria-label", (v) => v === "text.label" || /^localize\('axis\.files\.label', "Files"\)$/.test(v)],
  ["aria-level", (v) => v === "String(node.depth + 1)"],
  ["aria-expanded", (v) => v === "String(node.expanded)"],
  ["aria-selected", (v) => v === "String(i === index)"],
]);
const SINK_VALUES = [/^text\.(name|title)$/, /^localize\('axis\.files\.empty', "[^"]*"\)$/, /^node\.isDirectory \? \(node\.expanded \? '.' : '.'\) : ''$/];

const text = (n) => n.getText().replace(/\s+/g, " ");
function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  ts.forEachChild(node, (c) => void find(c, pred, out));
  return out;
}
const isAssignment = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

/** The rule breaks in the Files tree source (empty when fine). */
export function filesTreeViolations(source) {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  const bad = [];
  for (const n of find(sf, (c) => ts.isPropertyAccessExpression(c) || ts.isIdentifier(c))) {
    const name = ts.isPropertyAccessExpression(n) ? n.name.text : n.text;
    if (HTML_SINKS.has(name)) bad.push(`html sink ${name}`);
    if (OTHER_TEXT_APIS.has(name)) bad.push(`text put in the DOM another way: ${name}`);
  }
  // Bracket access: only index lookups into the row and node arrays; a string key (row['innerHTML']) or any other
  // computed member (row[k]) could reach a sink the checks above match by name, so both are refused.
  for (const access of find(sf, ts.isElementAccessExpression)) {
    const key = access.argumentExpression;
    if (ts.isStringLiteralLike(key) || ts.isNoSubstitutionTemplateLiteral(key)) bad.push(`bracket property access: ${text(access)}`);
    else if (!/^this\.(rows|visible)$/.test(text(access.expression))) bad.push(`computed member access: ${text(access)}`);
  }
  // Names and paths are read only as data or through fileRowText.
  for (const read of find(sf, (c) => ts.isPropertyAccessExpression(c) && NAME_OR_PATH.has(c.name.text) && text(c.expression) !== "text")) {
    let context = read.parent;
    while (context && !DATA_READS.has(text(context)) && !ts.isStatement(context) && !ts.isPropertyAssignment(context) && !ts.isArrowFunction(context)) context = context.parent;
    if (!context || !DATA_READS.has(text(context))) bad.push(`a name or path read outside fileRowText: ${text(read)}`);
  }
  // Tree nodes are not aliased or destructured (an alias would hide a name read from the rule above).
  for (const decl of find(sf, ts.isVariableDeclaration)) {
    const init = decl.initializer ? text(decl.initializer) : "";
    if (!ts.isIdentifier(decl.name)) bad.push(`a destructured declaration: ${text(decl)}`);
    else if (/^(node|child|a|b|this\.root)$/.test(init)) bad.push(`a tree node aliased: ${text(decl)}`);
  }
  for (const param of find(sf, ts.isParameter)) if (!ts.isIdentifier(param.name)) bad.push(`a destructured parameter: ${text(param)}`);
  // The one place a row's text comes from.
  const textDecls = find(sf, (c) => ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === "text");
  if (textDecls.length !== 1 || text(textDecls[0]) !== "text = fileRowText(node.name, node.isDirectory)" || !ts.isVariableDeclarationList(textDecls[0].parent) || !(textDecls[0].parent.flags & ts.NodeFlags.Const)) bad.push("rows do not get their text from one const fileRowText result");
  // Every text sink, with any assignment operator, takes that result or fixed text.
  for (const n of find(sf, (c) => isAssignment(c) && ts.isPropertyAccessExpression(c.left) && TEXT_SINKS.has(c.left.name.text))) {
    if (n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !SINK_VALUES.some((re) => re.test(text(n.right)))) bad.push(`text set from something else: ${text(n)}`);
  }
  // setAttribute: known attributes only, each from an allowed value.
  for (const call of find(sf, (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "setAttribute")) {
    const [nameArg, valueArg] = call.arguments;
    const attribute = nameArg && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
    const allowed = attribute && ATTRIBUTES.get(attribute);
    if (!allowed || !valueArg || !allowed(text(valueArg))) bad.push(`attribute set from something else: ${text(call)}`);
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
    [GOOD.replace(".textContent = text.name;", ".textContent = node.name;"), "a name or path read outside fileRowText: node.name"],
    [GOOD.replace(".textContent = text.name;", ".textContent = node.name;"), "text set from something else: append(row, $('span.name')).textContent = node.name"],
    [GOOD.replace(".textContent = text.name;", ".innerHTML = text.name;"), "html sink innerHTML"],
    [GOOD.replace("row.setAttribute('aria-label', text.label);", "row.setAttribute('aria-label', node.name);"), "attribute set from something else: row.setAttribute('aria-label', node.name)"],
    [GOOD.replace("row.title = text.title;", "row.title = node.resource.fsPath;"), "text set from something else: row.title = node.resource.fsPath"],
    [GOOD.replace("row.title = text.title;", "row.title = text.title; row.title += node.resource.path;"), "text set from something else: row.title += node.resource.path"],
    [GOOD.replace("row.title = text.title;", "row.title = text.title; row.title += node.resource.path;"), "a name or path read outside fileRowText: node.resource.path"],
    [GOOD.replace("row.title = text.title;", ""), "a row has no cleaned hover title"],
    [GOOD.replace("const text = fileRowText(node.name, node.isDirectory);", "const text = { name: node.name, label: node.name, title: node.name };"), "rows do not get their text from one const fileRowText result"],
    [GOOD.replace("const text = fileRowText(node.name, node.isDirectory);", "let text = fileRowText(node.name, node.isDirectory);"), "rows do not get their text from one const fileRowText result"],
    // Review 1 bypasses: an alias of the node, a destructured name, a path appended to the title.
    [GOOD.replace("const text = fileRowText(node.name, node.isDirectory);", "const nm = node;\n\t\t\tconst text = fileRowText(node.name, node.isDirectory);\n\t\t\trow.setAttribute('aria-description', nm.name);"), "a tree node aliased: nm = node"],
    [GOOD.replace("const text = fileRowText(node.name, node.isDirectory);", "const nm = node;\n\t\t\tconst text = fileRowText(node.name, node.isDirectory);\n\t\t\trow.setAttribute('aria-description', nm.name);"), "attribute set from something else: row.setAttribute('aria-description', nm.name)"],
    [GOOD.replace("const text = fileRowText(node.name, node.isDirectory);", "const { name } = node;\n\t\t\tconst text = fileRowText(node.name, node.isDirectory);\n\t\t\trow.setAttribute('aria-description', name);"), "a destructured declaration: { name } = node"],
    [GOOD.replace("row.setAttribute('aria-level', String(node.depth + 1));", "row.setAttribute('data-path', node.resource.toString());"), "attribute set from something else: row.setAttribute('data-path', node.resource.toString())"],
    [GOOD.replace("row.title = text.title;", "row.title = text.title; row.append(document.createTextNode(node.name));"), "text put in the DOM another way: createTextNode"],
    [GOOD.replace("row.title = text.title;", "row.title = text.title; row.dataset.name = text.name;"), "text put in the DOM another way: dataset"],
    // Review 2: a sink reached through a bracket.
    [GOOD.replace("row.title = text.title;", "row.title = text.title; row['innerHTML'] = text.name;"), "bracket property access: row['innerHTML']"],
    [GOOD.replace("row.title = text.title;", "row.title = text.title; const k = 'innerHTML'; row[k] = text.name;"), "computed member access: row[k]"],
  ];
  for (const [source, expected] of breaks) {
    assert.notEqual(source, GOOD, `the mutation applies: ${expected}`);
    assert.ok(filesTreeViolations(source).includes(expected), `${expected}\n  got: ${filesTreeViolations(source).join("; ")}`);
  }
});
