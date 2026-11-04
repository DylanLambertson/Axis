// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1 regression: the history scan reads commit messages as bytes, so an encoding cannot hide a secret from it.
// The commit objects are written with `hash-object` (with --literally only where the message holds a NUL), never `git commit`.
// The encoding cases need a Node with full ICU, as official builds have; the first test fails loudly without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { GitOpsError, executePush, planPush } from "../src/index.js";
import { messageViews } from "../src/messageViews.js";
import { baseOf, fixture, type Fixture } from "./realFixture.js";

/** A secret-shaped value assembled at runtime so no literal looks like a credential. */
const AWS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const scanFor = (seen: string[]) => async (d: string) => {
  seen.push(d);
  return d.includes(AWS_KEY) ? [{ rule: "aws-key" }] : [];
};

const ascii = (s: string): Buffer => Buffer.from(s, "latin1");
const utf16le = (s: string, bom: boolean): Buffer => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
const utf16be = (s: string, bom: boolean): Buffer => Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), Buffer.from(s, "utf16le").swap16()]);
/** A NUL after every character, and a NUL before every character. */
const nulAfter = (s: string): Buffer => utf16le(s, false);
const nulBefore = (s: string): Buffer => utf16be(s, false);
/** A NUL between the characters of the secret only, in a message that is otherwise plain. */
const nulInside = (s: string): Buffer => Buffer.from(s.split("").join("\0"), "latin1");

const MSG = `deploy with AWS=${AWS_KEY}\n`;

/** A commit on top of the base whose message is exactly `message` (bytes), made the tip of axis/feat. */
function commitWith(f: Fixture, message: Buffer, encoding?: string | string[], author = "Dylan Lambertson", committer = "Dylan Lambertson"): string {
  const tree = f.git("rev-parse", "HEAD^{tree}").trim();
  const head = ascii(`tree ${tree}\nparent ${baseOf(f)}\nauthor ${author} <me@dylanlambertson.dev> 1700000000 +0000\ncommitter ${committer} <me@dylanlambertson.dev> 1700000000 +0000\n${[encoding ?? []].flat().map((e) => `encoding ${e}\n`).join("")}\n`);
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", ...(encoding === undefined ? ["--literally"] : []), "--stdin"], { cwd: f.wt.workTree, env: f.env, input: Buffer.concat([head, message]) }).toString().trim();
  f.git("update-ref", "refs/heads/axis/feat", sha);
  return sha;
}

const CASES: Array<[string, Buffer]> = [
  ["UTF-16LE without a BOM", utf16le(MSG, false)],
  ["UTF-16LE with a BOM", utf16le(MSG, true)],
  ["UTF-16BE without a BOM", utf16be(MSG, false)],
  ["UTF-16BE with a BOM", utf16be(MSG, true)],
  ["a NUL after every character", nulAfter(MSG)],
  ["a NUL before every character", nulBefore(MSG)],
  ["NULs only inside the secret", nulInside(`${AWS_KEY}\n`)],
  ["mixed: UTF-8 text, then UTF-16LE at an odd offset", Buffer.concat([ascii("x"), utf16le(MSG, false)])],
  ["mixed: UTF-16BE text, then UTF-8", Buffer.concat([utf16be("note\n", false), ascii(MSG)])],
  ["invalid UTF-8 inside the secret", Buffer.concat([ascii(AWS_KEY.slice(0, 6)), Buffer.from([0xff]), ascii(AWS_KEY.slice(6)), ascii("\n")])],
  ["invalid UTF-8 and no secret at all", Buffer.concat([ascii("fine "), Buffer.from([0xc3, 0x28, 0xff]), ascii("\n")])],
  ["a lone NUL and no secret at all", ascii("fine\0\n")],
];

for (const scanMode of ["refuse", "warn"] as const) {
  for (const [name, message] of CASES) {
    test(`PSH-1 (${scanMode}): a commit message with ${name} is refused with a closed-set error, and the secret is not in it`, async () => {
      const f = fixture({ scanner: scanFor([]), scanMode });
      const sha = commitWith(f, message);
      const input = { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) };
      for (const run of [() => planPush(f.deps, input), () => executePush(f.deps, input)]) {
        const e = await run().then(() => undefined, (x: unknown) => x);
        assert.ok(e instanceof GitOpsError, `expected a refusal, got ${String(e)}`);
        assert.equal(e.code, "E_POLICY_DENIED");
        const text = JSON.stringify([e.message, e.details, e.stack]);
        for (const needle of [AWS_KEY, AWS_KEY.slice(0, 8), "deploy with"]) assert.ok(!text.includes(needle), `the error leaks ${needle}`);
        assert.ok(e.message.includes(sha.slice(0, 12)), "names the commit");
        assert.ok(/cannot be scanned|secret pattern/.test(e.message), e.message);
      }
      assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
    });
  }
}

test("PSH-1: an ordinary UTF-8 message, accents and emoji included, is scanned once, as before, and pushes", async () => {
  const parts: string[] = [];
  const f = fixture({ scanner: async (_d, m) => { parts.push(m.part); return []; }, scanMode: "refuse" });
  commitWith(f, Buffer.from("café ☕ naïve — ok 🚀\n", "utf8"));
  await executePush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  assert.deepEqual(parts, ["patch", "message"]);
});

test("PSH-1: a plain-UTF-8 secret in a message is still found and refused as a secret, not as an encoding", async () => {
  const f = fixture({ scanner: scanFor([]), scanMode: "refuse" });
  commitWith(f, ascii(MSG));
  const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof GitOpsError && /secret pattern/.test(e.message) && !e.message.includes(AWS_KEY), String(e));
});

test("PSH-1: messageViews flags only what cannot be read, and decodes a declared encoding", () => {
  const object = (m: Buffer, enc?: string): string => Buffer.concat([ascii(`tree x\n${enc === undefined ? "" : `encoding ${enc}\n`}\n`), m]).toString("latin1");
  for (const m of [utf16le(MSG, false), utf16le(MSG, true), utf16be(MSG, false), utf16be(MSG, true), nulAfter(MSG), nulBefore(MSG), nulInside(MSG)]) {
    assert.equal(messageViews(object(m)).undecodable, true);
  }
  assert.deepEqual(messageViews(object(ascii("plain\n"))), { views: ["tree x\n\nplain\n"], undecodable: false });
  assert.equal(messageViews(object(Buffer.from("\u00e9\n", "utf8"))).undecodable, false);
  assert.equal(messageViews(object(Buffer.from("\u00e9\n", "utf8"), "UTF-8")).undecodable, false);
  const latin = messageViews(object(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), "ISO-8859-1"));
  assert.equal(latin.undecodable, false);
  assert.ok(latin.views.some((v) => v.includes("caf\u00e9")));
  const jp = messageViews(object(ascii(`${AWS_KEY.slice(0, 4)}\x1b(B${AWS_KEY.slice(4)}\n`), "ISO-2022-JP"));
  assert.equal(jp.undecodable, false);
  assert.ok(jp.views.some((v) => v.includes(AWS_KEY)), "the escape sequence is undone by the declared encoding");
  assert.equal(messageViews(object(ascii("x\n"), "UTF-7")).undecodable, true, "an encoding this runtime does not know");
  assert.equal(messageViews(object(Buffer.from([0x81, 0x20, 0x0a]), "Shift_JIS")).undecodable, true, "bytes invalid in the declared encoding");
});

/** The encoding header is what git decodes a message from; ESC ( B inside a key is valid UTF-8 that git undoes for every reader. */
const ESC_KEY = ascii(`AWS=${AWS_KEY.slice(0, 4)}\x1b(B${AWS_KEY.slice(4)}\n`);

for (const scanMode of ["refuse", "warn"] as const) {
  test(`PSH-1 (${scanMode}): a key broken up by an ISO-2022-JP escape sequence is found through the declared encoding`, async () => {
    const f = fixture({ scanner: scanFor([]), scanMode });
    const sha = commitWith(f, ESC_KEY, "ISO-2022-JP");
    const input = { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) };
    if (scanMode === "refuse") {
      const e = await planPush(f.deps, input).then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof GitOpsError && e.code === "E_POLICY_DENIED" && /secret pattern/.test(e.message) && e.message.includes(sha.slice(0, 12)), String(e));
      assert.ok(!JSON.stringify([e.message, e.details]).includes(AWS_KEY.slice(0, 8)));
    } else {
      const plan = await planPush(f.deps, input);
      assert.equal(plan.requiresConfirmation, true);
      assert.deepEqual(plan.findings.map((x) => x.commit), [sha]);
    }
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
  });

  test(`PSH-1 (${scanMode}): a legitimate ISO-8859-1 commit is scanned and pushes, and a secret in it is found`, async () => {
    const f = fixture({ scanner: scanFor([]), scanMode });
    commitWith(f, Buffer.concat([ascii("caf"), Buffer.from([0xe9]), ascii("\n")]), "ISO-8859-1");
    const input = { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) };
    assert.equal((await planPush(f.deps, input)).requiresConfirmation, false);
    await executePush(f.deps, input);
    const g = fixture({ scanner: scanFor([]), scanMode });
    commitWith(g, Buffer.concat([ascii("caf"), Buffer.from([0xe9]), ascii(` ${AWS_KEY}\n`)]), "ISO-8859-1");
    const gi = { worktree: g.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(g) };
    const plan = await planPush(g.deps, gi).then((p) => p, (x: unknown) => x);
    assert.ok(plan instanceof GitOpsError ? /secret pattern/.test(plan.message) : (plan as { findings: unknown[] }).findings.length > 0);
  });

  for (const [name, enc, body] of [
    ["an encoding this runtime does not know", "UTF-7", ascii("plain\n")],
    ["bytes invalid in the declared encoding", "Shift_JIS", Buffer.from([0x81, 0x20, 0x0a])],
  ] as const) {
    test(`PSH-1 (${scanMode}): ${name} is refused with a closed-set error`, async () => {
      const f = fixture({ scanner: scanFor([]), scanMode });
      const sha = commitWith(f, body, enc);
      const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof GitOpsError && e.code === "E_POLICY_DENIED" && e.message.includes(sha.slice(0, 12)), String(e));
      assert.ok(!e.message.includes(enc), "the declared label is not echoed");
    });
  }
}

test("PSH-1: a runner that does not say it returned raw output fails the scan closed", async () => {
  const f = fixture({ scanner: scanFor([]), scanMode: "refuse" });
  commitWith(f, ascii("ok\n"));
  const inner = f.deps.runner;
  const deps = { ...f.deps, runner: { run: async (req: Parameters<typeof inner.run>[0]) => { const { raw: _raw, ...r } = await inner.run(req); return r; } } };
  const e = await planPush(deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof GitOpsError && e.code === "E_UNAVAILABLE", String(e));
});

test("PSH-1: this Node has the ICU data the encoding cases rely on", () => {
  for (const label of ["iso-2022-jp", "shift_jis", "euc-kr", "gbk", "windows-1252"]) assert.doesNotThrow(() => new TextDecoder(label, { fatal: true }), `no ${label} decoder: run the tests on a full-ICU Node`);
});

for (const scanMode of ["refuse", "warn"] as const) {
  const input = (f: Fixture) => ({ worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) });
  const found = async (f: Fixture, sha: string): Promise<void> => {
    const r = await planPush(f.deps, input(f)).then((p) => p, (x: unknown) => x);
    if (scanMode === "refuse") assert.ok(r instanceof GitOpsError && r.code === "E_POLICY_DENIED" && /secret pattern/.test(r.message) && r.message.includes(sha.slice(0, 12)), String(r));
    else assert.deepEqual((r as { findings: Array<{ commit?: string }> }).findings.map((x) => x.commit), [sha]);
  };
  const SHIFTED = `${AWS_KEY.slice(0, 4)}\x1b(B${AWS_KEY.slice(4)}`;

  test(`PSH-1 (${scanMode}): a carriage return after the encoding label does not hide the header`, async () => {
    const f = fixture({ scanner: scanFor([]), scanMode });
    await found(f, commitWith(f, ascii(`AWS=${SHIFTED}\n`), "ISO-2022-JP\r"));
  });

  test(`PSH-1 (${scanMode}): a key hidden by the declared encoding in the author name is found`, async () => {
    const f = fixture({ scanner: scanFor([]), scanMode });
    await found(f, commitWith(f, ascii("fine\n"), "ISO-2022-JP", SHIFTED));
  });

  test(`PSH-1 (${scanMode}): a commit with more than one encoding header is refused without decoding each`, async () => {
    const f = fixture({ scanner: scanFor([]), scanMode });
    const sha = commitWith(f, Buffer.alloc(4 * 1024 * 1024, 0xe9), Array.from({ length: 5000 }, () => "latin1"));
    const rss = process.memoryUsage().rss;
    const t = Date.now();
    const e = await planPush(f.deps, input(f)).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof GitOpsError && e.code === "E_POLICY_DENIED" && e.message.includes(sha.slice(0, 12)) && !e.message.includes("latin1"), String(e));
    assert.ok(Date.now() - t < 5000, "bounded time");
    assert.ok(process.memoryUsage().rss - rss < 1024 * 1024 * 1024, "bounded memory");
  });
}

for (const scanMode of ["refuse", "warn"] as const) {
  // Git's decoder accepts a doubled shift sequence that Node's rejects; the commit is refused, never scanned half-decoded.
  const DOUBLE = `${AWS_KEY.slice(0, 4)}\x1b(B\x1b(B${AWS_KEY.slice(4)}`;
  for (const label of ["ISO-2022-JP", "ISO-2022-JP-2", "csISO2022JP"]) {
    for (const where of ["author", "committer", "message"] as const) {
      test(`PSH-1 (${scanMode}): a doubled shift sequence in the ${where} with encoding ${label} is refused`, async () => {
        const f = fixture({ scanner: scanFor([]), scanMode });
        const body = ascii(where === "message" ? `AWS=${DOUBLE}\n` : "fine\n");
        const sha = commitWith(f, body, label, where === "author" ? DOUBLE : undefined, where === "committer" ? DOUBLE : undefined);
        const e = await planPush(f.deps, { worktree: f.wt, remote: "origin", branch: "axis/feat", baseSha: baseOf(f) }).then(() => undefined, (x: unknown) => x);
        assert.ok(e instanceof GitOpsError && e.code === "E_POLICY_DENIED" && e.message.includes(sha.slice(0, 12)), String(e));
        assert.ok(!JSON.stringify([e.message, e.details]).includes(AWS_KEY.slice(0, 8)) && !e.message.includes(label), "no key and no label in the error");
        assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/axis/feat"], { stdio: "ignore" }), "nothing was pushed");
      });
    }
  }
}

test("PSH-1: messageViews refuses what the strict decoder rejects and strips shifts for the ISO-2022-JP family", () => {
  const obj = (label: string, header: string, m: string): string => `tree x\nauthor ${header} <b> 1 +0000\nencoding ${label}\n\n${m}`;
  const bad = `${AWS_KEY.slice(0, 4)}\x1b(B\x1b(B${AWS_KEY.slice(4)}`;
  assert.equal(messageViews(obj("ISO-2022-JP", bad, "x\n")).undecodable, true);
  assert.equal(messageViews(obj("ISO-2022-JP", "a", `${AWS_KEY.slice(0, 4)}\x1b(B${AWS_KEY.slice(4)}\n`)).views.some((v) => v.includes(AWS_KEY)), true);
  assert.equal(messageViews(obj("Shift_JIS", "a", "x\n")).undecodable, false);
});

test("PSH-1: messageViews decodes once whatever the header count, and takes the first header the way git does", () => {
  const body = "x".repeat(1024);
  const many = `tree x\n${"encoding latin1\n".repeat(5000)}\n${body}`;
  const t = Date.now();
  assert.equal(messageViews(many).undecodable, true);
  assert.ok(Date.now() - t < 1000);
  const object = (enc: string, m: Buffer): string => Buffer.concat([ascii(`tree x\nauthor a <b> 1 +0000\nencoding ${enc}\n\n`), m]).toString("latin1");
  for (const enc of ["CP932", "eucJP", "CP936", "CP949"]) assert.equal(messageViews(object(enc, ascii("ok\n"))).undecodable, false, enc);
  assert.equal(messageViews(object("ISO-2022-JP\r", ascii(`${AWS_KEY.slice(0, 4)}\x1b(B${AWS_KEY.slice(4)}\n`))).views.some((v) => v.includes(AWS_KEY)), true);
  // A header that is not in the declared encoding is shown as it is; the message is still decoded.
  const mixed = messageViews(Buffer.concat([ascii("tree x\nauthor "), Buffer.from("\u00e9 <b> 1 +0000\nencoding Shift_JIS\n\n", "utf8"), Buffer.from([0x41, 0x0a])]).toString("latin1"));
  assert.equal(mixed.undecodable, false);
});
