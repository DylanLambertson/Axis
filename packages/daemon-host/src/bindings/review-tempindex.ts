// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { TempIndexProvider } from "@axis/review";

/**
 * Temporary git index files for the review, one fresh file per `create()` in a directory the daemon owns and has
 * already made (its private data directory: never a worktree). `dispose()` removes the file and is safe to repeat.
 */
export function createTempIndexProvider(dir: string): TempIndexProvider {
  if (!isAbsolute(dir)) throw new RangeError("the temporary index directory must be absolute");
  return {
    async create() {
      const path = join(dir, `review-index-${randomBytes(12).toString("hex")}`);
      return { path, dispose: () => rm(path, { force: true }) };
    },
  };
}
