// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit A, L2: in the production composition the plugin handlers (grant and enable's content hook) and a plugin's run start take
// the SAME project mutex, the worktrees binding's, so an increase and a start serialise as plugin-grant-contract.md section 3
// requires. A source pin, because the composition does not hand its mutex out: every mutex argument in the two registrations must
// be `worktrees.mutex`, and a fresh `new ProjectMutex()` anywhere in the file fails it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/compose-serving.ts", import.meta.url), "utf8");

/** The text of the balanced `{ … }` that starts at the first `{` at or after `from`. */
function block(text: string, from: number): string {
  const open = text.indexOf("{", from);
  assert.ok(open >= 0, "a block");
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return assert.fail("an unbalanced block");
}

const mutexesIn = (text: string): string[] => [...text.matchAll(/\bmutex:\s*([A-Za-z_.$][\w.$]*)/g)].map((m) => m[1] as string);

test("the plugin handlers and the composer runs (a plugin's start) get the same worktrees.mutex", () => {
  const plugins = block(source, source.indexOf("registerPluginsHandlers(registrar,"));
  const runs = block(source, source.indexOf("const composerRuns: ComposerRunsHandlerDeps ="));
  assert.deepEqual(mutexesIn(plugins), ["worktrees.mutex"], plugins.slice(0, 200));
  assert.deepEqual(mutexesIn(runs), ["worktrees.mutex"], runs.slice(0, 200));
  assert.doesNotMatch(source, /new\s+ProjectMutex\s*\(/, "the composition makes no project mutex of its own");
});
