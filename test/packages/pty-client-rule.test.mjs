// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { violation } from "./imports.test.mjs";

const dir = join(fileURLToPath(new URL("../../packages/", import.meta.url)), "daemon-host");
const at = (rel) => join(dir, ...rel.split("/"));

test("PV-X1a: the daemon host imports the pty process only through its client subpath, only from the pty-control binding; tests may use the root", () => {
  assert.equal(violation("daemon-host", "@axis/pty-process/client", at("src/bindings/pty-control.ts"), dir), null);
  for (const [spec, f] of [
    ["@axis/pty-process", "src/bindings/pty-control.ts"],
    ["@axis/pty-process/client", "src/entry.ts"],
    ["@axis/pty-process/client", "src/bindings/pty-git.ts"],
    ["@axis/pty-process", "src/compose.ts"],
    ["@axis/pty-process/dist/src/exec-node.js", "src/bindings/pty-control.ts"],
  ]) {
    assert.notEqual(violation("daemon-host", spec, at(f), dir), null, `${spec} from ${f}`);
  }
  assert.notEqual(violation("daemon-host", "@axis/pty-process/client"), null, "a call without a file is judged strictly");
  assert.equal(violation("daemon-host", "@axis/pty-process", at("test/pty-process-rig.ts"), dir), null);
});
