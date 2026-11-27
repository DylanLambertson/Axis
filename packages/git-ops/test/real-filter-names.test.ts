// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Filter drivers named oddly in the config (empty, upper case, dotted, legacy syntax, from an include) are neutralised on
// daemon calls; a plain git in the same repository runs each of them, so the fixture is not vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitOpsError, daemonGitFor, filterNames } from "../src/index.js";
import { fixture, type Fixture } from "./realFixture.js";

const posix = process.platform !== "win32";

/** A driver that writes its name to the marker and passes its input through. */
function driver(f: Fixture, name: string): string {
  const p = join(f.root, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\necho ${name} >> "${f.marker}"\ncat\n`);
  chmodSync(p, 0o755);
  return p;
}

const ran = (f: Fixture): string => (existsSync(f.marker) ? readFileSync(f.marker, "utf8") : "");

/** Plain git, the control: whatever the driver does to git, only the marker matters. */
function plain(f: Fixture, ...args: string[]): void {
  try {
    execFileSync("git", args, { cwd: f.wt.workTree, env: f.env, stdio: "ignore" });
  } catch {
    // a driver that does not speak the process protocol makes git fail
  }
}

/** The filter names this machine's system config holds (none on most machines; `lfs` where git-lfs is installed). */
function systemFilters(env: Record<string, string>): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["config", "--system", "--null", "--name-only", "--get-regexp", "^filter\\."], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return []; // no system config, or no filter in it
  }
  const names = out.split("\0").flatMap((k) => /^filter\.(.*)\.(clean|smudge|process|required)$/s.exec(k)?.[1] ?? []);
  return [...new Set(names)];
}

const CASES: readonly { attr: string; config: (f: Fixture) => string }[] = [
  { attr: "", config: (f) => `[filter ""]\n\tclean = ${driver(f, "e-clean")}\n\tsmudge = ${driver(f, "e-smudge")}\n\tprocess = ${driver(f, "e-process")}\n` },
  { attr: "Upper", config: (f) => `[filter "Upper"]\n\tclean = ${driver(f, "upper")}\n` },
  { attr: ".", config: (f) => `[filter "."]\n\tclean = ${driver(f, "dot")}\n` },
  { attr: "a.clean", config: (f) => `[filter "a.clean"]\n\tclean = ${driver(f, "dotted")}\n` },
  { attr: "legacy", config: (f) => `[Filter.Legacy]\n\tCLEAN = ${driver(f, "legacy")}\n` },
  {
    attr: "",
    config: (f) => {
      const inc = join(f.root, "included.cfg");
      writeFileSync(inc, `[filter ""]\n\tprocess = ${driver(f, "inc-process")}\n`);
      return `[include]\n\tpath = ${inc}\n`;
    },
  },
];

for (const [i, c] of CASES.entries()) {
  test(`case ${i}: a filter selected by \`* filter=${c.attr}\` never runs on daemon status, diff or add, and plain git runs it`, { skip: posix ? undefined : "posix shell drivers" }, async () => {
    const f = fixture();
    // `filter.process` names no driver: git ignores it, and so does the neutralising.
    appendFileSync(join(f.wt.gitDir, "config"), c.config(f) + `[filter]\n\tprocess = ${driver(f, "two-level")}\n`);
    writeFileSync(join(f.wt.gitDir, "info", "attributes"), `* filter=${c.attr}\n`);
    writeFileSync(join(f.wt.workTree, "a.txt"), "changed\n");
    const git = await daemonGitFor(f.wt, f.deps);
    for (const sub of [["status", "--porcelain"], ["diff"], ["diff", "--cached"]]) {
      const r = await git(sub);
      assert.equal(r.code, 0, `${sub.join(" ")}: ${r.stderr}`);
    }
    const added = await (await daemonGitFor(f.wt, f.deps, { GIT_INDEX_FILE: join(f.root, "private-index") }))(["add", "-A"]);
    assert.equal(added.code, 0, added.stderr);
    assert.equal(ran(f), "", "nothing ran through the daemon prefix");
    plain(f, "diff");
    assert.notEqual(ran(f), "", "plain git runs the driver");
    assert.ok(!ran(f).includes("two-level"), "git ignores a two-level filter key");
    rmSync(f.marker);
  });
}

test("names are read as git uses them; one that cannot be put on a command line safely is refused", async () => {
  const f = fixture();
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: f.home, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "/" };
  appendFileSync(join(f.wt.gitDir, "config"), `[filter ""]\n\tclean = x\n[filter "Upper"]\n\tsmudge = x\n[Filter.Legacy]\n\tProcess = x\n[filter]\n\tprocess = x\n`);
  // The daemon's git reads the system config too (its environment may not set GIT_CONFIG_*), as git does for every
  // command, so a filter there (git-lfs installs `[filter "lfs"]` in /etc/gitconfig) is read and emptied as well.
  assert.deepEqual((await filterNames(f.wt, f.deps, env)).sort(), ["", "Upper", "legacy", ...systemFilters(env)].sort());
  for (const name of ["a b", 'a\\"b', "a\\\\b", "é", "a=b"]) {
    const g = fixture();
    appendFileSync(join(g.wt.gitDir, "config"), `[filter "${name}"]\n\tclean = x\n`);
    await assert.rejects(filterNames(g.wt, g.deps, env), (e: unknown) => e instanceof GitOpsError && e.code === "E_POLICY_DENIED" && /filter/.test(e.message), name);
  }
});

// A name holding a line terminator or another control character: `.` without `s` did not match it, so the key was skipped
// (neither emptied nor refused) and the driver ran. Each is now refused before any daemon git runs. CR and tab are blanks to
// git's attribute parser, so no attribute can select them; the others are selected, and plain git runs them.
const ODD: readonly { label: string; ch: string; selectable: boolean }[] = [
  { label: "U+2028", ch: "\u2028", selectable: true },
  { label: "U+2029", ch: "\u2029", selectable: true },
  { label: "U+0085", ch: "\u0085", selectable: true },
  { label: "VT", ch: "\v", selectable: true },
  { label: "FF", ch: "\f", selectable: true },
  { label: "CR", ch: "\r", selectable: false },
  { label: "tab", ch: "\t", selectable: false },
];

for (const o of ODD) {
  test(`a filter named with ${o.label} is refused before any daemon git runs; plain git ${o.selectable ? "runs" : "cannot select"} it`, { skip: posix ? undefined : "posix shell drivers" }, async () => {
    const f = fixture();
    const name = `a${o.ch}b`;
    appendFileSync(join(f.wt.gitDir, "config"), `[filter "${name}"]\n\tclean = ${driver(f, "odd")}\n`, "utf8");
    writeFileSync(join(f.wt.gitDir, "info", "attributes"), `* filter=${name}\n`, "utf8");
    writeFileSync(join(f.wt.workTree, "a.txt"), "changed\n");
    await assert.rejects(daemonGitFor(f.wt, f.deps), (e: unknown) => e instanceof GitOpsError && e.code === "E_POLICY_DENIED");
    await assert.rejects(daemonGitFor(f.wt, f.deps, { GIT_INDEX_FILE: join(f.root, "private-index") }), (e: unknown) => e instanceof GitOpsError && e.code === "E_POLICY_DENIED");
    assert.equal(ran(f), "", "nothing ran");
    plain(f, "diff");
    assert.equal(ran(f) !== "", o.selectable, "the control");
  });
}

test("a filter key with three parts and a variable that names no driver part is refused, not skipped", async () => {
  const f = fixture();
  appendFileSync(join(f.wt.gitDir, "config"), `[filter "x"]\n\tcleaner = y\n`);
  await assert.rejects(daemonGitFor(f.wt, f.deps), (e: unknown) => e instanceof GitOpsError && e.code === "E_POLICY_DENIED");
});
