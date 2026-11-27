// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { BrokerError, contentDigest, denied, foldName, nodeBrokerFs, readContained, resolveTarget, type ContainDeps, type FileStat, type ResolvedTarget } from "@axis/broker";
import type { DriftEntry } from "../composer/drift.js";

/**
 * The observed hashes of one composer run (docs/design/axis-agent-shell-policies.md section 3.2): for each file the run
 * read or wrote, the digest of the content it last saw.
 *
 * - **The base of a write (§3.3).** `seenBy` answers the digest the run itself last saw for a file; `write_file` refuses
 *   any other `base` (`stale`), so a digest the model predicted (the empty file's, a vendored file's) replaces nothing
 *   the run did not read. A drift report does NOT change it: the model must read the file again.
 * - **Drift (§3.4).** Before each model turn `drift()` looks at every file again and returns those that changed since
 *   the daemon last looked (someone else wrote, removed or replaced them), each once. The run's own writes record their
 *   result, so they are never drift; a write that replaced an in-place change (`lostChange`) is reported as `lost`.
 * - **Keyed by the file, not the spelling.** The key is the resolved path below the root (symlinks followed, `./`,
 *   `//` and a trailing `/` gone), folded the way the platform folds names: `./a.txt` and `a.txt` are one entry. The
 *   notice shows the spelling the model used last.
 * - **Bounded.** At most `MAX_OBSERVED` files, the least recently seen dropped first; a file is hashed only when its
 *   identity, size or times moved, and at most `maxBytes` of it are read.
 * - **No content leaves.** Only the path and a fixed word go into the notice. The re-read goes through the broker's
 *   containment (WT-1) and refuses the Git directory like the broker's read guard; it is not audited because nothing of
 *   the file reaches the model.
 */

export const MAX_OBSERVED = 256;
const REMOVED = "removed";
const UNREADABLE = "unreadable";

interface Seen {
  /** The spelling the model used last (display only). */
  readonly display: string;
  /** The resolved path below the root, used to look at the file again. */
  readonly rel: string;
  /** What the run itself last saw: the only accepted `base` of a write. */
  readonly runDigest: string;
  /** What the daemon last saw (drift compares with this): a digest, `removed` or `unreadable`. */
  readonly lastDigest: string;
  /** The identity before the last look (a change during a read forces a hash next time); undefined after a write. */
  readonly stat: FileStat | undefined;
  /** A write of the run replaced someone's in-place change: reported once as `lost`. */
  readonly lost: boolean;
}

const sameStat = (a: FileStat, b: FileStat): boolean => a.id === b.id && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
const notFound = (e: unknown): boolean => e instanceof BrokerError && e.reason === "not-found";
const noGitDir = (t: ResolvedTarget): void => {
  if (t.protected?.gitDir === true) throw denied("protected-path", "the Git directory is not re-read");
};

export class ObservedFiles {
  readonly #seen = new Map<string, Seen>();
  readonly #contain: ContainDeps;
  readonly #worktreeId: string;
  readonly #maxBytes: number;
  readonly #platform: NodeJS.Platform;

  constructor(contain: ContainDeps, worktreeId: string, maxBytes: number) {
    this.#contain = contain;
    this.#worktreeId = worktreeId;
    this.#maxBytes = maxBytes;
    this.#platform = contain.platform ?? process.platform;
  }

  /** Over one real root on the node file system (tests; the binding passes its own containment). `platform` folds names as that platform does. */
  static forRoot(root: string, worktreeId: string, maxBytes: number, platform?: NodeJS.Platform): ObservedFiles {
    const entry = { id: worktreeId, root, gitDir: `${root}/.git` };
    const registry = { get: (id: string) => (id === worktreeId ? entry : undefined), repositoryRoots: () => [] };
    return new ObservedFiles({ registry, fs: nodeBrokerFs, ...(platform === undefined ? {} : { platform }) }, worktreeId, maxBytes);
  }

  get size(): number {
    return this.#seen.size;
  }

  /** The key and identity of the file at `path` now (taken BEFORE a read), or undefined when it does not resolve. */
  async locate(path: string): Promise<{ readonly key: string; readonly rel: string; readonly stat: FileStat | undefined } | undefined> {
    try {
      const t = await resolveTarget(this.#contain, this.#worktreeId, path, "upsert");
      return { key: t.realSegments.map((s) => foldName(s, this.#platform)).join("/"), rel: t.realSegments.join("/"), stat: t.before };
    } catch {
      return undefined;
    }
  }

  /** The digest the run itself last saw for the file at `path`, or undefined. */
  async seenBy(path: string): Promise<string | undefined> {
    const at = await this.locate(path);
    return at === undefined ? undefined : this.#seen.get(at.key)?.runDigest;
  }

  /** Record what the run saw (read) or wrote. `at` comes from `locate` before the action. */
  record(path: string, at: { readonly key: string; readonly rel: string; readonly stat: FileStat | undefined }, digest: string, o: { readonly wrote: boolean; readonly lost?: boolean }): void {
    this.#seen.delete(at.key);
    this.#seen.set(at.key, { display: path, rel: at.rel, runDigest: digest, lastDigest: digest, stat: o.wrote ? undefined : at.stat, lost: o.lost === true });
    if (this.#seen.size > MAX_OBSERVED) this.#seen.delete(this.#seen.keys().next().value as string);
  }

  /** Files whose content changed since the daemon last looked. Never throws: a file that cannot be judged is `unreadable`. */
  async drift(signal: AbortSignal): Promise<DriftEntry[]> {
    const out: DriftEntry[] = [];
    for (const [key, seen] of [...this.#seen]) {
      if (signal.aborted) break;
      if (seen.lost) out.push({ path: seen.display, change: "lost" });
      const now = await this.#look(seen);
      if (now.lastDigest !== seen.lastDigest) {
        const change = now.lastDigest === REMOVED ? "removed" : now.lastDigest === UNREADABLE ? "unreadable" : "changed";
        out.push({ path: seen.display, change });
      }
      if (now !== seen || seen.lost) this.#seen.set(key, { ...now, lost: false });
    }
    return out;
  }

  async #look(seen: Seen): Promise<Seen> {
    const as = (lastDigest: string, stat: FileStat | undefined): Seen => ({ ...seen, lastDigest, stat });
    let stat: FileStat | undefined;
    try {
      const t = await resolveTarget(this.#contain, this.#worktreeId, seen.rel, "read");
      noGitDir(t);
      stat = t.before;
    } catch (e) {
      return as(notFound(e) ? REMOVED : UNREADABLE, undefined);
    }
    if (stat !== undefined && seen.stat !== undefined && sameStat(stat, seen.stat)) return seen;
    try {
      return as(contentDigest(await readContained(this.#contain, this.#worktreeId, seen.rel, { maxBytes: this.#maxBytes, guard: noGitDir })), stat);
    } catch (e) {
      return as(notFound(e) ? REMOVED : UNREADABLE, undefined);
    }
  }
}
