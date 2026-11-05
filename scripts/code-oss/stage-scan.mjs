// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Text scanners and rewrite rules for scripts/code-oss/stage-packages.mjs (ADR 0005 D3).
//
// WHAT THIS IS, AND IS NOT. These are text lints over TypeScript and JavaScript source. They run on the RAW text,
// comments included, so an import hidden in or after a comment still counts (a false positive on commented-out
// code is accepted: the staging hook fails closed). They cannot see `eval`-built names, string concatenation or
// code in another language. The guarantee that matters is the bundle-time module-graph check
// (scripts/code-oss/check-daemon-graph.mjs), which reads what esbuild really resolved.
import { posix } from "node:path";

/** Matches the specifier in every import form. Group 1 is the text before the specifier, 2 the specifier. */
export const SPECIFIER_PATTERNS = [
  /(\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"])([^'"]+)(?=['"])/g,
  /(\bimport\s*['"])([^'"]+)(?=['"])/g,
  /(\bimport\s*\(\s*['"])([^'"]+)(?=['"])/g,
  /(\brequire\s*\(\s*['"])([^'"]+)(?=['"])/g,
  // Independent of what precedes `from` (a regex literal, a string-named binding, a comment): fail closed.
  /((?<![\w'"`])from\s*['"])([^'"\s,;]+)(?=['"])/g,
];

/**
 * Blanks comments (keeping newlines and string contents), so a scan sees only code. Tracks quotes, template
 * literals and regular-expression literals well enough that a `//` inside a string or a quote inside a regex does
 * not desynchronise it. Used for vendored third-party files only; Axis sources are scanned raw, comments included.
 */
export function maskComments(src) {
  let out = "";
  let i = 0;
  let prev = ""; // last significant character, to tell a division from a regular-expression literal
  const blank = (t) => t.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
    } else if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = "/";
    } else {
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

const NOT_VALUE_END = new Set(["return", "typeof", "instanceof", "in", "of", "void", "delete", "new", "case", "throw", "else", "do", "yield", "await"]);
const IMPORT_CLAUSE_STOP = new Set(["function", "class", "const", "let", "var", "interface", "enum", "namespace", "default", "declare", "abstract", "async", "module"]);

/**
 * A small JavaScript/TypeScript tokenizer: identifiers (and numbers), strings, template literals (nested `${}`
 * included), regular-expression literals and single punctuation characters. Comments are skipped. Strings carry
 * `start`/`end` of their contents (inside the quotes). It does not need to be a full lexer: it has to tell code from
 * comments and strings, which the regular expressions cannot do (`import /* ' *\/ ...`, `{ "z" as z }`).
 */
export function tokenize(src, { regexAfterParen = false } = {}) {
  const toks = [];
  const stack = []; // "tmpl" marks a `${` inside a template literal; "{" an ordinary block
  let i = 0;
  const prevIsValue = () => {
    const t = toks[toks.length - 1];
    if (!t) return false;
    if (t.type === "id") return !NOT_VALUE_END.has(t.value);
    if (t.type === "str" || t.type === "tmpl" || t.type === "re") return true;
    if (t.value === ")") return !regexAfterParen; // `if (x) /re/.test(y)` is a regex, `(a) / b` a division: scan both
    return t.value === "]" || t.value === "}";
  };
  const readTemplate = () => {
    // i is just after a backtick or just after the `}` that closes a `${`
    const start = i;
    while (i < src.length) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "`") {
        i++;
        toks.push({ type: "tmpl", value: src.slice(start, i - 1), start, end: i - 1 });
        return;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        toks.push({ type: "tmpl", value: src.slice(start, i), start, end: i, open: true });
        i += 2;
        stack.push("tmpl");
        return;
      } else i++;
    }
    toks.push({ type: "tmpl", value: src.slice(start), start, end: src.length });
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (/\s/.test(c)) i++;
    else if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      toks.push({ type: "str", value: src.slice(i + 1, j), start: i + 1, end: j });
      i = j + 1;
    } else if (c === "`") {
      i++;
      readTemplate();
    } else if (c === "/" && !prevIsValue()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      toks.push({ type: "re", value: src.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
    } else if (/[A-Za-z0-9_$#\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$#\u0080-\uffff]/.test(src[j])) j++;
      toks.push({ type: "id", value: src.slice(i, j), start: i, end: j });
      i = j;
    } else {
      if (c === "{") stack.push("{");
      if (c === "}") {
        if (stack.pop() === "tmpl") {
          i++;
          readTemplate();
          continue;
        }
      }
      toks.push({ type: "p", value: c, start: i, end: i + 1 });
      i++;
    }
  }
  return toks;
}

/**
 * Every module specifier in the source, as `{ spec, start, end }` (offsets of the text between the quotes), found on
 * tokens, not text: `import ... from "x"`, `export ... from "x"` (string-named bindings such as `{ "a" as b }`
 * included), `import "x"`, `import("x")` and `require("x")`. A string right after an identifier `from` is always
 * taken as a specifier, whatever precedes it (fail closed).
 */
export function tokenSpecifiers(src) {
  const all = new Map();
  for (const regexAfterParen of [false, true]) for (const s of tokenSpecifiersOf(tokenize(src, { regexAfterParen }))) all.set(s.start, s);
  return [...all.values()].sort((a, b) => a.start - b.start);
}

function tokenSpecifiersOf(t) {
  const found = new Map();
  const add = (tok) => found.set(tok.start, { spec: tok.value, start: tok.start, end: tok.end });
  const isId = (k, v) => t[k]?.type === "id" && t[k].value === v && t[k - 1]?.value !== ".";
  for (let k = 0; k < t.length; k++) {
    if (t[k].type === "id" && t[k].value === "from" && t[k + 1]?.type === "str" && t[k - 1]?.value !== ".") add(t[k + 1]);
    if (isId(k, "import")) {
      if (t[k + 1]?.type === "str") add(t[k + 1]);
      else if (t[k + 1]?.value === "(" && t[k + 2]?.type === "str") add(t[k + 2]);
    }
    if (isId(k, "require") && t[k + 1]?.value === "(" && t[k + 2]?.type === "str") add(t[k + 2]);
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** Dynamic loads whose argument is not a single string literal, found on tokens. */
export function tokenNonLiteralLoads(src) {
  const bad = [];
  for (const regexAfterParen of [false, true]) {
    const here = nonLiteralOf(tokenize(src, { regexAfterParen }));
    if (here.length > bad.length) bad.splice(0, bad.length, ...here);
  }
  return bad;
}

function nonLiteralOf(t) {
  const bad = [];
  for (let k = 0; k < t.length; k++) {
    const call = (t[k].value === "import" || t[k].value === "require") && t[k].type === "id" && t[k - 1]?.value !== "." && t[k + 1]?.value === "(";
    if (!call) continue;
    const arg = t[k + 2];
    const after = t[k + 3]?.value;
    if (arg?.type !== "str" || (after !== ")" && after !== ",")) bad.push(`${t[k].value}(`);
  }
  return bad;
}

/** Every specifier text in the source: the token scan, plus the text patterns (which also see comments, unless `code`). */
export function importSpecifiers(source, { code = false } = {}) {
  const found = tokenSpecifiers(source).map((s) => s.spec);
  const text = code ? maskComments(source) : source;
  for (const re of SPECIFIER_PATTERNS) for (const m of text.matchAll(re)) found.push(m[2]);
  return [...new Set(found)];
}

/** Dynamic loads whose argument is not a string literal cannot be checked or rewritten. */
export function nonLiteralLoads(source) {
  return tokenNonLiteralLoads(source);
}

/**
 * Other ways to reach code the specifier scan cannot see. Packages have no use for any of them, so a mention is
 * refused. Returns the offending tokens.
 */
export function hiddenLoaders(source) {
  const found = [];
  const words = /\b(createRequire|getBuiltinModule|dlopen|eval)\b/g;
  for (const m of source.matchAll(words)) found.push(m[1]);
  for (const m of source.matchAll(/\bnew\s+Function\b/g)) found.push(m[0]);
  for (const m of source.matchAll(/\bimport\s*\.\s*meta\s*\.\s*resolve\b/g)) found.push(m[0].replace(/\s+/g, ""));
  for (const m of source.matchAll(/\bprocess\s*\.\s*binding\b/g)) found.push(m[0].replace(/\s+/g, ""));
  for (const m of source.matchAll(/\bmodule\s*\.\s*(?:require|constructor)\b/g)) found.push(m[0].replace(/\s+/g, ""));
  for (const m of source.matchAll(/\/\/\/\s*<reference\b/g)) found.push("triple-slash reference");
  return found;
}

/**
 * Rewrites package specifiers to relative paths, on the tokens found by `tokenSpecifiers`. `resolveSpec(spec)` returns
 * the staged path (tree-relative, posix) or null. A specifier the token scan cannot see is left alone, and the
 * check on the staged file then refuses it.
 */
export function rewriteSpecifiers(source, fromFile, resolveSpec) {
  let out = "";
  let at = 0;
  // Token matches, plus the text patterns' matches (they also see comments, so a commented-out import is rewritten
  // too and cannot leave a bare specifier in the staged file).
  const spans = new Map(tokenSpecifiers(source).map((t) => [t.start, t]));
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(re)) {
      const start = m.index + m[1].length;
      if (!spans.has(start)) spans.set(start, { spec: m[2], start, end: start + m[2].length });
    }
  }
  for (const { spec, start, end } of [...spans.values()].sort((a, b) => a.start - b.start)) {
    const target = resolveSpec(spec);
    if (target === null) continue;
    let rel = posix.relative(posix.dirname(fromFile), target);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    out += source.slice(at, start) + rel;
    at = end;
  }
  return out + source.slice(at);
}

/** Subpaths of `@axis/*` that only some packages may import (ADR 0005 D2; mirrors test/packages/imports.test.mjs). */
export const RESTRICTED_SUBPATHS = new Map([
  ["@axis/journal/daemon-principal", new Set(["daemon"])],
  ["@axis/runs/daemon-attestation", new Set(["daemon"])],
]);

/**
 * Staged modules (package name, path inside the package's src) that only the listed packages may import. The
 * owning package may always import its own modules. This is the module-graph form of RESTRICTED_SUBPATHS and the
 * rule check-daemon-graph.mjs enforces on the esbuild metafile.
 */
export const RESTRICTED_MODULES = [
  { pkg: "journal", file: "daemon-principal.ts", importers: new Set(["daemon"]) },
  { pkg: "runs", file: "daemon-attestation.ts", importers: new Set(["daemon"]) },
  // The modules that hold the mint symbols: only their own package may reach them.
  { pkg: "journal", file: "principal.ts", importers: new Set() },
  { pkg: "runs", file: "attestation.ts", importers: new Set() },
  { pkg: "audit", file: "lock.ts", importers: new Set() },
];

/**
 * Classifies one specifier found in staged package `pkg`. Returns `{ kind, ... }`, or throws a string reason.
 *   relative: stays inside the package (checked by the caller against the file system)
 *   zod:      exactly the bare `zod`
 *   axis:     `@axis/<name>` or a declared subpath, `{ name, subpath }`
 *   node:     a `node:*` built-in
 * `exportsOf(name)` returns the subpath keys the package declares (for example "./daemon-principal"), or null for an unknown package.
 */
export function classifySpecifier(spec, pkg, exportsOf) {
  if (spec.startsWith("./") || spec.startsWith("../")) return { kind: "relative" };
  if (spec === "zod") return { kind: "zod" };
  if (spec.startsWith("zod/")) throw `only the "zod" entry is staged, not ${spec}`;
  if (spec.startsWith("node:")) {
    if (!/^node:[a-z_]+(?:\/[a-z0-9_]+)*$/.test(spec)) throw `malformed built-in specifier ${spec}`;
    return { kind: "node" };
  }
  if (spec.startsWith("@axis/")) {
    const m = /^@axis\/([a-z][a-z0-9-]*)(\/[A-Za-z0-9._-]+)?$/.exec(spec);
    if (!m) throw `malformed workspace specifier ${spec}`;
    const [, name, sub] = m;
    const keys = exportsOf(name);
    if (keys === null) throw `unknown workspace package ${spec}`;
    if (sub !== undefined) {
      if (!keys.includes(`.${sub}`)) throw `${spec} is not a subpath the package exports (or is not stageable)`;
      const allowed = RESTRICTED_SUBPATHS.get(spec);
      if (allowed !== undefined && !allowed.has(pkg)) throw `${spec} may only be imported by: ${[...allowed].join(", ")}`;
    }
    return { kind: "axis", name, subpath: sub === undefined ? null : `.${sub}` };
  }
  throw `import ${spec} is outside the allowlist (relative, zod, @axis/* and node:* only)`;
}
