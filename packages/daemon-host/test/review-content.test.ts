// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.review/1.content over real git (ticket RV-CONTENT): views from the snapshot tree, bound by the diff's content id.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Policy } from "@axis/daemon";
import { MAX_CONTENT_RESPONSE_CHARS, MAX_CONTENT_TEXT_BYTES } from "@axis/protocol";
import { files, gitUnavailable, LONG_LINE, reviewRig, sha256, type Client, type ReviewRig, type RigOptions } from "./review-rig.js";

const SKIP = gitUnavailable();
const allowAll: Policy = { evaluate: () => ({ effect: "allow" }) };

async function setup(t: TestContext, options: RigOptions = {}, actor = "user"): Promise<{ r: ReviewRig; user: Client }> {
  const r = await reviewRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect(actor) };
}
type Row = { fileId: string; displayPath: string; protectedPath: boolean; contentId: string | null; view: Record<string, unknown> & { kind: string } };
async function content(user: Client, r: ReviewRig, paths: readonly string[], extraIds: readonly string[] = []) {
  const fileIds = [...(await Promise.all(paths.map((p) => sha256(p)))), ...extraIds];
  const res = await user.call("content", { workspaceId: r.workspaceId, fileIds });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return { rows: files(res) as unknown as Row[], notFound: res.result?.["notFound"] as string[], head: res.result?.["head"] };
}
const cid = (mode: string, oid: string, prot = false): string => createHash("sha256").update(prot ? `${mode} ${oid} protected` : `${mode} ${oid}`).digest("hex");
const oidOf = (r: ReviewRig, rel: string): string => r.git("hash-object", "--no-filters", "--", rel).trim();

test("each named file is shown as it would be committed, protected first, with the diff's own content id", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("src/a.txt", "red \u001b[31mX\u001b[0m and ‮evil‬\n\tindent\n");
  r.write("img.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  r.write(".github/workflows/ci.yml", "on: push\n");
  r.write("zz/Makefile", "all:\n");
  rmSync(join(r.repo, "keep.txt"));
  const unknown = "9".repeat(64);
  const { rows, notFound, head } = await content(user, r, ["src/a.txt", "img.bin", "keep.txt", "zz/Makefile", ".github/workflows/ci.yml"], [unknown]);
  assert.equal(head, r.git("rev-parse", "HEAD").trim());
  // The diff's order (protected first, then by path), whatever order the request named them in.
  assert.deepEqual(rows.map((f) => [f.displayPath, f.protectedPath, f.view.kind]), [
    [".github/workflows/ci.yml", true, "text"],
    ["zz/Makefile", true, "text"],
    ["img.bin", false, "binary"],
    ["keep.txt", false, "deleted"],
    ["src/a.txt", false, "text"],
  ]);
  assert.deepEqual(notFound, [unknown]);
  const [ci, , bin, gone, a] = rows as [Row, Row, Row, Row, Row];
  assert.deepEqual(a.view["first"], ["red \\u{1b}[31mX\\u{1b}[0m and \\u{202e}evil\\u{202c}", "\tindent"]);
  assert.deepEqual(bin.view, { kind: "binary", size: 7, objectPrefix: oidOf(r, "img.bin").slice(0, 12) });
  assert.equal(ci.contentId, cid("100644", oidOf(r, ".github/workflows/ci.yml"), true), "the protected flag is in the content id");
  assert.equal(a.contentId, cid("100644", oidOf(r, "src/a.txt")));
  assert.equal(gone.contentId, cid("000000", "0".repeat(r.git("rev-parse", "HEAD").trim().length)));
});

test("an acknowledgement taken from content covers exactly that content: it releases the tree, and stops when the file changes", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("long.txt", LONG_LINE);
  const diff = (acknowledged?: unknown) => user.call("diff", { workspaceId: r.workspaceId, ...(acknowledged ? { acknowledged } : {}) });
  const listed = files(await diff())[0];
  const [shown] = (await content(user, r, ["long.txt"])).rows;
  assert.equal(shown?.contentId, listed?.["contentId"], "the same id the diff asks to acknowledge");
  assert.deepEqual([shown?.view.kind, shown?.view["cutLines"]], ["text", 1]);
  const ack = [{ fileId: shown?.fileId, contentId: shown?.contentId }];
  assert.match(String((await diff(ack)).result?.["treeHash"]), /^[0-9a-f]{40,64}$/);
  r.write("long.txt", `y${LONG_LINE}`);
  const [again] = (await content(user, r, ["long.txt"])).rows;
  assert.notEqual(again?.contentId, shown?.contentId);
  assert.equal((await diff(ack)).result?.["treeHash"], null, "an acknowledgement of what was shown before covers nothing now");
});

test("bytes come from the snapshot tree: invalid UTF-8 and escapes survive exactly, and a later work-tree edit is not shown", { skip: SKIP ?? false }, async (t) => {
  const path = (r: ReviewRig) => join(r.repo, "raw.txt");
  const { r, user } = await setup(t, {
    review: (real) => ({
      open: async (id, ctx) => {
        const round = await real.open(id, ctx);
        writeFileSync(path(r), "EDITED AFTER THE SNAPSHOT\n");
        return round;
      },
    }),
  });
  writeFileSync(path(r), Buffer.from([0x61, 0xff, 0xfe, 0x1b, 0x5b, 0x32, 0x4a, 0x5c, 0xc0, 0x80, 0x0a, 0xe4, 0xb8, 0xad, 0x0a]));
  const snapshotOid = oidOf(r, "raw.txt");
  const [row] = (await content(user, r, ["raw.txt"])).rows;
  assert.deepEqual(row?.view["first"], ["a\\xff\\xfe\\u{1b}[2J\\\\\\xc0\\x80", "中"]);
  assert.equal(row?.contentId, cid("100644", snapshotOid));
});

test("a symlink is shown as its target and never followed; a link out of the repository is flagged", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write("secret.txt", "TOP SECRET\n");
  try {
    symlinkSync("secret.txt", join(r.repo, "in"));
    symlinkSync("/etc/passwd", join(r.repo, "out"));
  } catch {
    t.skip("symlinks are not available here");
    return;
  }
  const { rows } = await content(user, r, ["in", "out"]);
  assert.deepEqual(rows.map((f) => f.view), [
    { kind: "symlink", target: "secret.txt", targetCut: false, escapesWorktree: false },
    { kind: "symlink", target: "/etc/passwd", targetCut: false, escapesWorktree: true },
  ]);
  // A link's content is the blob of its target text, under mode 120000 (the repository uses SHA-1 object ids here).
  assert.equal(rows[0]?.contentId, cid("120000", createHash("sha1").update("blob 10\0secret.txt").digest("hex")));
});

test("a submodule shows the commit it records; a filtered file is not shown and cannot be acknowledged", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  r.write(".gitattributes", "secret.env filter=crypt\n");
  r.write("secret.env", "cipher\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "filtered");
  r.write("secret.env", "plain text secret\n");
  const sub = join(r.repo, "vendor");
  (await import("node:fs")).mkdirSync(sub);
  const { execFileSync } = await import("node:child_process");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: sub, env: r.genv, encoding: "utf8" });
  g("init", "-q");
  writeFileSync(join(sub, "x"), "x\n");
  g("add", "x");
  g("-c", "commit.gpgsign=false", "commit", "-q", "-m", "x");
  const subHead = g("rev-parse", "HEAD").trim();
  const { rows } = await content(user, r, ["secret.env", "vendor"]);
  const byPath = new Map(rows.map((f) => [f.displayPath, f]));
  assert.deepEqual(byPath.get("secret.env")?.view, { kind: "unavailable", reason: "filtered" });
  assert.equal(byPath.get("secret.env")?.contentId, null);
  assert.deepEqual(byPath.get("vendor")?.view, { kind: "submodule", commit: subHead });
});

test("text over the size bound: a first and a last excerpt and the object prefix", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  const line = "id,value,comment\n";
  const n = Math.ceil((MAX_CONTENT_TEXT_BYTES + 100) / line.length);
  r.write("big.csv", `HEAD\n${line.repeat(n)}TAIL\n`);
  const [row] = (await content(user, r, ["big.csv"])).rows;
  assert.equal(row?.view.kind, "too-large");
  const v = row?.view as unknown as { first: string[]; last: string[]; readComplete: boolean; objectPrefix: string; size: number };
  assert.deepEqual([v.first[0], v.last.at(-1), v.readComplete, v.objectPrefix, v.size], ["HEAD", "TAIL", true, oidOf(r, "big.csv").slice(0, 12), 5 + n * line.length + 5]);
});

test("the reply's text budget is shared: once it is spent, later files show no lines and count them all", { skip: SKIP ?? false }, async (t) => {
  const { r, user } = await setup(t);
  const body = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(500, "x")).join("\n");
  const names = Array.from({ length: 6 }, (_, i) => `f${i}.txt`);
  for (const p of names) r.write(p, body);
  const { rows } = await content(user, r, names);
  const shown = rows.map((f) => (f.view["first"] as string[]).concat(f.view["last"] as string[]).join("").length);
  assert.ok(shown.reduce((a, b) => a + b, 0) <= MAX_CONTENT_RESPONSE_CHARS);
  assert.deepEqual([rows.at(-1)?.view["first"], rows.at(-1)?.view["omittedLines"]], [[], 200]);
});

test("only the user is shown content, whatever the policy; bad requests and unknown workspaces are refused with fixed text", { skip: SKIP ?? false }, async (t) => {
  const { r, user: agent } = await setup(t, { policy: allowAll }, "agent:planner");
  r.write("a.txt", "a\n");
  const res = await agent.call("content", { workspaceId: r.workspaceId, fileIds: [await sha256("a.txt")] });
  assert.deepEqual([res.ok, res.error?.code], [false, "E_NOT_FOUND"]);
  assert.equal(r.calls.open, 0, "nothing was read for an agent");
  const user = await r.connect("user");
  const bad = await user.call("content", { workspaceId: r.workspaceId, fileIds: [] });
  assert.equal(bad.error?.code, "E_INVALID_ARGUMENT");
  const gone = await user.call("content", { workspaceId: "ws-nope", fileIds: [await sha256("a.txt")] });
  assert.equal(gone.error?.code, "E_NOT_FOUND");
  assert.equal(JSON.stringify([bad, gone]).includes("a.txt"), false);
});
