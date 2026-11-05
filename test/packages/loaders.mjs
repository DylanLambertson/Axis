// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Shared scanning rules for test/packages/*.test.mjs (this file is not a test).
//
// WHAT THIS IS, AND IS NOT. These are TEXT LINTS over source and emitted code. They catch honest mistakes and the
// obvious ways of reaching the user-principal subpath, and nothing more. They cannot see `eval`, `new Function`,
// a loader name built at run time (`"getBuilt" + "inModule"`), an aliased or object re-export inside the daemon
// package (`const p = { mint: userPrincipal }; export { p }`), code in a language they do not read, or a native
// addon. The real guarantee is a bundle-time check on the daemon bundle's module graph (ADR 0005, staging hook,
// TODO), plus code review of whatever the daemon package exports. Do not read a passing scan as proof.

/** Every extension a script can have: JavaScript and TypeScript, in module, CommonJS and JSX flavours. */
export const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"];

/** True for a script file the scanners must read; declaration files (`.d.ts`, `.d.mts`, `.d.cts`) hold no code. */
export function isScriptFile(path) {
  if (/\.d\.[mc]?ts$/.test(path)) return false;
  return SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export const PRINCIPAL_SUBPATH = "@axis/journal/daemon-principal";

export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Ways to load a module without a static specifier the import scanner can see: `createRequire(...)` and
 * `process.getBuiltinModule(...)` (which reaches `node:module`). Packages have no use for either, so any mention is
 * refused. Returns the offending identifiers.
 */
export function forbiddenLoaders(source) {
  const text = stripComments(source);
  return [...text.matchAll(/\b(createRequire|getBuiltinModule)\b/g)].map((m) => m[1]);
}

/**
 * Re-exports of the user-principal subpath. Importing it is restricted to the daemon, and re-exporting it would hand
 * the minting function to whoever imports the re-exporter, so no file may do it: neither `export ... from` the
 * subpath, nor importing it and listing its names in an `export { ... }`.
 */
export function principalReexports(source) {
  const text = stripComments(source);
  const found = [];
  const fromSubpath = new RegExp(`\\bexport\\b[^'"\`;]*?\\bfrom\\s*['"]${PRINCIPAL_SUBPATH.replace(/[/]/g, "\\/")}['"]`, "g");
  for (const m of text.matchAll(fromSubpath)) found.push(m[0].slice(0, 60));
  const importsIt = text.includes(PRINCIPAL_SUBPATH) || /daemon-principal(?:\.js)?['"]/.test(text);
  if (importsIt) {
    for (const m of text.matchAll(/\bexport\s*(?:type\s*)?\{[^}]*\b(?:userPrincipal|UserPrincipal)\b[^}]*\}(?!\s*from\b)/g)) found.push(m[0].slice(0, 60));
    for (const m of text.matchAll(/\bexport\s+default\s+(?:userPrincipal|UserPrincipal)\b/g)) found.push(m[0]);
    for (const m of text.matchAll(/\bexport\s+(?:const|let|var)\s+\w+\s*=\s*userPrincipal\b/g)) found.push(m[0]);
  }
  return found;
}
