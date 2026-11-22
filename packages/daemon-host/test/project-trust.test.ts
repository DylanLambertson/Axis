// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AxisError } from "@axis/audit";
import { createProjectTrustGate, worktreeBelongs } from "../src/gate/project-trust-gate.js";
import { ProjectTrustTicket } from "../src/gate/project-ticket.js";
import { attestedWindow } from "../testing/attested.js";
import { consumeTicket, ticketedStart, trustCallOf, type ProjectTrustGateDeps } from "../src/gate/project-trust.js";

/** A desktop window's gated call (the attested identity's form). */
const win = (windowId: string) => trustCallOf(windowId === "" ? { windowId, clientKind: "desktop" } : attestedWindow(windowId));
import { toGitError } from "../src/handlers/git-errors.js";
import { toComposerError } from "../src/composer/errors.js";
import { toRunError } from "../src/runs/errors.js";
import { toDaemonError } from "../src/worktrees/errors.js";
import { createProjectRunStopper } from "../src/compose-parts.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";

// The project trust gate (docs/design/project-registration-and-trust.md §5.4): T1 to T4, the workspace binding, the ticket.

const POSIX = process.platform !== "win32";
const untrusted = (e: unknown) => e instanceof AxisError && e.code === "E_POLICY_DENIED" && e.detail["reason"] === "untrusted";
const signal = new AbortController().signal;

function rig(over: Partial<ProjectTrustGateDeps> = {}, row: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const project = { id: "p", path: "/r", trusted: true, commonDir: "/r/.git", gitDirId: "1:2", ...row };
  let now = 1_000;
  const deps: ProjectTrustGateDeps = {
    journal: {
      // A fresh copy per read, as the journal answers (a row read earlier does not change under the reader).
      getProject: (id: string) => (calls.push("T1"), id === "p" ? ({ ...project } as never) : undefined),
      getWorkspace: (id: string) => ({ id, projectId: "p", worktreePath: "/wt" }) as never,
      setProjectTrust: (i: unknown) => (calls.push(`drop:${JSON.stringify(i)}`), project as never),
    },
    binding: async () => (calls.push("T2"), { ok: true, binding: { path: "/r", commonDir: "/r/.git", gitDirId: "1:2" } }),
    trustCheck: async (r) => void calls.push(`T3:${JSON.stringify(r)}`),
    registry: { isRevoked: () => (calls.push("T4"), false) },
    now: () => now,
    onRevoked: (id) => void calls.push(`stop:${id}`),
    fs: {
      lstat: (async () => ({ isFile: () => true, size: 40 })) as never,
      readFile: (async (p: string) => (String(p).endsWith(".git") ? "gitdir: /r/.git/worktrees/w\n" : "/r/.git\n")) as never,
      realpath: (async (p: string) => String(p)) as never,
    },
    ...over,
  };
  return { gate: createProjectTrustGate(deps), calls, project, tick: (ms: number) => void (now += ms), now: () => now };
}

test("all hold: a ticket, after T1, T2, the workspace binding, T3 with the journal's path, and T4, in that order", async () => {
  const r = rig();
  const t = await r.gate.admit({ projectId: "p", caller: win("w1"), workspaceId: "ws", signal });
  assert.ok(ProjectTrustTicket.isTicket(t));
  assert.deepEqual(r.calls, ["T1", "T2", `T3:${JSON.stringify({ windowId: "w1", projectId: "p", projectPath: "/r", workspaceId: "ws" })}`, "T1", "T4"], "T1 again right before the mint");
  // worktrees.create has no workspace: trust.check carries none, and no workspace binding is read.
  const c = rig();
  await c.gate.admit({ projectId: "p", caller: win("w1"), signal });
  assert.deepEqual(c.calls, ["T1", "T2", `T3:${JSON.stringify({ windowId: "w1", projectId: "p", projectPath: "/r" })}`, "T1", "T4"]);
});

test("each condition refuses on its own (one mutant each)", async () => {
  const go = (r: ReturnType<typeof rig>, ws?: string) => r.gate.admit({ projectId: "p", caller: win("w1"), ...(ws === undefined ? {} : { workspaceId: ws }), signal });
  await assert.rejects(go(rig({}, { trusted: false })), untrusted, "T1: the record is not trusted");
  await assert.rejects(rig().gate.admit({ projectId: "nope", caller: win("w1"), signal }), untrusted, "T1: no row");
  await assert.rejects(go(rig({ binding: async () => ({ ok: true, binding: { path: "/r", commonDir: "/r/.git", gitDirId: "9:9" } }) })), untrusted, "T2: another inode");
  await assert.rejects(go(rig({}, { commonDir: null, gitDirId: null })), untrusted, "T2: a pre-v11 row never matches");
  await assert.rejects(go(rig({ trustCheck: async () => { throw new AxisError("E_POLICY_DENIED", "no", { reason: "untrusted" }); } })), untrusted, "T3: main says no");
  await assert.rejects(go(rig({ registry: { isRevoked: () => true } })), untrusted, "T4: a revoke recorded since dispatch (mutant: step 5 dropped)");
  const row = { id: "p", path: "/r", trusted: true, commonDir: "/r/.git", gitDirId: "1:2" };
  const ws = rig({ journal: { getProject: () => row as never, getWorkspace: () => ({ id: "ws", projectId: "other", worktreePath: "/wt" }) as never, setProjectTrust: () => row as never } });
  await assert.rejects(go(ws, "ws"), untrusted, "W: a workspace of another project");
  const repointed = rig({
    fs: {
      lstat: (async () => ({ isFile: () => true, size: 40 })) as never,
      readFile: (async (f: string) => (String(f).endsWith(".git") ? "gitdir: /other/.git/worktrees/w\n" : "/other/.git\n")) as never,
      realpath: (async (f: string) => String(f)) as never,
    },
  });
  await assert.rejects(go(repointed, "ws"), untrusted, "W: the worktree's .git repointed at another repository (mutant: W dropped)");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(rig().gate.admit({ projectId: "p", caller: win("w1"), signal: aborted.signal }), (e: unknown) => untrusted(e) || (e as Error).name === "AbortError", "an aborted call is refused (cancelled or untrusted)");
});

test("a lost binding drops the record (binding_lost) and stops the project's runs; an unavailable filesystem refuses only this call", async () => {
  const lost = rig({ binding: async () => ({ ok: false, reason: "not_a_repository" }) });
  await assert.rejects(lost.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  assert.ok(lost.calls.includes(`drop:${JSON.stringify({ id: "p", trusted: false, via: "binding_lost" })}`), "mutant: binding_lost not persisted");
  assert.ok(lost.calls.includes("stop:p"), "mutant: runs not stopped");
  assert.equal(lost.calls.some((c) => c.startsWith("T3")), false, "main is not asked after a lost binding");
  const swapped = rig({ binding: async () => ({ ok: true, binding: { path: "/r", commonDir: "/r/.git", gitDirId: "3:4" } }) });
  await assert.rejects(swapped.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  assert.ok(swapped.calls.some((c) => c.includes("binding_lost")));
  const slow = rig({ binding: async () => ({ ok: false, reason: "unavailable" }) });
  await assert.rejects(slow.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  assert.equal(slow.calls.some((c) => c.startsWith("drop") || c.startsWith("stop")), false, "a hung filesystem does not revoke");
});

test("the ticket: single use, bound to its project and workspace, fresh for 1 s on the gate's clock, unforgeable", async () => {
  const r = rig();
  const get = (ws?: string) => r.gate.admit({ projectId: "p", caller: win("w1"), ...(ws === undefined ? {} : { workspaceId: ws }), signal });
  const t = await get("ws");
  consumeTicket(t, { projectId: "p", workspaceId: "ws" }, r.now);
  assert.throws(() => consumeTicket(t, { projectId: "p", workspaceId: "ws" }, r.now), untrusted, "spent");
  const [t1, t2, t3] = [await get("ws"), await get("ws"), await get()];
  assert.throws(() => consumeTicket(t1, { projectId: "q", workspaceId: "ws" }, r.now), untrusted, "another project");
  assert.throws(() => consumeTicket(t2, { projectId: "p", workspaceId: "other" }, r.now), untrusted, "another workspace");
  assert.throws(() => consumeTicket(t3, { projectId: "p", workspaceId: "ws" }, r.now), untrusted, "a create ticket is not a workspace ticket");
  const old = await get("ws");
  r.tick(1_001);
  assert.throws(() => consumeTicket(old, { projectId: "p", workspaceId: "ws" }, r.now), untrusted, "expired (mutant: TTL not checked)");
  for (const forged of [undefined, null, {}, { projectId: "p", workspaceId: "ws" }, Object.create(ProjectTrustTicket.prototype)]) {
    assert.throws(() => consumeTicket(forged, { projectId: "p", workspaceId: "ws" }, r.now), untrusted);
  }
  assert.throws(() => new ProjectTrustTicket(Symbol("project-trust-ticket") as never), untrusted, "only the gate's key mints");
});

function layout(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-wt-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const common = join(root, "repo", ".git");
  mkdirSync(join(common, "worktrees", "w"), { recursive: true });
  writeFileSync(join(common, "worktrees", "w", "commondir"), "../..\n");
  const wt = join(root, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(common, "worktrees", "w")}\n`);
  return { root, common, wt };
}

test("the workspace binding on a real layout: a gitdir: file into <common>/worktrees/<n> whose commondir resolves back", { skip: POSIX ? false : "POSIX" }, async (t) => {
  const { root, common, wt } = layout(t);
  assert.equal(await worktreeBelongs(wt, common), true);
  // Repointed at another repository's worktree.
  const other = join(root, "other", ".git", "worktrees", "w");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "commondir"), "../..\n");
  writeFileSync(join(wt, ".git"), `gitdir: ${other}\n`);
  assert.equal(await worktreeBelongs(wt, common), false);
  // The right directory, but its commondir points elsewhere.
  writeFileSync(join(wt, ".git"), `gitdir: ${join(common, "worktrees", "w")}\n`);
  writeFileSync(join(common, "worktrees", "w", "commondir"), `${join(root, "other", ".git")}\n`);
  assert.equal(await worktreeBelongs(wt, common), false);
  // A .git directory in the worktree, or garbage in the file.
  writeFileSync(join(common, "worktrees", "w", "commondir"), "../..\n");
  rmSync(join(wt, ".git"));
  mkdirSync(join(wt, ".git"));
  assert.equal(await worktreeBelongs(wt, common), false);
  rmSync(join(wt, ".git"), { recursive: true });
  writeFileSync(join(wt, ".git"), "not a gitdir line\n");
  assert.equal(await worktreeBelongs(wt, common), false);
});

test("an archive repository cannot trust itself: Workspace Trust says yes (T3), but without the record (T1) the gate refuses", async () => {
  // A repository unpacked under a folder the user trusts in the workbench: main would answer true, the journal has no record.
  const r = rig({}, { trusted: false });
  await assert.rejects(r.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  assert.equal(r.calls.some((c) => c.startsWith("T3")), false, "main's answer is never the deciding one");
  // The renderer-writable model rewritten to trusted with the record false: still untrusted (the TRU-2 acceptance, unit level).
  const rewritten = rig({ trustCheck: async () => undefined }, { trusted: false });
  await assert.rejects(rewritten.gate.admit({ projectId: "p", caller: win("w1"), workspaceId: "ws", signal }), untrusted);
});

test("the wire code per path: every handler family answers the gate's refusal E_CONFLICT untrusted, never E_POLICY_DENIED or E_INTERNAL", () => {
  const gateError = new AxisError("E_POLICY_DENIED", "The project is not trusted", { reason: "untrusted" });
  for (const [name, map] of [["git (commit, push)", toGitError], ["worktrees (create, restore, discard)", toDaemonError], ["composer (runs.start)", toComposerError], ["cli-runs (start)", toRunError]] as const) {
    const e = (map as (x: unknown) => { code: string; details?: Record<string, unknown> })(gateError);
    assert.deepEqual([e.code, e.details?.["reason"]], ["E_CONFLICT", "untrusted"], `${name} (mutant: the internal code passed through)`);
  }
});

test("the run stopper ends every live CLI and composer run of the project's workspaces and nothing else; it never throws", () => {
  const stopped: string[] = [];
  const stop = createProjectRunStopper({
    mutex: () => undefined,
    journal: () => ({ listWorkspaces: () => [{ id: "a", projectId: "p" }, { id: "b", projectId: "q" }] as never }),
    runs: () => ({
      list: (o?: { workspaceId?: string }) => (o?.workspaceId === "a" ? [{ runId: "c1", state: "RUNNING" }, { runId: "c2", state: "COMPLETED" }] : [{ runId: "c3", state: "RUNNING" }]) as never,
      stop: (id: string) => (stopped.push(`cli:${id}`), {} as never),
    }),
    composer: () => ({
      list: (o: { workspaceId?: string }) => (o.workspaceId === "a" ? [{ runId: "m1", endedAt: null }, { runId: "m2", endedAt: "t" }] : [{ runId: "m3", endedAt: null }]),
      cancel: (id: string) => {
        stopped.push(`composer:${id}`);
        if (id === "m1") throw new Error("ended meanwhile");
      },
    }),
  });
  stop("p");
  assert.deepEqual(stopped, ["cli:c1", "composer:m1"]);
  assert.doesNotThrow(() => createProjectRunStopper({ mutex: () => undefined, journal: () => { throw new Error("x"); }, runs: () => undefined, composer: () => undefined })("p"));
});

test("the composer's start as the handler sees it spends the ticket first; without one nothing starts (mutant: not spent)", async () => {
  const started: string[] = [];
  const now = () => 5_000;
  const start = ticketedStart((i: { workspaceId: string }) => (started.push(i.workspaceId), "run"), () => "p", now);
  const gate = rig({ now } as never).gate;
  const good = await gate.admit({ projectId: "p", caller: win("w1"), workspaceId: "ws", signal });
  assert.equal(start({ workspaceId: "ws" }, signal, good), "run");
  assert.throws(() => start({ workspaceId: "ws" }, signal, good), untrusted, "spent");
  assert.throws(() => start({ workspaceId: "ws" }, signal, undefined), untrusted);
  const other = await gate.admit({ projectId: "p", caller: win("w1"), workspaceId: "other", signal });
  assert.throws(() => start({ workspaceId: "ws" }, signal, other), untrusted, "another workspace");
  assert.deepEqual(started, ["ws"]);
});

test("review B1: an untrust or a revoke that lands during any await of the gate refuses: the record is re-read right before the mint (mutant: no final re-read)", async () => {
  // The untrust lands while the binding is read.
  const duringBinding = rig({ binding: async () => ((duringBinding.project as { trusted: boolean }).trusted = false, { ok: true, binding: { path: "/r", commonDir: "/r/.git", gitDirId: "1:2" } }) });
  await assert.rejects(duringBinding.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  // The untrust lands while main is asked (trust.check round trip).
  const duringMain = rig({ trustCheck: async () => void ((duringMain.project as { trusted: boolean }).trusted = false) });
  await assert.rejects(duringMain.gate.admit({ projectId: "p", caller: win("w1"), workspaceId: "ws", signal }), untrusted);
  // A registry revoke recorded while main is asked.
  let revoked = false;
  const revokedDuring = rig({ trustCheck: async () => void (revoked = true), registry: { isRevoked: () => revoked } });
  await assert.rejects(revokedDuring.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  // The row re-bound to another repository meanwhile (a different binding than the one checked).
  const rebound = rig({ trustCheck: async () => void ((rebound.project as { gitDirId: string }).gitDirId = "7:7") });
  await assert.rejects(rebound.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
  // An empty window id is refused by the gate itself.
  await assert.rejects(rig().gate.admit({ projectId: "p", caller: win(""), signal }), untrusted);
});

test("review B S2: the stopper takes the project mutex: a start that passed the gate before the revoke is recorded, then stopped (mutant: no mutex)", async () => {
  const mutex = new ProjectMutex();
  const runs: { runId: string; state: string }[] = [];
  const stopped: string[] = [];
  const stop = createProjectRunStopper({
    mutex: () => mutex,
    journal: () => ({ listWorkspaces: () => [{ id: "a", projectId: "p" }] as never }),
    runs: () => ({ list: () => runs as never, stop: (id: string) => (stopped.push(id), {} as never) }),
    composer: () => undefined,
  });
  // A start holds the project mutex across its gate and its start, and records its run only after an await.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const start = mutex.run("p", async () => {
    await held;
    runs.push({ runId: "late", state: "RUNNING" });
  });
  await new Promise((x) => setTimeout(x, 0));
  stop("p"); // the revoke lands while the start is in flight
  await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(stopped, [], "the stopper waits for the start");
  release();
  await start;
  await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(stopped, ["late"], "the run the start recorded is stopped: none survives the revoke");
});

test("review 2 SF1: binding_lost inside a held project mutex: admit refuses at once, the stop runs AFTER the handler releases, and a start that was already waiting is stopped too (mutant: the re-entrant run)", async () => {
  const mutex = new ProjectMutex();
  const runs: { runId: string; state: string }[] = [{ runId: "r1", state: "RUNNING" }];
  const stopped: string[] = [];
  const stopper = createProjectRunStopper({
    mutex: () => mutex,
    journal: () => ({ listWorkspaces: () => [{ id: "a", projectId: "p" }] as never }),
    runs: () => ({ list: () => runs as never, stop: (id: string) => (stopped.push(id), {} as never) }),
    composer: () => undefined,
  });
  const lost = rig({ binding: async () => ({ ok: false, reason: "not_a_repository" }), onRevoked: stopper });
  let releaseHandler!: () => void;
  const handlerDone = new Promise<void>((r) => (releaseHandler = r));
  // A start handler holds the project and calls the gate, which finds the binding lost.
  const handler = mutex.run("p", async () => {
    await assert.rejects(lost.gate.admit({ projectId: "p", caller: win("w1"), signal }), untrusted);
    await new Promise((x) => setTimeout(x, 10));
    assert.deepEqual(stopped, [], "the stop queues: it does not run inside the handler's critical section");
    await handlerDone;
  });
  // Another start, in an unrelated context, was already waiting for the project: it records its run when it gets the lock.
  const other = mutex.run("p", async () => void runs.push({ runId: "late", state: "RUNNING" }));
  await new Promise((x) => setTimeout(x, 20));
  releaseHandler();
  const bound = new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 2_000));
  await Promise.race([Promise.all([handler, other]), bound]);
  await new Promise((x) => setTimeout(x, 20));
  assert.deepEqual(stopped, ["r1", "late"], "the stop ran after both, so the run the waiting start recorded did not survive");
});

test("review 2 nit: the workspace row is read again right before the mint: a workspace moved or removed during the gate refuses (mutant: no workspace re-read)", async () => {
  const row = { id: "p", path: "/r", trusted: true, commonDir: "/r/.git", gitDirId: "1:2" };
  let reads = 0;
  const r = rig({
    journal: {
      getProject: () => ({ ...row }) as never,
      // The first read (before the awaits) sees the workspace; the final one sees it gone.
      getWorkspace: (id: string) => (++reads === 1 ? ({ id, projectId: "p", worktreePath: "/wt" } as never) : undefined),
      setProjectTrust: () => row as never,
    },
  });
  await assert.rejects(r.gate.admit({ projectId: "p", caller: win("w1"), workspaceId: "ws", signal }), untrusted);
  assert.equal(reads, 2);
});
