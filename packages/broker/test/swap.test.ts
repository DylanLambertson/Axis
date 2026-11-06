// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Compare-and-swap writes (policies section 3.3, ticket C2): a write names the content it replaces, racing writers lose nothing silently.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ABSENT, BrokerError, contentDigest, nodeBrokerFs, swapContained, type BrokerFile, type BrokerFs } from "../src/index.js";
import { makeWorld } from "./helpers.js";
import { cleanupWorlds, skipLinks, worlds } from "./rig.js";

after(cleanupWorlds);

const arena = () => {
  const w = makeWorld();
  worlds.push(w);
  return w;
};
const o = (base: string) => ({ base, maxBytes: 1024 });
const dg = (t: string): string => contentDigest(Buffer.from(t));
const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    assert.ok(e instanceof BrokerError, String(e));
    return `${e.code}/${e.reason}`;
  }
};
/** No temporary file is left next to the target. */
const noTemp = (dir: string): void => assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".axis-swap-")), []);

/**
 * `nodeBrokerFs` with hooks: after the first read of `target` (the hash), before `rename`, before `link`. `frozenTimes`
 * makes the target's descriptor report the times it had when first looked at (a file system with coarse timestamps), so
 * each later check is shown to hold on its own.
 */
function racing(target: string, h: { afterHash?: () => void; beforeRename?: () => void; beforeLink?: () => void; frozenTimes?: boolean }): BrokerFs {
  return {
    ...nodeBrokerFs,
    async open(p, mode) {
      const f = await nodeBrokerFs.open(p, mode);
      if (p !== target || mode !== "read" || h.afterHash === undefined) return f;
      let reads = 0;
      let first: Awaited<ReturnType<BrokerFile["stat"]>> | undefined;
      const wrapped: BrokerFile = {
        ...f,
        async stat() {
          const st = await f.stat();
          first ??= st;
          return h.frozenTimes === true ? { ...st, mtime: first.mtime, ctime: first.ctime } : st;
        },
        async read(max) {
          const data = await f.read(max);
          if (reads++ === 0) h.afterHash?.();
          return data;
        },
      };
      return wrapped;
    },
    async rename(from, to) {
      h.beforeRename?.();
      return (nodeBrokerFs.rename as NonNullable<BrokerFs["rename"]>)(from, to);
    },
    async link(existing, to) {
      h.beforeLink?.();
      return (nodeBrokerFs.link as NonNullable<BrokerFs["link"]>)(existing, to);
    },
  };
}

test("create: `absent` writes a new file and refuses an existing one; nothing is left behind", async () => {
  const w = arena();
  const r = await swapContained(w.deps(), "wt1", "a.txt", Buffer.from("one"), o(ABSENT));
  assert.deepEqual(r, { bytes: 3, rel: "a.txt", digest: dg("one"), lostChange: false });
  assert.equal(readFileSync(join(w.wt, "a.txt"), "utf8"), "one");
  assert.equal(await reason(swapContained(w.deps(), "wt1", "a.txt", Buffer.from("two"), o(ABSENT))), "E_CONFLICT/stale");
  assert.equal(readFileSync(join(w.wt, "a.txt"), "utf8"), "one");
  assert.equal(statSync(join(w.wt, "a.txt")).nlink, 1, "the temporary name is gone");
  noTemp(w.wt);
});

test("replace: the digest of the current content is required; a stale or missing base changes nothing", async () => {
  const w = arena();
  const p = join(w.wt, "a.txt");
  writeFileSync(p, "mine");
  assert.equal(await reason(swapContained(w.deps(), "wt1", "a.txt", Buffer.from("x"), o(dg("older")))), "E_CONFLICT/stale");
  assert.equal(await reason(swapContained(w.deps(), "wt1", "missing.txt", Buffer.from("x"), o(dg("mine")))), "E_CONFLICT/stale");
  assert.equal(await reason(swapContained(w.deps(), "wt1", "a.txt", Buffer.from("x"), o("sha256:XYZ"))), "E_INVALID_ARGUMENT/invalid-args");
  assert.equal(readFileSync(p, "utf8"), "mine");
  const r = await swapContained(w.deps(), "wt1", "a.txt", Buffer.from("next"), o(dg("mine")));
  assert.equal(r.digest, dg("next"));
  assert.equal(readFileSync(p, "utf8"), "next");
  assert.equal(await reason(swapContained(w.deps(), "wt1", "a.txt", Buffer.from("again"), o(dg("mine")))), "E_CONFLICT/stale", "the old base is spent");
  noTemp(w.wt);
});

test("replace keeps the replaced file's permission bits", { skip: process.platform === "win32" ? "POSIX modes" : false }, async () => {
  const w = arena();
  const p = join(w.wt, "run.sh");
  writeFileSync(p, "echo a");
  chmodSync(p, 0o751);
  await swapContained(w.deps(), "wt1", "run.sh", Buffer.from("echo b"), o(dg("echo a")));
  assert.equal(statSync(p).mode & 0o777, 0o751);
});

for (const frozenTimes of [false, true]) {
  const how = frozenTimes ? " (coarse timestamps)" : "";
  test(`a writer that changes the file in place after the hash is refused, and its change stays${how}`, async () => {
    const w = arena();
    const p = join(w.wt, "a.txt");
    writeFileSync(p, "base");
    // Same length: the descriptor's times, or with coarse timestamps only the second hash, can see it.
    const fs = racing(p, { afterHash: () => writeFileSync(p, "THEM"), frozenTimes });
    assert.equal(await reason(swapContained(w.deps(fs), "wt1", "a.txt", Buffer.from("ours"), o(dg("base")))), "E_CONFLICT/stale");
    assert.equal(readFileSync(p, "utf8"), "THEM");
    noTemp(w.wt);
  });

  test(`a writer that replaces the name after the hash is refused, and its file stays${how}`, async () => {
    const w = arena();
    const p = join(w.wt, "a.txt");
    writeFileSync(p, "base");
    const fs = racing(p, {
      afterHash: () => {
        writeFileSync(join(w.base, "theirs"), "base"); // even the same content: it is another file, written by someone else
        renameSync(join(w.base, "theirs"), p);
      },
      frozenTimes,
    });
    assert.equal(await reason(swapContained(w.deps(fs), "wt1", "a.txt", Buffer.from("ours"), o(dg("base")))), "E_CONFLICT/stale");
    assert.equal(readFileSync(p, "utf8"), "base");
    noTemp(w.wt);
  });
}

test("a file created by someone else between the check and the link is never replaced", async () => {
  const w = arena();
  const p = join(w.wt, "new.txt");
  const fs = racing(p, { beforeLink: () => writeFileSync(p, "theirs") });
  assert.equal(await reason(swapContained(w.deps(fs), "wt1", "new.txt", Buffer.from("ours"), o(ABSENT))), "E_CONFLICT/stale");
  assert.equal(readFileSync(p, "utf8"), "theirs");
  noTemp(w.wt);
});

test("the residual window: a change to the old file between the last check and the rename is reported, not hidden", async () => {
  const w = arena();
  const p = join(w.wt, "a.txt");
  writeFileSync(p, "base");
  const fs = racing(p, { beforeRename: () => writeFileSync(p, "late change") });
  const r = await swapContained(w.deps(fs), "wt1", "a.txt", Buffer.from("ours"), o(dg("base")));
  assert.equal(r.lostChange, true);
  assert.equal(readFileSync(p, "utf8"), "ours");
  const clean = await swapContained(w.deps(), "wt1", "a.txt", Buffer.from("again"), o(dg("ours")));
  assert.equal(clean.lostChange, false);
});

test("a hard-linked file and a symlink out of the worktree are refused", { skip: skipLinks }, async () => {
  const w = arena();
  const p = join(w.wt, "a.txt");
  writeFileSync(p, "base");
  linkSync(p, join(w.base, "other-name"));
  assert.equal(await reason(swapContained(w.deps(), "wt1", "a.txt", Buffer.from("x"), o(dg("base")))), "E_POLICY_DENIED/hardlink");
  symlinkSync(join(w.outside, "secret.txt"), join(w.wt, "s.txt"));
  assert.equal(await reason(swapContained(w.deps(), "wt1", "s.txt", Buffer.from("x"), o(dg("TOP-SECRET")))), "E_POLICY_DENIED/symlink-escape");
  assert.equal(readFileSync(join(w.outside, "secret.txt"), "utf8"), "TOP-SECRET");
  assert.equal(readFileSync(p, "utf8"), "base");
  noTemp(w.wt);
});

test("a file system without rename and link cannot swap", async () => {
  const w = arena();
  const fs: BrokerFs = { lstat: nodeBrokerFs.lstat, realpath: nodeBrokerFs.realpath, open: nodeBrokerFs.open };
  assert.equal(await reason(swapContained(w.deps(fs), "wt1", "a.txt", Buffer.from("x"), o(ABSENT))), "E_POLICY_DENIED/fs-error");
});
