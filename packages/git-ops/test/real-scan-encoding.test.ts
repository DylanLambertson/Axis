// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1 regression: the history scan reads commit messages as bytes, so an encoding cannot hide a secret from it.
// The commit objects are written with `hash-object --literally`, because `git commit` refuses most of these messages.
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
function commitWith(f: Fixture, message: Buffer): string {
  const tree = f.git("rev-parse", "HEAD^{tree}").trim();
  const head = ascii(`tree ${tree}\nparent ${baseOf(f)}\nauthor Dylan Lambertson <me@dylanlambertson.dev> 1700000000 +0000\ncommitter Dylan Lambertson <me@dylanlambertson.dev> 1700000000 +0000\n\n`);
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { cwd: f.wt.workTree, env: f.env, input: Buffer.concat([head, message]) }).toString().trim();
  f.git("update-ref", "refs/heads/axis/feat", sha);
  return sha;
}

const CASES: Array<[string, Buffer, boolean]> = [
  ["UTF-16LE without a BOM", utf16le(MSG, false), true],
  ["UTF-16LE with a BOM", utf16le(MSG, true), true],
  ["UTF-16BE without a BOM", utf16be(MSG, false), true],
  ["UTF-16BE with a BOM", utf16be(MSG, true), true],
  ["a NUL after every character", nulAfter(MSG), true],
  ["a NUL before every character", nulBefore(MSG), true],
  ["NULs only inside the secret", nulInside(`${AWS_KEY}\n`), true],
  ["mixed: UTF-8 text, then UTF-16LE at an odd offset", Buffer.concat([ascii("x"), utf16le(MSG, false)]), true],
  ["mixed: UTF-16BE text, then UTF-8", Buffer.concat([utf16be("note\n", false), ascii(MSG)]), false],
  ["invalid UTF-8 inside the secret", Buffer.concat([ascii(AWS_KEY.slice(0, 6)), Buffer.from([0xff]), ascii(AWS_KEY.slice(6)), ascii("\n")]), true],
  ["invalid UTF-8 and no secret at all", Buffer.concat([ascii("fine "), Buffer.from([0xc3, 0x28, 0xff]), ascii("\n")]), false],
  ["a lone NUL and no secret at all", ascii("fine\0\n"), false],
];

for (const scanMode of ["refuse", "warn"] as const) {
  for (const [name, message, decodable] of CASES) {
    test(`PSH-1 (${scanMode}): a commit message with ${name} is refused with a closed-set error, and the secret is not in it`, async () => {
      const seen: string[] = [];
      const f = fixture({ scanner: scanFor(seen), scanMode });
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
      // Where the secret is recoverable, the scanner was handed the decoded text, not only the raw bytes.
      if (decodable) assert.ok(seen.some((d) => d.includes(AWS_KEY)), "the scanner never saw the decoded secret");
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

test("PSH-1: messageViews reads every encoding of the secret and flags only what is undecodable", () => {
  const object = (m: Buffer): string => Buffer.concat([ascii("tree x\n\n"), m]).toString("latin1");
  for (const m of [utf16le(MSG, false), utf16le(MSG, true), utf16be(MSG, false), utf16be(MSG, true), nulAfter(MSG), nulBefore(MSG), nulInside(MSG)]) {
    const r = messageViews(object(m));
    assert.ok(r.undecodable && r.views.some((v) => v.includes(AWS_KEY)));
  }
  assert.deepEqual(messageViews(object(ascii("plain\n"))), { views: ["tree x\n\nplain\n"], undecodable: false });
  assert.equal(messageViews(object(Buffer.from("é\n", "utf8"))).undecodable, false);
  // A runner that ignored `raw` has already decoded the text: a replacement character is a lost byte, so it is refused.
  assert.equal(messageViews("tree x\n\ncafé ☕\n").undecodable, false);
  assert.equal(messageViews("tree x\n\nbad � ☕\n").undecodable, true);
});
