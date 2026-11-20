// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shell A5 (docs/design/axis-shell-a5.md): the Changes view only reads git state through the workbench IGitService and
// draws every text with textContent from the model, which cleans file names. The view needs a workbench, so these rules
// are checked on the source (a plain TypeScript parse), and the checker is itself tested with sources that break each
// rule. The model's behaviour (hostile names, diff sides, the fake IGitService) is covered by the overlay unit tests.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript6";

const OVERLAY = fileURLToPath(new URL("../../code-oss/overlay/src/vs/axis", import.meta.url));
const VIEW = "contrib/agent/browser/changesView.ts";
const MODEL = "services/changes/common/axisChanges.ts";
const SOURCE = "services/changes/common/axisChangesSource.ts";
const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "DOMParser", "write", "writeln", "srcdoc"]);
/** Every IGitService and IGitRepository member that is not a read the Changes view needs (openRepository, repositories, state). */
const GIT_OTHER = new Set(["commitFiles", "updateState", "setDelegate", "diffBetweenWithStats", "diffBetweenWithStats2", "getRefs"]);
const PROCESS = new Set(["child_process", "spawn", "spawnSync", "exec", "execFile", "execSync", "fork"]);
/** Model fields that are raw paths or URIs: never shown. */
const RAW = new Set(["resource", "original", "modified", "uri", "path", "fsPath", "query", "rootUri", "id"]);
/** The only producers of row text: cleaned model fields and fixed labels. */
const ROW_TEXT = new Set(["row.name", "changeKindGlyph(row.kind)", "changeKindLabel(row.kind)"]);

const text = (n) => n.getText().replace(/\s+/g, " ");
function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  ts.forEachChild(node, (c) => void find(c, pred, out));
  return out;
}
const parse = (source) => ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
const names = (sf) => find(sf, (n) => ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)).map((n) => (ts.isPropertyAccessExpression(n) ? n.name.text : n.text));
const specifiers = (sf) => find(sf, (n) => ts.isImportDeclaration(n)).map((n) => n.moduleSpecifier.text);

/** Rule breaks shared by the three Changes files: HTML sinks, processes, other git calls. */
export function readOnlyViolations(source) {
  const sf = parse(source);
  const bad = [];
  for (const name of names(sf)) {
    if (HTML_SINKS.has(name)) bad.push(`html sink ${name}`);
    if (PROCESS.has(name)) bad.push(`process call ${name}`);
    if (GIT_OTHER.has(name)) bad.push(`git call other than a read: ${name}`);
  }
  for (const spec of specifiers(sf)) if (/child_process|^node:|electron/.test(spec)) bad.push(`import ${spec}`);
  return bad;
}

/** Rule breaks in the view: text only from the model, the state before the name, open only through reveal. */
export function changesViewViolations(source) {
  const sf = parse(source);
  const bad = readOnlyViolations(source);
  for (const n of find(sf, (c) => ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(c.left) && ["textContent", "title", "innerText", "nodeValue"].includes(c.left.name.text))) {
    const raw = find(n.right, (c) => ts.isPropertyAccessExpression(c) && RAW.has(c.name.text) && !text(c).startsWith("heading.") && !text(c).startsWith("group."));
    if (raw.length) bad.push(`raw path or URI shown: ${text(n)}`);
  }
  if (find(sf, (c) => ts.isPropertyAccessExpression(c) && c.name.text === "openEditor").length) bad.push("opens editors itself instead of through reveal");
  if (find(sf, (c) => ts.isPropertyAccessExpression(c) && ["openRepository", "repositories", "state"].includes(c.name.text) && /gitService|repository/i.test(text(c.expression))).length) bad.push("the view reads git itself instead of through the source");
  const reveals = find(sf, (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "reveal").map((c) => text(c.arguments[0] ?? c));
  if (reveals.sort().join(" | ") !== "diffTargetOf(row) | reviewAllTargetOf(this.visible, this.workspaceLabel)") bad.push("reveal targets are not built by the model (diffTargetOf, reviewAllTargetOf)");
  const render = find(sf, (c) => ts.isMethodDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === "render")[0];
  const renderText = render ? text(render) : "";
  if (!/nextActiveIndex\(this\.visible, this\.activeId, this\.activeIndex\)/.test(renderText)) bad.push("the active row does not follow its file (nextActiveIndex)");
  if (!/if \(focusWasInside\) \{ this\.summary\.focus\(\); \}/.test(renderText)) bad.push("focus is dropped when the list empties");
  if (!/const existing = this\.byId\.get\(row\.id\);/.test(source)) bad.push("rows are not kept by file id");
  if (find(sf, (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "setAttribute" && c.arguments.length === 2 && ts.isStringLiteralLike(c.arguments[0]) && c.arguments[0].text === "aria-label" && text(c.arguments[1]) !== "changeRowLabel(row)" && /\brow\b/.test(text(c.arguments[1]))).length) bad.push("a row's accessible name is not changeRowLabel(row)");
  const method = (name) => find(sf, (c) => ts.isMethodDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === name)[0];
  const renderRow = method("fillRow");
  if (!renderRow || !method("createRow")) {
    bad.push("no createRow or fillRow");
    return bad;
  }
  const body = text(renderRow);
  if (!/element\.setAttribute\('role', 'option'\)/.test(text(method("createRow")))) bad.push("a row is not a listbox option");
  if (!/element\.setAttribute\('aria-label', changeRowLabel\(row\)\)/.test(body)) bad.push("a row's accessible name is not changeRowLabel(row)");
  if (!/element\.replaceChildren\(state, name, where\)/.test(body)) bad.push("the state is not drawn before the name");
  const rowTexts = find(renderRow, (c) => ts.isBinaryExpression(c) && ts.isPropertyAccessExpression(c.left) && c.left.name.text === "textContent" && !text(c.left).startsWith("where."));
  for (const n of rowTexts) if (!ROW_TEXT.has(text(n.right))) bad.push(`row text not from the model: ${text(n.right)}`);
  if (rowTexts.length !== 3) bad.push("a row must show the glyph, the state word and the name");
  if (!/\.textContent = changeKindGlyph\(row\.kind\)/.test(body) || !/\.textContent = changeKindLabel\(row\.kind\)/.test(body)) bad.push("the state is not shown as a letter and a word");
  if (!/element\.className = `axis-change-row kind-\$\{row\.kind\}`;/.test(body)) bad.push("the row class is not from the kind");
  if (!/'listbox'/.test(source)) bad.push("the rows are not in a listbox");
  return bad;
}

/** The source reads only `openRepository` and `state`, and only opens worktrees inside the window's folders. */
export function sourceViolations(source) {
  const bad = readOnlyViolations(source);
  if (!/repository = await this\.isRepositoryRoot\(root\) \? await this\.git\.openRepository\(root\) : undefined;/.test(source)) bad.push("a folder that is not a repository root is opened");
  if ((source.match(/openRepository\(/g) ?? []).length !== 1) bad.push("openRepository is called on more than one path");
  if (!/const known = this\.find\(root\);\s+if \(known\) \{\s+this\.follow\(known, root\);\s+return;/.test(source)) bad.push("a repository the service already has is reopened");
  if (!/if \(this\.tried\.has\(key\) && !retry\) \{/.test(source)) bad.push("an unavailable root is opened again on every update");
  if (!/if \(!root \|\| !this\.isMounted\(root\)\)/.test(source)) bad.push("a worktree outside the window's folders is opened");
  if (!/generation !== this\.generation/.test(source)) bad.push("a late answer for another worktree is not dropped");
  if (!/!roots\.isEqual\(roots\.removeTrailingPathSeparator\(repository\.rootUri\), root\)/.test(source)) bad.push("a repository rooted elsewhere is accepted");
  return bad;
}

const read = (rel) => readFileSync(join(OVERLAY, rel), "utf8");
const GOOD_VIEW = read(VIEW);
const GOOD_SOURCE = read(SOURCE);

test("the Changes view, model and source follow the read-only, textContent-only rules", () => {
  assert.deepEqual(changesViewViolations(GOOD_VIEW), []);
  assert.deepEqual(readOnlyViolations(read(MODEL)), []);
  assert.deepEqual(sourceViolations(GOOD_SOURCE), []);
});

test("the checker finds each way of breaking the view rules", () => {
  const breaks = [
    [GOOD_VIEW.replace("name.textContent = row.name;", "name.innerHTML = row.name;"), "html sink innerHTML"],
    [GOOD_VIEW.replace("name.textContent = row.name;", "name.textContent = row.resource.path;"), "raw path or URI shown: name.textContent = row.resource.path"],
    [GOOD_VIEW.replace("name.textContent = row.name;", "name.textContent = row.resource.path;"), "row text not from the model: row.resource.path"],
    [GOOD_VIEW.replace("element.title = row.folder ? `${row.folder}/${row.name}` : row.name;", "element.title = row.resource.fsPath;"), "raw path or URI shown: element.title = row.resource.fsPath"],
    [GOOD_VIEW.replace("element.setAttribute('aria-label', changeRowLabel(row));", "element.setAttribute('aria-label', row.name);"), "a row's accessible name is not changeRowLabel(row)"],
    [GOOD_VIEW.replace("element.setAttribute('role', 'option');", "element.setAttribute('role', 'button');"), "a row is not a listbox option"],
    [GOOD_VIEW.replace(".textContent = changeKindGlyph(row.kind);", ".textContent = '';"), "the state is not shown as a letter and a word"],
    [GOOD_VIEW.replace(".textContent = changeKindLabel(row.kind);", ".textContent = row.folder;"), "row text not from the model: row.folder"],
    [GOOD_VIEW.replace("element.replaceChildren(state, name, where);", "element.replaceChildren(name, state, where);"), "the state is not drawn before the name"],
    [GOOD_VIEW.replace("this.viewService.reveal(diffTargetOf(row));", "this.editorService.openEditor(diffTargetOf(row));"), "opens editors itself instead of through reveal"],
    [GOOD_VIEW.replace("this.viewService.reveal(diffTargetOf(row));", "this.viewService.reveal({ ...diffTargetOf(row), label: row.resource.path });"), "reveal targets are not built by the model (diffTargetOf, reviewAllTargetOf)"],
    [GOOD_VIEW.replace("this.viewService.reveal(diffTargetOf(row));", "this.viewService.reveal({ kind: 'diff', original: row.resource, modified: row.resource, label: row.name });"), "reveal targets are not built by the model (diffTargetOf, reviewAllTargetOf)"],
    [GOOD_VIEW.replace("this.list.setAttribute('role', 'listbox');", "this.list.setAttribute('role', 'list');"), "the rows are not in a listbox"],
    [GOOD_VIEW.replace("element.className = `axis-change-row kind-${row.kind}`;", "element.className = `axis-change-row kind-${row.name}`;"), "the row class is not from the kind"],
    [GOOD_VIEW.replace("this.source.setRoot(root);", "this.source.setRoot(root); void this.gitService.repositories;"), "the view reads git itself instead of through the source"],
    [GOOD_VIEW.replace("nextActiveIndex(this.visible, this.activeId, this.activeIndex)", "Math.min(this.activeIndex, this.rows.length - 1)"), "the active row does not follow its file (nextActiveIndex)"],
    [GOOD_VIEW.replace("\t\t\tif (focusWasInside) {\n\t\t\t\tthis.summary.focus();\n\t\t\t}\n", ""), "focus is dropped when the list empties"],
    [GOOD_VIEW.replace("const existing = this.byId.get(row.id);", "const existing = undefined;"), "rows are not kept by file id"],
  ];
  for (const [source, expected] of breaks) {
    assert.notEqual(source, GOOD_VIEW, `the mutation applies: ${expected}`);
    assert.ok(changesViewViolations(source).includes(expected), `${expected}\n  got: ${changesViewViolations(source).join("; ")}`);
  }
});

test("the checker finds each way of breaking the source rules", () => {
  const OPEN = "repository = await this.isRepositoryRoot(root) ? await this.git.openRepository(root) : undefined;";
  const breaks = [
    [GOOD_SOURCE.replace(OPEN, `${OPEN} await repository?.commitFiles([], '');`), "git call other than a read: commitFiles"],
    [GOOD_SOURCE.replace(OPEN, `${OPEN} repository?.updateState(repository.state.get());`), "git call other than a read: updateState"],
    [GOOD_SOURCE.replace(OPEN, `${OPEN} await repository?.diffBetweenWithStats('HEAD', 'HEAD');`), "git call other than a read: diffBetweenWithStats"],
    [`import { spawn } from 'child_process';\n${GOOD_SOURCE}`, "import child_process"],
    [GOOD_SOURCE.replace("if (!root || !this.isMounted(root)) {", "if (!root) {"), "a worktree outside the window's folders is opened"],
    [GOOD_SOURCE.replace("if (generation !== this.generation || this._store.isDisposed) {", "if (this._store.isDisposed) {"), "a late answer for another worktree is not dropped"],
    [GOOD_SOURCE.replace("if (!repository || !roots.isEqual(roots.removeTrailingPathSeparator(repository.rootUri), root)) {", "if (!repository) {"), "a repository rooted elsewhere is accepted"],
    [GOOD_SOURCE.replace(OPEN, "repository = await this.git.openRepository(root);"), "a folder that is not a repository root is opened"],
    [GOOD_SOURCE.replace("const known = this.find(root);", "const known = undefined;"), "a repository the service already has is reopened"],
    [GOOD_SOURCE.replace("if (this.tried.has(key) && !retry) {", "if (false) {"), "an unavailable root is opened again on every update"],
    [GOOD_SOURCE.replace("this.tried.add(key);", "this.tried.add(key); void this.git.openRepository(root);"), "openRepository is called on more than one path"],
  ];
  for (const [source, expected] of breaks) {
    assert.notEqual(source, GOOD_SOURCE, `the mutation applies: ${expected}`);
    assert.ok(sourceViolations(source).includes(expected), `${expected}\n  got: ${sourceViolations(source).join("; ")}`);
  }
});

function overlayFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) overlayFiles(join(dir, e.name), out);
    else if (e.name.endsWith(".ts")) out.push(join(dir, e.name));
  }
  return out;
}

test("only the Changes view reaches IGitService, and only the model builds git: URIs (no other git path in the overlay)", () => {
  const users = [];
  const gitUris = [];
  for (const path of overlayFiles(OVERLAY)) {
    const rel = relative(OVERLAY, path).split(sep).join("/");
    if (rel.includes("/test/")) continue;
    const source = readFileSync(path, "utf8");
    if (specifiers(parse(source)).some((s) => s.endsWith("/contrib/git/common/gitService.js"))) users.push(rel);
    if (/toGitUri|GIT_SCHEME|scheme: 'git'/.test(source)) gitUris.push(rel);
  }
  assert.deepEqual(users.sort(), [VIEW, MODEL, SOURCE].sort());
  assert.deepEqual(gitUris, [MODEL]);
});
