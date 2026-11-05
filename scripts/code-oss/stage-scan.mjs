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

export function importSpecifiers(source, { code = false } = {}) {
  if (code) source = maskComments(source);
  const found = [];
  for (const re of SPECIFIER_PATTERNS) for (const m of source.matchAll(re)) found.push(m[2]);
  return found;
}

/** Dynamic loads whose argument is not a string literal cannot be checked or rewritten. */
export function nonLiteralLoads(source) {
  return [...source.matchAll(/\b(?:import|require)\s*\(\s*(?!['"][^'"`$\\]*['"]\s*\))/g)].map((m) => m[0]);
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

/** Rewrites package specifiers to relative paths. `resolveSpec(spec)` returns the staged path (tree-relative, posix) or null. */
export function rewriteSpecifiers(source, fromFile, resolveSpec) {
  let out = source;
  for (const re of SPECIFIER_PATTERNS) {
    out = out.replace(re, (whole, head, spec) => {
      const target = resolveSpec(spec);
      if (target === null) return whole;
      let rel = posix.relative(posix.dirname(fromFile), target);
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${head}${rel}`;
    });
  }
  return out;
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
