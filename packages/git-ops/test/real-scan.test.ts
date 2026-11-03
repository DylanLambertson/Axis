// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Real-git regression tests for the daemon-side secret scan of an outgoing push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MAX_DIFF, createNodeRunner, executePush, planPush } from "../src/index.js";
import { baseOf, fixture } from "./realFixture.js";

/** A secret-shaped value assembled at runtime so no literal looks like a credential. */
export const AWS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");

export const scanFor = (seen: string[]) => async (d: string) => {
  seen.push(d);
  return d.includes(AWS_KEY) ? [{ rule: "aws-key" }] : [];
};

test("B-1: a submodule diff.submodule=diff preference cannot run a nested repository's diff.external in the daemon", async () => {
  const f = fixture({ scanner: async () => [] });
  const evil = join(f.root, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho daemon-exec >> "${f.marker}"\n`);
  chmodSync(evil, 0o755);
  const repo = f.wt.workTree;
  const sub = join(repo, "sub");
  f.run(repo, "init", "-q", "sub");
  for (const [k, v] of [["user.name", "x"], ["user.email", "x@x"], ["diff.external", evil]] as const) f.run(sub, "config", k, v);
  writeFileSync(join(sub, "x"), "1\n");
  f.run(sub, "add", "x");
  f.run(sub, "commit", "-q", "-m", "s1");
  const s1 = f.run(sub, "rev-parse", "HEAD").trim();
  writeFileSync(join(sub, "x"), "2\n");
  f.run(sub, "commit", "-q", "-am", "s2");
  const s2 = f.run(sub, "rev-parse", "HEAD").trim();
  f.git("update-index", "--add", "--cacheinfo", `160000,${s1},sub`);
  f.git("commit", "-q", "-m", "sub1");
  f.git("push", "-q", "origin", "axis/feat");
  f.git("update-index", "--cacheinfo", `160000,${s2},sub`);
  f.git("commit", "-q", "-m", "sub2");
  f.run(repo, "config", "--global", "diff.submodule", "diff");
  // Sanity: the unhardened diff does run it, so the fixture is not vacuous.
  f.git("diff", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD");
  assert.ok(existsSync(f.marker), "fixture: an unhardened submodule diff runs diff.external");
  writeFileSync(f.marker, "");
  await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.equal(readFileSync(f.marker, "utf8"), "", "a program from worktree-controlled config ran in the daemon during the secret-scan diff");
  // The behaviour above also holds for plain diff-tree (it ignores diff.submodule), so pin the protections themselves:
  // the real scan calls carry them, and the same call with them swapped for the attack form does run the program.
  const scans = f.seen.filter((c) => c.context === "daemon" && c.argv.includes("diff-tree") && c.argv.includes("-p"));
  assert.ok(scans.length >= 2, "the scan ran once per outgoing commit");
  for (const c of scans) for (const want of ["--submodule=short", "--ignore-submodules=all", "diff.submodule=short"]) assert.ok(c.argv.includes(want), want);
  const last = scans.at(-1) as (typeof scans)[number];
  const attack = last.argv.filter((a) => a !== "--ignore-submodules=all").map((a) => (a === "--submodule=short" ? "--submodule=diff" : a === "diff.submodule=short" ? "diff.submodule=diff" : a));
  await createNodeRunner().run({ ...last, argv: attack });
  assert.ok(readFileSync(f.marker, "utf8").includes("daemon-exec"), "fixture: without the protections the same scan call runs the nested diff.external");
});

test("B-2: in a partial clone the scan diff cannot lazy-fetch through remote.<n>.uploadpack in the daemon", async () => {
  const f = fixture({ scanner: async () => [] });
  const repo = f.wt.workTree;
  f.run(repo, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(repo, "a.txt"), "two\n");
  f.git("commit", "-q", "-am", "second");
  const up = join(f.root, "up.sh");
  writeFileSync(up, `#!/bin/sh\necho daemon-exec >> "${f.marker}"\nexec git-upload-pack "$@"\n`);
  chmodSync(up, 0o755);
  f.run(repo, "config", "--global", "remote.origin.uploadpack", up);
  const clone = (name: string): string => {
    const pc = join(f.root, name);
    f.run(f.root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${repo}`, pc);
    for (const [k, v] of [["user.name", "Dylan Lambertson"], ["user.email", "me@dylanlambertson.dev"]] as const) f.run(pc, "config", k, v);
    f.run(pc, "checkout", "-q", "axis/feat");
    f.run(pc, "branch", "-q", "main", "origin/main");
    f.run(pc, "update-ref", "-d", "refs/remotes/origin/axis/feat");
    return pc;
  };
  // Sanity, on a clone of its own (a fetch fills the object store): an unhardened diff does fetch, through the planted program.
  f.run(clone("probe"), "diff", "--no-ext-diff", "main", "axis/feat");
  assert.ok(existsSync(f.marker), "fixture: a partial-clone diff runs the uploadpack program");
  writeFileSync(f.marker, "");
  const pc = clone("pc");
  writeFileSync(f.marker, "");
  const wt = { workTree: pc, gitDir: join(pc, ".git") };
  await planPush(f.deps, { worktree: wt, remote: "origin", branch: "axis/feat", baseSha: f.run(pc, "rev-parse", "main").trim() }).catch(() => undefined);
  assert.equal(readFileSync(f.marker, "utf8"), "", "the daemon ran a transport program during a lazy fetch");
});

test("S-6: a refs/replace entry cannot show the scanner clean content in place of the blob that is pushed", async () => {
  const seen: string[] = [];
  const f = fixture({ scanner: scanFor(seen), scanMode: "refuse" });
  const repo = f.wt.workTree;
  writeFileSync(join(repo, "prod.env"), `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "add env");
  const secretBlob = f.git("rev-parse", "HEAD:prod.env").trim();
  writeFileSync(join(f.root, "clean.txt"), "AWS=redacted\n");
  const clean = f.run(repo, "hash-object", "-w", join(f.root, "clean.txt")).trim();
  f.git("replace", secretBlob, clean);
  assert.ok(!f.git("diff", "main", "HEAD").includes(AWS_KEY), "fixture: an unhardened diff honours the replacement");
  const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && /secret pattern/.test(e.message), `the scan did not see the real blob; scanner got ${JSON.stringify(seen)}`);
});

test("S-1: a remote-tracking ref planted in the worktree does not narrow the scanned range", async () => {
  const seen: string[] = [];
  const f = fixture({ scanner: scanFor(seen), scanMode: "refuse" });
  writeFileSync(join(f.wt.workTree, ".env"), `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "add env");
  f.git("update-ref", "refs/remotes/origin/axis/feat", "HEAD"); // the remote has no such branch
  const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && /secret pattern/.test(e.message), `the scan was narrowed; scanner got ${JSON.stringify(seen)}`);
});

test("S-1: a base that is missing, malformed or not an ancestor of the tip is refused", async () => {
  const f = fixture({ scanner: async () => [] });
  const input = { worktree: f.wt, remote: "origin", branch: "axis/feat" };
  const codeOf = async (baseSha: unknown): Promise<string> => planPush(f.deps, { ...input, baseSha } as never).then(() => "OK", (e: { code: string }) => e.code);
  assert.equal(await codeOf(undefined), "E_INVALID_ARGUMENT");
  assert.equal(await codeOf("main"), "E_INVALID_ARGUMENT");
  assert.equal(await codeOf("0".repeat(40)), "E_CONFLICT", "not in the repository");
  // A commit that exists but is not an ancestor of the tip (history rewritten since the base was recorded).
  f.git("checkout", "-q", "--orphan", "other");
  writeFileSync(join(f.wt.workTree, "z.txt"), "z\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "unrelated");
  const stray = f.git("rev-parse", "HEAD").trim();
  f.git("checkout", "-q", "axis/feat");
  assert.equal(await codeOf(stray), "E_CONFLICT", "not an ancestor");
  assert.equal(await codeOf(baseOf(f)), "OK");
});

test("B-3: a secret added in one commit and deleted in the next is scanned and refused, and never reaches the remote", async () => {
  const seen: string[] = [];
  const f = fixture({ scanner: scanFor(seen), scanMode: "refuse" });
  const add = (n: string): void => { f.git("add", "-A"); f.git("commit", "-q", "-m", n); };
  writeFileSync(join(f.wt.workTree, ".env"), `AWS=${AWS_KEY}\n`);
  add("add env");
  const leaky = f.git("rev-parse", "HEAD").trim();
  f.git("rm", "-q", ".env");
  add("oops, remove env");
  const input = { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) };
  const e = await executePush(f.deps, input).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && e.message.includes(leaky.slice(0, 12)), `refused, naming the commit; got ${String(e)}`);
  assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
  assert.equal(seen.length, 4, "the scanner is called for the patch and the message of each outgoing commit");
});

test("B-3: a secret that exists only in a merge resolution is scanned", async () => {
  const hits: Array<{ commit: string; found: boolean }> = [];
  const f = fixture({
    scanner: async (d, meta) => {
      hits.push({ commit: meta.commit, found: d.includes(AWS_KEY) });
      return d.includes(AWS_KEY) ? [{ rule: "aws-key" }] : [];
    },
    scanMode: "warn",
  });
  const repo = f.wt.workTree;
  f.git("branch", "other", "main");
  writeFileSync(join(repo, "f.txt"), "f\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "f1");
  f.git("checkout", "-q", "other");
  writeFileSync(join(repo, "o.txt"), "o\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "o1");
  f.git("checkout", "-q", "axis/feat");
  f.git("merge", "-q", "--no-ff", "--no-commit", "other");
  writeFileSync(join(repo, "merge.env"), `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "merge");
  const merge = f.git("rev-parse", "HEAD").trim();
  const plan = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.findings.map((x) => x.commit), [merge], "found in the merge commit and nowhere else");
  assert.equal(hits.filter((h) => h.found).every((h) => h.commit === merge), true);
});

test("S-2: a '-diff' attribute cannot hide content from the scan, and the path is reported as binary", async () => {
  const metas: string[][] = [];
  const seen: string[] = [];
  const f = fixture({ scanner: async (d, meta) => { metas.push([...meta.binaryPaths]); return scanFor(seen)(d); }, scanMode: "warn" });
  writeFileSync(join(f.wt.workTree, ".gitattributes"), "*.cfg -diff\n");
  writeFileSync(join(f.wt.workTree, "prod.cfg"), `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "cfg");
  const plan = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.ok(seen.some((d) => d.includes(AWS_KEY)), "the scanner saw the text, not 'Binary files differ'");
  assert.ok(plan.findings.length > 0 && plan.requiresConfirmation);
  assert.deepEqual(metas.flat(), ["prod.cfg"]);
});

test("S-2: a NUL byte or binary file is refused in refuse mode unless the path is allow-listed, and needs confirmation in warn mode", async () => {
  const mk = (scanMode: "warn" | "refuse") => {
    const f = fixture({ scanner: async () => [], scanMode });
    writeFileSync(join(f.wt.workTree, "key.p12"), Buffer.from([0x30, 0x82, 0x00, 0x00, 0x01]));
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "binary");
    return f;
  };
  const refuse = mk("refuse");
  const input = (f: ReturnType<typeof mk>, extra: object = {}) => ({ worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f), ...extra });
  const e = await planPush(refuse.deps, input(refuse)).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && /key\.p12/.test(e.message), "refused, naming the path");
  await planPush(refuse.deps, input(refuse, { allowedBinaryPaths: ["other.bin"] })).then(() => assert.fail("a different path does not allow it"), () => undefined);
  const ok = await planPush(refuse.deps, input(refuse, { allowedBinaryPaths: ["key.p12"] }));
  assert.equal(ok.requiresConfirmation, false);
  const warn = mk("warn");
  const plan = await planPush(warn.deps, input(warn, { allowedBinaryPaths: ["key.p12"] }));
  assert.equal(plan.requiresConfirmation, true, "warn mode: any binary path needs confirmation, allow-listed or not");
  assert.match(plan.reasons.join(), /key\.p12/);
  await executePush(warn.deps, input(warn), { confirmed: true, confirmedPlan: { tip: plan.tip, digest: plan.digest } });
});

test("S-8: padding a push with 8 MiB of filler before a secret does not hide it, even in refuse mode", async () => {
  const f = fixture({ scanner: scanFor([]), scanMode: "refuse" });
  writeFileSync(join(f.wt.workTree, "pad.txt"), "filler line\n".repeat(Math.ceil((MAX_DIFF + 1024) / 12)) + `AWS=${AWS_KEY}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "padded");
  const e = await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && /too large to scan/.test(e.message), String(e));
  assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
});

test("S-3: a commit made after the scan is not pushed: the branch moving is refused, and the source is pinned to the scanned sha", async () => {
  const late = (f: ReturnType<typeof fixture>): void => {
    writeFileSync(join(f.wt.workTree, ".env"), `AWS=${AWS_KEY}\n`);
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "late");
  };
  // 1. The branch moves while the scanner runs: refused before anything is pushed.
  const a = fixture({ scanMode: "refuse", scanner: async (_d, m) => { if (m.part === "patch") late(a); return []; } });
  const input = (f: ReturnType<typeof fixture>) => ({ worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  writeFileSync(join(a.wt.workTree, "b.txt"), "b\n");
  a.git("add", "-A");
  a.git("commit", "-q", "-m", "one outgoing commit, so the scanner runs");
  const e = await executePush(a.deps, input(a)).then(() => undefined, (x: unknown) => x);
  assert.equal((e as { code?: string } | undefined)?.code, "E_CONFLICT");
  assert.throws(() => execFileSync("git", ["--git-dir", a.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }));
  // 2. The branch moves in the window between the last check and git push: the pinned sha still wins.
  const b = fixture({ scanMode: "refuse", scanner: async () => [] });
  const scannedTip = b.git("rev-parse", "HEAD").trim();
  const inner = b.deps.runner;
  const deps = { ...b.deps, runner: { run: async (req: Parameters<typeof inner.run>[0]) => { if (req.context === "pty") late(b); return inner.run(req); } } };
  await executePush(deps, input(b));
  const pushed = execFileSync("git", ["--git-dir", b.remote, "rev-parse", "refs/heads/axis/feat"], { encoding: "utf8" }).trim();
  assert.equal(pushed, scannedTip, "pushed an unscanned commit");
});

test("RR-1: a confirmation is bound to the plan the user saw; findings added after planPush are not pushed under it", async () => {
  const keyed = async (d: string) => (d.includes(["AK", "IA"].join("")) ? [{ rule: "aws-key" }] : []);
  const f = fixture({ scanner: keyed, scanMode: "warn" });
  const input = { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) };
  writeFileSync(join(f.wt.workTree, "fixture.txt"), `AWS=${["AK", "IA", "EXAMPLEEXAMPLE12"].join("")}\n`); // a known test key the user accepts
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "test fixture");
  const plan = await planPush(f.deps, input);
  assert.equal(plan.requiresConfirmation, true);
  const confirmedPlan = { tip: plan.tip, digest: plan.digest };
  // Before "push anyway" is clicked, a leftover process adds a real key.
  writeFileSync(join(f.wt.workTree, ".env"), `AWS=${["AK", "IA", "REALREALREAL1234"].join("")}\n`);
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "late");
  const e = await executePush(f.deps, input, { confirmed: true, confirmedPlan }).then(() => undefined, (x: unknown) => x) as { code?: string; details?: unknown } | undefined;
  assert.equal(e?.code, "E_CONFLICT");
  assert.deepEqual(e?.details, { reason: "plan_changed" });
  assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
  // The fresh plan, confirmed as shown, does push.
  const fresh = await planPush(f.deps, input);
  await executePush(f.deps, input, { confirmed: true, confirmedPlan: { tip: fresh.tip, digest: fresh.digest } });
  assert.equal(execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { encoding: "utf8" }).trim(), fresh.tip);
});

test("RR-N2: a secret in a commit message is scanned, in refuse mode refused, and the scanner is told it is a message", async () => {
  const parts: string[] = [];
  const f = fixture({ scanner: async (d, meta) => { parts.push(meta.part); return d.includes(AWS_KEY) ? [{ rule: "aws-key" }] : []; }, scanMode: "refuse" });
  writeFileSync(join(f.wt.workTree, "ok.txt"), "fine\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", `deploy with AWS=${AWS_KEY}`);
  const bad = f.git("rev-parse", "HEAD").trim();
  const e = await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof Error && e.message.includes(bad.slice(0, 12)), String(e));
  assert.deepEqual(parts, ["patch", "message"]);
  assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
});
