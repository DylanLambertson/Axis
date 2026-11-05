// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Compile-time check that the `axis.review/1` wire shapes line up with this package's types (ticket P1b).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewResponse } from "@axis/protocol";
import type { ChangeKind, ChangeStatus, ReviewFile, SkippedFile } from "../../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <T extends true>(): T | undefined => undefined;
type Wire = ReviewResponse<"diff">["files"][number];

yes<Equal<Wire["status"], ChangeStatus>>();
yes<Equal<Wire["kind"], ChangeKind>>();
yes<Equal<Wire["displayPath"], ReviewFile["displayPath"]>>();
yes<Equal<Wire["displayOldPath"], ReviewFile["displayOldPath"]>>();
yes<Equal<Wire["similarity"], ReviewFile["similarity"]>>();
yes<Equal<Wire["additions"], ReviewFile["additions"]>>();
yes<Equal<Wire["deletions"], ReviewFile["deletions"]>>();
yes<Equal<Wire["unsafePath"], ReviewFile["unsafePath"]>>();
yes<Equal<Wire["fileLevelReason"], ReviewFile["fileLevelReason"]>>();
yes<Equal<Wire["protectedRules"], string[]>>();
yes<Equal<Wire["warnings"], string[]>>();
yes<Equal<ReviewResponse<"diff">["skipped"][number]["reason"], SkippedFile["reason"]>>();
yes<Equal<ReviewResponse<"diff">["skipped"][number]["size"], SkippedFile["size"]>>();

test("the axis.review/1 wire shapes compile against the review types", () => {
  assert.ok(true);
});
