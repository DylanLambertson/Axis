// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTES, SHADOWS, SHADOW_NAMES, TOKEN_NAMES, contrastRatio, cssVariableName, cssVariables, type Palette, type ThemeKind, type TokenName } from "../src/index.js";

const themes: ThemeKind[] = ["dark", "light"];

/** Every background a text or status role can sit on (tokens.md section 2). */
const BACKGROUNDS: TokenName[] = ["canvas", "surface", "raised", "overlay", "hover", "accent-soft", "warn-soft", "diff-add", "diff-del"];
/** Roles that are read as text: 4.5:1 on every background (SC 1.4.3). */
const TEXT_ROLES: TokenName[] = ["text", "text-secondary", "accent-text", "ok", "warn", "bad", "info"];

const ratio = (p: Palette, fg: TokenName, bg: TokenName) => contrastRatio(p[fg], p[bg]);

test("contrastRatio: the WCAG endpoints, symmetric, and rejects anything but #RRGGBB", () => {
  assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#5823F6", "#5823F6"), 1);
  assert.throws(() => contrastRatio("#FFF", "#000000"), /not a #RRGGBB colour/);
  assert.throws(() => contrastRatio("#ffffff", "#000000"), /not a #RRGGBB colour/);
  assert.throws(() => contrastRatio("#FFFFFF00", "#000000"), /not a #RRGGBB colour/);
});

test("the published figures of tokens.md section 2 are reproduced exactly", () => {
  const d = PALETTES.dark;
  const l = PALETTES.light;
  assert.equal(ratio(d, "text", "canvas").toFixed(2), "15.43");
  assert.equal(ratio(d, "accent-text", "overlay").toFixed(2), "5.03");
  assert.equal(ratio(d, "control-border", "overlay").toFixed(2), "3.34");
  assert.equal(ratio(l, "control-border", "accent-soft").toFixed(2), "3.16");
  assert.equal(ratio(l, "warn", "accent-soft").toFixed(2), "4.97");
  assert.equal(ratio(l, "info", "accent-soft").toFixed(2), "4.79");
  assert.equal(contrastRatio(d["on-accent"], d.accent).toFixed(2), "7.03");
});

test("both themes define exactly the token names, each an upper-case #RRGGBB value, frozen", () => {
  for (const t of themes) {
    assert.deepEqual(Object.keys(PALETTES[t]).sort(), [...TOKEN_NAMES].sort(), t);
    for (const name of TOKEN_NAMES) assert.match(PALETTES[t][name], /^#[0-9A-F]{6}$/, `${t}.${name}`);
    assert.ok(Object.isFrozen(PALETTES[t]) && Object.isFrozen(SHADOWS[t]), t);
    assert.deepEqual(Object.keys(SHADOWS[t]), [...SHADOW_NAMES], t);
  }
  assert.ok(Object.isFrozen(PALETTES) && Object.isFrozen(SHADOWS));
});

test("every text and status role meets 4.5:1 on every background it can sit on, in both themes", () => {
  for (const t of themes) {
    for (const fg of TEXT_ROLES) {
      for (const bg of BACKGROUNDS) {
        assert.ok(ratio(PALETTES[t], fg, bg) >= 4.5, `${t}: ${fg} on ${bg} is ${ratio(PALETTES[t], fg, bg).toFixed(2)}`);
      }
    }
  }
});

test("control boundaries and the focus ring meet 3:1 on every background (SC 1.4.11), in both themes", () => {
  for (const t of themes) {
    for (const bg of BACKGROUNDS) {
      assert.ok(ratio(PALETTES[t], "control-border", bg) >= 3, `${t}: control-border on ${bg}`);
      assert.ok(ratio(PALETTES[t], "accent-text", bg) >= 3, `${t}: focus ring on ${bg}`);
    }
  }
});

test("labels on filled controls meet 4.5:1: on-accent on accent and its hover, on-status on ok and bad", () => {
  for (const t of themes) {
    const p = PALETTES[t];
    assert.ok(ratio(p, "on-accent", "accent") >= 4.5, `${t} on-accent`);
    assert.ok(ratio(p, "on-accent", "accent-hover") >= 4.5, `${t} on-accent hover`);
    assert.ok(ratio(p, "on-status", "ok") >= 4.5, `${t} on ok`);
    assert.ok(ratio(p, "on-status", "bad") >= 4.5, `${t} on bad`);
  }
});

test("decorative borders stay below control strength, and disabled text is the faintest text role", () => {
  for (const t of themes) {
    const p = PALETTES[t];
    assert.ok(ratio(p, "border", "surface") < ratio(p, "control-border", "surface"), t);
    assert.ok(ratio(p, "text-disabled", "surface") < ratio(p, "text-secondary", "surface"), t);
  }
});

test("cssVariables: one --axis- property per colour in TOKEN_NAMES order, then the shadows, with the theme's values", () => {
  assert.equal(cssVariableName("text-secondary"), "--axis-text-secondary");
  assert.equal(cssVariableName("elev-2"), "--axis-elev-2");
  for (const t of themes) {
    const vars = cssVariables(t);
    assert.deepEqual(vars.map(([k]) => k), [...TOKEN_NAMES, ...SHADOW_NAMES].map((n) => `--axis-${n}`));
    assert.deepEqual(vars.map(([, v]) => v), [...TOKEN_NAMES.map((n) => PALETTES[t][n]), ...SHADOW_NAMES.map((n) => SHADOWS[t][n])]);
  }
  assert.notDeepEqual(cssVariables("dark"), cssVariables("light"));
});
