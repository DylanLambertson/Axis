// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Process and resolver egress (ticket FU-EGRESS, review egress-lint r1 N2): `node:dns` in no shipped file, `node:child_process`
// only in the files named in scripts/code-oss/egress-rules.mjs, with only their functions, their fixed program and no shell.
// Judged by the import lint, the staging classification, the staged-tree check and the bundle graph check, which share the rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsafeForms, importSpecifiers } from "../../scripts/code-oss/stage-ast.mjs";
import { classifySpecifier } from "../../scripts/code-oss/stage-scan.mjs";
import { STAGE_ROOT, checkStagedFile } from "../../scripts/code-oss/stage-verify.mjs";
import { DEFAULT_ENTRY, checkMetafile } from "../../scripts/code-oss/check-daemon-graph.mjs";
import { SPAWN_FILES, egressBuiltinRefusal, stagedPathOf } from "../../scripts/code-oss/egress-rules.mjs";
import { sourceFiles, violation } from "./imports.test.mjs";

const packagesDir = fileURLToPath(new URL("../../packages/", import.meta.url));
const split = (staged) => [staged.split("/")[0], staged.split("/").slice(1).join("/")];
/** The four checks on one (staged path, specifier): true when every one refuses, false when every one accepts. */
const verdicts = (staged, spec) => {
  const [pkg, rel] = split(staged);
  const dir = join(packagesDir, pkg);
  const lint = violation(pkg, spec, join(dir, "src", ...rel.split("/")), dir) !== null;
  let classify = false;
  try { classifySpecifier(spec, pkg, () => [], rel); } catch (e) { assert.equal(typeof e, "string"); classify = true; }
  let verify = false;
  try { checkStagedFile(staged, `import "${spec}";\n`, new Set([staged])); } catch (e) { assert.equal(e.name, "StageError", String(e)); verify = true; }
  const P = (r) => `${STAGE_ROOT}/${r}`;
  const meta = { inputs: { [DEFAULT_ENTRY]: { imports: [{ path: P(staged), kind: "import-statement" }] }, [P(staged)]: { imports: [{ path: spec, kind: "import-statement", external: true }] } } };
  const graph = checkMetafile(meta, { zod: null, files: [{ path: staged }] }).some((t) => t.includes(spec));
  return [lint, classify, verify, graph];
};
const all = (v, want, what) => assert.deepEqual(v, [want, want, want, want], `${what}: [lint, classify, verify, graph]`);

test("node:dns and node:dns/promises are refused in every shipped file, by every check; tests may use them", () => {
  for (const spec of ["node:dns", "node:dns/promises"]) {
    for (const f of ["daemon-host/web/server.ts", "daemon-host/bindings/providers.ts", "daemon-host/entry.ts", ...SPAWN_FILES.keys(), "anthropic/adapter.ts"]) all(verdicts(f, spec), true, `${spec} in ${f}`);
    assert.notEqual(egressBuiltinRefusal(spec, null), null, "a call without a file is judged strictly");
    assert.equal(violation("daemon-host", spec, join(packagesDir, "daemon-host", "test", "a.test.ts"), join(packagesDir, "daemon-host")), null, "tests may");
  }
  // Not a resolver: an unrelated built-in whose name starts the same way is judged on its own.
  assert.equal(egressBuiltinRefusal("node:dnsx", "audit/lock.ts"), null);
});

test("node:child_process is accepted in exactly the named files, by every check", () => {
  assert.equal(SPAWN_FILES.size, 8);
  for (const f of SPAWN_FILES.keys()) all(verdicts(f, "node:child_process"), false, f);
  const near = [
    "audit/x.ts", "audit/lock.tsx", "audit/lock.ts.ts", "audit/sub/lock.ts", "audit/Lock.ts", "broker/index.ts", "broker/x/runner.ts",
    "git-ops/runner.ts", "git-ops/git.ts", "git-snapshot/lock.ts", "worktrees/nodeRunner.ts", "daemon-host/bindings/providers.ts",
    "daemon-host/web/server.ts", "pty-process/ports.ts", "anthropic/adapter.ts", "runs/git.ts", "daemon-host/audit/lock.ts", "git-ops/x/git-ops/nodeRunner.ts",
  ];
  for (const f of near) all(verdicts(f, "node:child_process"), true, f);
  assert.notEqual(egressBuiltinRefusal("node:child_process", null), null, "a call without a file is judged strictly");
  assert.notEqual(egressBuiltinRefusal("node:child_process/x", "daemon-host/x.ts"), null, "a subpath is the same built-in");
  assert.equal(violation("git-ops", "node:child_process", join(packagesDir, "git-ops", "test", "a.test.ts"), join(packagesDir, "git-ops")), null, "tests may");
});

test("the bare forms are outside the allowlist everywhere, the named files included", () => {
  for (const spec of ["dns", "dns/promises", "child_process", "cluster"]) {
    for (const f of [...SPAWN_FILES.keys(), "daemon-host/web/server.ts"]) {
      const [pkg, rel] = split(f);
      assert.notEqual(violation(pkg, spec, join(packagesDir, pkg, "src", ...rel.split("/")), join(packagesDir, pkg)), null, `${spec} in ${f}`);
      assert.throws(() => classifySpecifier(spec, pkg, () => [], rel), (e) => typeof e === "string", `${spec} in ${f}`);
      assert.throws(() => checkStagedFile(f, `import "${spec}";\n`, new Set([f])), /bare import/, `${spec} in ${f}`);
    }
  }
  assert.throws(() => classifySpecifier("node:cluster", "broker", () => [], "runner.ts"), /loads or runs code/);
});

test("the staged path is named exactly as each caller passes it, never as a suffix", () => {
  const cases = [
    [["/r/packages/audit/src/lock.ts", "audit", "src/lock.ts"], "audit/lock.ts"],
    [["x.ts", "audit", "src\\lock.ts"], "audit/lock.ts"],
    [["packages/audit/src/lock.ts", "audit", null], "audit/lock.ts"],
    [["audit/lock.ts", "audit", null], "audit/lock.ts"],
    [["audit/lock.ts", "audit", "test/lock.ts"], null],
    [["xpackages/audit/src/lock.ts", "audit", null], null],
    [["packages/audit/src/lock.ts", "broker", null], null],
    [["xaudit/lock.ts", "audit", null], null],
    [["audit/lock.ts", null, null], null],
  ];
  for (const [args, want] of cases) assert.equal(stagedPathOf(...args), want, JSON.stringify(args));
});

/** What the scanner says about `src` placed at the staged path `staged`, as the import lint calls it and as the staged check does. */
const forms = (staged, src) => {
  const [pkg, rel] = split(staged);
  const viaLint = unsafeForms(src, join(packagesDir, pkg, "src", rel), { pkg, shipped: true, pkgRel: `src/${rel}` });
  const viaStaged = unsafeForms(src, staged, { pkg, shipped: true });
  assert.deepEqual(viaLint, viaStaged, "the lint and the staged check see the same file");
  assert.deepEqual(unsafeForms(src, `packages/${pkg}/src/${rel}`, { pkg }), viaStaged, "and so does the staging hook");
  return viaStaged;
};
const refused = (staged, src, re) => assert.ok(forms(staged, src).some((m) => re.test(m)), `${staged}: ${src}\n${JSON.stringify(forms(staged, src))}`);
const accepted = (staged, src) => assert.deepEqual(forms(staged, src), [], `${staged}: ${src}`);

test("a named file takes only its own functions, statically and by name, and only calls them", () => {
  const S = 'import { spawn } from "node:child_process";\n';
  accepted("git-ops/nodeRunner.ts", `${S}spawn(p, [], { shell: false });`);
  accepted("git-ops/nodeRunner.ts", `spawn(p, [...argv], { cwd });\n${S}`);
  accepted("git-ops/nodeRunner.ts", `${S}spawn("/usr/bin/git", [], {});`);
  accepted("broker/runner.ts", 'import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";\nconst f = o.spawn ?? nodeSpawn;\nlet c: ChildProcess; type T = typeof nodeSpawn;');
  accepted("audit/lock.ts", 'import { execFileSync } from "node:child_process";\nexecFileSync("ps", ["-o", "lstart="], { encoding: "utf8", "timeout": 2000 });');
  accepted("worktrees/lock.ts", "import { execFile } from 'node:child_process';\nexecFile(`/bin/ps`, [], { env: { ...e } }, (err, out) => {});");
  const named = /is not one this file may use/;
  for (const fn of ["exec", "execSync", "fork", "spawnSync", "execFileSync", "execFile"]) refused("git-ops/nodeRunner.ts", `import { ${fn} } from "node:child_process";\n${fn}(p);`, named);
  refused("git-ops/nodeRunner.ts", 'import { exec as spawn } from "node:child_process";\nspawn(p);', named);
  refused("audit/lock.ts", 'import { spawn } from "node:child_process";\nspawn("ps");', named);
  refused("git-ops/nodeRunner.ts", 'import * as cp from "node:child_process";\ncp.spawn(p);', /by name only/);
  refused("git-ops/nodeRunner.ts", 'import cp from "node:child_process";\ncp.spawn(p);', /by name only/);
  refused("git-ops/nodeRunner.ts", 'import cp, { spawn } from "node:child_process";\nspawn(p);', /by name only/);
  refused("git-ops/nodeRunner.ts", 'import cp = require("node:child_process");\ncp.spawn(p);', /never re-exported or required/);
  refused("git-ops/nodeRunner.ts", 'export { spawn } from "node:child_process";', /never re-exported or required/);
  refused("git-ops/nodeRunner.ts", 'export * from "node:child_process";', /never re-exported or required/);
  refused("git-ops/nodeRunner.ts", 'const cp = await import("node:child_process");', /never dynamically/);
  refused("git-ops/nodeRunner.ts", 'const cp = require("node:child_process");', /never dynamically/);
  refused("git-ops/nodeRunner.ts", "const cp = await import(`node:child_process/x`);", /never dynamically/);
  const value = /may only be called/;
  for (const use of ["const s = spawn;", "export { spawn };", "export default spawn;", "g(spawn);", "const o = { spawn };", "const o = { run: spawn };", "return spawn;", "(spawn as any)(p);", "(0, spawn)(p);", "x = spawn;", "const s = spawn || g;", "const s = g ?? h ?? spawn ? 1 : 2;", "[spawn];", "spawn.call(null, p);"]) {
    refused("git-ops/nodeRunner.ts", `${S}${use}`, value);
  }
  refused("git-ops/nodeRunner.ts", 'import { spawn as s } from "node:child_process";\nconst t = s;', value);
  refused("audit/lock.ts", 'import { execFileSync } from "node:child_process";\nconst f = o.run ?? execFileSync;', value);
  // The injected default: bound once by const, and then only called.
  const B = 'import { spawn as nodeSpawn } from "node:child_process";\n';
  accepted("broker/runner.ts", `${B}function r() { f(p, [...a.slice(1)], { shell: false }); }\nconst f = o.spawn ?? nodeSpawn;`);
  for (const use of ["g(f);", "export { f };", "const h = f;", "return f;", "const o2 = { f };"]) refused("broker/runner.ts", `${B}const f = o.spawn ?? nodeSpawn;\n${use}`, value);
  // Never exported, in any form, and only where the rule allows an injected default (the broker).
  for (const use of ["export const f = o.spawn ?? nodeSpawn;", "export const f = o.spawn ?? nodeSpawn, g = 1;"]) refused("broker/runner.ts", `${B}${use}`, value);
  for (const use of ["export { f };", "export { f as spawn };", "export default f;", "module.exports.f = f;", "exports.f = f;", "export const g = f;", "export function g() { return f; }", "export class G { s = f; }", "export let g = f;", "export var g = f;"]) {
    refused("broker/runner.ts", `${B}const f = o.spawn ?? nodeSpawn;\n${use}`, value);
  }
  for (const f of ["git-ops/nodeRunner.ts", "git-snapshot/indexflags.ts", "worktrees/git.ts"]) refused(f, 'import { spawn } from "node:child_process";\nconst f = o.spawn ?? spawn;', value);
  refused("git-snapshot/git.ts", 'import { execFile } from "node:child_process";\nconst f = o.x ?? execFile;', value);
  for (const decl of ["let f = o.spawn ?? nodeSpawn;", "var f = o.spawn ?? nodeSpawn;", "const f = (o.spawn ?? nodeSpawn);", "const f = o.spawn ?? nodeSpawn ?? g;", "const { f } = o.spawn ?? nodeSpawn;", "f = o.spawn ?? nodeSpawn;", "const f = o.spawn || nodeSpawn;"]) {
    refused("broker/runner.ts", `${B}${decl}`, value);
  }
});

test("a file with a fixed program names exactly that literal", () => {
  const A = 'import { execFileSync } from "node:child_process";\n';
  for (const p of ['"curl"', '"/bin/ps"', "prog", '"ps" + x', "`p${s}`", '"ps "', "/* none */"]) refused("audit/lock.ts", `${A}execFileSync(${p}, a);`, /runs only ps/);
  for (const p of ['"ps"', '"/usr/bin/ps"', "cmd"]) refused("worktrees/lock.ts", `import { execFile } from "node:child_process";\nexecFile(${p}, a);`, /runs only \/bin\/ps/);
});

test("the shell option is only ever the literal false, in every spelling", () => {
  const S = 'import { spawn } from "node:child_process";\n';
  const shell = /shell is only ever/;
  for (const opt of ["shell: true", 'shell: "/bin/sh"', "shell: x", "shell: !0", "shell", '"shell": true', "'shell': 1", '["shell"]: true', "[`shell`]: true"]) {
    for (const f of ["git-ops/nodeRunner.ts", "broker/runner.ts", "audit/lock.ts"]) refused(f, `${S}const o = { ${opt} };`, shell);
  }
  refused("broker/runner.ts", "const o = { shell: true };", shell);
  for (const m of ["get shell() { return true; }", "set shell(v) {}", "shell() { return true; }", '"shell"() {}', '["shell"]() {}', "get [`shell`]() { return 1; }", "async shell() {}", "*shell() {}"]) {
    refused("git-ops/nodeRunner.ts", `${S}spawn(p, [], { ${m} });`, shell);
  }
  refused("git-ops/nodeRunner.ts", `${S}class O { shell = true; }`, shell);
  refused("git-ops/nodeRunner.ts", `${S}class O { get shell() { return true; } }`, shell);
  for (const w of ["o.shell = true;", 'o["shell"] = "/bin/sh";', "o.shell ||= true;", "o.shell ??= x;"]) refused("worktrees/git.ts", `${S}${w}`, shell);
  accepted("git-ops/nodeRunner.ts", `${S}spawn(p, [], { shell: false, "env": {}, ...(c ? {} : { signal }) }); const v = o.shell;`);
});

test("a spawn function is called as (program, [argv], { options }), so the options can be traced", () => {
  const S = 'import { spawn } from "node:child_process";\n';
  const shape = /is called as \(program, \[argv\], \{ options \}\)/;
  const calls = [
    "spawn(p, [], o);", "spawn(p, [], { ...o });", "spawn(p, [], { ...(c ? o : {}) });", "spawn(p, [], { ...(c ? {} : { ...o }) });", "spawn(p, [], Object.assign({}, o));",
    "spawn(p, [], mk());", "spawn(p, [], { [k]: true });", '[`spawn`](p, [], {});', "spawn(p, [], { get cwd() { return d; } });", "spawn(p, [], { m() {} });",
    "spawn(p, argv, {});", "spawn(p, a.slice(1), {});", "spawn(p, { shell: true }, {});", "spawn(p, o);", "spawn(p);", "spawn(p, [], {}, () => {});", "spawn(...args);",
    "spawn(p, ...rest);", "spawn(...[p, { shell: true }], [], {});", "spawn(...pa, [], {});", "spawn?.(p, [], {});", "spawn(p, [], { shell: false }, x);",
  ].filter((c) => c.startsWith("spawn"));
  for (const c of calls) refused("git-ops/nodeRunner.ts", `${S}${c}`, shape);
  const E = 'import { execFile } from "node:child_process";\n';
  accepted("git-snapshot/git.ts", `${E}execFile(g, [...b], { cwd }, (e, out) => {});`);
  accepted("git-snapshot/git.ts", `${E}execFile(g, [], { cwd });`);
  accepted("git-snapshot/git.ts", `${E}execFile(g, [], { cwd }, function cb() {});`);
  for (const c of ["execFile(g, [], { cwd }, cb);", "execFile(g, [], { cwd }, () => {}, x);", "execFile(g, [], o, () => {});"]) refused("git-snapshot/git.ts", `${E}${c}`, shape);
  refused("audit/lock.ts", 'import { execFileSync } from "node:child_process";\nexecFileSync("ps", [], {}, () => {});', shape);
  // A fixed program's argv is written out: no spread (the value-program files may spread theirs).
  for (const argv of ["[...a]", '["-o", ...a]', '["-o", "lstart=", "-p", ...[String(pid)]]']) {
    refused("audit/lock.ts", `import { execFileSync } from "node:child_process";\nexecFileSync("ps", ${argv}, {});`, shape);
    refused("worktrees/lock.ts", `import { execFile } from "node:child_process";\nexecFile("/bin/ps", ${argv}, {}, () => {});`, shape);
  }
  accepted("audit/lock.ts", 'import { execFileSync } from "node:child_process";\nexecFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2000 });');
  // The injected default is held to the same shape.
  const B = 'import { spawn as nodeSpawn } from "node:child_process";\nconst f = o.spawn ?? nodeSpawn;\n';
  for (const c of ["f(p, a, {});", "f(p, [], o);", "f(p, [], { ...o });"]) refused("broker/runner.ts", `${B}${c}`, shape);
});

test("everywhere else, every way to reach a process or resolver is refused", () => {
  const where = ["daemon-host/bindings/providers.ts", "daemon-host/handlers/git.ts", "audit/x.ts", "broker/index.ts"];
  const srcs = [
    'import { spawn } from "node:child_process";\nspawn("curl");',
    'import { exec } from "child_process";\nexec("curl x | sh");',
    "const m = 'node:child_process'; const cp = await import(m);",
    'const cp = require("node:child_process");',
    "const r = require; r('node:dns');",
    'const req = createRequire(import.meta.url); req("node:child_process");',
    'process.binding("spawn_sync");',
    'process["binding"]("cares_wrap");',
    'process.getBuiltinModule("node:dns");',
    'globalThis.process.getBuiltinModule("node:child_process");',
    "const { lookup } = await import(`node:dns`); lookup(name);",
  ];
  for (const f of where) {
    for (const s of srcs) {
      const [pkg, rel] = split(f);
      const dir = join(packagesDir, pkg);
      const file = join(dir, "src", rel);
      const specs = importSpecifiers(s, file).filter((x) => violation(pkg, x, file, dir) !== null);
      assert.ok(forms(f, s).length + specs.length >= 1, `${f}: ${s}`);
    }
  }
  // Tests are not shipped: the scanner leaves their child_process use alone.
  assert.deepEqual(unsafeForms('import * as cp from "node:child_process";\nconst e = cp.exec;', "a.test.ts", { pkg: "git-ops", shipped: false, pkgRel: "test/a.test.ts" }), []);
});

test("real tree: the named files are exactly the shipped files that load node:child_process, and only the egress client loads node:dns", () => {
  const spawners = [];
  const resolvers = [];
  for (const pkg of readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory())) {
    const srcDir = join(packagesDir, pkg, "src");
    let present = true;
    try { statSync(srcDir); } catch { present = false; }
    if (!present) continue;
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(srcDir.length + 1).split("\\").join("/");
      const specs = importSpecifiers(text, file).map((s) => s.replace(/\/.*$/, ""));
      if (specs.includes("node:child_process")) spawners.push(`${pkg}/${rel}`);
      if (specs.includes("node:dns")) resolvers.push(`${pkg}/${rel}`);
      assert.deepEqual(unsafeForms(text, file, { pkg, shipped: true, pkgRel: `src/${rel}` }), [], `${pkg}/${rel}`);
    }
  }
  assert.deepEqual(spawners.sort(), [...SPAWN_FILES.keys()].sort());
  assert.deepEqual(resolvers, ["daemon-host/net/egress-client.ts"], "the egress client (web-rules.mjs rule 1b) is the one shipped file that resolves names");
  // Each named file calls what it names (the scan above passing means a fixed program is that literal).
  for (const [f, rule] of SPAWN_FILES) {
    const [pkg, rel] = split(f);
    const text = readFileSync(join(packagesDir, pkg, "src", rel), "utf8");
    assert.ok([...rule.names].every((n) => new RegExp(`\\b${n}\\b`).test(text)) && typeof rule.runs === "string", f);
  }
});
