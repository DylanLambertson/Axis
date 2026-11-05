// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Compile-time check that the `axis.git/1` wire shapes line up with this package's own types (ticket P1b): a field renamed
// or retyped here, or in the contract, makes `tsc` fail in this file.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitRequest, GitResponse } from "@axis/protocol";
import type { CommitInput, CommitResult, ConfirmedPlan, PushInput, PushPlan, SecretFinding } from "../../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Each is assignable to the other: the same fields with the same types (readonly aside). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Every field required and without `undefined`: zod writes an optional field as `?: T | undefined`, the package as `?: T`. */
type Req<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
/** The same field names, and the same types for each field (optional or not, readonly or not). */
type Shape<A, B> = Same<keyof A, keyof B> extends true ? Same<Req<A>, Req<B>> : false;
const yes = <T extends true>(): T | undefined => undefined;

// commit: the request is the package's input without the worktree (the host resolves it) plus the workspace id.
yes<Shape<Omit<GitRequest<"commit">, "workspaceId">, Omit<CommitInput, "worktree">>>();
yes<Same<GitResponse<"commit">, CommitResult>>();
// push: the wire carries the confirmed plan and the remote; the branch and the base commit come from the journal.
yes<Equal<GitRequest<"push">["remote"], PushInput["remote"]>>();
yes<Same<GitRequest<"push">["confirmedPlan"], ConfirmedPlan>>();
yes<Equal<NonNullable<GitRequest<"push">["allowedBinaryPaths"]>, string[]>>();
yes<Equal<GitRequest<"push">["allowedBinaryPaths"], GitRequest<"pushPlan">["allowedBinaryPaths"]>>();
// pushPlan: the reply's scalar fields are the plan's.
yes<Equal<GitResponse<"pushPlan">["tip"], PushPlan["tip"]>>();
yes<Equal<GitResponse<"pushPlan">["digest"], PushPlan["digest"]>>();
yes<Equal<GitResponse<"pushPlan">["requiresConfirmation"], PushPlan["requiresConfirmation"]>>();
yes<Equal<GitResponse<"pushPlan">["remote"], PushPlan["remote"]>>();
yes<Equal<GitResponse<"pushPlan">["branch"], PushPlan["branch"]>>();
yes<Equal<GitResponse<"pushPlan">["reasons"], string[]>>();
yes<Shape<GitResponse<"pushPlan">["findings"][number], SecretFinding>>();

test("the axis.git/1 wire shapes compile against the git-ops types", () => {
  assert.ok(true);
});
