// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Removes compiled output and incremental build state for every package, so a
// build never runs tests from sources that were deleted or renamed
// (`tsc -b --clean` leaves such orphans behind).
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(packagesDir, entry.name);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".tsbuildinfo")) rmSync(join(dir, f), { force: true });
  }
}
