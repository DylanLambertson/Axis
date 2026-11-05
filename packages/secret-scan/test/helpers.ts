// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Canaries are built at run time from a seeded generator: the repository never holds a literal that looks like a credential.
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, scanText, shannonEntropy, type Finding, type ScanContext, type ScanLimits } from "../src/index.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HEXCHARS = "0123456789abcdef";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rnd(seed: number, len: number, alphabet = ALNUM): string {
  const r = rng(seed);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

/** A value with a digit, a letter and real entropy: what the generic rule is meant to catch. */
export function randomValue(seed: number, len = 32): string {
  for (let i = 0; ; i++) {
    const v = rnd(seed + i * 7919, len);
    if (/[0-9]/.test(v) && /[A-Za-z]/.test(v) && shannonEntropy(v) >= 4) return v;
  }
}

export const canary = {
  aws: (seed = 1): string => "AK" + "IA" + rnd(seed, 16, UPPER_B32),
  gcp: (seed = 1): string => "AI" + "za" + rnd(seed, 35, ALNUM + "_-"),
  github: (seed = 1): string => "gh" + "p_" + rnd(seed, 36),
  gitlab: (seed = 1): string => "gl" + "pat-" + rnd(seed, 22),
  slack: (seed = 1): string => "xo" + "xb-" + rnd(seed, 12, "0123456789") + "-" + rnd(seed, 24),
  stripe: (seed = 1): string => "sk" + "_live_" + rnd(seed, 24),
  npm: (seed = 1): string => "np" + "m_" + rnd(seed, 36),
  anthropic: (seed = 1): string => "sk" + "-ant-api03-" + rnd(seed, 40, ALNUM + "_-"),
  jwt: (seed = 1): string => {
    const b = (s: string): string => Buffer.from(s).toString("base64url");
    return b('{"alg":"HS256","typ":"JWT"}') + "." + b('{"sub":"' + rnd(seed, 12) + '","iat":1700000000}') + "." + rnd(seed + 1, 43, ALNUM + "_-");
  },
  pemHeader: (kind = "RSA"): string => "-----BEGIN " + kind + " PRIVATE" + " KEY-----",
  /** The name a generic assignment hangs on, split so that no source line holds `name = value`. */
  name: (word: "secret" | "token" | "password" | "apikey" | "key"): string => (word === "key" ? ["api", "_key"].join("") : word),
};

export const hexOf = (seed: number, len: number): string => rnd(seed, len, HEXCHARS);

/** A new-file patch for `path` adding `lines`, the shape `git diff-tree -p` prints. */
export function patch(path: string, lines: readonly string[], opts: { eol?: string } = {}): string {
  const eol = opts.eol ?? "";
  return (
    `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}${eol}\n`).join("")
  );
}

export function scan(text: string, ctx: ScanContext = {}, limits: Partial<ScanLimits> = {}, now: () => number = () => 0): readonly Finding[] {
  return scanText(text, ctx, { ...DEFAULT_LIMITS, ...limits }, now).findings;
}

export const rules = (fs: readonly Finding[]): string[] => fs.map((f) => f.rule);

/** A finding holds a rule, a place and nothing else; and none of `secrets` is anywhere in the serialised findings. */
export function assertNoText(fs: readonly Finding[], ...secrets: string[]): void {
  const json = JSON.stringify(fs);
  for (const s of secrets) assert.ok(!json.includes(s), "a finding must not hold matched text");
  for (const f of fs) {
    assert.deepEqual(Object.keys(f).filter((k) => !["rule", "path", "line", "commit"].includes(k)), []);
    assert.match(f.rule, /^[A-Za-z0-9._-]{1,64}$/);
  }
}
