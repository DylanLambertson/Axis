// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { MAX_REVIEW_PATH, MAX_REVIEW_SKIPPED, toDisplayPath, type ReviewFileWire } from "@axis/protocol";
import type { RoundFile, RoundSkipped } from "../ports/review.js";

/** `fileId`: SHA-256 (lower-case hex) of the UTF-8 encoding of the path as the host decoded it. Never of the display string. */
export function fileIdOf(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

/** `contentId`: SHA-256 of `<newMode> <newOid>` of the entry in the snapshot tree (mode is part of the binding). */
export function contentIdOf(newMode: string, newOid: string, protectedPath = false): string {
  // The WT-3 flag is part of what is acknowledged: a file shown as protected is acknowledged as protected, so an
  // acknowledgement cannot be carried to a response that no longer reports the flag (and the other way round).
  return createHash("sha256").update(protectedPath ? `${newMode} ${newOid} protected` : `${newMode} ${newOid}`, "utf8").digest("hex");
}

/** A path that does not decode as strict UTF-8 holds U+FFFD: it is not a usable path, whatever the review package said. */
export const hasReplacementChar = (path: string): boolean => path.includes("\uFFFD");

/**
 * Equal path strings are one entry: two byte paths that decode to the same string would share a `fileId`, so they are
 * folded into ONE unsafe row (the first entry's facts, marked unsafe). Order is otherwise the review's.
 */
export function foldEqualPaths(files: readonly RoundFile[]): RoundFile[] {
  const seen = new Map<string, number>();
  const out: RoundFile[] = [];
  for (const f of files) {
    const at = seen.get(f.path);
    if (at === undefined) {
      seen.set(f.path, out.length);
      out.push(f);
    } else {
      out[at] = { ...(out[at] as RoundFile), unsafePath: true };
    }
  }
  return out;
}

/** The closed WT-3 flag of a file: any rule matched (a matcher that threw is `matcher-error`, which counts). */
export const isProtected = (f: { readonly protectedRules: readonly string[] }): boolean => f.protectedRules.length > 0;

/** Protected files first, the review's own order otherwise (a stable sort). */
export function protectedFirst<T extends { readonly protectedRules: readonly string[] }>(files: readonly T[]): T[] {
  return [...files.filter(isProtected), ...files.filter((f) => !isProtected(f))];
}

const tag = (s: string, max: number): string => toDisplayPath(s, max);
const tags = (list: readonly string[]): string[] => list.slice(0, 4).map((s) => tag(s, 64));

/** One row of the reply. Every display string goes through `toDisplayPath`; no raw path, mode or object id leaves. */
export function wireRow(f: RoundFile, facts: { readonly fileId: string; readonly truncated: boolean; readonly contentId: string | null; readonly acknowledged: boolean; readonly unsafe: boolean }): ReviewFileWire {
  return {
    fileId: facts.fileId,
    displayPath: toDisplayPath(f.path, MAX_REVIEW_PATH),
    ...(f.oldPath === undefined ? {} : { displayOldPath: toDisplayPath(f.oldPath, MAX_REVIEW_PATH) }),
    status: f.status,
    kind: f.kind,
    ...(f.similarity === undefined ? {} : { similarity: f.similarity }),
    ...(f.additions === undefined ? {} : { additions: f.additions }),
    ...(f.deletions === undefined ? {} : { deletions: f.deletions }),
    unsafePath: facts.unsafe,
    truncated: facts.truncated,
    contentId: facts.contentId,
    acknowledged: facts.acknowledged,
    protectedPath: isProtected(f),
    protectedRules: tags(f.protectedRules),
    ...(f.fileLevelReason === undefined ? {} : { fileLevelReason: tag(f.fileLevelReason, 128) }),
    warnings: tags(f.warnings),
  };
}

export function wireSkipped(skipped: readonly RoundSkipped[]): { displayPath: string; size: number; reason: "too_large_to_review" }[] {
  return skipped.slice(0, MAX_REVIEW_SKIPPED).map((s) => ({ displayPath: toDisplayPath(s.path, MAX_REVIEW_PATH), size: s.size, reason: "too_large_to_review" as const }));
}

export interface AckSessionLimits {
  readonly maxSessions: number;
  readonly maxPairsPerSession: number;
}

/**
 * Which acknowledgements were already applied in a review session, so one audit event is written per first application of
 * a (`fileId`, `contentId`) and not one per poll. A session is one connection reviewing one workspace against one HEAD.
 * Bounded; when a bound is hit the oldest record is dropped, which can only cause an extra audit event, never a missing one.
 */
export class AckSessions {
  readonly #sessions = new Map<string, Set<string>>();
  readonly #limits: AckSessionLimits;
  constructor(limits: AckSessionLimits = { maxSessions: 64, maxPairsPerSession: 1024 }) {
    this.#limits = limits;
  }

  /** True the first time this pair is seen in the session. Call `commit` after the audit event is written. */
  isFirst(session: string, fileId: string, contentId: string): boolean {
    return !(this.#sessions.get(session)?.has(`${fileId}:${contentId}`) ?? false);
  }

  commit(session: string, fileId: string, contentId: string): void {
    let set = this.#sessions.get(session);
    if (set === undefined) {
      set = new Set();
    } else {
      this.#sessions.delete(session);
    }
    if (set.size >= this.#limits.maxPairsPerSession) set.clear();
    set.add(`${fileId}:${contentId}`);
    this.#sessions.set(session, set);
    while (this.#sessions.size > this.#limits.maxSessions) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true) break;
      this.#sessions.delete(oldest.value);
    }
  }
}
