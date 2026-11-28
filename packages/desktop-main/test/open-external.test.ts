// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// EL-5. Mutants each test kills:
//   E1 a scheme other than http, https and mailto accepted (file, javascript, the app scheme, a custom scheme, data);
//   E2 a control, space, bidirectional or non-ASCII character accepted; E3 the length bound dropped; E4 credentials in an http(s)
//   URL accepted; E5 a link opened without the confirmation, or with a confirmation that shows anything but the full normalised
//   href; E6 Cancel not the default; E7 two dialogs for one window at once; E8 a link opened after the window closed;
//   E9 a confirm or open failure reported as success; E10 the URL in an event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EXTERNAL_URL, createExternalOpener, decideExternal, externalConfirmation, type ExternalConfirmation } from "../src/index.js";

test("decideExternal: schemes", () => {
  assert.deepEqual(decideExternal("https://example.com/a?b=1#c"), { ok: true, href: "https://example.com/a?b=1#c" });
  assert.deepEqual(decideExternal("HTTP://EXAMPLE.com"), { ok: true, href: "http://example.com/" }, "normalised");
  assert.deepEqual(decideExternal("mailto:someone@example.com"), { ok: true, href: "mailto:someone@example.com" });
  for (const u of ["file:///etc/passwd", "javascript:alert(1)", "axis-app://shell/index.html", "vscode://x", "ssh://h", "data:text/html,x", "ftp://h/", "blob:https://x/1"]) {
    assert.deepEqual(decideExternal(u), { ok: false, reason: "scheme" }, `E1: ${u}`);
  }
});

test("decideExternal: characters, length, credentials and hosts", () => {
  for (const u of ["https://example.com/a b", "https://example.com/\u202Eexe.txt", "https://exаmple.com/", "https://e.com/\n", "\thttps://e.com/", "https://e.com/\u0000"]) {
    assert.deepEqual(decideExternal(u), { ok: false, reason: "bad_chars" }, `E2: ${JSON.stringify(u)}`);
  }
  assert.deepEqual(decideExternal(`https://e.com/${"a".repeat(MAX_EXTERNAL_URL)}`), { ok: false, reason: "too_long" }, "E3");
  assert.equal(decideExternal(`https://e.com/${"a".repeat(MAX_EXTERNAL_URL - 20)}`).ok, true);
  assert.deepEqual(decideExternal("https://bank.example@evil.example/"), { ok: false, reason: "credentials" }, "E4");
  assert.deepEqual(decideExternal("https://u:p@evil.example/"), { ok: false, reason: "credentials" }, "E4");
  assert.deepEqual(decideExternal("mailto:"), { ok: false, reason: "no_host" });
  assert.deepEqual(decideExternal("not a url"), { ok: false, reason: "bad_chars" });
  assert.deepEqual(decideExternal("nourl"), { ok: false, reason: "bad_url" });
  for (const v of [undefined, null, 1, {}, ""]) assert.deepEqual(decideExternal(v), { ok: false, reason: "not_string" });
  assert.deepEqual(decideExternal("https://xn--80ak6aa92e.com/"), { ok: true, href: "https://xn--80ak6aa92e.com/" }, "punycode is shown as is");
});

test("externalConfirmation: the full URL, Cancel the default, no approval wording", () => {
  const c = externalConfirmation("https://example.com/x?y");
  assert.deepEqual(c, { message: "Open this link in your browser?", detail: "https://example.com/x?y", buttons: ["Cancel", "Open link"], defaultId: 0, cancelId: 0, noLink: true }, "E5/E6");
  assert.doesNotMatch(`${c.message} ${c.buttons.join(" ")}`, /approv|native|tier/i);
});

function rig(answer: (id: number, c: ExternalConfirmation) => Promise<boolean>) {
  const windows = new Set([1, 2]);
  const opened: string[] = [];
  const shown: ExternalConfirmation[] = [];
  const events: string[] = [];
  const opener = createExternalOpener({
    confirm: (id, c) => (shown.push(c), answer(id, c)),
    open: async (href) => void opened.push(href),
    isWindow: (id) => windows.has(id),
    onEvent: (e, r) => events.push(r === undefined ? e : `${e}:${r}`),
  });
  return { opener, windows, opened, shown, events };
}

test("opener: confirm first, then open exactly the shown href", async () => {
  const r = rig(async () => true);
  assert.deepEqual(await r.opener.open(1, "HTTPS://Example.com/p?q=secret-token"), { ok: true });
  assert.deepEqual(r.shown.map((c) => c.detail), ["https://example.com/p?q=secret-token"], "E5");
  assert.deepEqual(r.opened, ["https://example.com/p?q=secret-token"], "E5");
  assert.deepEqual(await r.opener.open(1, "file:///x"), { ok: false, reason: "scheme" });
  assert.equal(r.shown.length, 1, "E5: a refused link shows no dialog");
  assert.deepEqual(await r.opener.open(9, "https://e.com/"), { ok: false, reason: "no_window" });
  assert.ok(r.events.every((e) => !e.includes("secret") && !e.includes("http")), "E10");
});

test("opener: declined, busy, closed window and failures", async () => {
  const declined = rig(async () => false);
  assert.deepEqual(await declined.opener.open(1, "https://e.com/"), { ok: false, reason: "declined" });
  assert.deepEqual(declined.opened, []);

  const pending = new Map<number, (v: boolean) => void>();
  const slow = rig((id) => new Promise<boolean>((res) => void pending.set(id, res)));
  const first = slow.opener.open(1, "https://e.com/1");
  assert.deepEqual(await slow.opener.open(1, "https://e.com/2"), { ok: false, reason: "busy" }, "E7");
  const other = slow.opener.open(2, "https://e.com/3");
  slow.windows.delete(1);
  slow.opener.windowClosed(1);
  pending.get(1)?.(true);
  assert.deepEqual(await first, { ok: false, reason: "no_window" }, "E8");
  pending.get(2)?.(true);
  assert.deepEqual(await other, { ok: true });
  assert.deepEqual(slow.opened, ["https://e.com/3"]);

  const throwsConfirm = rig(async () => {
    throw new Error("x");
  });
  assert.deepEqual(await throwsConfirm.opener.open(1, "https://e.com/"), { ok: false, reason: "failed" }, "E9");
  assert.deepEqual(await throwsConfirm.opener.open(1, "https://e.com/"), { ok: false, reason: "failed" }, "the window is not left busy");
  const failing = createExternalOpener({ confirm: async () => true, open: async () => Promise.reject(new Error("x")), isWindow: () => true });
  assert.deepEqual(await failing.open(1, "https://e.com/"), { ok: false, reason: "failed" }, "E9");
  const truthy = createExternalOpener({ confirm: async () => 1 as unknown as boolean, open: async () => {}, isWindow: () => true });
  assert.deepEqual(await truthy.open(1, "https://e.com/"), { ok: false, reason: "declined" }, "only true opens");
});
