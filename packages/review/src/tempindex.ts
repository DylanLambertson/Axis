// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A temporary index is used by one operation at a time: two operations sharing one file could interleave read-tree, add and
// update-index and build a tree on the wrong base. The provider must give each create() its own file; a path that is
// still in use is refused here rather than trusted.
import { internal } from "./errors.js";
import type { TempIndexProvider } from "./types.js";

const live = new WeakMap<TempIndexProvider, Set<string>>();

export interface HeldIndex {
  readonly path: string;
  release(): Promise<void>;
}

export async function acquireIndex(provider: TempIndexProvider): Promise<HeldIndex> {
  const idx = await provider.create();
  let paths = live.get(provider);
  if (!paths) live.set(provider, (paths = new Set()));
  // A duplicate is not disposed: that would remove the file the other operation is using.
  if (typeof idx.path !== "string" || paths.has(idx.path)) throw internal("the temporary index provider returned a file that is still in use");
  const held = paths;
  held.add(idx.path);
  return {
    path: idx.path,
    async release() {
      held.delete(idx.path);
      try {
        await idx.dispose();
      } catch {
        /* a leftover temporary file is the provider's to clean up; it must not mask the result */
      }
    },
  };
}
