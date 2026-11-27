// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTES, TOKEN_NAMES, contrastRatio, cssVariableName, cssVariables, type ThemeKind } from "../src/index.js";

const themes: ThemeKind[] = ["dark", "light"];

test("contrastRatio: the WCAG endpoints, symmetric, and a known pair from docs/UX.md", () => {
  assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#5823F6", "#5823F6"), 1);
  // UX.md: control-border #6B7079 is 3.77:1 on the dark canvas.
  assert.equal(contrastRatio("#6B7079", "#111214").toFixed(2), "3.77");
  assert.throws(() => contrastRatio("#FFF", "#000000"), /not a #RRGGBB colour/);
  assert.throws(() => contrastRatio("#ffffff", "#000000"), /not a #RRGGBB colour/);
});

test("both themes define exactly the token names, each an upper-case #RRGGBB value", () => {
  for (const t of themes) {
    assert.deepEqual(Object.keys(PALETTES[t]).sort(), [...TOKEN_NAMES].sort(), t);
    for (const name of TOKEN_NAMES) assert.match(PALETTES[t][name], /^#[0-9A-F]{6}$/, `${t}.${name}`);
    assert.ok(Object.isFrozen(PALETTES[t]), t);
  }
});

test("text and accents meet WCAG 2.2 AA on every surface (4.5:1 text, 3:1 control boundaries)", () => {
  for (const t of themes) {
    const p = PALETTES[t];
    for (const bg of [p.canvas, p.surface, p.raised]) {
      assert.ok(contrastRatio(p.text, bg) >= 4.5, `${t} text on ${bg}`);
      assert.ok(contrastRatio(p["text-secondary"], bg) >= 4.5, `${t} secondary on ${bg}`);
      assert.ok(contrastRatio(p["accent-text"], bg) >= 4.5, `${t} accent text on ${bg}`);
      assert.ok(contrastRatio(p["control-border"], bg) >= 3, `${t} control border on ${bg}`);
    }
    assert.ok(contrastRatio(p["on-accent"], p.accent) >= 4.5, `${t} label on accent`);
  }
});

test("cssVariables: one --axis- property per token, in TOKEN_NAMES order, with the theme's value", () => {
  assert.equal(cssVariableName("text-secondary"), "--axis-text-secondary");
  for (const t of themes) {
    const vars = cssVariables(t);
    assert.deepEqual(vars.map(([k]) => k), TOKEN_NAMES.map((n) => `--axis-${n}`));
    assert.deepEqual(vars.map(([, v]) => v), TOKEN_NAMES.map((n) => PALETTES[t][n]));
  }
  assert.notDeepEqual(cssVariables("dark"), cssVariables("light"));
});
