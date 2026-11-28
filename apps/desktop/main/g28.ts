// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// G-28 in main: the check main/entry.ts runs before any other module of main is initialised. It imports only the dependency-free
// debug-flags module, so nothing else runs first (test/entry-order.test.mjs pins that on the built bundle). It detects; the
// packaging fuses (OS-21) and the 1a/L33 launch test close G-28 (`--inspect` listens before this runs).
import { DEBUG_FLAG_EXIT, debugFlagRefusals } from "@axis/desktop-main/debug-flags";

/** A packaged build given a refused switch or environment name exits 64 and names it, never its value. True when it refused. */
export function refuseDebugging(
  facts: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string | undefined>>; readonly packaged: boolean; readonly platform: string },
  exit: (code: number) => void,
  log: (line: string) => void,
): boolean {
  const refused = debugFlagRefusals(facts.argv, facts.env, { packaged: facts.packaged, platform: facts.platform });
  if (refused.length === 0) return false;
  log(`refused debugging switches in a packaged build: ${refused.join(", ")}`);
  exit(DEBUG_FLAG_EXIT);
  return true;
}
