// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { Incomplete, SnapshotEntry, WorktreeLink } from "./types.js";

/**
 * The digest an acknowledgement binds to. It covers what can change what git runs or where it talks to: for each
 * entry its id, state, mode, size, content hash and link target, the worktree link, and which items could not be
 * read. It never covers times, redacted text, settings (derived from the files) or `refs/axis/*`.
 */
export function computeDigest(
  entries: readonly SnapshotEntry[],
  link: WorktreeLink,
  incomplete: readonly Incomplete[],
): string {
  const rows = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => [e.id, e.state, e.mode, e.size, e.sha256, e.linkTarget]);
  const gaps = incomplete
    .filter((i) => i.blocking)
    .map((i) => [i.id, i.reason])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const body = JSON.stringify(["git-snapshot-v1", rows, link.declared, link.mismatch, gaps]);
  return createHash("sha256").update(body).digest("hex");
}
