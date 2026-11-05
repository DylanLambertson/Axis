// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { clip } from "./display.js";
import { CRITICAL_LABELS } from "./settings.js";
import type { EntryGroup, Incomplete, Setting, Snapshot, SnapshotEntry } from "./types.js";

export const MAX_CHANGES = 512;
export const MAX_LINES = 40;
const MAX_LINE_CHARS = 400;
const MAX_FLAGS = 64;
/** Flags for the settings that decide what git runs are kept in their own list: a flood of changes cannot push them out. */
const MAX_CRITICAL_FLAGS = 64;

export interface EntryView {
  readonly state: string;
  readonly mode: string | null;
  readonly size: number | null;
  /** The first 12 hex digits of the content hash. */
  readonly hash: string | null;
  readonly linkTarget: string | null;
}

export interface LineDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly moreAdded: number;
  readonly moreRemoved: number;
  /** The kept text was cut, so lines past the cut are not compared. */
  readonly truncated: boolean;
}

export type ChangeKind = "added" | "removed" | "modified" | "mode-changed" | "type-changed";

export interface Change {
  readonly id: string;
  readonly group: EntryGroup;
  readonly path: string;
  readonly kind: ChangeKind;
  /** Short label for the dashboard row and the review header. */
  readonly flag: string;
  readonly before: EntryView | null;
  readonly after: EntryView | null;
  readonly lines: LineDelta | null;
}

export interface SettingChange {
  readonly key: string;
  readonly label: string;
  readonly severity: "high" | "medium";
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly note: Setting["note"];
}

export interface RefChange {
  readonly name: string;
  readonly kind: "added" | "removed" | "changed";
  readonly before: string | null;
  readonly after: string | null;
}

/** Everything is redacted and escaped; there is no raw content in it. */
export interface SnapshotDiff {
  readonly changes: readonly Change[];
  readonly settingChanges: readonly SettingChange[];
  readonly refChanges: readonly RefChange[];
  readonly flags: readonly string[];
  /** What the `after` snapshot could not read in full. */
  readonly incomplete: readonly Incomplete[];
  readonly linkMismatch: boolean;
  /** True when something blocks Axis commit and push until acknowledged (or, if incomplete, cannot be). */
  readonly blocking: boolean;
  /** More changes than the cap: the first ones are listed. */
  readonly truncated: boolean;
  /** Nothing differs: no flag. */
  readonly empty: boolean;
}

const present = (e: SnapshotEntry | undefined): e is SnapshotEntry => e !== undefined && e.state !== "missing";

const fingerprint = (e: SnapshotEntry): string => JSON.stringify([e.state, e.mode, e.size, e.sha256, e.linkTarget]);

const view = (e: SnapshotEntry): EntryView => ({
  state: e.state,
  mode: e.mode === null ? null : e.mode.toString(8).padStart(4, "0"),
  size: e.size,
  hash: e.sha256 === null ? null : e.sha256.slice(0, 12),
  linkTarget: e.linkTarget,
});

function lineDelta(before: SnapshotEntry | undefined, after: SnapshotEntry | undefined): LineDelta | null {
  const b = before?.text ?? null;
  const a = after?.text ?? null;
  if (b === null && a === null) return null;
  const counts = new Map<string, number>();
  const bl = b === null ? [] : b.split("\n");
  const al = a === null ? [] : a.split("\n");
  for (const l of bl) counts.set(l, (counts.get(l) ?? 0) + 1);
  const added: string[] = [];
  let moreAdded = 0;
  for (const l of al) {
    const n = counts.get(l) ?? 0;
    if (n > 0) {
      counts.set(l, n - 1);
      continue;
    }
    if (added.length < MAX_LINES) added.push(clip(l, MAX_LINE_CHARS));
    else moreAdded++;
  }
  const removed: string[] = [];
  let moreRemoved = 0;
  for (const l of bl) {
    const n = counts.get(l) ?? 0;
    if (n <= 0) continue;
    counts.set(l, n - 1);
    if (removed.length < MAX_LINES) removed.push(clip(l, MAX_LINE_CHARS));
    else moreRemoved++;
  }
  return { added, removed, moreAdded, moreRemoved, truncated: (before?.textTruncated ?? false) || (after?.textTruncated ?? false) };
}

const NOUN: Record<EntryGroup, string> = {
  config: "config file",
  hooks: "hook",
  "in-tree-hooks": "in-worktree hook file",
  attributes: "attributes file",
  link: "worktree link",
};

function classify(b: SnapshotEntry | undefined, a: SnapshotEntry | undefined): ChangeKind | null {
  const hadB = present(b);
  const hasA = present(a);
  if (!hadB && !hasA) return null;
  if (!hadB) return "added";
  if (!hasA) return "removed";
  if (fingerprint(b as SnapshotEntry) === fingerprint(a as SnapshotEntry)) return null;
  const x = b as SnapshotEntry;
  const y = a as SnapshotEntry;
  if (x.state !== y.state) return "type-changed";
  if (x.sha256 !== y.sha256 || x.size !== y.size || x.linkTarget !== y.linkTarget) return "modified";
  return "mode-changed";
}

function flagFor(kind: ChangeKind, e: SnapshotEntry, a: SnapshotEntry | undefined): string {
  const name = e.group === "hooks" ? e.id.replace(/^hooks\//, "") : e.id;
  const verb = kind === "mode-changed" ? ((a?.mode ?? 0) & 0o111) !== 0 ? "made executable" : "mode changed" : kind === "type-changed" ? "type changed" : kind;
  return `${NOUN[e.group]} ${verb}: ${name}`;
}

function byId(entries: readonly SnapshotEntry[]): Map<string, SnapshotEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

function valueMap(settings: readonly Setting[]): Map<string, { values: string[]; s: Setting }> {
  const m = new Map<string, { values: string[]; s: Setting }>();
  for (const s of settings) {
    const slot = m.get(s.key) ?? { values: [], s };
    slot.values.push(s.value === null ? "(no value)" : s.value);
    m.set(s.key, slot);
  }
  return m;
}

function settingChanges(before: readonly Setting[], after: readonly Setting[]): SettingChange[] {
  const b = valueMap(before);
  const a = valueMap(after);
  const out: SettingChange[] = [];
  for (const key of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const bv = [...(b.get(key)?.values ?? [])];
    const av = [...(a.get(key)?.values ?? [])];
    const added: string[] = [];
    for (const v of av) {
      const i = bv.indexOf(v);
      if (i >= 0) bv.splice(i, 1);
      else added.push(v);
    }
    if (added.length === 0 && bv.length === 0) continue;
    const s = (a.get(key) ?? b.get(key))?.s as Setting;
    out.push({ key, label: s.label, severity: s.severity, added, removed: bv, note: (a.get(key)?.s ?? s).note });
  }
  return out;
}

function refChanges(before: Snapshot["refs"], after: Snapshot["refs"]): RefChange[] {
  const b = new Map(before);
  const a = new Map(after);
  const out: RefChange[] = [];
  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const x = b.get(name) ?? null;
    const y = a.get(name) ?? null;
    if (x === y) continue;
    out.push({ name, kind: x === null ? "added" : y === null ? "removed" : "changed", before: x, after: y });
  }
  return out.slice(0, MAX_CHANGES);
}

/** The structured before/after difference for display. Pure, linear, and bounded in what it returns. */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const b = byId(before.entries);
  const a = byId(after.entries);
  const changes: Change[] = [];
  let truncated = false;
  for (const id of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const x = b.get(id);
    const y = a.get(id);
    const kind = classify(x, y);
    if (kind === null) continue;
    if (changes.length >= MAX_CHANGES) {
      truncated = true;
      break;
    }
    const e = (y ?? x) as SnapshotEntry;
    changes.push({
      id,
      group: e.group,
      path: e.path,
      kind,
      flag: flagFor(kind, e, y),
      before: x === undefined || x.state === "missing" ? null : view(x),
      after: y === undefined || y.state === "missing" ? null : view(y),
      lines: lineDelta(x, y),
    });
  }
  const settings = settingChanges(before.settings, after.settings);
  const critical = new Set<string>();
  const flags = new Set<string>();
  for (const s of settings) {
    const where = s.note === "in-worktree" ? " (inside the worktree)" : "";
    const f = `${s.label} ${s.added.length > 0 && s.removed.length > 0 ? "changed" : s.added.length > 0 ? "added" : "removed"}: ${s.key}${where}`;
    (CRITICAL_LABELS.has(s.label) ? critical : flags).add(f);
  }
  for (const c of changes) flags.add(c.flag);
  const linkMismatch = after.link.mismatch;
  if (linkMismatch) critical.add("worktree .git does not match the recorded git dir");
  const gaps = after.incomplete.filter((i) => i.blocking);
  for (const g of gaps) critical.add(`could not read in full: ${g.id}`);
  const refs = refChanges(before.refs, after.refs);
  const blocking = changes.length > 0 || linkMismatch || gaps.length > 0 || before.incomplete.some((i) => i.blocking);
  return {
    changes,
    settingChanges: settings,
    refChanges: refs,
    flags: [...[...critical].slice(0, MAX_CRITICAL_FLAGS), ...[...flags].slice(0, MAX_FLAGS)],
    incomplete: gaps,
    linkMismatch,
    blocking,
    truncated,
    empty: changes.length === 0 && settings.length === 0 && refs.length === 0 && !linkMismatch && gaps.length === 0,
  };
}
