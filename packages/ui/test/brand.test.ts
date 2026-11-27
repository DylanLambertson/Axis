// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND, windowTitle } from "../src/index.js";

test("the brand is frozen and names the product", () => {
  assert.ok(Object.isFrozen(BRAND));
  assert.equal(BRAND.productName, "Axis");
  assert.throws(() => {
    (BRAND as { productName: string }).productName = "Other";
  }, TypeError);
});

test("windowTitle: the page first, then the product name; the product name alone for no page or a blank one", () => {
  assert.equal(windowTitle(), BRAND.productName);
  assert.equal(windowTitle(""), BRAND.productName);
  assert.equal(windowTitle("   "), BRAND.productName);
  assert.equal(windowTitle(" demo-repo "), `demo-repo - ${BRAND.productName}`);
});
