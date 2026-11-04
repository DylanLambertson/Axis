// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1 at review time (design §11): the secret scanner @axis/git-ops already uses, run over the patch of what would be
// committed, so the push dialog can warn before the commit exists. It does not replace the scan in planPush.
import { createHash } from "node:crypto";
import { MAX_DIFF, type SecretFinding } from "@axis/git-ops";
import { assertBinding, type ReviewBinding } from "./binding.js";
import { escapeForDisplay } from "./display.js";
import { mapUnexpected, internal, invalid } from "./errors.js";
import { OBJECT_ID, expectOk, reviewGitFor } from "./gitcall.js";
import { resolveLimits } from "./limits.js";
import type { ReviewDeps, ReviewFile } from "./types.js";

export interface SecretWarning {
  /** Restricted to `[A-Za-z0-9._-]{1,64}`: the scanner's rule name, never matched text. */
  readonly rule: string;
  readonly displayPath: string | undefined;
  readonly line: number | undefined;
}

export interface SecretWarnings {
  /** False when no scanner is configured: nothing was checked, which is not the same as nothing found. */
  readonly scanned: boolean;
  readonly findings: readonly SecretWarning[];
  /** Files git treats as binary: pattern matching cannot see inside them. */
  readonly binaryPaths: readonly string[];
  /** The patch was larger than the scanner takes, or the runner cut it off. */
  readonly truncated: boolean;
  readonly requiresConfirmation: boolean;
  /** SHA-256 over the reviewed tree and the findings: a confirmation names this and is void if the tree changes. */
  readonly digest: string;
}

const RULE = /^[A-Za-z0-9._-]{1,64}$/;

export function secretWarnings(deps: ReviewDeps, binding: ReviewBinding, files: readonly ReviewFile[]): Promise<SecretWarnings> {
  return mapUnexpected(async () => {
    assertBinding(binding);
    const reviewedTree = binding.reviewedTree;
    if (!OBJECT_ID.test(reviewedTree)) throw invalid("not a review binding");
    const limits = resolveLimits(deps.limits);
    const accepted = new Set(binding.accepted.flatMap((a) => [a.path]));
    const binaryPaths = files.filter((f) => accepted.has(f.path) && f.kind === "binary").map((f) => escapeForDisplay(f.path, { maxLength: limits.maxDisplay, cut: "middle" }));
    const scanner = deps.git.scanner;
    // `scanned` is part of the digest: a confirmation of "nothing found" is not a confirmation of "nothing was checked".
    const digestOf = (scanned: boolean, findings: readonly SecretWarning[], truncated: boolean): string =>
      createHash("sha256").update(JSON.stringify(["axis.review.secrets/1", reviewedTree, scanned, findings, binaryPaths, truncated])).digest("hex");
    if (!scanner) return { scanned: false, findings: [], binaryPaths, truncated: false, requiresConfirmation: false, digest: digestOf(false, [], false) };

    const git = await reviewGitFor(deps, binding.worktree);
    const r = await git([
      "diff-tree", "-p", "-r", "--text", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      "--submodule=short", "--ignore-submodules=all", binding.headTree, reviewedTree,
    ]);
    const patch = expectOk(r, "read the reviewed patch");
    const cut = r.truncated === true || patch.length > MAX_DIFF;
    const raw: readonly SecretFinding[] = await scanner(cut ? patch.slice(0, MAX_DIFF) : patch, {
      worktree: binding.worktree,
      truncated: cut,
      commit: reviewedTree,
      binaryPaths: binaryPaths.length === 0 ? [] : files.filter((f) => accepted.has(f.path) && f.kind === "binary").map((f) => f.path),
      part: "patch",
    });
    if (!Array.isArray(raw)) throw internal("the secret scanner returned something that is not a list");
    const findings: SecretWarning[] = raw.slice(0, 1000).map((f) => ({
      rule: typeof f.rule === "string" && RULE.test(f.rule) ? f.rule : "unknown-rule",
      displayPath: typeof f.path === "string" ? escapeForDisplay(f.path, { maxLength: limits.maxDisplay, cut: "middle" }) : undefined,
      line: typeof f.line === "number" && Number.isSafeInteger(f.line) && f.line > 0 ? f.line : undefined,
    }));
    return {
      scanned: true,
      findings,
      binaryPaths,
      truncated: cut || raw.length > 1000,
      requiresConfirmation: findings.length > 0 || binaryPaths.length > 0 || cut || raw.length > 1000,
      digest: digestOf(true, findings, cut || raw.length > 1000),
    };
  });
}
