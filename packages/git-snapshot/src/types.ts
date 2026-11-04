// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export type EntryState = "file" | "dir" | "symlink" | "missing" | "other" | "unreadable" | "oversize" | "unstable";
export type EntryGroup = "config" | "hooks" | "in-tree-hooks" | "attributes" | "link";

/** One watched item. `text` is redacted and escaped; the raw content is never kept, only its hash. */
export interface SnapshotEntry {
  readonly id: string;
  readonly group: EntryGroup;
  readonly path: string;
  readonly state: EntryState;
  readonly mode: number | null;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly linkTarget: string | null;
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly binary: boolean;
  /** errno name (`unreadable`) or a short fixed reason. */
  readonly detail: string | null;
}

export interface Setting {
  /** `section.subsection.name` with the section and name lower-cased, the subsection redacted and escaped. */
  readonly key: string;
  /** Redacted and escaped; null for a bare key. */
  readonly value: string | null;
  /** Id of the entry (file) it came from. */
  readonly origin: string;
  readonly line: number;
  /** Why it matters, from the table in settings.ts. */
  readonly label: string;
  readonly severity: "high" | "medium";
  /** For path-valued settings: where the target lies. */
  readonly note: "in-worktree" | "outside-worktree" | "unresolved" | null;
}

export interface Incomplete {
  readonly id: string;
  readonly reason: string;
  /** False for `refs/axis/*`, which never blocks. */
  readonly blocking: boolean;
}

export interface WorktreeLink {
  /** The git dir the worktree's `.git` names; null when it cannot be read or parsed. */
  readonly declared: string | null;
  /** What the journal expects, when the caller passed it. */
  readonly expected: string | null;
  readonly mismatch: boolean;
}

export interface Snapshot {
  readonly version: 1;
  readonly takenAtMs: number;
  readonly worktreePath: string;
  readonly commonDir: string;
  readonly entries: readonly SnapshotEntry[];
  readonly settings: readonly Setting[];
  /** `[name, sha]` pairs for `refs/axis/*`, sorted. A notice only. */
  readonly refs: readonly (readonly [string, string])[];
  readonly incomplete: readonly Incomplete[];
  readonly link: WorktreeLink;
  /** Over the blocking entries and the link check; see digest.ts. */
  readonly digest: string;
}
