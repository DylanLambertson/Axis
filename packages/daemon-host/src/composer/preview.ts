// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { BROKER_TIERS, MAX_PREVIEW_ARGS, MAX_PREVIEW_ARGV_CHARS, MAX_PREVIEW_FINDINGS, MAX_PREVIEW_HEAD, REFUSED_ACTIVITY, type ApprovalPreview, type CommandPreview } from "@axis/protocol";

/**
 * The approval preview of a composer tool call (review r1 S2, ticket C8; docs/design/composer-runtime.md section 4).
 * Built by `bindings/agent.ts` from the arguments it proved the broker's digest covers, so what the user judges is what
 * runs. It shows the tier recorded at issue, whether a protected path (WT-3) is written, and for a write: the byte count
 * and SHA-256 of exactly the bytes written and a bounded, escaped head. The whole content goes through the secret
 * scanner and the host redactor first; a finding is listed by rule name only (`redactor-match` for the redactor), the
 * head is then the redactor's output, and a head that still trips either (or a scan that cannot complete) is not shown
 * at all. Never throws: anything unexpected yields `undefined`, and the caller then declines the call without issuing a
 * challenge.
 */

export interface PreviewScanner {
  /** Rule names found in plain text (`@axis/secret-scan`, part `message`). Throws when the scan cannot cover the text. */
  scan(text: string): Promise<readonly string[]>;
}

export interface PreviewInput {
  readonly tier: string;
  /** The broker's reasons (`protected:<label>` marks a WT-3 path). */
  readonly reasons: readonly string[];
  /** What the call writes, exactly as the digest covers it; undefined for a call that writes no content. */
  readonly content: string | undefined;
  /** The command the call starts (C3), as the broker pinned it and its digest covers it; undefined for none. */
  readonly command?: CommandInput;
}

export interface CommandInput {
  readonly argv: readonly string[];
  /** The program's real path, and its `#!` interpreter's (null for a binary), as in the broker's command line. */
  readonly program: string;
  readonly interpreter: string | null;
  /** The working directory below the worktree root (`.` for the root). */
  readonly cwd: string;
}

/** SHA-256 over what runs: the program, the interpreter, the arguments and the working directory (canonical JSON). */
export function commandIdentity(c: CommandInput): string {
  return createHash("sha256").update(JSON.stringify([c.program, c.interpreter, [...c.argv], c.cwd]), "utf8").digest("hex");
}

/**
 * The command as the user sees it, or undefined when it cannot be shown whole (an argument, the program or the directory
 * cut by its bound, more than `MAX_PREVIEW_ARGS` arguments or `MAX_PREVIEW_ARGV_CHARS` escaped units): the call is then
 * declined, never approved on part of its command line. The secret scan runs over every argument (a finding declines too).
 */
export async function commandPreview(c: CommandInput, deps: PreviewDeps): Promise<CommandPreview | undefined> {
  if (c.argv.length === 0 || c.argv.length > MAX_PREVIEW_ARGS) return undefined;
  const whole = (text: string, max: number): string | undefined => {
    const { head, truncated } = escapedHead(text, max);
    return truncated || head.length === 0 ? undefined : head;
  };
  const argv = c.argv.map((a) => whole(a, 4096));
  const program = whole(c.program, 1024);
  const interpreter = c.interpreter === null ? null : whole(c.interpreter, 1024);
  const cwd = whole(c.cwd, 512);
  if (argv.some((a) => a === undefined) || program === undefined || interpreter === undefined || cwd === undefined) return undefined;
  if (argv.reduce((n, a) => n + (a as string).length, 0) > MAX_PREVIEW_ARGV_CHARS) return undefined;
  for (const a of c.argv) {
    if ((await deps.scanner.scan(a)).length > 0 || deps.redact(a) !== a) return undefined;
  }
  return { argv: argv as string[], program, interpreter, cwd, identity: commandIdentity(c) };
}

export interface PreviewDeps {
  readonly scanner: PreviewScanner;
  readonly redact: (text: string) => string;
}

const RULE = /^[A-Za-z0-9._-]{1,64}$/;

/** Blank letters that draw nothing (Hangul fillers, the braille blank): shown escaped in a head although activity text allows them. */
const BLANK_LETTER = /^[\u115f\u1160\u2800\u3164\uffa0]$/u;
const MARK = /^\p{M}$/u;
/** Combining marks in a row kept as they are; more are escaped, so a stack cannot draw over the text around it. */
export const MAX_COMBINING_RUN = 2;

const hex = (ch: string): string => `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;

/**
 * The start of `text` as the user sees it, cut on a code point boundary at `max` UTF-16 units. Every code point activity
 * text refuses, every blank letter and every combining mark past `MAX_COMBINING_RUN` in a row is written `\u{hex}`, and a
 * backslash is written `\\`, so the escaping is reversible: what the head shows names exactly one content.
 */
export function escapedHead(text: string, max = MAX_PREVIEW_HEAD): { readonly head: string; readonly truncated: boolean } {
  let head = "";
  let marks = 0;
  for (const ch of text) {
    marks = MARK.test(ch) ? marks + 1 : 0;
    const t = ch === "\\" ? "\\\\" : REFUSED_ACTIVITY.test(ch) || BLANK_LETTER.test(ch) || marks > MAX_COMBINING_RUN ? hex(ch) : ch;
    if (head.length + t.length > max) return { head, truncated: true };
    head += t;
  }
  return { head, truncated: false };
}

export async function buildApprovalPreview(input: PreviewInput, deps: PreviewDeps): Promise<ApprovalPreview | undefined> {
  try {
    const tier = (BROKER_TIERS as readonly string[]).includes(input.tier) ? (input.tier as ApprovalPreview["tier"]) : undefined;
    if (tier === undefined) return undefined;
    const isProtected = input.reasons.some((r) => r.startsWith("protected:"));
    if (input.command !== undefined) {
      // A command writes no content of its own here; what it starts is the whole preview, shown whole or not at all.
      const command = input.content === undefined ? await commandPreview(input.command, deps) : undefined;
      return command === undefined ? undefined : { tier, protected: isProtected, content: null, command };
    }
    if (input.content === undefined) return { tier, protected: isProtected, content: null };
    const bytes = Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let findings: string[];
    try {
      findings = [...new Set(await deps.scanner.scan(input.content))].filter((r) => RULE.test(r));
      // The two detectors differ (the redactor knows registered secrets and some formats the scanner does not): either counts.
      if (deps.redact(input.content) !== input.content) findings.push("redactor-match");
    } catch {
      // A scan that could not cover the content: say so, and show none of it.
      return { tier, protected: isProtected, content: { bytes: bytes.length, sha256, head: "", truncated: bytes.length > 0, findings: ["scan-incomplete"] } };
    }
    if (findings.length === 0) {
      const { head, truncated } = escapedHead(input.content);
      return { tier, protected: isProtected, content: { bytes: bytes.length, sha256, head, truncated, findings: [] } };
    }
    // A secret-like value: the head is what the redactor leaves, and only if the scanner then finds nothing in it.
    const { head: redacted } = escapedHead(deps.redact(input.content));
    let clean = false;
    try {
      clean = (await deps.scanner.scan(redacted)).length === 0 && deps.redact(redacted) === redacted;
    } catch {
      clean = false;
    }
    return {
      tier,
      protected: isProtected,
      content: { bytes: bytes.length, sha256, head: clean ? redacted : "", truncated: true, findings: findings.slice(0, MAX_PREVIEW_FINDINGS) },
    };
  } catch {
    return undefined;
  }
}
