// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ticket P1e: a plan the scan blocks is refused with a closed reason, or returned as `blocked` when the caller asks for it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitOpsError, MAX_DIFF, ScanIncomplete, executePush, planPush } from "../src/index.js";
import type { SecretFinding } from "../src/index.js";
import { BASE, FakeRunner, WT, healthy, makeDeps } from "./helpers.js";

const input = { worktree: WT, remote: "origin", branch: "axis/feat", baseSha: BASE };
const found = async (): Promise<SecretFinding[]> => [{ rule: "private-key" }];
const BIN = (s: string[]) => (s[0] === "diff-tree" && s.includes("--numstat") ? { stdout: "-\t-\tkey.p12\0-\t-\tb/two.png\0" } : undefined);
const BIG = (s: string[]) => (s[0] === "diff-tree" && !s.includes("--numstat") ? { stdout: "+x\n".repeat(MAX_DIFF) } : undefined);
const NUL = (s: string[], req: { raw?: boolean }) => (s[0] === "cat-file" && req.raw === true ? { stdout: "tree x\n\nmsg\0\n" } : undefined);

async function refusal(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  return assert.fail("expected a refusal");
}
const deps = (mode: "refuse" | "warn", extra: Parameters<typeof healthy>[0], scanner = async (): Promise<SecretFinding[]> => []) => makeDeps(new FakeRunner(healthy(extra)), { scanner, scanMode: mode });

test("a blocked plan is refused E_POLICY_DENIED with its closed reason, by default", async () => {
  const cases: Array<[string, ReturnType<typeof deps>]> = [
    ["secrets_found", deps("refuse", () => undefined, found)],
    ["scan_incomplete", deps("refuse", BIG)],
    ["binary_unscanned", deps("refuse", BIN)],
    ["message_unscannable", deps("refuse", NUL)],
    ["message_unscannable", deps("warn", NUL)],
  ];
  for (const [reason, d] of cases) {
    const e = await refusal(planPush(d, input));
    assert.equal(e.code, "E_POLICY_DENIED", reason);
    assert.deepEqual(e.details, { reason }, reason);
  }
});

test("reportBlocked returns the plan with the reason, the findings and the unlisted binary paths instead of throwing; it never asks for confirmation", async () => {
  const p = await planPush(deps("refuse", BIN, found), { ...input, reportBlocked: true, allowedBinaryPaths: ["b/two.png"] });
  assert.deepEqual(p.blocked, { reason: "secrets_found", unlistedBinaryPaths: ["key.p12"] });
  assert.deepEqual(p.findings.map((f) => f.rule), ["private-key"]);
  assert.deepEqual([p.requiresConfirmation, p.reasons], [false, []]);
  const bin = await planPush(deps("refuse", BIN), { ...input, reportBlocked: true });
  assert.deepEqual(bin.blocked, { reason: "binary_unscanned", unlistedBinaryPaths: ["key.p12", "b/two.png"] });
  const all = await planPush(deps("refuse", BIN), { ...input, reportBlocked: true, allowedBinaryPaths: ["key.p12", "b/two.png"] });
  assert.equal(all.blocked, undefined);
  assert.equal(all.requiresConfirmation, false);
  assert.equal((await planPush(deps("refuse", BIG), { ...input, reportBlocked: true })).blocked?.reason, "scan_incomplete");
  // Warn mode would have confirmation reasons for the same scan (a finding, a binary path); a block replaces them, it does not add to them.
  const warn = await planPush(deps("warn", (s, req) => BIN(s) ?? NUL(s, req), found), { ...input, reportBlocked: true });
  assert.equal(warn.blocked?.reason, "message_unscannable");
  assert.deepEqual([warn.requiresConfirmation, warn.reasons, warn.blocked?.unlistedBinaryPaths], [false, [], []]);
  assert.ok(warn.findings.length >= 1);
});

test("the reason is the first that applies: message, then findings, then an incomplete scan, then binary paths", async () => {
  const all = (s: string[], req: { raw?: boolean }) => BIG(s) ?? NUL(s, req) ?? BIN(s);
  assert.equal((await planPush(deps("refuse", all, found), { ...input, reportBlocked: true })).blocked?.reason, "message_unscannable");
  const noMessage = (s: string[]) => BIG(s) ?? BIN(s);
  assert.equal((await planPush(deps("refuse", noMessage, found), { ...input, reportBlocked: true })).blocked?.reason, "secrets_found");
  assert.equal((await planPush(deps("refuse", noMessage), { ...input, reportBlocked: true })).blocked?.reason, "scan_incomplete");
  assert.equal((await refusal(planPush(deps("refuse", noMessage, found), input))).details?.["reason"], "secrets_found");
});

test("warn mode is unchanged: a finding, an incomplete scan and binary paths need confirmation, with or without reportBlocked", async () => {
  for (const flag of [false, true]) {
    const o = { ...input, ...(flag ? { reportBlocked: true } : {}) };
    for (const d of [deps("warn", () => undefined, found), deps("warn", BIG), deps("warn", BIN)]) {
      const p = await planPush(d, o);
      assert.equal(p.blocked, undefined);
      assert.equal(p.requiresConfirmation, true);
      assert.ok(p.reasons.length > 0);
    }
  }
});

test("executePush never pushes a blocked plan, with or without reportBlocked, and the pty runner is not called", async () => {
  for (const flag of [false, true]) {
    const r = new FakeRunner(healthy(BIN));
    const d = makeDeps(r, { scanner: async () => [], scanMode: "refuse" });
    const p0 = await planPush(d, { ...input, reportBlocked: true });
    const e = await refusal(executePush(d, { ...input, ...(flag ? { reportBlocked: true } : {}) }, { confirmed: true, confirmedPlan: { tip: p0.tip, digest: p0.digest } }));
    assert.equal(e.code, "E_POLICY_DENIED");
    assert.equal(e.details?.["reason"], "binary_unscanned");
    assert.equal(r.ptyCalls().length, 0);
  }
});

test("a scanner that reports ScanIncomplete ends the scan: refuse blocks scan_incomplete after one call; any other throw is still a failure", async () => {
  let calls = 0;
  const incomplete = async (): Promise<SecretFinding[]> => {
    calls += 1;
    throw new ScanIncomplete();
  };
  const two = [`${"1".repeat(40)}`, `${"2".repeat(40)}`].join("\n");
  const d = makeDeps(new FakeRunner(healthy((s) => (s[0] === "rev-list" ? { stdout: `${two}\n` } : undefined))), { scanner: incomplete, scanMode: "refuse" });
  assert.equal((await refusal(planPush(d, input))).details?.["reason"], "scan_incomplete");
  assert.equal(calls, 1, "the second commit is not scanned after the scanner gave up");
  calls = 0;
  assert.equal((await planPush(d, { ...input, reportBlocked: true })).blocked?.reason, "scan_incomplete");
  assert.equal(calls, 1);
  const w = await planPush(makeDeps(new FakeRunner(healthy()), { scanner: incomplete, scanMode: "warn" }), input);
  assert.equal(w.requiresConfirmation, true, "warn mode: incomplete means confirm");
  const boom = makeDeps(new FakeRunner(healthy()), { scanner: async () => Promise.reject(new Error("x /secret")), scanMode: "refuse" });
  const e = await refusal(planPush(boom, input));
  assert.equal(e.code, "E_UNAVAILABLE");
  assert.equal(e.details, undefined);
  assert.ok(!e.message.includes("/secret"));
});

const MSG = (s: string[], req: { raw?: boolean }) => (s[0] === "cat-file" && req.raw === true ? { stdout: "tree x\n\nreal message\n" } : undefined);

test("S2: once the scanner gave up on the patch nothing else is read or scanned, so a later failure cannot replace scan_incomplete", async () => {
  const parts: string[] = [];
  const scanner = async (_t: string, m: { part: string }): Promise<SecretFinding[]> => {
    parts.push(m.part);
    if (m.part === "patch") throw new ScanIncomplete();
    throw new Error("a later, ordinary failure");
  };
  const r = new FakeRunner(healthy(MSG));
  const p = await planPush(makeDeps(r, { scanner, scanMode: "refuse" }), { ...input, reportBlocked: true });
  assert.equal(p.blocked?.reason, "scan_incomplete");
  assert.deepEqual(parts, ["patch"]);
  assert.equal(r.subs().some((s) => s[0] === "cat-file"), false, "the commit object is not even read");
  // A failing read of the commit object (never reached) cannot replace it either.
  const failing = new FakeRunner(healthy((s, req) => (s[0] === "cat-file" ? { code: 128 } : MSG(s, req))));
  assert.equal((await planPush(makeDeps(failing, { scanner, scanMode: "refuse" }), { ...input, reportBlocked: true })).blocked?.reason, "scan_incomplete");
});

test("S2: a scanner that gives up on a message view ends the scan there (no further view, no later failure)", async () => {
  const parts: string[] = [];
  const scanner = async (_t: string, m: { part: string }): Promise<SecretFinding[]> => {
    parts.push(m.part);
    if (m.part === "message") throw new ScanIncomplete();
    return [];
  };
  // Latin-1 bytes: the message has two views (the bytes read as UTF-8, and decoded from its declared encoding).
  const twoViews = (s: string[], req: { raw?: boolean }) => (s[0] === "cat-file" && req.raw === true ? { stdout: "tree x\nencoding iso-8859-1\n\nmsg \xe9\n" } : undefined);
  const d = makeDeps(new FakeRunner(healthy(twoViews)), { scanner, scanMode: "refuse" });
  assert.equal((await planPush(d, { ...input, reportBlocked: true })).blocked?.reason, "scan_incomplete");
  assert.deepEqual(parts, ["patch", "message"], "the second view is not scanned");
  const ok: string[] = [];
  await planPush(makeDeps(new FakeRunner(healthy(twoViews)), { scanner: async (_t, m) => (ok.push(m.part), []), scanMode: "refuse" }), input);
  assert.deepEqual(ok, ["patch", "message", "message"], "without a give-up both views are scanned");
});

test("S1: a binary name with U+FFFD stays blocked even when listed, and the scanner is never told it is allowed", async () => {
  const name = "alias�.bin";
  const stat = (s: string[]) => (s[0] === "diff-tree" && s.includes("--numstat") ? { stdout: `-\t-\t${name}\0-\t-\tplain.bin\0` } : undefined);
  const allowedSeen: string[][] = [];
  const scanner = async (_t: string, m: { part: string; allowedBinaryPaths?: readonly string[] }): Promise<SecretFinding[]> => {
    if (m.part === "patch") allowedSeen.push([...(m.allowedBinaryPaths ?? [])]);
    return [];
  };
  const d = makeDeps(new FakeRunner(healthy(stat)), { scanner, scanMode: "refuse" });
  const p = await planPush(d, { ...input, reportBlocked: true, allowedBinaryPaths: [name, "plain.bin"] });
  assert.deepEqual(p.blocked, { reason: "binary_unscanned", unlistedBinaryPaths: [name] });
  assert.deepEqual(allowedSeen, [["plain.bin"]]);
  assert.equal((await refusal(planPush(d, { ...input, allowedBinaryPaths: [name, "plain.bin"] }))).details?.["reason"], "binary_unscanned");
  const e = await refusal(executePush(d, { ...input, allowedBinaryPaths: [name, "plain.bin"] }, { confirmed: true }));
  assert.equal(e.details?.["reason"], "binary_unscanned");
});
