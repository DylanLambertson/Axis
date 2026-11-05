// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Text scanners and rewrite rules for scripts/code-oss/stage-packages.mjs (ADR 0005 D3).
//
// WHAT THIS IS, AND IS NOT. Module references are found by parsing the file with the TypeScript parser
// (stage-ast.mjs), not by pattern matching text; the same parse finds the names that reach code without a
// visible specifier. The guarantee that matters is the bundle-time module-graph check (scripts/code-oss/check-daemon-graph.mjs), which reads what esbuild really resolved.
export { importSpecifiers, unsafeForms, rewriteSpecifiers, scanModules } from "./stage-ast.mjs";

/**
 * Node built-ins that load or run code by other means than a module specifier. No package needs them, except the
 * listed ones: `node:worker_threads` (MessageChannel only, enforced on the parse) for the daemon's in-process
 * transport, and `node:child_process` for the packages that spawn processes. Judged on `src/` files.
 */
export const LOADER_BUILTINS = new Map([
  ["node:module", new Set()],
  ["node:vm", new Set()],
  ["node:repl", new Set()],
  ["node:inspector", new Set()],
  ["node:wasi", new Set()],
  ["node:worker_threads", new Set(["daemon"])],
  // Runs programs: only the packages that spawn processes today. A new one needs an ADR 0005 amendment.
  ["node:child_process", new Set(["audit", "broker", "git-ops", "git-snapshot", "worktrees"])],
]);

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
    if (pkg === "protocol") throw `node:* is not allowed in the protocol package (contracts shared with the web target): ${spec}`;
    const only = LOADER_BUILTINS.get(spec.replace(/\/.*$/, ""));
    if (only !== undefined && !only.has(pkg)) throw `${spec} loads or runs code without a module specifier and is not allowed${only.size > 0 ? ` outside ${[...only].join(", ")}` : ""}`;
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
