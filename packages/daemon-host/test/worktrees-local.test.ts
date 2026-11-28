// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { worktreesMethods } from "@axis/protocol";
import { localInfo } from "../src/worktrees/info.js";
import type { Client, Msg } from "./approvals-rig.js";
import { createWs, gitSkipReason, worktreesRig, type Rig } from "./worktrees-rig.js";

// DC-7 (docs/design/worktrees-local-checkout.md): `list { projectId, includeLocal: true }` puts the repository's own checkout
// first, as origin "local", read from the `git worktree list` the daemon already runs (no new git process, no status in the
// user's checkout). No row for a bare repository. Real repositories.
// Mutants: a local row without the flag, a local row not first, a branch kept as refs/heads/..., an unborn head shown as
// zeros, a bare repository given a local row, an extra git process, counts read in the checkout, an untrusted project refused.

const skip = gitSkipReason();
const WT = "axis.worktrees";
type Row = Record<string, unknown>;

async function setup(t: TestContext, options: Parameters<typeof worktreesRig>[0] = {}): Promise<{ r: Rig; user: Client }> {
  const r = await worktreesRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}
function rows(m: Msg): Row[] {
  assert.equal(m.ok, true, JSON.stringify(m.error));
  assert.equal(worktreesMethods.list.response.safeParse(m.result).success, true, "the reply matches the contract");
  return (m.result as { worktrees: Row[] }).worktrees;
}
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
/** Another repository registered as an UNTRUSTED project (as "Add" without trust does). */
function project(r: Rig, id: string, dir: string): string {
  r.journal.registerProject({ id, path: dir, displayName: id, trusted: false, actor: "user" });
  return id;
}

test("without includeLocal the reply is today's: no local row", { skip }, async (t) => {
  const { user } = await setup(t);
  await createWs(user, (_m, msg) => msg);
  const list = rows(await user.call(WT, "list", { projectId: "proj-1" }));
  assert.equal(list.some((w) => w["origin"] === "local"), false, "kills a local row without the flag");
});

test("with includeLocal the checkout comes first: its branch, head and real path, no id, state or counts", { skip }, async (t) => {
  const { r, user } = await setup(t);
  await createWs(user, (_m, msg) => msg);
  r.git(r.repo, "worktree", "add", "-q", "-b", "ext", path.join(r.tmp, "external"));
  writeFileSync(path.join(r.repo, "a.txt"), "the user's own edit\n");
  const list = rows(await user.call(WT, "list", { projectId: "proj-1", includeLocal: true }));
  assert.deepEqual(list[0], { origin: "local", projectId: "proj-1", branch: "main", head: r.git(r.repo, "rev-parse", "HEAD").trim(), path: realpathSync(r.repo), locked: false, present: true });
  assert.deepEqual(list.slice(1).map((w) => w["origin"]).sort(), ["axis", "external"]);
});

test("a detached checkout has branch null; an unborn branch has head null (never the zero id)", { skip }, async (t) => {
  const { r, user } = await setup(t);
  r.git(r.repo, "checkout", "-q", "--detach");
  const detached = rows(await user.call(WT, "list", { projectId: "proj-1", includeLocal: true }))[0];
  assert.equal(detached?.["branch"], null);
  assert.match(String(detached?.["head"]), /^[0-9a-f]{40}$/);
  const fresh = path.join(r.tmp, "fresh");
  mkdirSync(fresh);
  git(fresh, "init", "-q");
  git(fresh, "symbolic-ref", "HEAD", "refs/heads/trunk");
  const unborn = rows(await user.call(WT, "list", { projectId: project(r, "proj-fresh", fresh), includeLocal: true }));
  assert.deepEqual(unborn, [{ origin: "local", projectId: "proj-fresh", branch: "trunk", head: null, path: realpathSync(fresh), locked: false, present: true }]);
});

test("a bare repository has no local row; its linked worktree is still external", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const bare = path.join(r.tmp, "bare.git");
  git(r.tmp, "clone", "-q", "--bare", r.repo, bare);
  git(bare, "worktree", "add", "-q", "-b", "side", path.join(r.tmp, "bare-wt"));
  const list = rows(await user.call(WT, "list", { projectId: project(r, "proj-bare", bare), includeLocal: true }));
  assert.deepEqual(list.map((w) => w["origin"]), ["external"], "kills a local row for a bare repository");
});

test("review 1 NIT-1: a branch name longer than the wire allows is cut with a marker, and the reply still conforms", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const long = `${"a".repeat(200)}/${"b".repeat(200)}`;
  r.git(r.repo, "checkout", "-q", "-b", long);
  r.git(r.repo, "worktree", "add", "-q", "-b", `${"c".repeat(200)}/${"d".repeat(200)}`, path.join(r.tmp, "external-long"));
  const list = rows(await user.call(WT, "list", { projectId: "proj-1", includeLocal: true }));
  const branch = String(list[0]?.["branch"]);
  assert.equal(branch.length, 256);
  assert.equal(branch, `${long.slice(0, 255)}\u2026`, "kills dropping the whole reply for an over-long branch");
  assert.equal(String(list.find((w) => w["origin"] === "external")?.["branch"]).length, 256, "an external row is cut the same way");
});

test("review 1 NIT-2: a project registered at a linked worktree gets the MAIN checkout as its local row, and its own path as external", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const linked = path.join(r.tmp, "linked");
  r.git(r.repo, "worktree", "add", "-q", "-b", "side", linked);
  const list = rows(await user.call(WT, "list", { projectId: project(r, "proj-linked", linked), includeLocal: true }));
  assert.deepEqual(list.map((w) => [w["origin"], w["path"]]), [["local", realpathSync(r.repo)], ["external", realpathSync(linked)]]);
});

test("an untrusted project gets its local row (list stays a tier 0 read)", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const other = path.join(r.tmp, "other");
  mkdirSync(other);
  git(other, "init", "-q");
  git(other, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(path.join(other, "x.txt"), "x\n");
  git(other, "add", "x.txt");
  git(other, "commit", "-q", "-m", "x");
  const list = rows(await user.call(WT, "list", { projectId: project(r, "proj-other", other), includeLocal: true }));
  assert.equal(list[0]?.["origin"], "local");
  assert.equal(list[0]?.["branch"], "main");
});

test("the local row costs no git process: the same count with and without includeLocal, none run in the checkout for counts", { skip }, async (t) => {
  const { r, user } = await setup(t, { gitWrapper: true });
  const count = (): number => readFileSync(r.gitLog, "utf8").split("\n").filter((l) => l !== "").length;
  writeFileSync(r.gitLog, "");
  rows(await user.call(WT, "list", { projectId: "proj-1" }));
  const without = count();
  writeFileSync(r.gitLog, "");
  rows(await user.call(WT, "list", { projectId: "proj-1", includeLocal: true }));
  assert.equal(count(), without, "kills a status (or any other git call) for the local row");
});

const entry = { path: "/r", head: "0".repeat(40), branch: "refs/heads/feature/x", locked: false, prunable: false, isMain: true, managed: false, external: false, id: null, bare: false };

test("localInfo: refs/heads/ dropped, other refs kept, the zero id and a prunable entry mapped", () => {
  assert.deepEqual(localInfo(entry, "p"), { origin: "local", projectId: "p", branch: "feature/x", head: null, path: "/r", locked: false, present: true });
  assert.equal(localInfo({ ...entry, prunable: true }, "p")?.present, false);
  assert.equal(localInfo({ ...entry, head: "a".repeat(64) }, "p")?.head, "a".repeat(64));
});

test("review 1 NIT-3: a checkout path the shell could not show safely leaves the row out, never the whole reply", () => {
  for (const p of ["/r/evil\nname", "/r/\u202ertl", "/r/zero\u200bwidth", "/r/line\u2028sep", `/${"p".repeat(4096)}`]) {
    assert.equal(localInfo({ ...entry, path: p }, "p"), undefined, JSON.stringify(p));
  }
  assert.equal(localInfo({ ...entry, path: `/${"p".repeat(4095)}` }, "p")?.path.length, 4096, "the longest valid path is kept");
});
