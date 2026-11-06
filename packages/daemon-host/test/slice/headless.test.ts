// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuditLog } from "@axis/audit";
import { approvalRequiredDetailsSchema } from "@axis/protocol";
import { classifyDeniedName } from "@axis/pty-policy";
import { createGitFixture, gitSkipReason, canary, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, newKey, resultOf, transcript, until } from "../../testing/test-client.js";
import type { TestSupervisor } from "../../testing/test-supervisor.js";
import {
  DENIED_SEEDS, FAKE_CLI, auditRows, awaitRun, confirmNative, finaliseApproved, damagedCopy, disposeHosts, type AuditRow, createWorkspace, databaseBytes, openStopped, registerProject, startHost, trustWindow, type Workspace,
} from "../../testing/slice-helpers.js";

/**
 * The headless slice (plan section 1, ticket H12): the real composition root (`composeDaemonHost`) in a CHILD PROCESS, no Electron,
 * no UI, no Code OSS. Real: the process, its lock, signals and exit code, `@axis/worktrees` over a fixture repository, the run
 * supervisor, the run snapshotter (`@axis/git-snapshot`, H13), `@axis/review`, `@axis/git-ops`, the secret scanner, the audit
 * chain and the anchor protocol.
 *
 * FAKES (each replaced by a named later ticket):
 *  - the pty port (`LocalPty`: a plain child process; B9 brings the pty process and the process-group contract of question 18);
 *  - the `pty` git runner (a local node runner serving the pty context; B9);
 *  - the supervisor (`TestSupervisor`: answers anchors, trust, settings and native confirmations the way main would).
 * Hooks are not built (H9-hooks): step 5 asserts the interim, that a planted pre-commit hook does NOT run.
 */
const skip = gitSkipReason();
const PROJECT = "axis.worktrees";

/** A generous bound so a stuck step fails the suite instead of hanging CI; the steps themselves wait on conditions. */
const SUITE_TIMEOUT_MS = 240_000;

describe("headless slice", { skip, timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  let sup: TestSupervisor;
  let user: TestClient;
  let projectId: string;
  let w1: Workspace;
  let w2: Workspace;
  let runId = "";
  let commit = "";
  let treeHash = "";
  let stopped: DatabaseSync;
  let planDigest = "";
  const secrets: string[] = [];
  const hookState: { marker: string; works: boolean } = { marker: "", works: false };
  const dumpPath = (n: string): string => join(scratch, `${n}.json`);
  const cliAgents = () => [
    { id: "fake", label: "Fake CLI", command: [process.execPath, FAKE_CLI], args: [dumpPath("fake")] },
    { id: "slow", label: "Slow CLI", command: [process.execPath, FAKE_CLI], args: [dumpPath("slow"), "slow"] },
  ];
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: string }).code === "EPERM";
    }
  };

  before(async () => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-out-"));
    Object.assign(hookState, fx.plantHook());
    mkdirSync(join(scratch, "unused-worktrees"));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("1. start: ready, not degraded, the contracts are offered; a second host on the same data exits 75", async () => {
    const started = await startHost(fx, { agents: cliAgents() });
    sup = started.sup;
    const ready = await started.ready;
    assert.equal(ready["degraded"], undefined);
    assert.deepEqual([...(ready["contracts"] as string[])].sort(), ["axis.approvals", "axis.audit", "axis.cli-runs", "axis.events", "axis.git", "axis.projects", "axis.providers", "axis.review", "axis.runs", "axis.worktrees"]);
    trustWindow(sup);
    projectId = await registerProject(sup, fx.repo);
    user = await TestClient.open(sup);
    assert.deepEqual(user.welcome.contracts.map((c) => c.id).sort(), (ready["contracts"] as string[]).slice().sort());
    const projects = await user.ok<{ projects: Array<{ id: string; trusted: boolean }> }>("axis.projects", "list", {});
    assert.deepEqual(projects.projects.map((p) => p.id), [projectId]);
    // C5: the composed list answers from the agent binding's registry (it was [] before), so the mock and its model are listed.
    const listed = await user.ok<{ providers: Array<{ providerId: string; status: string; models: Array<{ modelId: string }> }> }>("axis.providers", "list", {});
    assert.deepEqual(listed.providers.map((p) => [p.providerId, p.status, p.models.map((m) => m.modelId)]), [["mock", "ready", ["mock-model"]]]);

    const second = await startHost(fx, { config: { dataDir: sup.dataDir, worktreeRoot: join(scratch, "other-worktrees") } });
    assert.equal((await second.sup.exited).code, 75, "a second host on a locked data directory exits E_CONFLICT (75)");
    await second.sup.dispose();
  });

  test("2. create: id and baseSha, an idempotent replay, a conflicting reuse, no caller-chosen principal", async () => {
    const key = newKey();
    const first = await user.ok<{ id: string; worktree: { baseSha: string; branch: string } }>(PROJECT, "create", { projectId, name: "Add hello" }, key);
    assert.match(first.worktree.baseSha, /^[0-9a-f]{40,64}$/);
    const replay = await user.ok<{ id: string }>(PROJECT, "create", { projectId, name: "Add hello" }, key);
    assert.equal(replay.id, first.id, "the same key and payload returns the stored result");
    const other = await user.call(PROJECT, "create", { projectId, name: "Something else" }, key);
    assert.equal(other.error?.code, "E_IDEMPOTENCY_CONFLICT");
    const listed = await user.ok<{ worktrees: unknown[] }>(PROJECT, "list", { projectId });
    assert.equal(listed.worktrees.length, 1, "the replay created nothing new");
    const forged = await user.call(PROJECT, "create", { projectId, name: "Forged", createdBy: "agent:evil" }, true);
    assert.equal(forged.error?.code, "E_INVALID_ARGUMENT", "no payload field can name the principal");
    w1 = await (await import("../../testing/slice-helpers.js")).describeWorkspace(user, first.id);
    assert.equal(w1.baseSha, first.worktree.baseSha);
  });

  test("3. run: QUEUED, RUNNING, REVIEWING; the CLI environment holds no PTY-5 denied name", async () => {
    const started = await user.ok<{ run: { runId: string; state: string } }>("axis.cli-runs", "start", { workspaceId: w1.id, agentId: "fake" }, true);
    runId = started.run.runId;
    const seen = new Set<string>([started.run.state]);
    const done = await awaitRun(user, runId, "REVIEWING", seen);
    assert.equal(done["exitCode"], 0);
    for (const s of seen) assert.ok(["QUEUED", "RUNNING", "REVIEWING"].includes(s), s);
    const dump = JSON.parse(readFileSync(dumpPath("fake"), "utf8")) as { envNames: string[]; cwd: string };
    assert.ok(dump.envNames.includes("PATH"));
    for (const seed of DENIED_SEEDS) {
      assert.notEqual(classifyDeniedName(seed), undefined, `${seed} is a denied name (the seed is meaningful)`);
      assert.ok(!dump.envNames.includes(seed), `${seed} reached the CLI`);
    }
    assert.ok(dump.envNames.every((n) => classifyDeniedName(n) === undefined), "no denied name in the CLI environment");
    assert.ok(!dump.envNames.includes("AXIS_SLICE_SCAN_MODE"), "the host's own AXIS_ variable stays inside the host");
    assert.equal(readFileSync(join(w1.path, "src", "hello.txt"), "utf8"), "hello from the fake CLI\n");
    // The real GIT-SNAP-1 snapshot (H13) ran before and after: a run that wrote only a work file left git's configuration as it was.
    let verdict: unknown = "pending";
    await until(async () => (verdict = (await user.ok<{ run: Record<string, unknown> }>("axis.cli-runs", "get", { runId })).run["snapshotAfter"]) !== "pending", "snapshot verdict");
    assert.equal(verdict, "ok");
  });

  type Diff = { head: string; branch: string; treeHash: string; files: Array<{ displayPath: string }> };
  const diffOf = (ws: Workspace): Promise<Diff> => user.ok<Diff>("axis.review", "diff", { workspaceId: ws.id });
  const commitOf = (ws: Workspace, d: Diff, message: string) =>
    user.call("axis.git", "commit", { workspaceId: ws.id, reviewedTreeHash: d.treeHash, expectedParent: d.head, expectedBranch: d.branch, message }, true);
  const planOf = (ws: Workspace, who: TestClient = user) => who.ok<{ tip: string; digest: string; requiresConfirmation: boolean; reasons: string[]; findings: Array<{ rule: string; path?: string }>; blocked?: { reason: string } }>("axis.git", "pushPlan", { workspaceId: ws.id, remote: "origin" });

  test("4. review: diff lists src/hello.txt with a treeHash; complete is the user's alone", async () => {
    const d = await diffOf(w1);
    assert.deepEqual(d.files.map((f) => f.displayPath), ["src/hello.txt"]);
    treeHash = d.treeHash;
    assert.match(treeHash, /^[0-9a-f]{40,64}$/);
    const agent = await TestClient.open(sup, sup.attest({ actor: "agent:fake", actorId: "agent-1" }));
    const denied = await agent.call("axis.review", "complete", { runId }, true);
    assert.equal(denied.error?.code, "E_POLICY_DENIED", "an agent connection cannot complete a review");
    agent.close();
    const done = await user.ok<{ run: { state: string } }>("axis.review", "complete", { runId }, true);
    assert.equal(done.run.state, "COMPLETED");
  });

  test("5. commit: the reviewed tree only; a changed worktree is refused; the pre-commit hook does not run (interim, H9-hooks)", async () => {
    const reviewed = await diffOf(w1);
    writeFileSync(join(w1.path, "extra.txt"), "changed after the review\n");
    const refused = await commitOf(w1, reviewed, "Add hello");
    assert.equal(refused.error?.code, "E_CONFLICT", "the worktree changed after the review");
    assert.equal(fx.git(w1.path, "rev-parse", "HEAD").trim(), reviewed.head, "nothing was committed");
    rmSync(join(w1.path, "extra.txt"));
    const fresh = await diffOf(w1);
    assert.equal(fresh.treeHash, reviewed.treeHash);
    const made = resultOf<{ commit: string; tree: string }>(await commitOf(w1, fresh, "Add hello"), "commit");
    commit = made.commit;
    assert.equal(made.tree, treeHash);
    assert.equal(fx.git(w1.path, "rev-parse", `${commit}^{tree}`).trim(), treeHash, "the commit's tree is the reviewed tree");
    assert.equal(fx.git(w1.path, "rev-parse", `${commit}^`).trim(), reviewed.head);
    assert.equal(fx.git(w1.path, "rev-parse", w1.branch).trim(), commit);
    if (hookState.works) assert.equal(existsSync(hookState.marker), false, "interim: a bound commit runs no repository hook");
  });

  test("6. push: plan, challenge, native confirmation, approved retry; one ref moves; reuse and replay", async () => {
    const plan = await planOf(w1);
    assert.deepEqual([plan.tip, plan.requiresConfirmation, plan.findings.length, plan.blocked], [commit, false, 0, undefined]);
    planDigest = plan.digest;
    const request = { workspaceId: w1.id, remote: "origin", confirmedPlan: { tip: plan.tip, digest: plan.digest } };
    const key = newKey();
    const asked = await user.call("axis.git", "push", request, key);
    assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED");
    const { challenge } = approvalRequiredDetailsSchema.parse(asked.error?.details);
    assert.equal(challenge.nativeConfirmationRequired, true);
    assert.deepEqual(fx.remoteRefs(), [], "nothing is pushed before the approval");
    await until(() => sup.nativeConfirms.some((c) => c.challengeId === challenge.challengeId), "native.confirm");
    const resolved = await user.ok<{ state: string }>("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
    assert.equal(resolved.state, "approved");
    await confirmNative(sup, user, challenge.challengeId);
    const approval = { challengeId: challenge.challengeId };
    const pushed = await user.call("axis.git", "push", { ...request, approval }, key);
    assert.ok(pushed.ok, `push failed: ${pushed.error?.code}`);
    assert.deepEqual(fx.remoteRefs(), [`refs/heads/${w1.branch} ${commit}`], "exactly the workspace branch moved");
    const confirms = sup.nativeConfirms.length;
    const reused = await user.call("axis.git", "push", { ...request, approval }, true);
    assert.equal(reused.ok, false, "a spent challenge cannot be used again");
    const replay = await user.call("axis.git", "push", { ...request, approval }, key);
    assert.ok(replay.ok, "a replay of the same key returns the stored result");
    assert.equal(sup.nativeConfirms.length, confirms, "no new confirmation for a replay");
    const second = await TestClient.open(sup);
    const again = await second.call("axis.git", "push", request, key);
    assert.equal(again.error?.code, "E_APPROVAL_REQUIRED", "another connection needs its own approval");
    second.close();
    assert.deepEqual(fx.remoteRefs(), [`refs/heads/${w1.branch} ${commit}`], "still one ref, still the same commit");
  });

  test("7. secret path: refuse mode blocks the push by rule name and path only, before any challenge; a stale plan is plan_changed", async () => {
    const secret = canary();
    w2 = await createWorkspace(user, projectId, "Secrets");
    writeFileSync(join(w2.path, "settings.txt"), `aws_access_key_id=${secret}\n`);
    const d2 = await diffOf(w2);
    resultOf(await commitOf(w2, d2, "Add settings"), "commit");
    const plan = await planOf(w2);
    assert.equal(plan.blocked?.reason, "secrets_found");
    assert.equal(plan.requiresConfirmation, false, "a blocked plan cannot be confirmed");
    assert.ok(plan.findings.some((f) => f.rule === "aws-access-key-id"), "the key rule matched");
    assert.ok(plan.findings.every((f) => f.path === "settings.txt"), "findings name the path");
    const before = { confirms: sup.nativeConfirms.length, pending: (await user.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length };
    const refused = await user.call("axis.git", "push", { workspaceId: w2.id, remote: "origin", confirmedPlan: { tip: plan.tip, digest: plan.digest } }, true);
    assert.equal(refused.error?.code, "E_CONFLICT");
    assert.equal(refused.error?.details?.["reason"], "secrets_found");
    assert.deepEqual({ confirms: sup.nativeConfirms.length, pending: (await user.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length }, before, "no challenge, no dialog");
    assert.equal(fx.remoteRefs().length, 1, "the secret workspace was not pushed");
    secrets.push(secret);
    // Archived, so `worktrees.remove` (tier 4) has a legal target for the stall step below.
    assert.equal(((await finaliseApproved(sup, user, w2.id)).result as { state: string }).state, "FINALISED");
    const confirmsAfterFinalise = sup.nativeConfirms.length; // the finalise showed its own tier 4 dialog

    // A plan that changed after it was shown: w1 gets a second commit, the old plan is refused before a challenge.
    writeFileSync(join(w1.path, "second.txt"), "second\n");
    const d1 = await diffOf(w1);
    resultOf(await commitOf(w1, d1, "Add second"), "commit");
    const stale = await user.call("axis.git", "push", { workspaceId: w1.id, remote: "origin", confirmedPlan: { tip: commit, digest: planDigest } }, true);
    assert.equal(stale.error?.code, "E_CONFLICT");
    assert.equal(stale.error?.details?.["reason"], "plan_changed");
    assert.equal(sup.nativeConfirms.length, confirmsAfterFinalise, "no dialog for a stale plan");
    assert.deepEqual(fx.remoteRefs(), [`refs/heads/${w1.branch} ${commit}`]);
  });

  const stopGracefully = async (s: TestSupervisor): Promise<{ code: number | null; signal: string | null }> => {
    if (process.platform === "win32") s.shutdown();
    else s.kill("SIGTERM");
    return s.exited;
  };

  let composerRunId = "";
  test("7b. composer: a run waits for the user's approval of a protected write, and nothing is written meanwhile", async () => {
    const started = await user.ok<{ run: { runId: string } }>("axis.runs", "start", { workspaceId: w1.id, mode: "edit", prompt: "Add a Makefile", providerId: "mock", modelId: "mock-model" }, true);
    composerRunId = started.run.runId;
    await until(async () => (await user.ok<{ run: { awaitingApproval: boolean } }>("axis.runs", "get", { runId: composerRunId })).run.awaitingApproval, "the approval to be asked");
    assert.equal((await user.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length, 1);
    assert.equal(existsSync(join(w1.path, "Makefile")), false);
  });

  test("8. audit chain: graceful shutdown ends by draining, the chain verifies against the final anchor, every call is recorded", async () => {
    user.close();
    const exit = await stopGracefully(sup);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(!sup.stderr.includes("slice.forced_exit"), "the process ended by draining, not by process.exit");
    stopped = openStopped(sup.dataDir, join(scratch, "stopped"));
    const rows = auditRows(stopped);
    // (a) the chain verifies against the anchor the supervisor holds, and that anchor is the final head.
    assert.notEqual(sup.anchor, null);
    assert.deepEqual(new AuditLog(stopped).verify({ expectedHead: sup.anchor as { seq: number; hash: string } }).ok, true);
    assert.equal(sup.anchor?.seq, rows[rows.length - 1]?.seq, "the final anchor covers the last event");
    // (b) the decision and the execution of every call, in order, with the attested actor; the challenge's whole life; the run's transitions.
    const find = (from: number, pred: (r: AuditRow) => boolean): number => {
      const at = rows.findIndex((r, i) => i > from && pred(r));
      assert.ok(at > from, `an expected audit row is missing after ${from}`);
      return at;
    };
    const rpc = (target: string, action: string, outcome = "success") => (r: AuditRow) => r.target === target && r.action === action && r.outcome === outcome && r.actor === "user";
    const phase = (p: string) => (r: AuditRow) => r.action.startsWith("tier4.") && (JSON.parse(r.payload) as { phase?: string }).phase === p;
    let at = -1;
    for (const target of ["axis.worktrees/1.create", "axis.cli-runs/1.start"]) {
      at = find(at, rpc(target, "policy.decision", "success"));
      at = find(at, rpc(target, "rpc.execute"));
    }
    at = find(at, (r) => r.action === "cli_run.exit");
    for (const target of ["axis.review/1.complete", "axis.git/1.commit"]) at = find(at, rpc(target, "rpc.execute"));
    for (const p of ["issued", "resolve", "native", "authorised"]) at = find(at, phase(p));
    at = find(at, rpc("axis.git/1.push", "rpc.execute"));
    at = find(at, phase("completed"));
    // The composer run waiting at shutdown: its challenge was withdrawn and recorded BEFORE the final anchor (the line above
    // asserts the anchor covers the last row), and its journal row was left RUNNING for recovery (review r1 S1).
    const issued = find(at, (r) => r.actor === `agent:composer.${composerRunId}` && (JSON.parse(r.payload) as { phase?: string }).phase === "issued");
    at = find(issued, (r) => r.target === rows[issued]?.target && (JSON.parse(r.payload) as { phase?: string }).phase === "withdraw");
    const composerStates = (stopped.prepare("SELECT to_state FROM state_transitions WHERE entity = 'run' AND entity_id = ? ORDER BY id").all(composerRunId) as Array<{ to_state: string }>).map((r) => r.to_state);
    assert.deepEqual(composerStates, ["QUEUED", "RUNNING"], "nothing was written to the journal after the shutdown began");
    const runStates = (stopped.prepare("SELECT to_state FROM state_transitions WHERE entity = 'run' AND entity_id = ? ORDER BY id").all(runId) as Array<{ to_state: string }>).map((r) => r.to_state);
    assert.deepEqual(runStates.filter((x) => x !== "QUEUED"), ["RUNNING", "REVIEWING", "COMPLETED"]);
    const ws = stopped.prepare("SELECT state, created_by FROM agent_workspaces WHERE id = ?").get(w1.id) as { state: string; created_by: string };
    assert.deepEqual({ ...ws }, { state: "READY", created_by: "user" }, "READY, created by the attested actor");
    // (d) exactly one success for the one push; one per commit made.
    const successes = (target: string): number => rows.filter(rpc(target, "rpc.execute")).length;
    assert.equal(successes("axis.git/1.push"), 1);
    assert.equal(successes("axis.git/1.commit"), 3, "three commits were made, each recorded once");
    // (c) the canary and the key appear nowhere in the database; neither they nor a temporary path in the audit rows, the log or a response.
    const bytes = databaseBytes(join(scratch, "stopped"));
    const key = [sup.key, sup.key.toString("base64url"), sup.key.toString("hex"), sup.key.toString("base64")];
    for (const needle of [...secrets, ...key]) assert.equal(bytes.includes(needle), false, "a secret is in the database file");
    const text = rows.map((r) => `${r.actor} ${r.action} ${r.target} ${r.payload}`).join("\n");
    for (const needle of [fx.root, scratch, tmpdir()]) assert.equal(text.includes(needle), false, "an absolute temporary path is in an audit row");
    const everywhere = [sup.stderr, ...transcript];
    for (const needle of [...secrets, sup.key.toString("base64url"), sup.key.toString("hex")]) {
      assert.equal(everywhere.some((t) => t.includes(needle)), false, "a secret reached a response or the host's log");
    }
    assert.equal(sup.stderr.includes(fx.root), false, "a temporary path reached the host's log");
  });

  const degradedHost = async (dataDir: string, anchor: { seq: number; hash: string } | null) => {
    const h = await startHost(fx, { config: { dataDir, worktreeRoot: join(scratch, "unused-worktrees") }, ...(anchor === null ? {} : { anchor }) });
    const ready = await h.ready;
    return { ...h, ready, client: await TestClient.open(h.sup) };
  };

  test("9. tamper and truncation: degraded, only the audit reads are served, nothing is written", async () => {
    const edited = damagedCopy(sup.dataDir, join(scratch, "tampered"), (db) => void db.exec("UPDATE audit_events SET payload = '{}' WHERE seq = 10"));
    const offline = new AuditLog(openStopped(edited, join(scratch, "tampered-ro"))).verify({});
    assert.deepEqual([offline.ok, offline.ok ? "" : offline.reason], [false, "hash_mismatch"], "editing a stored event breaks the chain");
    const cut = damagedCopy(sup.dataDir, join(scratch, "truncated"), (db) => void db.exec("DELETE FROM audit_events WHERE seq > (SELECT MAX(seq) - 3 FROM audit_events)"));
    for (const [dir, reason] of [[edited, "audit_chain_invalid"], [cut, "database_behind_anchor"]] as const) {
      const h = await degradedHost(dir, sup.anchor);
      assert.equal(h.ready["degraded"], reason);
      assert.deepEqual([...(h.ready["contracts"] as string[])].sort(), ["axis.audit", "axis.projects"], "only the audit reads and the project list are served");
      const status = await h.client.ok<{ degraded: { reason: string } | null }>("axis.audit", "status", {});
      assert.equal(status.degraded?.reason, reason);
      const refused = await h.client.call("axis.worktrees", "create", { projectId, name: "Not now" }, true);
      assert.equal(refused.ok, false, "a degraded host creates nothing");
      assert.equal(refused.error?.code, "E_METHOD_NOT_FOUND", "the contract does not exist on a degraded host");
      assert.deepEqual(h.client.welcome.contracts.map((c) => c.id).sort(), ["axis.audit", "axis.projects"], "the registry offers nothing else");
      assert.equal(readdirSync(join(scratch, "unused-worktrees"), { recursive: true }).length, 0, "and touched no worktree directory");
      h.client.close();
      await h.sup.dispose();
    }
  });

  let restart: { root: string; key: Buffer; anchor: { seq: number; hash: string } | null };
  const restartHost = async (over: Parameters<typeof startHost>[1] = {}) => {
    const h = await startHost(fx, { root: restart.root, key: restart.key, ...(restart.anchor === null ? {} : { anchor: restart.anchor }), agents: cliAgents(), ...over });
    const ready = await h.ready;
    assert.equal(ready["degraded"], undefined, "the anchor check is ok");
    trustWindow(h.sup);
    return { sup: h.sup, client: await TestClient.open(h.sup) };
  };

  test("10. kill and recover: the stale lock is taken over, the run is BLOCKED, nothing re-runs, the worktree is intact", async () => {
    stopped.close();
    restart = { root: dirname(sup.dataDir), key: sup.key, anchor: sup.anchor };
    const slowKey = newKey();
    const b = await restartHost();
    const started = await b.client.ok<{ run: { runId: string } }>("axis.cli-runs", "start", { workspaceId: w1.id, agentId: "slow" }, slowKey);
    await awaitRun(b.client, started.run.runId, "RUNNING");
    await until(() => existsSync(dumpPath("slow")), "the slow CLI to be up");
    const { pid } = JSON.parse(readFileSync(dumpPath("slow"), "utf8")) as { pid: number };
    b.client.close();
    b.sup.kill("SIGKILL");
    assert.equal((await b.sup.exited).signal, process.platform === "win32" ? null : "SIGKILL");
    restart.anchor = b.sup.anchor;
    await until(() => !alive(pid), "the orphaned slow CLI to end with its host");
    const c = await restartHost();
    const run = (await c.client.ok<{ run: { state: string; reason: string | null } }>("axis.cli-runs", "get", { runId: started.run.runId })).run;
    assert.deepEqual([run.state, run.reason], ["BLOCKED", "INTERRUPTED_BY_RESTART"]);
    // The start had returned before the kill, so its key holds the stored result: the retry replays that run. A key that was in
    // flight at the kill answers `outcome-unknown` instead (daemon-idempotency tests). Either way nothing runs twice.
    const again = await c.client.call("axis.cli-runs", "start", { workspaceId: w1.id, agentId: "slow" }, slowKey);
    const replayedRun = again.ok ? (again.result as { run: { runId: string } }).run.runId : undefined;
    assert.ok(replayedRun === started.run.runId || again.error?.details?.["reason"] === "outcome-unknown", "the old key neither starts a second run nor answers anything else");
    const composer = (await c.client.ok<{ run: { state: string; reason: string | null; live: boolean } }>("axis.runs", "get", { runId: composerRunId })).run;
    assert.deepEqual([composer.state, composer.reason, composer.live], ["BLOCKED", "INTERRUPTED_BY_RESTART", false], "the composer run interrupted by the shutdown");
    assert.equal(existsSync(join(w1.path, "Makefile")), false, "the unapproved write never happened");
    const runs = await c.client.ok<{ runs: unknown[] }>("axis.cli-runs", "list", { workspaceId: w1.id });
    assert.equal(runs.runs.length, 2, "no run was started by the retry");
    const status = await c.client.ok<{ worktrees: Array<{ present: boolean; head: string | null }> }>(PROJECT, "status", { ids: [w1.id] });
    assert.equal(status.worktrees[0]?.present, true, "the worktree is intact");
    assert.ok(existsSync(join(w1.path, "src", "hello.txt")));
    restart.anchor = c.sup.anchor;
    c.client.close();
    c.sup.kill("SIGKILL");
    await c.sup.exited;
    restart.anchor = c.sup.anchor;
  });

  test("11. anchor stall: tier 3 and above are refused before any challenge, tiers 2 and below keep working, and it resumes", async () => {
    const h = await restartHost({ config: { limits: { anchorMaxLagEvents: 8 } } });
    const { client, sup: s } = h;
    const plan = await planOf(w1, client);
    s.holdAcks = true;
    const status = () => client.ok<{ stalled: boolean }>("axis.audit", "status", {});
    await until(async () => (await client.ok("axis.cli-runs", "list", {}), (await status()).stalled), "the anchor to stall");
    const request = { workspaceId: w1.id, remote: "origin", confirmedPlan: { tip: plan.tip, digest: plan.digest } };
    const noApproval = await client.call("axis.git", "push", request, true);
    const bogus = await client.call("axis.git", "push", { ...request, approval: { challengeId: "A".repeat(43) } }, true);
    for (const a of [noApproval, bogus]) assert.deepEqual([a.error?.code, a.error?.details?.["reason"]], ["E_UNAVAILABLE", "anchor_stalled"]);
    // `worktrees.remove` (tier 4) has no content-hook check of its own: only the gate's preflight stops it before a challenge.
    for (const approval of [undefined, { challengeId: "A".repeat(43) }]) {
      const removal = await client.call(PROJECT, "remove", { id: w2.id, ...(approval === undefined ? {} : { approval }) }, true);
      assert.deepEqual([removal.error?.code, removal.error?.details?.["reason"]], ["E_UNAVAILABLE", "anchor_stalled"]);
    }
    assert.equal(s.nativeConfirms.length, 0, "no dialog while stalled");
    assert.equal((await client.ok<{ challenges: unknown[] }>("axis.approvals", "pending", {})).challenges.length, 0, "no challenge was issued");
    assert.equal((await client.call("axis.cli-runs", "list", {})).ok, true, "reads still work");
    const last = s.anchorPuts[s.anchorPuts.length - 1];
    assert.ok(last !== undefined, "the host put anchors that were not acknowledged");
    s.holdAcks = false;
    s.ack(last.seq, last.hash);
    let resumed: Awaited<ReturnType<TestClient["call"]>> = { ok: false };
    await until(async () => ((resumed = await client.call("axis.git", "push", request, true)), resumed.error?.code !== "E_UNAVAILABLE"), "tier 4 to resume");
    assert.equal(resumed.error?.code, "E_APPROVAL_REQUIRED", "the gate issues a challenge again once acknowledgements return");
    client.close();
    await s.dispose();
  });
});
