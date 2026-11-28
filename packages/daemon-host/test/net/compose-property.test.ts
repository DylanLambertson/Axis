// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeRequest, CompositionError } from "../../src/net/compose-request.js";
import { declaredOrigins, egressTarget } from "../../src/net/host.js";
import { isMatchedTarget, matchTarget } from "../../src/net/url-pattern.js";
import { ISSUE, NAMED } from "./templates.js";

// PV-N1e property test, with FIXED seeds (logged): for random text values, a value is either refused before encoding, by an
// independent statement of the rule below, or it composes, parses (WHATWG) and matches as the identity, and one decode of
// each encoded value gives the value back. Never both, never neither.

const SEEDS = [1, 7, 42, 1337, 20261122, 0xdecafbad];
const ORIGIN = "https://api.example.com";
const DECLARED = declaredOrigins([ORIGIN]);

/** mulberry32: a small deterministic generator, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces chosen to hit the edges: separators, controls, escapes in both cases, dots, sub-delimiters, Unicode, surrogates.
const PIECES = ["%2%65", "%2%66", "%5%63", "\uff0e", "\uff0f", "\u3002", "a", "Z", "0", "-", "_", "~", ".", "..", "/", "?", "#", "\\", "%", "%2e", "%2E", "%2f", "%5C", "%3b", "%25", "%41", "%0a", "%7F", " ", "+", "&", "=", "!", "'", "(", "*", ";", ":", "@", "$", ",", "[", "]", "\t", "\n", "\r", "\u0000", "\u007f", "\u0085", "\u2028", "\u202e", "\u00e9", "e\u0301", "\ud83d\ude00", "\ud800", "\udc00", "\uff46", "\uff0e", "\ufe52", "\u0130", "\u00df", "\u00b7", "\u06d4", "\u0701", "\ua4f8"];

function expectRefused(v: string, inPath: boolean): boolean {
  const bytes = new TextEncoder().encode(v).byteLength;
  const lone = /[\ud800-\udfff]/.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
  return v === "" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(v) || /[/?#\\;]/.test(v) || v.includes("%") ||
    (inPath && (v === "." || v === ".." || /[\u00b7\u0387\u06d4\u0701\ua4f8\u2024\u2044\u2215\u2216\u29f5\u29f8\u3002\ufe52\ufe68\uff0e\uff0f\uff3c\uff61]/.test(v))) || lone || bytes > 256;
}

test("compose -> parse -> match is the identity for every accepted value, and refusal matches the rule (fixed seeds)", (t) => {
  t.diagnostic(`seeds ${SEEDS.join(",")}`);
  let accepted = 0;
  let refused = 0;
  for (const seed of SEEDS) {
    const next = rng(seed);
    for (let i = 0; i < 400; i++) {
      const n = 1 + Math.floor(next() * 6);
      const v = Array.from({ length: n }, () => PIECES[Math.floor(next() * PIECES.length)]).join("");
      for (const inPath of [true, false]) {
        const where = `seed ${seed} #${i} ${inPath ? "path" : "query"} ${JSON.stringify(v)}`;
        let c;
        try {
          c = inPath ? composeRequest(NAMED, "gh", ORIGIN, { name: v }) : composeRequest(ISSUE, "gh", ORIGIN, { owner: "o", repo: "r", number: 1, search: v });
        } catch (e) {
          assert.ok(e instanceof CompositionError, where);
          assert.ok(expectRefused(v, inPath), `${where}: refused (${e.reason}) though the rule accepts it`);
          refused++;
          continue;
        }
        assert.ok(!expectRefused(v, inPath), `${where}: composed though the rule refuses it`);
        const target = egressTarget(c.url, DECLARED);
        assert.ok(typeof target === "object", `${where}: ${String(target)}`);
        assert.equal(target.url.href, c.url, `${where}: the parser changed the URL`);
        assert.ok(isMatchedTarget(matchTarget(c, target)), where);
        const encoded = inPath ? (c.segments[1] as string) : (c.query[0]?.[1] as string);
        assert.equal(decodeURIComponent(encoded), v, `${where}: one decode gives the value back`);
        // The multi-decode invariant (review 1 SF3): a second and a third decode, strict or lenient, change nothing more, so
        // no server that decodes twice sees a separator, a dot segment or a new escape.
        const lenient = (x: string): string => x.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
        assert.equal(lenient(lenient(decodeURIComponent(encoded))), v, `${where}: decoding again changes nothing`);
        assert.ok(!/%25(?:[0-9A-F]{2})/.test(encoded) || v.includes("%"), `${where}: nothing is double-encoded`);
        accepted++;
      }
    }
  }
  t.diagnostic(`accepted ${accepted}, refused ${refused}`);
  assert.ok(accepted > 500 && refused > 500, `both sides exercised: ${accepted} accepted, ${refused} refused`);
});
