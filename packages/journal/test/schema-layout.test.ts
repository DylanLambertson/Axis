// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The journal's migration list stays a list: every migration's SQL lives in its own module, so a new migration is a new
// module and one line here, and schema.ts never grows toward the file-length limit again (it had reached 496 lines).

const source = readFileSync(new URL("../../src/schema.ts", import.meta.url), "utf8");

test("schema.ts is only the ordered list of migrations: short, and no SQL of its own", () => {
  const lines = source.split("\n").length;
  assert.ok(lines <= 60, `schema.ts has ${lines} lines; a migration belongs in its own module`);
  assert.doesNotMatch(source, /\b(CREATE|ALTER|DROP|INSERT|UPDATE)\s+(TABLE|INDEX|TRIGGER|INTO|VIEW)\b/i, "no SQL text in schema.ts");
  assert.doesNotMatch(source, /\bversion:\s*\d+/, "no migration object is written inline");
});
