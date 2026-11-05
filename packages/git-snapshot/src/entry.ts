// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { join } from "node:path";
import { clip, displayPath, escapeDisplay, redactText } from "./display.js";
import { decodeText, listDir, readItem, type ReadResult } from "./fsread.js";
import { Exhausted, type Budget, type Limits } from "./limits.js";
import type { EntryGroup, Incomplete, Setting, SnapshotEntry } from "./types.js";

const REDACTOR_TEXT_MAX = 16_000;

/** Everything one snapshot collects into. */
export interface Ctx {
  readonly limits: Limits;
  readonly budget: Budget;
  readonly entries: Map<string, SnapshotEntry>;
  readonly settings: Setting[];
  readonly incomplete: Incomplete[];
  readonly homeDir: string;
}

/** An item id for a name inside a directory: injective, so two different names never share an id. */
export const childId = (base: string, name: string): string => `${base}/${escapeDisplay(name)}`;

/** Redacted, escaped text of at most `max` characters, cut at a line end when it must be cut. */
export function textOf(bytes: Buffer, size: number, max: number): { text: string | null; truncated: boolean; binary: boolean } {
  const cap = Math.min(max, REDACTOR_TEXT_MAX);
  const cutBytes = size > bytes.length;
  const decoded = decodeText(bytes, cutBytes);
  if (decoded === null) return { text: null, truncated: false, binary: true };
  let text = decoded;
  let truncated = cutBytes;
  if (text.length > cap) {
    text = clip(text, cap);
    truncated = true;
  }
  if (truncated) {
    const nl = text.lastIndexOf("\n");
    if (nl > 0) text = text.slice(0, nl + 1);
  }
  const redacted = redactText(text);
  return { text: redacted.split("\n").map(escapeDisplay).join("\n"), truncated, binary: false };
}

function toEntry(id: string, group: EntryGroup, path: string, r: ReadResult, keepText: boolean, max: number): SnapshotEntry {
  let text: string | null = null;
  let truncated = false;
  let binary = false;
  if (keepText && r.bytes !== null && r.size !== null) {
    const t = textOf(r.bytes, r.size, max);
    text = t.text;
    truncated = t.truncated;
    binary = t.binary;
  }
  return {
    id,
    group,
    path: displayPath(path),
    state: r.state,
    mode: r.mode,
    size: r.size,
    sha256: r.sha256,
    linkTarget: r.linkTarget === null ? null : displayPath(r.linkTarget),
    text,
    textTruncated: truncated,
    binary,
    detail: r.detail,
  };
}

const BAD_STATES: ReadonlySet<string> = new Set(["unreadable", "oversize", "unstable"]);

export interface RecordOptions {
  /** Keep the file's whole content in `bytes` (a config file that will be parsed). */
  readonly parse?: boolean;
}

/** Reads one item, adds its entry (once per id), and notes it incomplete when it could not be read in full. */
export async function record(
  ctx: Ctx,
  id: string,
  group: EntryGroup,
  path: string,
  opts: RecordOptions = {},
): Promise<{ entry: SnapshotEntry; read: ReadResult }> {
  const existing = ctx.entries.get(id);
  const limit = opts.parse === true ? ctx.limits.maxConfigBytes : ctx.limits.maxFileBytes;
  if (existing === undefined) ctx.budget.addEntry();
  const read = await readItem(path, ctx.budget, {
    maxBytes: limit,
    keep: opts.parse === true ? limit : Math.min(ctx.limits.maxTextChars, REDACTOR_TEXT_MAX) * 4,
  });
  const entry = toEntry(id, group, path, read, true, ctx.limits.maxTextChars);
  if (existing === undefined) {
    ctx.entries.set(id, entry);
    if (BAD_STATES.has(read.state)) {
      ctx.incomplete.push({ id, reason: `${read.state}${read.detail === null ? "" : ` (${read.detail})`}`, blocking: true });
    }
  }
  return { entry: existing ?? entry, read };
}

/**
 * Records a directory and, `depth` levels down, what it holds. A symlinked directory is entered once (by device and
 * inode), so a link cycle ends. A directory below the depth limit is recorded but not entered, which is incomplete
 * only when `strict` (in-tree hook directories: a script there can be reached through a nested path).
 */
export async function recordTree(
  ctx: Ctx,
  baseId: string,
  group: EntryGroup,
  dirPath: string,
  depth: number,
  strict: boolean,
  seen: Set<string> = new Set(),
): Promise<void> {
  const { read } = await record(ctx, baseId, group, dirPath);
  if (read.kind !== "dir") return;
  if (read.identity !== null) {
    if (seen.has(read.identity)) return;
    seen.add(read.identity);
  }
  const list = await listDir(dirPath, ctx.budget, ctx.limits.maxEntries);
  if (!list.ok) {
    if (list.detail !== "missing") ctx.incomplete.push({ id: baseId, reason: `unreadable (${list.detail})`, blocking: true });
    return;
  }
  for (const hex of list.undecodable) {
    ctx.incomplete.push({ id: `${baseId}/${hex}`, reason: "name is not valid UTF-8, so it was not read", blocking: true });
  }
  for (const name of list.names) {
    const id = childId(baseId, name);
    const child = join(dirPath, name);
    if (depth <= 0) {
      const { read: r } = await record(ctx, id, group, child);
      if (r.kind === "dir" && strict) ctx.incomplete.push({ id, reason: "directory below the depth limit", blocking: true });
      continue;
    }
    await recordTree(ctx, id, group, child, depth - 1, strict, seen);
  }
}

export { Exhausted };
