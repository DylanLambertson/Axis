// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import type { GitRunner } from "@axis/git-ops";
import { Journal } from "@axis/journal";
import { createProjectControl, outboundMessageSchema, projectDisplayName, projectExcludedRoots, type BindingFs, type ProjectMessage } from "../src/index.js";
import { nodeBindingFs } from "../src/projects/binding.js";

// The project messages of the control channel (docs/design/project-registration-and-trust.md §5.1 and §5.2).

const POSIX = process.platform !== "win32" && typeof process.getuid === "function";
const SKIP = POSIX ? false : "POSIX uid is needed (Windows refuses every binding)";

function git(p: string): string {
  mkdirSync(join(p, ".git", "objects"), { recursive: true });
  mkdirSync(join(p, ".git", "refs"));
  writeFileSync(join(p, ".git", "HEAD"), "ref: refs/heads/main\n");
  return p;
}

function rig(t: TestContext, o: { journal?: false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-pc-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const sent: Record<string, unknown>[] = [];
  const runner: GitRunner = { run: async () => ({ code: 0, stdout: "remote.origin.url\nhttps://u:p@h/x.git\0", stderr: "" }) };
  const dataDir = join(root, "axis", "data");
  const worktreeRoot = join(root, "axis", "worktrees");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const pc = createProjectControl({
    journal: o.journal === false ? undefined : journal,
    control: { send: (m) => void sent.push(m as Record<string, unknown>) },
    excludedRoots: projectExcludedRoots({ dataDir, worktreeRoot }),
    binding: { platform: process.platform, uid: POSIX ? (process.getuid as () => number)() : undefined },
    remote: { runner, env: { PATH: process.env["PATH"] }, platform: process.platform },
  });
  const ask = async (m: ProjectMessage): Promise<Record<string, unknown>> => {
    await pc.handle(m);
    const answer = sent[sent.length - 1] as Record<string, unknown>;
    assert.equal(outboundMessageSchema.safeParse(answer).success, true, JSON.stringify(answer));
    return answer;
  };
  return { root, db, journal, ask, dataDir, worktreeRoot };
}

const inspect = (path: string) => ({ type: "projects.inspect" as const, requestId: "r1", path });
const register = (path: string, trusted = false, commonDir = join(path, ".git")) => ({ type: "projects.register" as const, requestId: "r2", path, commonDir, trusted });
const trust = (projectId: string, path: string, trusted: boolean) =>
  ({ type: "projects.trust" as const, requestId: "r3", projectId, path, trusted, ...(trusted ? { commonDir: join(path, ".git") } : {}) });

test("inspect shows the binding, the remote in display form and the registration; it writes nothing", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const p = git(join(r.root, "repo"));
  writeFileSync(join(p, ".git", "config"), "[remote \"origin\"]\n\turl = https://u:p@h/x.git\n");
  const before = r.db.prepare("SELECT count(*) AS n FROM audit_events").get();
  assert.deepEqual(await r.ask(inspect(p)), { type: "projects.inspected", requestId: "r1", ok: true, commonDir: join(p, ".git"), remoteKnown: true, remote: { name: "origin", url: "https://h/x.git" }, remotes: 1 });
  assert.deepEqual(r.db.prepare("SELECT count(*) AS n FROM audit_events").get(), before, "an inspection registers and trusts nothing");
  const added = await r.ask(register(p));
  const again = await r.ask(inspect(p));
  assert.deepEqual(again["registered"], { projectId: added["projectId"], trusted: false });
});

test("register binds the re-derived repository, read-only or trusted as main's dialog said", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const ro = git(join(r.root, "ro"));
  const tr = git(join(r.root, "tr"));
  const a = await r.ask(register(ro, false));
  const b = await r.ask(register(tr, true));
  const pa = r.journal.getProject(a["projectId"] as string);
  const pb = r.journal.getProject(b["projectId"] as string);
  assert.deepEqual([pa?.trusted, pa?.commonDir, pb?.trusted], [false, join(ro, ".git"), true]);
  assert.match(pa?.gitDirId ?? "", /^[0-9]+:[0-9]+$/);
  assert.equal(pa?.displayName, "ro");
});

test("register refusals: not normalised, not a repository, a changed binding, a duplicate, an excluded root, a nested project", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const p = git(join(r.root, "repo"));
  const code = async (m: ProjectMessage) => { const a = await r.ask(m); return [a["code"], a["reason"]]; };
  assert.deepEqual(await code(register(`${p}/../repo`)), ["E_INVALID_ARGUMENT", undefined]);
  mkdirSync(join(r.root, "plain"));
  assert.deepEqual(await code(register(join(r.root, "plain"))), ["E_INVALID_ARGUMENT", "not_a_repository"]);
  assert.deepEqual(await code(register(p, false, join(r.root, "other", ".git"))), ["E_INVALID_ARGUMENT", "binding_changed"], "mutant: commonDir not compared");
  await r.ask(register(p));
  assert.deepEqual(await code(register(p)), ["E_CONFLICT", undefined]);
  // Inside the data directory or the worktree root, or containing them (mutants: each direction dropped).
  assert.deepEqual(await code(register(git(join(r.dataDir, "repo")))), ["E_INVALID_ARGUMENT", "excluded_root"]);
  assert.deepEqual(await code(register(git(join(r.worktreeRoot, "ws")))), ["E_INVALID_ARGUMENT", "excluded_root"]);
  assert.deepEqual(await code(register(git(join(r.root, "axis")))), ["E_INVALID_ARGUMENT", "excluded_root"]);
  // Review S2: the Axis data root (dirname of the data directory) holds the anchor and the pty scratch: never a project.
  assert.deepEqual(await code(register(git(join(r.root, "axis", "anchor", "repo")))), ["E_INVALID_ARGUMENT", "excluded_root"], "mutant: data root not excluded");
  assert.deepEqual(projectExcludedRoots({ dataDir: "/a/axis/data", worktreeRoot: "/w" }), ["/a/axis", "/a/axis/data", "/w"]);
  // Inside a registered project, or around one.
  assert.deepEqual(await code(register(git(join(p, "inner")))), ["E_INVALID_ARGUMENT", "nested_project"]);
  assert.deepEqual(await code(register(git(r.root))), ["E_INVALID_ARGUMENT", "excluded_root"]);
  const outer = join(r.root, "outer");
  const inner = git(join(outer, "inner"));
  await r.ask(register(inner));
  assert.deepEqual(await code(register(git(outer))), ["E_INVALID_ARGUMENT", "nested_project"]);
});

test("review N1: two overlapping registers of nested folders are handled one at a time: exactly one is registered", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const outer = git(join(r.root, "outer"));
  const inner = git(join(outer, "inner"));
  const answers: Record<string, unknown>[] = [];
  // A barrier: filesystem calls are released in pairs, so two unserialised flows run in lockstep and reach their checks in the
  // same tick; a lone flow (serialised) is released after 30 ms.
  const waiting: (() => void)[] = [];
  const gate = (): Promise<void> => new Promise((resolve) => {
    waiting.push(resolve);
    if (waiting.length === 2) for (const go of waiting.splice(0)) go();
    else setTimeout(() => { const i = waiting.indexOf(resolve); if (i >= 0) waiting.splice(i, 1); resolve(); }, 30);
  });
  // The gate comes AFTER each real call, so the last release resumes both flows in the same tick.
  const after = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } finally {
      await gate();
    }
  };
  const lockstep: BindingFs = { realpath: (p) => after(nodeBindingFs.realpath(p)), lstat: (p) => after(nodeBindingFs.lstat(p)) };
  const pc = createProjectControl({
    journal: r.journal,
    control: { send: (m) => void answers.push(m as Record<string, unknown>) },
    excludedRoots: [r.dataDir],
    binding: { platform: process.platform, uid: (process.getuid as () => number)(), fs: lockstep },
    remote: { runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, env: {}, platform: process.platform },
  });
  await Promise.all([pc.handle(register(outer)), pc.handle(register(inner))]);
  assert.deepEqual(answers.map((a) => a["ok"] === true ? "ok" : a["reason"]), ["ok", "nested_project"], "mutant: no serialisation");
  assert.equal(r.journal.listProjects().length, 1);
});

test("trust: a grant re-derives the binding; a swapped .git is refused; a revoke needs nothing; a moved row is refused", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const p = git(join(r.root, "repo"));
  const id = (await r.ask(register(p)))["projectId"] as string;
  assert.equal((await r.ask(trust(id, p, true)))["ok"], true);
  assert.equal(r.journal.getProject(id)?.trusted, true);
  assert.equal((await r.ask(trust(id, p, false)))["ok"], true);
  assert.equal(r.journal.getProject(id)?.trusted, false);
  // The .git replaced in place (a new inode): the grant is refused, the record unchanged.
  renameSync(join(p, ".git"), join(r.root, "old-git"));
  git(p);
  const swapped = await r.ask(trust(id, p, true));
  assert.deepEqual([swapped["ok"], swapped["code"]], [false, "E_INVALID_ARGUMENT"]);
  assert.equal(r.journal.getProject(id)?.trusted, false);
  assert.deepEqual([(await r.ask(trust(id, join(r.root, "elsewhere"), false)))["reason"], (await r.ask(trust("p-none", p, false)))["code"]], ["project_moved", "E_NOT_FOUND"]);
  const actions = (r.db.prepare("SELECT actor, action FROM audit_events ORDER BY seq").all() as { actor: string; action: string }[]).map((e) => `${e.actor} ${e.action}`);
  assert.deepEqual(actions.slice(-3), ["daemon journal.project.register.read_only", "daemon journal.project.trust.grant_dialog", "daemon journal.project.trust.revoke_gesture"]);
});

test("a repository cannot register or trust itself: inspecting one whose config claims trust leaves it unregistered and untrusted", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const p = git(join(r.root, "archive"));
  writeFileSync(join(p, ".git", "config"), "[axis]\n\ttrusted = true\n\tproject = true\n");
  mkdirSync(join(p, ".axis"));
  writeFileSync(join(p, ".axis", "trust"), "trusted\n");
  const seen = await r.ask(inspect(p));
  assert.equal(seen["registered"], undefined);
  assert.deepEqual(r.journal.listProjects(), []);
  const id = (await r.ask(register(p, false)))["projectId"] as string;
  assert.equal(r.journal.getProject(id)?.trusted, false, "only the message main sends after its dialog grants");
});

test("degraded (no journal): every message is unavailable; a journal error is a closed code, never its text", { skip: SKIP }, async (t) => {
  const r = rig(t, { journal: false });
  const p = git(join(r.root, "repo"));
  for (const m of [inspect(p), register(p), trust("p-1", p, false)]) assert.equal((await r.ask(m))["code"], "E_UNAVAILABLE");
});

test("a project display name comes from the folder name, or a fixed word when that is not plain text", () => {
  assert.equal(projectDisplayName("/work/my-repo"), "my-repo");
  assert.equal(projectDisplayName("/work/‮evil"), "project");
});

test("the message queue is bounded: past 16 waiting, a message is answered E_BACKPRESSURE at once (mutant: no bound)", async () => {
  const answers: Record<string, unknown>[] = [];
  const hung: BindingFs = { realpath: () => new Promise(() => undefined), lstat: () => new Promise(() => undefined) };
  const pc = createProjectControl({
    journal: { listProjects: () => [], getProject: () => undefined, registerProject: () => undefined as never, setProjectTrust: () => undefined as never },
    control: { send: (m) => void answers.push(m as Record<string, unknown>) },
    excludedRoots: ["/axis/data"],
    binding: { platform: "linux", uid: 1, fs: hung, timeoutMs: 20 },
    remote: { runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, env: {}, platform: "linux" },
  });
  const all = Array.from({ length: 17 }, (_, i) => pc.handle({ type: "projects.inspect", requestId: `r${i}`, path: `/repo${i}` }));
  assert.deepEqual(answers.map((a) => [a["requestId"], a["code"]]), [["r16", "E_BACKPRESSURE"]], "refused before any work");
  await Promise.all(all);
  assert.equal(answers.length, 17);
  assert.ok(answers.slice(1).every((a) => a["code"] === "E_UNAVAILABLE"), "the others ran and hit the binding bound");
  // Once drained, the queue takes messages again.
  await pc.handle({ type: "projects.inspect", requestId: "again", path: "/repo" });
  assert.equal(answers.at(-1)?.["code"], "E_UNAVAILABLE");
});

test("review B S1: a projects.trust revoke calls onRevoked for that project (it stops the runs); a grant or a refusal does not (mutant: no call)", { skip: SKIP }, async (t) => {
  const r = rig(t);
  const p = git(join(r.root, "repo"));
  const revoked: string[] = [];
  const pc = createProjectControl({
    journal: r.journal,
    control: { send: () => undefined },
    excludedRoots: [r.dataDir],
    binding: { platform: process.platform, uid: (process.getuid as () => number)() },
    remote: { runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, env: {}, platform: process.platform },
    onRevoked: (id) => void revoked.push(id),
  });
  await pc.handle(register(p, true));
  const id = r.journal.listProjects()[0]?.id as string;
  await pc.handle(trust(id, p, true));
  assert.deepEqual(revoked, [], "a grant stops nothing");
  await pc.handle(trust("p-none", p, false));
  assert.deepEqual(revoked, [], "a refused revoke stops nothing");
  await pc.handle(trust(id, p, false));
  assert.deepEqual(revoked, [id]);
});

test("review B nits: a full queue never refuses a revoke; an excluded root whose real path cannot be read in time refuses registration (fail closed)", async (t) => {
  const answers: Record<string, unknown>[] = [];
  const hung: BindingFs = { realpath: () => new Promise(() => undefined), lstat: () => new Promise(() => undefined) };
  const revoked: string[] = [];
  const journal = {
    listProjects: () => [],
    getProject: (id: string) => (id === "p-1" ? ({ id, path: "/repo", trusted: true, commonDir: "/repo/.git", gitDirId: "1:1" } as never) : undefined),
    registerProject: () => undefined as never,
    setProjectTrust: () => undefined as never,
  };
  const pc = createProjectControl({
    journal,
    control: { send: (m) => void answers.push(m as Record<string, unknown>) },
    excludedRoots: ["/axis/data"],
    binding: { platform: "linux", uid: 1, fs: hung, timeoutMs: 20 },
    remote: { runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, env: {}, platform: "linux" },
    onRevoked: (id) => void revoked.push(id),
  });
  const queued = Array.from({ length: 16 }, (_, i) => pc.handle({ type: "projects.inspect", requestId: `q${i}`, path: `/r${i}` }));
  const revoke = pc.handle({ type: "projects.trust", requestId: "rv", projectId: "p-1", path: "/repo", trusted: false });
  assert.equal(answers.some((a) => a["requestId"] === "rv"), false, "the revoke was not refused: it waits its turn (mutant: not exempt)");
  await Promise.all([...queued, revoke]);
  assert.deepEqual(answers.find((a) => a["requestId"] === "rv"), { type: "projects.result", requestId: "rv", ok: true, projectId: "p-1" });
  assert.deepEqual(revoked, ["p-1"]);

  // An excluded root whose real path hangs: registration and inspection are refused, never let through.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-roots-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = git(join(root, "repo"));
  const slow: Record<string, unknown>[] = [];
  const db = openDatabase(":memory:");
  const pc2 = createProjectControl({
    journal: Journal.open(db, { audit: new AuditLog(db) }),
    control: { send: (m) => void slow.push(m as Record<string, unknown>) },
    excludedRoots: ["/axis/data"],
    binding: POSIX ? { platform: process.platform, uid: (process.getuid as () => number)() } : { platform: "linux", uid: 1, fs: hung, timeoutMs: 20 },
    remote: { runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, env: {}, platform: process.platform },
    rootsRealpath: () => new Promise(() => undefined),
  });
  if (POSIX) {
    await pc2.handle(register(p));
    assert.deepEqual([slow[0]?.["code"], slow[0]?.["reason"]], ["E_UNAVAILABLE", "roots_unavailable"], "mutant: the timed-out root is ignored");
  }
});
