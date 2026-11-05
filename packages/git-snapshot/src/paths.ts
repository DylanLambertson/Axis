// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { realpath } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A path value from a git config file: `~/x` is the home directory, anything else relative is under `base`. */
export function resolveUserPath(raw: string, base: string, home: string): string | null {
  if (raw.length === 0 || raw.includes("\0")) return null;
  if (raw === "~") return home;
  if (raw.startsWith("~/") || (sep === "\\" && raw.startsWith("~\\"))) return resolve(home, raw.slice(2));
  // `~user/` and `%(prefix)/` need git itself; they are reported as unresolved, never guessed.
  if (raw.startsWith("~") || raw.startsWith("%(")) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
}

const realNative = (p: string): Promise<string> =>
  new Promise((ok, fail) => realpath.native(p, (err, out) => (err === null ? ok(out) : fail(err))));

/** The real path of `p`, or of its nearest existing parent with the rest appended. */
export async function realish(p: string): Promise<string> {
  let cur = resolve(p);
  const rest: string[] = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const real = await realNative(cur);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) break;
      rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
      cur = parent;
    }
  }
  return resolve(p);
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Where `target` lies compared to the worktree roots, by lexical path and by real path (a symlink into a worktree counts). */
export async function locate(target: string, roots: readonly string[]): Promise<"in-worktree" | "outside-worktree"> {
  const real = await realish(target);
  for (const root of roots) {
    if (isWithin(resolve(root), resolve(target)) || isWithin(await realish(root), real)) return "in-worktree";
  }
  return "outside-worktree";
}

export async function samePath(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  return (await realish(a)) === (await realish(b));
}
