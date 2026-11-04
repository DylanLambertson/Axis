// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export { takeSnapshot, takeStableSnapshot, type TakeOptions, type StableOptions } from "./collect.js";
export { diffSnapshots, MAX_CHANGES, MAX_LINES, type Change, type ChangeKind, type EntryView, type LineDelta, type RefChange, type SettingChange, type SnapshotDiff } from "./diff.js";
export { judgeDrift, acknowledgeDrift, assertDriftAllowed, type Acknowledgement, type DriftVerdict, type JudgeInput } from "./verdict.js";
export { parseSnapshot } from "./schema.js";
export { computeDigest } from "./digest.js";
export { classifyPath, classifyPathResolved, foldName, type ProtectedCategory, type ProtectedMatch } from "./protected.js";
export { parseGitConfig, type ConfigEntry, type ParsedConfig } from "./gitconfig.js";
export { DEFAULT_LIMITS, type Limits } from "./limits.js";
export { SnapshotError } from "./errors.js";
export { escapeDisplay } from "./display.js";
export type { EntryGroup, EntryState, Incomplete, Setting, Snapshot, SnapshotEntry, WorktreeLink } from "./types.js";
