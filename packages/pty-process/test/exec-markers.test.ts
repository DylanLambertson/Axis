// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-EXEC-1 (marker half): with marker programs configured, no allowed exec starts one. Each pinned case has a CONTROL
// that runs the same command without the service prefix and DOES run the marker, so a fixture that never reaches the
// program cannot pass vacuously. Real git; skipped with a reason where a git feature is missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { atLeastGit, GIT, gitRig, nextReq, SKIP, type GitRig } from "../testing/git.js";

const clear = (r: GitRig): void => writeFileSync(join(r.tmp, "markers.log"), "");

function exec(r: GitRig, repo: { top: string; gitDir: string }, rest: string[], stdin?: string): Promise<Record<string, unknown>> {
  return r.send({ t: "exec", req: nextReq(), argv: [GIT, ...rest], cwd: repo.top, env: {}, timeoutMs: 60_000, maxOutput: 1 << 20, repo: { gitDir: repo.gitDir, workTree: repo.top }, ...(stdin === undefined ? {} : { stdin }) });
}

/** The control: the same subcommand with the rig's environment and no service prefix. Returns the exit code. */
function control(r: GitRig, cwd: string, args: string[], input?: string): number {
  try {
    execFileSync(GIT as string, args, { cwd, env: r.baseEnv, input, stdio: ["pipe", "ignore", "ignore"] });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

test("PTY-EXEC-1: with diff.external, core.editor, core.sshCommand, core.pager, core.fsmonitor and a smudge/clean filter set, no allowed exec runs a marker", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("markers");
  writeFileSync(join(repo.top, ".gitattributes"), "* filter=m diff=m\n");
  r.git(["add", ".gitattributes"], repo.top);
  r.git(["commit", "-q", "--no-verify", "-m", "attrs"], repo.top);
  for (const [k, name] of [["diff.external", "ext"], ["diff.m.textconv", "textconv"], ["core.editor", "editor"], ["core.sshCommand", "ssh"], ["core.pager", "pager"], ["core.fsmonitor", "fsmonitor"], ["filter.m.smudge", "smudge"], ["filter.m.clean", "clean"], ["filter.m.process", "process"]] as const) {
    r.git(["config", k, r.marker(name, name === "smudge" || name === "clean" ? "cat\n" : "exit 1\n")], repo.top);
  }
  r.git(["config", "filter.m.required", "true"], repo.top);
  // Control: plain git does start them (status reads the index through fsmonitor; diff runs the external driver).
  control(r, repo.top, ["status", "--porcelain"]);
  assert.match(r.markers(), /fsmonitor/, "control: the fsmonitor marker is reachable");
  clear(r);
  const head = r.git(["rev-parse", "HEAD"], repo.top).trim();
  const tree = r.git(["rev-parse", "HEAD^{tree}"], repo.top).trim();
  const blob = r.git(["rev-parse", "HEAD:a.txt"], repo.top).trim();
  const forms: Array<[string[], string?]> = [
    [["rev-parse", "--verify", "--end-of-options", "HEAD"]],
    [["rev-parse", "--abbrev-ref", "HEAD"]],
    [["ls-tree", "-r", "-z", head]],
    [["rev-list", "--objects", "-n", "1", head]],
    [["write-tree"]],
    [["var", "GIT_AUTHOR_IDENT"]],
    [["symbolic-ref", "--quiet", "HEAD"]],
    [["cat-file", "-p", blob]],
    [["cat-file", "-e", blob]],
    [["cat-file", "--batch"], `${blob}\n`],
    [["cat-file", "--batch-check"], `${blob}\n`],
    [["hash-object", "--no-filters", "--stdin"], "bytes\n"],
    [["config", "--get", "user.name"]],
    [["config", "--show-scope", "--get-all", "core.hooksPath"]],
    [["commit-tree", "-p", head, "-F", "-", tree], "msg\n"],
  ];
  for (const [rest, stdin] of forms) {
    const reply = await exec(r, repo, rest, stdin);
    assert.equal(reply["t"], "exec-result", rest.join(" "));
    assert.equal(r.markers(), "", `no marker after ${rest.join(" ")}`);
  }
});

test("PTY-EXEC-1: write-tree does not start core.fsmonitor (control: unpinned write-tree does)", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("fsm");
  r.git(["config", "core.fsmonitor", r.marker("fsmonitor", "exit 1\n")], repo.top);
  control(r, repo.top, ["write-tree"]);
  if (!/fsmonitor/.test(r.markers())) return t.skip(`this git (${String(GIT)}) does not consult core.fsmonitor in write-tree, so the case cannot be exercised`);
  clear(r);
  const reply = await exec(r, repo, ["write-tree"]);
  assert.equal(reply["code"], 0);
  assert.equal(r.markers(), "");
});

const LAZY_SKIP = SKIP || (atLeastGit([2, 27, 0]) ? false : "partial clone over file:// needs git 2.27 or later");

for (const [name, rest] of [
  ["cat-file -e", (blob: string, _head: string) => [["cat-file", "-e", blob]] as const],
  ["cat-file --batch-check", (blob: string, _head: string) => [["cat-file", "--batch-check"], `${blob}\n`] as const],
  ["rev-list --objects", (_blob: string, head: string) => [["rev-list", "--objects", head]] as const],
] as const) {
  test(`PTY-EXEC-1: ${name} of a missing blob in a partial clone runs no remote.origin.uploadpack and fetches nothing (control on a fresh clone does)`, { skip: LAZY_SKIP }, async (t) => {
    const r = gitRig();
    t.after(() => r.cleanup());
    const src = r.repo("src");
    r.git(["config", "uploadpack.allowFilter", "true"], src.top);
    const blob = r.git(["rev-parse", "HEAD:a.txt"], src.top).trim();
    const head = r.git(["rev-parse", "HEAD"], src.top).trim();
    const upload = r.marker("uploadpack", `exec '${GIT}' upload-pack "$@"\n`);
    const fresh = (dir: string): { top: string; gitDir: string } => {
      r.git(["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${src.top}`, dir], r.tmp);
      const top = join(r.tmp, dir);
      r.git(["config", "remote.origin.uploadpack", upload], top);
      clear(r);
      return { top, gitDir: join(top, ".git") };
    };
    const missing = (top: string): boolean => execMissing(r, top, blob);
    const [args, input] = rest(blob, head) as readonly [readonly string[], string?];
    // Control on its own fresh clone: the same request without the prefix runs the marker and fetches the blob.
    const c = fresh("control");
    assert.ok(missing(c.top), "the fixture is a real partial clone: the blob starts missing");
    control(r, c.top, [...args], input);
    assert.match(r.markers(), /uploadpack/, "control: plain git runs uploadpack");
    assert.equal(missing(c.top), false, "control: plain git fetched the blob");
    // Pinned on a second fresh clone.
    const p = fresh("pinned");
    assert.ok(missing(p.top));
    const reply = await exec(r, p, [...args], input);
    assert.equal(reply["t"], "exec-result");
    assert.equal(r.markers(), "", "no uploadpack marker");
    assert.ok(missing(p.top), "the blob is still missing after the pinned call");
  });
}

/** `GIT_NO_LAZY_FETCH=1 cat-file -e` exits non-zero when the blob is absent (and cannot fetch on any version: protocol off too). */
function execMissing(r: GitRig, top: string, blob: string): boolean {
  try {
    execFileSync(GIT as string, ["-c", "protocol.allow=never", "cat-file", "-e", blob], { cwd: top, env: { ...r.baseEnv, GIT_NO_LAZY_FETCH: "1" }, stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

test("PTY-EXEC-1 (old git): a repository protocol.file.allow=always cannot re-enable a lazy fetch when git ignores GIT_NO_LAZY_FETCH (control: it does without the transport allow-list)", { skip: LAZY_SKIP }, async (t) => {
  // An old-git stand-in: the real git, but GIT_NO_LAZY_FETCH (git 2.44+) never reaches it. Runs on any git version.
  const probe = gitRig();
  t.after(() => probe.cleanup());
  const oldGit = join(probe.tmp, "old-git");
  writeFileSync(oldGit, `#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec '${GIT}' "$@"\n`);
  chmodSync(oldGit, 0o755);
  const r = gitRig({ gitPath: oldGit });
  t.after(() => r.cleanup());
  const src = r.repo("src");
  r.git(["config", "uploadpack.allowFilter", "true"], src.top);
  const blob = r.git(["rev-parse", "HEAD:a.txt"], src.top).trim();
  const upload = r.marker("uploadpack", `exec '${GIT}' upload-pack "$@"\n`);
  const fresh = (dir: string): { top: string; gitDir: string } => {
    r.git(["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${src.top}`, dir], r.tmp);
    const top = join(r.tmp, dir);
    r.git(["config", "remote.origin.uploadpack", upload], top);
    r.git(["config", "protocol.file.allow", "always"], top);
    clear(r);
    return { top, gitDir: join(top, ".git") };
  };
  const c = fresh("control");
  assert.ok(execMissing(r, c.top, blob));
  // Control: the protocol.allow=never pin alone, no lazy-fetch switch: the per-protocol setting wins and uploadpack runs.
  control(r, c.top, ["-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "cat-file", "-e", blob]);
  assert.match(r.markers(), /uploadpack/, "control: protocol.file.allow=always overrides protocol.allow=never");
  const p = fresh("pinned");
  const reply = await r.send({ t: "exec", req: nextReq(), argv: [oldGit, "cat-file", "-e", blob], cwd: p.top, env: {}, timeoutMs: 60_000, maxOutput: 65536, repo: { gitDir: p.gitDir, workTree: p.top } });
  assert.equal(reply["t"], "exec-result");
  assert.notEqual(reply["code"], 0);
  assert.equal(r.markers(), "", "no uploadpack marker");
  assert.ok(execMissing(r, p.top, blob), "the blob is still missing");
  assert.equal(r.execLog[r.execLog.length - 1]?.env["GIT_ALLOW_PROTOCOL"], "none");
});
