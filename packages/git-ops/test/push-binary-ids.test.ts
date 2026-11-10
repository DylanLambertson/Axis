// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ticket P1f: a binary file of the outgoing history has an identity derived from its path bytes, so it can be allowed or refused without display text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BINARY_ID, GitOpsError, binaryRow, executePush, planDigest, planPush } from "../src/index.js";
import type { SecretFinding } from "../src/index.js";
import { BASE, FakeRunner, WT, healthy, makeDeps } from "./helpers.js";

const input = { worktree: WT, remote: "origin", branch: "axis/feat", baseSha: BASE, reportBlocked: true };
const none = async (): Promise<SecretFinding[]> => [];
/** The numstat of one commit, read raw: one character per byte. */
const stat = (...names: Buffer[]) => (s: string[]) =>
  s[0] === "diff-tree" && s.includes("--numstat") ? { stdout: names.map((n) => `-\t-\t${n.toString("latin1")}\0`).join("") } : undefined;
const bytes = (...b: number[]) => Buffer.from(b);
const rig = (...names: Buffer[]) => makeDeps(new FakeRunner(healthy(stat(...names))), { scanner: none, scanMode: "refuse" });
const rows = async (d: ReturnType<typeof rig>, extra = {}) => (await planPush(d, { ...input, ...extra })).blocked?.unlistedBinaryRows ?? [];

async function refusal(p: Promise<unknown>): Promise<GitOpsError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GitOpsError, String(e));
    return e;
  }
  return assert.fail("expected a refusal");
}

test("an id is derived from the path bytes: stable between plans, well formed, and apart for names that only look alike", async () => {
  const ff = Buffer.concat([Buffer.from("alias"), bytes(0xff), Buffer.from(".bin")]);
  const fe = Buffer.concat([Buffer.from("alias"), bytes(0xfe), Buffer.from(".bin")]);
  const real = Buffer.from("alias�.bin");
  const nfc = Buffer.from("café.bin");
  const nfd = Buffer.from("café.bin");
  const d = rig(ff, fe, real, nfc, nfd);
  const first = await rows(d);
  assert.equal(first.length, 5, "five different files, five rows");
  assert.equal(new Set(first.map((r) => r.id)).size, 5);
  assert.ok(first.every((r) => BINARY_ID.test(r.id)));
  assert.deepEqual(first.map((r) => r.lossy), [true, true, true, false, false]);
  assert.deepEqual(first.map((r) => r.path).slice(0, 3), ["alias�.bin", "alias�.bin", "alias�.bin"], "the three share one display name");
  assert.deepEqual(await rows(d), first, "the same plan again names the same ids");
  assert.deepEqual(first[0], binaryRow(ff));
  // A runner that returns decoded text although raw was asked for (and marks it raw): its lossy names are still lossy, so still blocked.
  const decoded = (s: string[]) => (s[0] === "diff-tree" && s.includes("--numstat") ? { stdout: "-\t-\talias\ufffd.bin\0" } : undefined);
  const lossy = await rows(makeDeps(new FakeRunner(healthy(decoded)), { scanner: none, scanMode: "refuse" }));
  assert.deepEqual(lossy.map((r) => r.lossy), [true]);
});

test("allowing an id allows that file and no other, by id and without the display name", async () => {
  const names = ["img/a.bin", "img/b.bin", "img/c.bin"].map((n) => Buffer.from(n));
  const [a, b, c] = names.map(binaryRow);
  const d = rig(...names);
  assert.deepEqual((await rows(d, { allowedBinaryIds: [a!.id] })).map((r) => r.path), ["img/b.bin", "img/c.bin"]);
  assert.deepEqual((await rows(d, { allowedBinaryIds: [a!.id, c!.id] })).map((r) => r.path), ["img/b.bin"]);
  const all = await planPush(d, { ...input, allowedBinaryIds: [a!.id, b!.id, c!.id] });
  assert.equal(all.blocked, undefined);
  assert.equal(all.requiresConfirmation, false);
  // An id the history does not hold allows nothing; a path and an id may be mixed.
  assert.equal((await rows(d, { allowedBinaryIds: [binaryRow(Buffer.from("other.bin")).id] })).length, 3);
  assert.deepEqual((await rows(d, { allowedBinaryPaths: ["img/a.bin"], allowedBinaryIds: [b!.id] })).map((r) => r.path), ["img/c.bin"]);
});

test("a lossy name cannot be allowed by its id, and the scanner is not told it is allowed; its look-alikes stay blocked", async () => {
  const ff = Buffer.concat([Buffer.from("x"), bytes(0xff), Buffer.from(".bin")]);
  const fe = Buffer.concat([Buffer.from("x"), bytes(0xfe), Buffer.from(".bin")]);
  const nfc = Buffer.from("café.bin");
  const nfd = Buffer.from("café.bin");
  const seen: string[][] = [];
  const scanner = async (_t: string, m: { part: string; allowedBinaryPaths?: readonly string[] }): Promise<SecretFinding[]> => {
    if (m.part === "patch") seen.push([...(m.allowedBinaryPaths ?? [])]);
    return [];
  };
  const d = makeDeps(new FakeRunner(healthy(stat(ff, fe, nfc, nfd))), { scanner, scanMode: "refuse" });
  const p = await planPush(d, { ...input, allowedBinaryIds: [binaryRow(ff).id, binaryRow(fe).id, binaryRow(nfc).id] });
  assert.equal(p.blocked?.reason, "binary_unscanned");
  assert.deepEqual(p.blocked?.unlistedBinaryRows.map((r) => r.id), [binaryRow(ff).id, binaryRow(fe).id, binaryRow(nfd).id], "both lossy names and the other spelling stay");
  assert.deepEqual(seen, [["café.bin"]]);
  assert.equal((await refusal(planPush(d, { ...input, reportBlocked: false, allowedBinaryIds: [binaryRow(ff).id] }))).details?.["reason"], "binary_unscanned");
  assert.equal((await refusal(executePush(d, { ...input, allowedBinaryIds: [binaryRow(ff).id, binaryRow(fe).id] }, { confirmed: true }))).details?.["reason"], "binary_unscanned");
});

test("an id that is not an id is refused as an invalid argument before anything is scanned", async () => {
  const d = rig(Buffer.from("a.bin"));
  const good = binaryRow(Buffer.from("a.bin")).id;
  for (const bad of ["", "a.bin", good.toUpperCase(), `${good}0`, good.slice(1), "bin_zz", `${good} `, "../a.bin"]) {
    const e = await refusal(planPush(d, { ...input, allowedBinaryIds: [bad] }));
    assert.equal(e.code, "E_INVALID_ARGUMENT", JSON.stringify(bad));
  }
  const many = Array.from({ length: 501 }, (_, i) => `bin_${i.toString(16).padStart(32, "0")}`);
  assert.equal((await refusal(planPush(d, { ...input, allowedBinaryIds: many }))).code, "E_INVALID_ARGUMENT");
});

test("the digest covers the identities a refuse-mode plan waives: not the display text, and nothing when nothing is waived", async () => {
  const a = Buffer.from("img/a.bin");
  const b = Buffer.from("img/b.bin");
  const byId = await planPush(rig(a), { ...input, allowedBinaryIds: [binaryRow(a).id] });
  const byPath = await planPush(rig(a), { ...input, allowedBinaryPaths: ["img/a.bin"] });
  assert.equal(byId.digest, byPath.digest, "one file, one identity, whichever way it was allowed");
  assert.equal(byId.digest, planDigest(byId.tip, [], [], [binaryRow(a).id]));
  const other = await planPush(rig(b), { ...input, allowedBinaryIds: [binaryRow(b).id] });
  assert.equal(other.tip, byId.tip);
  assert.notEqual(other.digest, byId.digest, "another file waived is another plan");
  const clean = await planPush(rig(), input);
  assert.equal(clean.digest, planDigest(clean.tip, [], []), "a plan that waives nothing keeps its digest");
  assert.equal(planDigest("t", [], [], []), planDigest("t", [], []));
  assert.equal(planDigest("t", [], [], ["bin_b", "bin_a"]), planDigest("t", [], [], ["bin_a", "bin_b"]), "the order of ids does not matter");
});

test("a confirmation names the waived file: the plan the user saw is not the plan of another waiver", async () => {
  const a = Buffer.from("img/a.bin");
  const d = rig(a);
  const seen = await planPush(d, { ...input, allowedBinaryIds: [binaryRow(a).id] });
  const ok = await executePush(d, { ...input, allowedBinaryIds: [binaryRow(a).id] }, { confirmed: true, confirmedPlan: { tip: seen.tip, digest: seen.digest } });
  assert.equal(ok, undefined);
  const forged = { tip: seen.tip, digest: planDigest(seen.tip, [], [], [binaryRow(Buffer.from("img/b.bin")).id]) };
  const e = await refusal(executePush(d, { ...input, allowedBinaryIds: [binaryRow(a).id] }, { confirmed: true, confirmedPlan: forged }));
  assert.equal(e.details?.["reason"], "plan_changed");
});
