// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Main's shell-independent `window.gone` sender (PV-K2 K2-g4a): a code window's numeric id becomes its `w<n>`; nothing else is
// ever sent, and a failing target is a `false`, never a throw into main's window events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWindowGoneSender } from "../src/main/window-lifecycle.js";
import { windowIdOf } from "../src/main/connect-broker.js";

test("a destroyed or crashed window is sent as its w<n>, the same id the broker attests", () => {
  const sent: string[] = [];
  const sender = createWindowGoneSender({ windowGone: (id) => (sent.push(id), true) });
  assert.equal(sender.windowGone(7), true);
  assert.equal(sender.windowGone(0), true);
  assert.equal(sender.windowGone(9_999_999_999), true);
  assert.deepEqual(sent, [windowIdOf(7), "w0", "w9999999999"]);
});

test("anything but a whole code window id is refused before the target", () => {
  const sent: string[] = [];
  const sender = createWindowGoneSender({ windowGone: (id) => (sent.push(id), true) });
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_000_000, "3", undefined, null]) {
    assert.equal(sender.windowGone(bad as never), false, String(bad));
  }
  assert.deepEqual(sent, []);
});

test("the target's answer is passed back, and a throwing target is a false", () => {
  assert.equal(createWindowGoneSender({ windowGone: () => false }).windowGone(1), false, "a host that is not running");
  const throwing = createWindowGoneSender({
    windowGone: () => {
      throw new Error("channel closed");
    },
  });
  assert.equal(throwing.windowGone(1), false);
});
