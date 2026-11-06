// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { BrokerError, contentDigest, readContained, resolveTarget, type ContainDeps, type FileStat } from "@axis/broker";
import type { DriftEntry } from "../composer/drift.js";

/**
 * The observed hashes of one composer run (docs/design/axis-agent-shell-policies.md section 3.2): for each path the run
 * read or wrote, the digest of the content it last saw. Before each model turn `drift()` looks at every one again and
 * returns those that changed since (someone else wrote, removed or replaced them), then takes the new state as seen, so
 * each change is reported once. The run's own writes record their result, so they are never reported as drift.
 *
 * - **Bounded.** At most `MAX_OBSERVED` paths, the least recently seen dropped first; a file is hashed only when its
 *   identity, size or times differ from what was recorded, and at most `maxBytes` of it are read.
 * - **No content leaves.** Only the path the model named and a fixed word go into the notice; the read goes through the
 *   broker's containment (WT-1), the same as the model's own reads, and is not audited because nothing reaches the model.
 * - **Paths as the model named them.** Two spellings of one file are two entries; each is still checked against the file.
 */

export const MAX_OBSERVED = 256;

interface Seen {
  readonly digest: string;
  /** The file's identity before it was read (so a change during the read forces a hash next time); undefined after a write. */
  readonly stat: FileStat | undefined;
}

const sameStat = (a: FileStat, b: FileStat): boolean => a.id === b.id && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
const notFound = (e: unknown): boolean => e instanceof BrokerError && e.reason === "not-found";

export class ObservedFiles {
  readonly #seen = new Map<string, Seen>();
  readonly #contain: ContainDeps;
  readonly #worktreeId: string;
  readonly #maxBytes: number;

  constructor(contain: ContainDeps, worktreeId: string, maxBytes: number) {
    this.#contain = contain;
    this.#worktreeId = worktreeId;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#seen.size;
  }

  /** The identity of the file at `path` now, taken BEFORE a read (undefined when it cannot be looked at). */
  async statOf(path: string): Promise<FileStat | undefined> {
    try {
      return (await resolveTarget(this.#contain, this.#worktreeId, path, "read")).before;
    } catch {
      return undefined;
    }
  }

  record(path: string, data: Uint8Array | string, stat: FileStat | undefined): void {
    this.#set(path, { digest: typeof data === "string" ? data : contentDigest(data), stat });
  }

  #set(path: string, seen: Seen): void {
    this.#seen.delete(path);
    this.#seen.set(path, seen);
    if (this.#seen.size > MAX_OBSERVED) this.#seen.delete(this.#seen.keys().next().value as string);
  }

  /** Paths whose content changed since the run last saw them. Never throws: a file that cannot be judged is `unreadable`. */
  async drift(signal: AbortSignal): Promise<DriftEntry[]> {
    const out: DriftEntry[] = [];
    for (const [path, seen] of [...this.#seen]) {
      if (signal.aborted) break;
      const now = await this.#look(path, seen);
      if (now === "removed") {
        this.#seen.delete(path);
        out.push({ path, change: "removed" });
      } else if (now.digest !== seen.digest) {
        this.#seen.set(path, now);
        out.push({ path, change: now.digest === "unreadable" ? "unreadable" : "changed" });
      } else if (now !== seen) {
        this.#seen.set(path, now);
      }
    }
    return out;
  }

  async #look(path: string, seen: Seen): Promise<Seen | "removed"> {
    let stat: FileStat | undefined;
    try {
      stat = (await resolveTarget(this.#contain, this.#worktreeId, path, "read")).before;
    } catch (e) {
      return notFound(e) ? "removed" : { digest: "unreadable", stat: undefined };
    }
    if (stat !== undefined && seen.stat !== undefined && sameStat(stat, seen.stat)) return seen;
    try {
      return { digest: contentDigest(await readContained(this.#contain, this.#worktreeId, path, { maxBytes: this.#maxBytes })), stat };
    } catch (e) {
      return notFound(e) ? "removed" : { digest: "unreadable", stat: undefined };
    }
  }
}
