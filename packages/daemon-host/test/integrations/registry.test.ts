// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The built-in connector registry (net-read-slice.md §2): frozen, read-only operations, valid templates and origins, a token
// shape, and result schemas that reduce to a few named fields inside the contract's result bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { originSchema, resultValueSchema } from "@axis/protocol";
import { templateProblem } from "../../src/net/compose-request.js";
import { CONNECTORS, connectorOf, operationOf, type ReadOperation } from "../../src/integrations/registry.js";

const github = CONNECTORS["github"]!;
const op = (id: string): ReadOperation => operationOf(github, id) as ReadOperation;
const PR = { number: 7, title: "Fix", state: "open", user: { login: "octo", id: 1, site_admin: false }, html_url: "https://github.com/o/r/pull/7", body: "dropped" };

test("one built-in connector, GitHub, on its one origin, bearer auth, every operation a read with a valid template", () => {
  assert.deepEqual(Object.keys(CONNECTORS), ["github"]);
  for (const c of Object.values(CONNECTORS)) {
    for (const o of c.origins) assert.ok(originSchema.safeParse(o).success, o);
    assert.equal(c.auth, "bearer");
    for (const [id, o] of Object.entries(c.operations)) {
      assert.equal(o.kind, "read", id);
      assert.equal(templateProblem(o.template), null, id);
      assert.ok(o.template.method === "GET" || o.template.method === "HEAD", id);
    }
  }
  assert.deepEqual(github.origins, ["https://api.github.com"]);
  assert.deepEqual(Object.keys(github.operations), ["pulls_list", "issue_get"]);
});

test("the registry is frozen all the way down", () => {
  assert.ok(Object.isFrozen(CONNECTORS));
  assert.ok(Object.isFrozen(github) && Object.isFrozen(github.origins) && Object.isFrozen(github.operations) && Object.isFrozen(op("pulls_list").template.path));
  assert.throws(() => ((github.origins as string[]).push("https://evil.example")));
});

test("lookups count own entries only", () => {
  for (const id of ["constructor", "__proto__", "toString", "GitHub"]) assert.equal(connectorOf(CONNECTORS, id), undefined, id);
  assert.equal(operationOf(github, "constructor"), undefined);
  assert.equal(connectorOf(CONNECTORS, "github"), github);
});

test("the token shape: 20 to 255 visible ASCII characters, never a space, a control or a line break", () => {
  for (const good of ["a".repeat(20), "x".repeat(255), String.raw`canary"T0k3n\x+y/z=Q9w-synthetic-0001`, "ghp_" + "A1".repeat(18)]) assert.ok(github.tokenShape.test(good), good);
  for (const bad of ["a".repeat(19), "x".repeat(256), `${"a".repeat(20)} b`, `${"a".repeat(20)}\n`, `${"a".repeat(20)}\r\nX-Evil: 1`, `${"a".repeat(20)}é`, `${"a".repeat(20)}\t`]) {
    assert.equal(github.tokenShape.test(bad), false, JSON.stringify(bad));
  }
});

test("pulls_list reduces each item to four named fields and drops everything else", () => {
  const r = op("pulls_list").result.safeParse([PR, { ...PR, number: 8, state: "closed" }]);
  assert.ok(r.success);
  assert.deepEqual(r.data, { items: [{ number: 7, title: "Fix", state: "open", author: "octo" }, { number: 8, title: "Fix", state: "closed", author: "octo" }] });
  assert.ok(resultValueSchema.safeParse(r.data).success, "inside the contract's result bounds");
  assert.equal(JSON.stringify(r.data).includes("dropped"), false);
});

test("issue_get reduces one object the same way", () => {
  const r = op("issue_get").result.safeParse(PR);
  assert.ok(r.success);
  assert.deepEqual(r.data, { number: 7, title: "Fix", state: "open", author: "octo" });
});

test("a response outside the schema is refused, never passed through", () => {
  const list = op("pulls_list").result;
  for (const bad of [{}, "x", [{ ...PR, state: "merged" }], [{ ...PR, title: "t".repeat(513) }], [{ ...PR, number: 0 }], [{ ...PR, number: 1.5 }], [{ ...PR, user: { login: "a b" } }], Array(101).fill(PR)]) {
    assert.equal(list.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(op("issue_get").result.safeParse([PR]).success, false);
});
