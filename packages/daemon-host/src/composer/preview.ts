// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { BROKER_TIERS, MAX_PREVIEW_FINDINGS, MAX_PREVIEW_HEAD, REFUSED_ACTIVITY, type ApprovalPreview } from "@axis/protocol";

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
}

export interface PreviewDeps {
  readonly scanner: PreviewScanner;
  readonly redact: (text: string) => string;
}

const RULE = /^[A-Za-z0-9._-]{1,64}$/;

const token = (ch: string): string => (REFUSED_ACTIVITY.test(ch) ? `\\u{${(ch.codePointAt(0) as number).toString(16)}}` : ch);

/** The start of `text` with every refused code point escaped, cut on a code point boundary at `max` UTF-16 units. */
export function escapedHead(text: string, max = MAX_PREVIEW_HEAD): { readonly head: string; readonly truncated: boolean } {
  let head = "";
  for (const ch of text) {
    const t = token(ch);
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
