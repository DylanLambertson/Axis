// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Display-safe text helpers for approval requests and audit payloads.
import { createHash } from "node:crypto";
import { canonicalize, type JsonValue } from "@axis/audit";

// Built with `new RegExp`: the native emitter would write raw U+2028/2029 into a regex literal.
const BIDI = new RegExp("[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
const CTRL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

// Format characters (zero-width space and joiner, word joiner, the BOM, tag characters) are invisible, so two different names can look alike.
const DISPLAY = new RegExp(`${BIDI.source}|${CTRL.source}|\\p{Cf}`, "gu");

/**
 * Control characters (a terminal escape, a carriage return, a newline, U+2028/2029) and bidirectional controls (which
 * reorder text in a dialog) are shown as their code points, so approval text is one line of printable characters.
 */
export const escapeDisplay = (s: string): string => s.replace(DISPLAY, (c) => {
  const cp = c.codePointAt(0) as number;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
});
/** Cuts at `n` UTF-16 units without leaving half of a surrogate pair. */
export const clipText = (s: string, n: number): string => {
  if (s.length <= n) return s;
  const cut = s.charCodeAt(n - 1);
  return s.slice(0, cut >= 0xd800 && cut <= 0xdbff ? n - 1 : n);
};
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
export const printable = (s: string): string => clip(s.replace(CTRL, "?"), 200);
export const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** What a call's digest covers: the call as the policy decided it (resolved paths, command lines) and its parsed arguments. */
export interface CallDigestInput {
  readonly tool: string;
  readonly worktreeId: string;
  readonly actor: string;
  readonly tier: string;
  /** `access:path` for each declared target, in declaration order. */
  readonly paths: readonly string[];
  readonly commands: readonly string[];
  readonly args: unknown;
}

/**
 * The digest an approval is bound to (SHA-256 of the canonical call, arguments in full). The one definition: the broker
 * computes it before it asks, and an approval hook that shows the user the arguments recomputes it to prove that what it
 * shows is what the digest covers. Throws for arguments that cannot be canonicalised.
 */
export const callDigest = (c: CallDigestInput): string =>
  sha(canonicalize({ tool: c.tool, worktreeId: c.worktreeId, actor: c.actor, tier: c.tier, paths: [...c.paths], commands: [...c.commands], args: c.args as JsonValue }));
