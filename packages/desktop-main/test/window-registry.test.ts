// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The window registry. Mutants each test kills:
//   R1 an unregistered webContents passing; R2 a frame URL compared by prefix, origin or without the query and fragment;
//   R3 a subframe passing; R4 a destroyed sender passing; R5 the checks reordered (a destroyed unregistered sender reported as
//   anything but not_app_window); R6 a window id reused after close; R7 a closed window still found by id or webContents;
//   R8 a throwing close listener stopping the others; R9 the size bound dropped; R10 a webContents registered twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_URL, WindowRegistry, type AppSender } from "../src/index.js";

const ok = (webContentsId: number, over: Partial<AppSender> = {}): AppSender => ({ webContentsId, frameUrl: APP_URL, isMainFrame: true, destroyed: false, ...over });

test("checkAppSender: the ordered window checks", () => {
  const r = new WindowRegistry();
  const w = r.add(7);
  assert.ok(w);
  assert.equal(r.checkAppSender(ok(7)), w.id);
  assert.equal(r.checkAppSender(ok(8)), "not_app_window", "R1");
  assert.equal(r.checkAppSender(ok(8, { destroyed: true, isMainFrame: false })), "not_app_window", "R5");
  assert.equal(r.checkAppSender({ ...ok(7), webContentsId: undefined }), "not_app_window");
  for (const frameUrl of [`${APP_URL}#x`, `${APP_URL}?a`, "axis-app://shell/", "axis-app://shell/other.html", "axis-app://shell/index.html/", undefined, "https://x/index.html"]) {
    assert.equal(r.checkAppSender(ok(7, { frameUrl })), "bad_frame", `R2: ${String(frameUrl)}`);
  }
  assert.equal(r.checkAppSender(ok(7, { isMainFrame: false })), "not_main_frame", "R3");
  assert.equal(r.checkAppSender(ok(7, { destroyed: true })), "destroyed", "R4");
});

test("ids are never reused, and close prunes", () => {
  const r = new WindowRegistry();
  const a = r.add(1);
  const b = r.add(2);
  assert.ok(a && b);
  assert.deepEqual([a.id, b.id], [1, 2]);
  const closed: number[] = [];
  r.onClosed(() => {
    throw new Error("boom");
  });
  const off = r.onClosed((id) => closed.push(id));
  assert.equal(r.close(a.id), true);
  assert.deepEqual(closed, [1], "R8");
  assert.equal(r.get(a.id), undefined, "R7");
  assert.equal(r.byWebContents(1), undefined, "R7");
  assert.equal(r.checkAppSender(ok(1)), "not_app_window", "R7");
  assert.equal(r.close(a.id), false);
  const c = r.add(1);
  assert.ok(c);
  assert.equal(c.id, 3, "R6");
  off();
  r.close(c.id);
  assert.deepEqual(closed, [1]);
});

test("bounds and duplicates", () => {
  const r = new WindowRegistry({ maxWindows: 2 });
  assert.ok(r.add(1));
  assert.equal(r.add(1), undefined, "R10");
  assert.ok(r.add(2));
  assert.equal(r.add(3), undefined, "R9");
  assert.equal(r.size, 2);
  for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) assert.equal(new WindowRegistry().add(bad), undefined, String(bad));
  for (const bad of [Number.NaN, 0, -1, 1.5, Infinity]) assert.throws(() => new WindowRegistry({ maxWindows: bad }), /maxWindows/, `R11: ${bad}`);
  const e = r.get(1);
  assert.ok(e);
  assert.equal(Object.isFrozen(e), true);
});
