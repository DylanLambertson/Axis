// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// PV-N1d slice B: the egress client's test seam (a CA, a resolver and a dial map) is not reachable from production code.
// Nothing under src names the test factory or its seam except the client itself, and nothing under src imports the client
// but the composition root (none does yet: PV-N1f wires it). The import lint enforces the import edge
// (scripts/code-oss/web-rules.mjs egressClientEdgeRefusal); this test pins the names.

const src = fileURLToPath(new URL("../../../src/", import.meta.url));
const CLIENT = "net/egress-client.ts";

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.[cm]?[jt]sx?$/.test(name)) yield p;
  }
}

/** Every src file (relative, `/`-separated) whose text names `pattern`, the client itself excluded. */
export function srcFilesNaming(pattern: RegExp, root = src): string[] {
  const out: string[] = [];
  for (const f of files(root)) {
    const rel = relative(root, f).split(sep).join("/");
    if (rel !== CLIENT && pattern.test(readFileSync(f, "utf8"))) out.push(rel);
  }
  return out;
}

test("no src file but the client names the test factory or its seam", () => {
  assert.ok(readFileSync(join(src, CLIENT), "utf8").includes("createEgressClientForTest"), "the scan looks at the right file");
  assert.deepEqual(srcFilesNaming(/createEgressClientForTest|EgressTestSeam/), []);
});

test("no src file imports the egress client yet (the composition root will, in PV-N1f)", () => {
  assert.deepEqual(srcFilesNaming(/net\/egress-client(\.js)?["']|["']\.\/egress-client(\.js)?["']/), []);
});

test("the scan finds a naming file when there is one", () => {
  const fixture = fileURLToPath(new URL("../../../test/net/", import.meta.url));
  assert.ok(srcFilesNaming(/createEgressClientForTest/, fixture).includes("egress-client.test.ts"));
});
