// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-6 QA nits: the command palette and its top-bar trigger, the gallery's terminal samples that are not regions, and
// F6 moving on past two regions that share a name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandRegistry } from "@axis/ui";
import { App } from "../renderer/App.js";
import { CommandPalette } from "../renderer/components/CommandPalette.js";
import { TerminalPane } from "../renderer/components/TerminalPane.js";
import { cycleRegion } from "../renderer/frame/keyboard.js";

const count = (html: string, needle: string) => html.split(needle).length - 1;

test("the top bar opens the palette: a dialog trigger with the platform's keycaps and aria-keyshortcuts", () => {
  const other = renderToStaticMarkup(<App initialHash="" isMac={false} />);
  assert.match(other, /aria-haspopup="dialog" aria-keyshortcuts="Control\+[Kk]">Commands <span class="axis-keycaps" aria-hidden="true"><kbd class="axis-kbd">Ctrl<\/kbd><kbd class="axis-kbd">[Kk]<\/kbd>/);
  const mac = renderToStaticMarkup(<App initialHash="" isMac={true} />);
  assert.match(mac, /aria-keyshortcuts="Meta\+[Kk]">Commands <span class="axis-keycaps" aria-hidden="true"><kbd class="axis-kbd">⌘<\/kbd><kbd class="axis-kbd">[Kk]<\/kbd>/);
  assert.doesNotMatch(other, /role="dialog"/, "closed until asked");
  assert.doesNotMatch(other, /inert/, "the frame takes input while the palette is closed");
});

function registry() {
  const r = new CommandRegistry();
  r.register({ id: "axis.go.home", title: "Go to Home", run: () => {} });
  r.register({ id: "axis.region.next", title: "Focus next region", chord: "F6", run: () => {} });
  return r;
}

test("the palette: a labelled modal dialog, a combobox owning a listbox, the first option active, chords as keycaps", () => {
  const html = renderToStaticMarkup(<CommandPalette commands={registry().list()} platform="other" onClose={() => {}} onRun={() => {}} />);
  assert.match(html, /<div class="axis-palette" role="dialog" aria-modal="true" aria-label="Command palette">/);
  const input = /<input [^>]*>/.exec(html)?.[0] ?? "";
  assert.match(input, /role="combobox"/);
  assert.match(input, /aria-expanded="true"/);
  const list = /aria-controls="([^"]+)"/.exec(input)?.[1];
  const active = /aria-activedescendant="([^"]+)"/.exec(input)?.[1];
  assert.ok(list !== undefined && html.includes(`<ul id="${list}" class="axis-palette__list" role="listbox" aria-label="Commands">`), "the input controls the listbox");
  assert.ok(active !== undefined && new RegExp(`id="${active}" class="axis-palette__item" role="option" aria-selected="true"><span>Focus next region</span>`).test(html), "the first command (by title) is active");
  assert.equal(count(html, 'aria-selected="true"'), 1);
  assert.match(html, /<span>Focus next region<\/span><span class="axis-keycaps" aria-hidden="true"><kbd class="axis-kbd">F6<\/kbd><\/span>/);
  assert.match(html, /<span>Go to Home<\/span><\/li>/, "no keycaps without a chord");
  assert.match(html, /<label class="axis-sr" for="[^"]+">Command<\/label>/);
});

test("the palette with nothing to show says so and points at no option", () => {
  const html = renderToStaticMarkup(<CommandPalette commands={[]} platform="mac" onClose={() => {}} onRun={() => {}} />);
  assert.match(html, /<p class="axis-palette__empty" role="status">No command matches\.<\/p>/);
  assert.doesNotMatch(html, /aria-activedescendant/);
  assert.doesNotMatch(html, /role="option"/);
});

test("a terminal sample is neither a landmark nor an F6 region; the gallery has none", () => {
  const sample = renderToStaticMarkup(<TerminalPane state={{ kind: "unavailable" }} region={false} />);
  assert.match(sample, /^<div class="axis-terminal">/);
  assert.doesNotMatch(sample, /data-region|aria-label="Terminal"|tabindex/);
  assert.match(renderToStaticMarkup(<TerminalPane state={{ kind: "unavailable" }} />), /^<section class="axis-terminal" aria-label="Terminal" data-region="terminal" tabindex="-1">/);
  const gallery = renderToStaticMarkup(<App initialHash="#/states" isMac={false} />);
  assert.equal(count(gallery, 'data-region="terminal"'), 0);
  assert.equal(count(gallery, "data-region="), 3, "top, nav and main only");
});

/** A document of named regions; `closest` finds the region an element sits in. */
function fakeDocument(names: readonly string[], focused: number) {
  const regions = names.map((name) => {
    const el = {
      dataset: { region: name },
      tabIndex: -1,
      focused: false,
      getClientRects: () => [{}],
      offsetParent: {},
      hasAttribute: () => true,
      closest: () => el,
      focus: () => {
        for (const r of regions) r.focused = false;
        el.focused = true;
      },
    };
    return el;
  });
  const doc = {
    querySelectorAll: () => regions,
    get activeElement() {
      return regions.find((r) => r.focused) ?? null;
    },
  };
  if (focused >= 0) regions[focused]!.focus();
  return { doc: doc as unknown as Document, at: () => regions.findIndex((r) => r.focused) };
}

test("F6 moves on past two regions that share a name, both ways, and wraps", () => {
  const f = fakeDocument(["top", "terminal", "terminal", "main"], 1);
  cycleRegion(f.doc, false);
  assert.equal(f.at(), 2, "the second terminal, not the first again");
  cycleRegion(f.doc, false);
  assert.equal(f.at(), 3);
  cycleRegion(f.doc, false);
  assert.equal(f.at(), 0);
  cycleRegion(f.doc, true);
  assert.equal(f.at(), 3);
  cycleRegion(f.doc, true);
  assert.equal(f.at(), 2);
  cycleRegion(f.doc, true);
  assert.equal(f.at(), 1);
  const none = fakeDocument(["top", "main"], -1);
  cycleRegion(none.doc, true);
  assert.equal(none.at(), 1, "from nowhere Shift+F6 goes to the last");
});
