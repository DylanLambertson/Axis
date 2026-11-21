// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Process and resolver egress (ticket FU-EGRESS, review egress-lint r1 N2), shared by the import lint
// (test/packages/imports.test.mjs), the staging hook (stage-scan.mjs), the staged-tree check (stage-verify.mjs) and the
// bundle graph check (check-daemon-graph.mjs). Paths are staged paths: `<package>/<path inside its src>`; null means a call
// without a file, judged strictly. Matched by equality, never as a prefix or suffix.
//
//   1. `node:dns` (and `node:dns/promises`) is loaded by no shipped file: a lookup of a chosen name is a request that leaves
//      the machine (resolver exfiltration), and nothing in the daemon resolves names itself.
//   2. `node:child_process` is loaded only by the files in SPAWN_FILES, each taking only the functions listed for it (never
//      `exec`, `execSync` or `fork`, which run a shell command string or a module), and a file with a fixed program must
//      name it as a string literal. No file sets `shell` to anything but `false`. The module scanner (stage-ast.mjs
//      spawnForms) enforces the per-file names, the call shape, the program and the `shell` option on the parse, so in the
//      import lint, the staging hook and the staged-tree check; the bundle graph check applies only which file may load it.

/** Built-ins that resolve names over the network. No shipped file may load them. */
export const RESOLVER_BUILTINS = new Set(["node:dns"]);
export const SPAWN_BUILTIN = "node:child_process";

/**
 * The files that start programs, what they may take from `node:child_process`, and the program when it is fixed (`null`:
 * the program is a value, see `runs`: those files are the PTY-2 boundary, any program by value but never a shell). `injectable`:
 * the file may take an injected spawn function, `const f = injected ?? spawn`, not exported. A new file, a new function or a
 * new program here needs an ADR 0005 amendment.
 */
export const SPAWN_FILES = new Map([
  ["audit/lock.ts", { names: new Set(["execFileSync"]), program: "ps", runs: "`ps -o lstart= -p <pid>`: the start time of the lock holder" }],
  ["worktrees/lock.ts", { names: new Set(["execFile"]), program: "/bin/ps", runs: "`/bin/ps -o lstart= -p <pid>`: the start time of the lock holder" }],
  ["git-ops/nodeRunner.ts", { names: new Set(["spawn"]), program: null, runs: "git, by the absolute path the trusted resolver returned, with an argv vector" }],
  ["git-snapshot/git.ts", { names: new Set(["execFile"]), program: null, runs: "git (`rev-parse`, `config --list`), by the absolute path given" }],
  ["git-snapshot/indexflags.ts", { names: new Set(["spawn"]), program: null, runs: "git (`ls-files` index flags), by the absolute path given" }],
  ["worktrees/git.ts", { names: new Set(["spawn"]), program: null, runs: "git, by the resolved path, with an argument vector" }],
  ["broker/runner.ts", { names: new Set(["spawn"]), program: null, injectable: true, runs: "the approved command's argv (`argv[0]` an absolute path), the run_command boundary (PTY-2, Phase 3 sandbox)" }],
]);

const base = (spec) => spec.replace(/\/.*$/, "");

/** Why the staged file `rel` may not load the built-in `spec`, or null. */
export function egressBuiltinRefusal(spec, rel) {
  const b = base(spec);
  if (RESOLVER_BUILTINS.has(b)) return `${spec} resolves names over the network: no shipped file may load it`;
  if (b === SPAWN_BUILTIN && !(typeof rel === "string" && SPAWN_FILES.has(rel))) return `${spec} starts programs: only the files named in SPAWN_FILES (scripts/code-oss/egress-rules.mjs) may load it`;
  return null;
}

/**
 * The staged path of a scanned file, as each caller names it (the import lint's package-relative `pkgRel`, the staging step's
 * `packages/<pkg>/src/...`, the staged tree's `<pkg>/...`), or null for anything else, including a path outside `src`.
 */
export function stagedPathOf(file, pkg, pkgRel = null) {
  if (typeof pkg !== "string") return null;
  const norm = (p) => (typeof p === "string" ? p.split("\\").join("/") : null);
  const r = norm(pkgRel);
  if (r !== null) return r.startsWith("src/") ? `${pkg}/${r.slice(4)}` : null;
  const f = norm(file);
  if (f === null) return null;
  if (f.startsWith(`packages/${pkg}/src/`)) return `${pkg}/${f.slice(`packages/${pkg}/src/`.length)}`;
  return f.startsWith(`${pkg}/`) ? f : null;
}
