// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Text scanners and rewrite rules for scripts/code-oss/stage-packages.mjs (ADR 0005 D3).
//
// WHAT THIS IS, AND IS NOT. Module references are found by parsing the file with the TypeScript parser
// (stage-ast.mjs), not by pattern matching text; the same parse finds the names that reach code without a
// visible specifier. The guarantee that matters is the bundle-time module-graph check (scripts/code-oss/check-daemon-graph.mjs), which reads what esbuild really resolved.
export { importSpecifiers, unsafeForms, rewriteSpecifiers, scanModules } from "./stage-ast.mjs";
import { listenerBuiltinRefusal } from "./web-rules.mjs";
export { LISTENER_BUILTINS, LISTENER_FILE, WEB_HOST_DIR } from "./web-rules.mjs";

/**
 * Node built-ins that load or run code by other means than a module specifier. No package needs them, except the
 * listed ones: `node:worker_threads` (MessageChannel only, enforced on the parse) for the daemon's in-process
 * transport, and `node:child_process` for the packages that spawn processes. Judged on `src/` files.
 */
export const LOADER_BUILTINS = new Map([
  ["node:module", new Set()],
  ["node:process", new Set()],
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
 * Exact-file exceptions to RESTRICTED_SUBPATHS: specifier -> package -> paths inside that package's `src` that may
 * import it, despite the package not being listed there. Exact paths, never patterns; mirrors HOST_FILE_RULES in
 * test/packages/imports.test.mjs and the single mint file in test/packages/principal-dist.test.mjs. The daemon host's
 * review handler mints the user principal for a person's acceptance, and its run trust minter mints the single-use run
 * attestation after main's `trust.check` (ADR 0005 D2).
 */
export const RESTRICTED_FILE_EXCEPTIONS = new Map([
  ["@axis/journal/daemon-principal", new Map([["daemon-host", new Set(["handlers/review.ts"])]])],
  ["@axis/runs/daemon-attestation", new Map([["daemon-host", new Set(["gate/run-trust.ts"])]])],
]);

/**
 * Staged modules (package name, path inside the package's src) that only the listed packages may import. The
 * owning package may always import its own modules. This is the module-graph form of RESTRICTED_SUBPATHS and the
 * rule check-daemon-graph.mjs enforces on the esbuild metafile.
 */
export const RESTRICTED_MODULES = [
  { pkg: "journal", file: "daemon-principal.ts", importers: new Set(["daemon"]), files: new Set(["daemon-host/handlers/review.ts"]) },
  { pkg: "runs", file: "daemon-attestation.ts", importers: new Set(["daemon"]), files: new Set(["daemon-host/gate/run-trust.ts"]) },
  // The modules that hold the mint symbols: only their own package may reach them.
  { pkg: "journal", file: "principal.ts", importers: new Set() },
  { pkg: "runs", file: "attestation.ts", importers: new Set() },
  { pkg: "audit", file: "lock.ts", importers: new Set() },
  // The host's run trust minter: even inside its own package only the composition points (the public index, and the composition
  // root `compose.ts`, which hands handler code the registrar only) may load it, so no handler, service or binding can mint an
  // attestation without main's per-start trust.check (TRU-2).
  { pkg: "daemon-host", file: "gate/run-trust.ts", importers: new Set(), files: new Set(["daemon-host/index.ts", "daemon-host/compose.ts"]), exact: true },
  // The composition root loads the minters: only the public index and the process entry (`entry.ts`, which calls `composeDaemonHost` and nothing else of it) may load it, so no handler can import a minter through it.
  { pkg: "daemon-host", file: "compose.ts", importers: new Set(), files: new Set(["daemon-host/index.ts", "daemon-host/entry.ts"]), exact: true },
  // The discard token minter has the same two loaders as the run trust minter.
  { pkg: "daemon-host", file: "gate/worktrees-confirm.ts", importers: new Set(), files: new Set(["daemon-host/index.ts", "daemon-host/compose.ts"]), exact: true },
  // The public index re-exports the composition (and so, through it, both minters): no staged file may load it (a barrel hop), only
  // code outside the staged tree (the overlay entry, `rel === null`) may. `outside` is what lets that importer through.
  { pkg: "daemon-host", file: "index.ts", importers: new Set(), files: new Set(), exact: true, outside: true },
  // The process entry reaches the composition root, so it is a composition point too: no staged file may load it, only the overlay entry may.
  { pkg: "daemon-host", file: "entry.ts", importers: new Set(), files: new Set(), exact: true, outside: true },
];

/** The staged modules that hold a host minter, and the only staged files that may load them or anything that reaches them. */
export const HOST_MINTER_FILES = new Set(["daemon-host/gate/run-trust.ts", "daemon-host/gate/worktrees-confirm.ts"]);
export const HOST_COMPOSITION_FILES = new Set(["daemon-host/index.ts", "daemon-host/compose.ts", "daemon-host/entry.ts"]);

/** True when the staged file `rel` (package `importerPkg`) may import restricted module `r`. `exact` ignores the owner package. */
export function mayImportRestricted(r, importerPkg, rel) {
  if (r.files?.has(rel) === true) return true;
  if (rel === null && r.outside === true) return true;
  if (r.exact === true) return false;
  return importerPkg === r.pkg || (importerPkg !== null && r.importers.has(importerPkg));
}

/**
 * Classifies one specifier found in staged package `pkg`. Returns `{ kind, ... }`, or throws a string reason.
 *   relative: stays inside the package (checked by the caller against the file system)
 *   zod:      exactly the bare `zod`
 *   axis:     `@axis/<name>` or a declared subpath, `{ name, subpath }`
 *   node:     a `node:*` built-in
 * `exportsOf(name)` returns the subpath keys the package declares (for example "./daemon-principal"), or null for an unknown package.
 */
export function classifySpecifier(spec, pkg, exportsOf, fileRel = null) {
  if (spec.startsWith("./") || spec.startsWith("../")) return { kind: "relative" };
  if (spec === "zod") return { kind: "zod" };
  if (spec.startsWith("zod/")) throw `only the "zod" entry is staged, not ${spec}`;
  if (spec.startsWith("node:")) {
    if (!/^node:[a-z_]+(?:\/[a-z0-9_]+)*$/.test(spec)) throw `malformed built-in specifier ${spec}`;
    if (pkg === "protocol") throw `node:* is not allowed in the protocol package (contracts shared with the web target): ${spec}`;
    const only = LOADER_BUILTINS.get(spec.replace(/\/.*$/, ""));
    if (only !== undefined && !only.has(pkg)) throw `${spec} loads or runs code without a module specifier and is not allowed${only.size > 0 ? ` outside ${[...only].join(", ")}` : ""}`;
    const listener = listenerBuiltinRefusal(spec, fileRel === null ? null : `${pkg}/${fileRel}`);
    if (listener !== null) throw listener;
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
      const exact = RESTRICTED_FILE_EXCEPTIONS.get(spec)?.get(pkg)?.has(fileRel) === true;
      if (allowed !== undefined && !allowed.has(pkg) && !exact) throw `${spec} may only be imported by: ${[...allowed].join(", ")}`;
    }
    return { kind: "axis", name, subpath: sub === undefined ? null : `.${sub}` };
  }
  throw `import ${spec} is outside the allowlist (relative, zod, @axis/* and node:* only)`;
}
