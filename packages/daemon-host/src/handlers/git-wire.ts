// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  MAX_BLOCKED_BINARY_FILES,
  MAX_FINDING_PATH,
  MAX_PLAN_REASON_TEXT,
  MAX_PLAN_REASONS,
  MAX_PUSH_FINDINGS,
  gitPushPlanResponseSchema,
  objectIdSchema,
  toDisplayPath,
  type GitResponse,
  type SecretFindingWire,
} from "@axis/protocol";
import type { PushPlanFacts } from "../ports/git.js";

const RULE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * One finding on the wire: the rule name, an ESCAPED path, a line and the commit. A rule the contract cannot carry is
 * named `unrecognised-rule` (the finding still counts, so the plan still asks for confirmation); a commit that is not an
 * object id is dropped. Matched text is never part of the facts, so it cannot appear here.
 */
function wireFinding(f: PushPlanFacts["findings"][number]): SecretFindingWire {
  return {
    rule: RULE.test(f.rule) ? f.rule : "unrecognised-rule",
    ...(f.path === undefined ? {} : { path: toDisplayPath(f.path, MAX_FINDING_PATH) }),
    ...(f.line === undefined || !Number.isInteger(f.line) || f.line < 0 ? {} : { line: f.line }),
    ...(f.commit !== undefined && objectIdSchema.safeParse(f.commit).success ? { commit: f.commit } : {}),
  };
}

/**
 * The `pushPlan` reply, or null when it is not one the contract accepts (the handler then fails closed, `E_INTERNAL`).
 * Every reason is escaped with `toDisplayPath`: a binary file name in a reason can carry bidi or zero-width characters.
 * A blocked plan (`facts.blocked`) lists its binary files (identity, display name through `toDisplayPath`, lossy flag), at most `MAX_BLOCKED_BINARY_FILES`; a
 * reason outside the contract's closed set fails the whole reply. At most `MAX_PUSH_FINDINGS` findings are listed and `findingsTruncated` says there were more; the digest covers all.
 */
export function pushPlanReply(facts: PushPlanFacts, remote: string, branch: string): GitResponse<"pushPlan"> | null {
  const reasons = facts.reasons.slice(0, MAX_PLAN_REASONS).map((r) => toDisplayPath(r, MAX_PLAN_REASON_TEXT));
  // More reasons than the contract holds: the last one still says so, so no reason is silently dropped.
  if (facts.reasons.length > MAX_PLAN_REASONS) reasons[MAX_PLAN_REASONS - 1] = "more reasons than can be listed";
  const answer = gitPushPlanResponseSchema.safeParse({
    remote,
    branch,
    tip: facts.tip,
    requiresConfirmation: facts.requiresConfirmation,
    reasons,
    findings: facts.findings.slice(0, MAX_PUSH_FINDINGS).map(wireFinding),
    findingsTruncated: facts.findings.length > MAX_PUSH_FINDINGS,
    digest: facts.digest,
    ...(facts.blocked === undefined
      ? {}
      : {
          blocked: {
            reason: facts.blocked.reason,
            binaryFiles: facts.blocked.binaryFiles.slice(0, MAX_BLOCKED_BINARY_FILES).map((f) => ({ id: f.id, path: toDisplayPath(f.path, MAX_FINDING_PATH), lossy: f.lossy })),
            binaryFilesTruncated: facts.blocked.binaryFiles.length > MAX_BLOCKED_BINARY_FILES,
          },
        }),
  });
  return answer.success ? answer.data : null;
}
