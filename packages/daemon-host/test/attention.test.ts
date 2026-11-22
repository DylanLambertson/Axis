// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D4: axis.attention/1 counts, from fakes of the journal reads and the live run services. Each count has a refusing
// neighbour (another kind, another status, a verdict of ok), and the bounds (cap, scan window, agents listed) each have a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HandlerContext } from "@axis/daemon";
import { ATTENTION_COUNT_CAP, ATTENTION_MAX_AGENTS, ATTENTION_REFUSAL_MESSAGE, attentionSummaryResponseSchema } from "@axis/protocol";
import { ATTENTION_SCAN_ROWS, AttentionRefusal, countOf, createAttentionHandlers, createAttentionService, type AttentionRunRow, type AttentionService, type AttentionServiceDeps } from "../src/index.js";

const ZERO = { n: 0, capped: false };
const row = (runId: string, kind: "cli" | "composer", state: string, agentId: string | null = null): AttentionRunRow => ({ runId, kind, state, agentId });

interface World {
  latest?: AttentionRunRow[];
  running?: AttentionRunRow[];
  unread?: number;
  cli?: Record<string, { status: string; snapshotAfter: string }>;
  composer?: Record<string, { awaitingApproval: boolean }>;
}
function deps(w: World, calls: string[] = []): AttentionServiceDeps {
  return {
    projectExists: (id) => id === "p1",
    records: {
      latestRuns: (p, limit) => (calls.push(`latest:${p}:${limit}`), (w.latest ?? []).slice(0, limit)),
      runningRuns: (p, limit) => (calls.push(`running:${p}:${limit}`), (w.running ?? []).slice(0, limit)),
      unreadForUser: (p, limit) => (calls.push(`unread:${p}:${limit}`), Math.min(w.unread ?? 0, limit)),
    },
    cliRun: (id) => {
      const r = w.cli?.[id];
      if (r === undefined) throw new Error(`no run ${id}`);
      return r;
    },
    composerRun: (id) => {
      const r = w.composer?.[id];
      if (r === undefined) throw new Error(`no run ${id}`);
      return r;
    },
  };
}
const summary = (w: World) => {
  const s = createAttentionService(deps(w)).summary("p1");
  assert.equal(attentionSummaryResponseSchema.safeParse(s).success, true, "every answer fits the contract");
  return s;
};

test("an empty project: every count is zero, read with one bounded call per journal read", () => {
  const calls: string[] = [];
  const s = createAttentionService(deps({}, calls)).summary("p1");
  assert.deepEqual(s, { projectId: "p1", approvalsWaiting: { total: ZERO, byAgent: [], more: false }, failedRuns: ZERO, quietCliRuns: ZERO, driftFlags: ZERO, unreadMessages: ZERO });
  assert.deepEqual(calls.sort(), [`latest:p1:${ATTENTION_SCAN_ROWS}`, `running:p1:${ATTENTION_SCAN_ROWS}`, `unread:p1:${ATTENTION_SCAN_ROWS}`]);
  assert.equal(ATTENTION_SCAN_ROWS, 1001, "1000 rows is a complete read; a 1001st marks it incomplete");
});

test("an unregistered project is refused before anything is read", () => {
  const calls: string[] = [];
  assert.throws(() => createAttentionService(deps({}, calls)).summary("p2"), AttentionRefusal);
  assert.deepEqual(calls, []);
});

test("approvals waiting: running composer runs whose loop waits on a confirmation, per agent, null agent first", () => {
  const s = summary({
    running: [row("c1", "composer", "RUNNING", "b"), row("c2", "composer", "RUNNING", "a"), row("c3", "composer", "RUNNING", "b"), row("c4", "composer", "RUNNING", null), row("c5", "composer", "RUNNING", "a"), row("c6", "composer", "RUNNING", "z"), row("x1", "cli", "RUNNING", "a")],
    composer: { c1: { awaitingApproval: true }, c2: { awaitingApproval: true }, c3: { awaitingApproval: true }, c4: { awaitingApproval: true }, c5: { awaitingApproval: false } },
    cli: { x1: { status: "running", snapshotAfter: "pending" } },
  });
  // c5 is not waiting; c6 is unknown to the composer service (it threw); x1 is a CLI run, never an approval.
  assert.deepEqual(s.approvalsWaiting, { total: { n: 4, capped: false }, byAgent: [{ agentId: null, n: 1 }, { agentId: "a", n: 1 }, { agentId: "b", n: 2 }], more: false });
  assert.deepEqual(s.quietCliRuns, ZERO);
});

test("approvals waiting: at most ATTENTION_MAX_AGENTS agents are listed, then more", () => {
  const ids = Array.from({ length: ATTENTION_MAX_AGENTS + 1 }, (_, i) => `a${String(i).padStart(3, "0")}`);
  const running = ids.map((a, i) => row(`c${i}`, "composer", "RUNNING", a));
  const composer = Object.fromEntries(running.map((r) => [r.runId, { awaitingApproval: true }]));
  const s = summary({ running, composer });
  assert.equal(s.approvalsWaiting.byAgent.length, ATTENTION_MAX_AGENTS);
  assert.equal(s.approvalsWaiting.byAgent[0]?.agentId, "a000");
  assert.equal(s.approvalsWaiting.more, true);
  assert.deepEqual(s.approvalsWaiting.total, { n: ATTENTION_MAX_AGENTS + 1, capped: false });
  assert.equal(summary({ running: running.slice(1), composer }).approvalsWaiting.more, false, "exactly the limit is not more");
});

test("quiet CLI runs: a running CLI run whose status is quiet; another status, a composer run or an unknown run is not", () => {
  const s = summary({
    running: [row("q1", "cli", "RUNNING"), row("q2", "cli", "RUNNING"), row("r1", "cli", "RUNNING"), row("gone", "cli", "RUNNING"), row("c1", "composer", "RUNNING")],
    cli: { q1: { status: "quiet", snapshotAfter: "pending" }, q2: { status: "quiet", snapshotAfter: "pending" }, r1: { status: "running", snapshotAfter: "pending" }, c1: { status: "quiet", snapshotAfter: "pending" } },
    composer: { c1: { awaitingApproval: false } },
  });
  assert.deepEqual(s.quietCliRuns, { n: 2, capped: false });
});

test("failed runs: a live workspace whose newest run failed, CLI or composer; any other state is not", () => {
  const s = summary({
    latest: [row("f1", "cli", "FAILED"), row("f2", "composer", "FAILED"), row("ok", "composer", "COMPLETED"), row("x", "composer", "CANCELLED"), row("b", "composer", "BLOCKED"), row("r", "composer", "RUNNING")],
    cli: { f1: { status: "failed", snapshotAfter: "ok" } },
  });
  assert.deepEqual(s.failedRuns, { n: 2, capped: false });
  assert.deepEqual(s.driftFlags, ZERO, "the failed CLI run's snapshot is ok");
});

test("drift flags: an ended CLI run whose snapshot is drift, unknown or unreadable; ok, a pending verdict and composer runs are not", () => {
  const s = summary({
    latest: [
      row("d1", "cli", "COMPLETED"), row("d2", "cli", "CANCELLED"), row("d3", "cli", "FAILED"), row("lost", "cli", "COMPLETED"),
      row("ok", "cli", "COMPLETED"), row("live", "cli", "RUNNING"), row("rev", "cli", "REVIEWING"), row("c", "composer", "COMPLETED"),
      row("settling", "cli", "FAILED"),
    ],
    cli: {
      d1: { status: "finished", snapshotAfter: "drift" }, d2: { status: "killed", snapshotAfter: "unknown" }, d3: { status: "failed", snapshotAfter: "drift" },
      ok: { status: "finished", snapshotAfter: "ok" }, live: { status: "running", snapshotAfter: "drift" }, rev: { status: "finished", snapshotAfter: "drift" },
      c: { status: "finished", snapshotAfter: "drift" },
      // Ended, but the supervisor still holds the process while the post-run snapshot runs: no verdict yet, no flag (review N-3).
      settling: { status: "failed", snapshotAfter: "pending" },
    },
  });
  // `lost` is unknown to the supervisor (a throw): possibly changed, so it counts. RUNNING and REVIEWING have not ended.
  assert.deepEqual(s.driftFlags, { n: 4, capped: false });
  assert.deepEqual(s.failedRuns, { n: 2, capped: false });
});

test("unread messages: the journal's count, capped above the cap", () => {
  assert.deepEqual(summary({ unread: 7 }).unreadMessages, { n: 7, capped: false });
  assert.deepEqual(summary({ unread: ATTENTION_COUNT_CAP }).unreadMessages, { n: ATTENTION_COUNT_CAP, capped: false });
  assert.deepEqual(summary({ unread: ATTENTION_COUNT_CAP + 1 }).unreadMessages, { n: ATTENTION_COUNT_CAP, capped: true });
  assert.deepEqual(summary({ unread: 5000 }).unreadMessages, { n: ATTENTION_COUNT_CAP, capped: true });
});

test("countOf saturates at the cap, and a full scan window reports capped whatever it counted", () => {
  assert.deepEqual(countOf(0), ZERO);
  assert.deepEqual(countOf(ATTENTION_COUNT_CAP), { n: ATTENTION_COUNT_CAP, capped: false });
  assert.deepEqual(countOf(ATTENTION_COUNT_CAP + 1), { n: ATTENTION_COUNT_CAP, capped: true });
  assert.deepEqual(countOf(3, true), { n: ATTENTION_COUNT_CAP, capped: true });
  const latest = Array.from({ length: ATTENTION_SCAN_ROWS }, (_, i) => row(`r${i}`, "composer", i === 0 ? "FAILED" : "COMPLETED"));
  const s = summary({ latest });
  assert.deepEqual([s.failedRuns, s.driftFlags], [{ n: ATTENTION_COUNT_CAP, capped: true }, { n: ATTENTION_COUNT_CAP, capped: true }]);
  assert.deepEqual(s.quietCliRuns, ZERO, "the running window was not full");
  const one = summary({ latest: latest.slice(1) });
  assert.deepEqual([one.failedRuns, one.driftFlags], [ZERO, ZERO], "exactly 1000 rows is a complete read, not capped (review N-2)");
  const running = Array.from({ length: ATTENTION_SCAN_ROWS }, (_, i) => row(`c${i}`, "composer", "RUNNING"));
  const r = summary({ running, composer: {} });
  assert.deepEqual([r.approvalsWaiting, r.quietCliRuns], [{ total: { n: ATTENTION_COUNT_CAP, capped: true }, byAgent: [], more: false }, { n: ATTENTION_COUNT_CAP, capped: true }]);
  assert.deepEqual(summary({ running: running.slice(1), composer: {} }).quietCliRuns, ZERO);
});

const ctx = (identity: Record<string, unknown>, aborted = false): HandlerContext => {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { identity, requestId: "q", correlationId: "c", signal: ac.signal } as unknown as HandlerContext;
};
const USER = { actor: "user", clientKind: "desktop" };
const outcome = async (p: unknown): Promise<string> => {
  try {
    return `ok:${JSON.stringify(await p)}`;
  } catch (e) {
    const x = e as { code?: string; message?: string; details?: unknown };
    return `${x.code}|${x.message}|${JSON.stringify(x.details)}`;
  }
};
const NOT_FOUND = `E_NOT_FOUND|${ATTENTION_REFUSAL_MESSAGE}|{"reason":"not_found"}`;

test("the handler serves the user's desktop connection only; anyone else is answered exactly as an unknown project", async () => {
  const h = createAttentionHandlers(createAttentionService(deps({ unread: 2 })));
  const served = await outcome(h.summary(ctx(USER), { projectId: "p1" } as never));
  assert.ok(served.startsWith('ok:{"projectId":"p1"') && served.includes('"unreadMessages":{"n":2,"capped":false}'), served);
  assert.equal(await outcome(h.summary(ctx(USER), { projectId: "p2" } as never)), NOT_FOUND);
  for (const who of [{ actor: "user", clientKind: "web" }, { actor: "agent:a1", clientKind: "desktop" }, { actor: "daemon", clientKind: "desktop" }, {}]) {
    assert.equal(await outcome(h.summary(ctx(who), { projectId: "p1" } as never)), NOT_FOUND, JSON.stringify(who));
  }
  assert.equal(await outcome(h.summary(ctx(USER, true), { projectId: "p1" } as never)), 'E_CANCELLED|The request was cancelled.|undefined');
});

test("any other error, or an answer outside the contract, is E_INTERNAL with no text of its own", async () => {
  const CANARY = "CANARY77aa /home/secret";
  const thrower: AttentionService = { summary: () => { throw new Error(CANARY); } };
  assert.equal(await outcome(createAttentionHandlers(thrower).summary(ctx(USER), { projectId: "p1" } as never)), "E_INTERNAL|Request failed|undefined");
  const good = createAttentionService(deps({})).summary("p1");
  for (const bad of [{ ...good, note: CANARY }, { ...good, failedRuns: { n: 1000, capped: true } }, { ...good, unreadMessages: { n: 3, capped: true } }, { ...good, approvalsWaiting: { total: { n: 1, capped: false }, byAgent: [], more: false } }]) {
    const out = await outcome(createAttentionHandlers({ summary: () => bad as never }).summary(ctx(USER), { projectId: "p1" } as never));
    assert.equal(out, "E_INTERNAL|Request failed|undefined", JSON.stringify(bad).slice(0, 120));
  }
});

test("the policy row: served, user only, at the contract's tier, no trust needed, never web-allowed or planned", async () => {
  const { RULES, PLANNED_RULES, WEB_ALLOWED, coverageProblems } = await import("../src/policy/index.js");
  const { attentionMethods: methods, plannedContracts } = await import("@axis/protocol");
  assert.equal(plannedContracts["axis.attention/1"], undefined);
  for (const [method, spec] of Object.entries(methods)) {
    const key = `axis.attention/1.${method}`;
    assert.deepEqual([RULES[key]?.actors, RULES[key]?.tier, RULES[key]?.trust], [["user"], spec.tier, "none"], key);
    assert.equal(PLANNED_RULES[key], undefined);
    assert.equal(WEB_ALLOWED.has(key), false);
  }
  assert.deepEqual(coverageProblems(), []);
});
