// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EGRESS_ERROR_TEXT, EgressError, socketError } from "../../src/net/egress-errors.js";
import { BodyCollector, checkContentEncoding, checkRequestBody, EGRESS_LIMITS, IntegrationGate, jsonDepthOver, parseJsonBody, parseRetryAfter, requestHeaders } from "../../src/net/egress-limits.js";

// PV-N1d slice B: the pure caps and rate rules, with an injected clock.

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof EgressError ? e.code : `not an EgressError: ${String(e)}`;
  }
  return "no error";
};

test("the caps are ADR 0009's", () => {
  assert.deepEqual({ ...EGRESS_LIMITS }, {
    requestBytes: 1_048_576, responseBytes: 4_194_304, responseHeaderBytes: 16_384, jsonDepth: 64, firstByteMs: 10_000, totalMs: 30_000, inFlightPerIntegration: 4, maxBackoffSeconds: 900,
  });
});

test("a request body over 1 MiB is refused before sending; exactly 1 MiB is not", () => {
  assert.equal(code(() => checkRequestBody(new Uint8Array(1_048_577))), "request_too_large");
  assert.equal(code(() => checkRequestBody(new Uint8Array(1_048_576))), "no error");
  assert.equal(code(() => checkRequestBody(undefined)), "no error");
});

test("request headers: client-owned, proxy, malformed and duplicate names and non-printable values are refused", () => {
  for (const n of ["Host", "content-length", "Transfer-Encoding", "Accept-Encoding", "connection", "keep-alive", "upgrade", "TE", "trailer", "expect", "proxy-authorization", "Proxy-Connection", "proxy-anything", "bad name", "", "x:y", "é"]) {
    assert.equal(code(() => requestHeaders({ [n]: "v" })), "header_refused", n);
  }
  for (const n of ["\u212aey", "x-\u212a", "\u0130d", "\u017fet"]) assert.equal(code(() => requestHeaders({ [n]: "v" })), "header_refused", `${JSON.stringify(n)} lower-cases to ASCII`);
  for (const v of ["a\r\nX-Injected: 1", "a\nb", "a\0b", "é"]) assert.equal(code(() => requestHeaders({ "x-ok": v })), "header_refused", JSON.stringify(v));
  assert.equal(code(() => requestHeaders({ "X-A": "1", "x-a": "2" })), "header_refused", "the same name twice");
  const built = requestHeaders({ Authorization: "Bearer t", "X-Tab": "a\tb", Accept: "application/json" });
  assert.equal(Object.getPrototypeOf(built), null, "a fresh null-prototype record");
  assert.deepEqual({ ...built }, { authorization: "Bearer t", "x-tab": "a\tb", accept: "application/json" });
});

test("only identity content encoding is accepted", () => {
  for (const ok of [undefined, "identity", " Identity "]) assert.equal(code(() => checkContentEncoding(ok)), "no error", String(ok));
  for (const bad of ["gzip", "br", "deflate", "identity, gzip", "", ["identity", "gzip"]]) assert.equal(code(() => checkContentEncoding(bad)), "encoding_refused", String(bad));
});

test("the body collector fails over 4 MiB and keeps nothing; exactly 4 MiB is returned whole", () => {
  const ok = new BodyCollector();
  ok.add(Buffer.alloc(4_194_303, 1));
  ok.add(Buffer.alloc(1, 2));
  assert.equal(ok.body().byteLength, 4_194_304);
  const over = new BodyCollector();
  over.add(Buffer.alloc(4_194_304));
  assert.equal(code(() => over.add(Buffer.alloc(1))), "response_too_large");
  assert.equal(over.body().byteLength, 0, "nothing is kept, so nothing truncated can be returned");
});

test("JSON depth: 64 levels pass, 65 fail before parsing; brackets inside strings and escapes do not count", () => {
  assert.equal(jsonDepthOver("[".repeat(64) + "]".repeat(64), 64), false);
  assert.equal(jsonDepthOver("[".repeat(65) + "]".repeat(65), 64), true);
  assert.equal(jsonDepthOver(`{"a":${"{\"b\":".repeat(64)}1${"}".repeat(64)}}`, 64), true);
  assert.equal(jsonDepthOver(`["${"[".repeat(100)}"]`, 64), false, "brackets in a string");
  assert.equal(jsonDepthOver(`["\\"${"[".repeat(100)}"]`, 64), false, "an escaped quote does not end the string");
  assert.equal(jsonDepthOver(`["\\\\", ${"[".repeat(64)}${"]".repeat(64)}]`, 64), true, "an escaped backslash does end it");
  assert.equal(jsonDepthOver("[[]][[]]", 2), false, "depth goes down again");
  assert.equal(code(() => parseJsonBody(Buffer.from("[".repeat(65) + "]".repeat(65)))), "json_too_deep");
  assert.equal(code(() => parseJsonBody(Buffer.from("{nope"))), "json_invalid");
  assert.equal(code(() => parseJsonBody(Buffer.from([0x22, 0xff, 0x22]))), "json_invalid", "invalid UTF-8");
  assert.deepEqual(parseJsonBody(Buffer.from('{"a":[1,"x"]}')), { a: [1, "x"] });
});

test("Retry-After is whole seconds only, capped at 15 minutes; a date or any other form is ignored", () => {
  assert.equal(parseRetryAfter("120"), 120);
  assert.equal(parseRetryAfter(" 7 "), 7);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("900"), 900);
  assert.equal(parseRetryAfter("901"), 900);
  assert.equal(parseRetryAfter("9999999999"), 900);
  for (const bad of ["Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "-1", "+5", "1e3", "0x10", "", "12345678901", "5 s"]) assert.equal(parseRetryAfter(bad), undefined, bad);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(["5", "6"]), undefined, "a repeated header is ignored");
});

test("at most 4 in flight per integration; a release frees one slot once; integrations are separate", () => {
  const gate = new IntegrationGate(() => 0);
  const releases = [1, 2, 3, 4].map(() => gate.enter("gh"));
  assert.equal(code(() => gate.enter("gh")), "busy");
  assert.equal(code(() => gate.enter("other")), "no error");
  releases[0]!();
  releases[0]!(); // a second release of the same slot frees nothing more
  const fifth = gate.enter("gh");
  assert.equal(code(() => gate.enter("gh")), "busy");
  fifth();
  for (const r of releases.slice(1)) r();
  [1, 2, 3, 4].forEach(() => gate.enter("gh"));
  assert.equal(code(() => gate.enter("gh")), "busy");
});

test("backoff on the injected clock: Retry-After when given, else doubling from 2 s, never over 15 minutes; success resets", () => {
  let now = 1_000_000;
  const gate = new IntegrationGate(() => now);
  assert.equal(gate.backOff("gh", 120), 120);
  const err = (() => {
    try {
      gate.enter("gh");
    } catch (e) {
      return e as EgressError;
    }
    return undefined;
  })();
  assert.equal(err?.code, "rate_limited");
  assert.equal(err?.retryAfterSeconds, 120);
  now += 119_999;
  assert.equal(code(() => gate.enter("gh")), "rate_limited");
  now += 1;
  gate.enter("gh")();
  assert.equal(code(() => gate.enter("other")), "no error", "other integrations are not held back");
  assert.deepEqual([gate.backOff("x", undefined), gate.backOff("x", undefined), gate.backOff("x", undefined)], [2, 4, 8]);
  for (let i = 0; i < 20; i++) gate.backOff("y", undefined);
  assert.equal(gate.backOff("y", undefined), 900, "capped at 15 minutes");
  assert.equal(gate.backOff("y", 5000), 900, "a Retry-After over the cap is capped too");
  gate.succeeded("x");
  assert.equal(gate.backOff("x", undefined), 2, "a success resets the doubling");
});

test("errors are closed: a code, its fixed text and an integer status only", () => {
  const e = new EgressError("http_status", 502);
  assert.equal(e.message, `${EGRESS_ERROR_TEXT.http_status} (status 502)`);
  assert.equal(new EgressError("http_status", 1.5).status, undefined);
  assert.equal(new EgressError("busy").message, EGRESS_ERROR_TEXT.busy);
  assert.equal(new EgressError("rate_limited", 429, 2.5).retryAfterSeconds, undefined);
  const canary = "https://secret.example/token=CANARY";
  const mapped: Array<[string, string]> = [
    ["HPE_HEADER_OVERFLOW", "response_headers_too_large"], ["ENOTFOUND", "unresolved"], ["EAI_AGAIN", "unresolved"], ["ABORT_ERR", "aborted"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failed"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_failed"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls_failed"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_failed"], ["ERR_SSL_WRONG_VERSION_NUMBER", "tls_failed"], ["ERR_TLS_HANDSHAKE_TIMEOUT", "tls_failed"], ["ECONNREFUSED", "connect_failed"], ["", "connect_failed"],
  ];
  for (const [c, want] of mapped) {
    const out = socketError(Object.assign(new Error(`connect to ${canary}`), { code: c }));
    assert.equal(out.code, want, c);
    assert.ok(!out.message.includes("CANARY") && !String(out.stack).includes("CANARY"), c);
  }
  assert.equal(socketError("plain string").code, "connect_failed");
  const same = new EgressError("busy");
  assert.equal(socketError(same), same, "an EgressError passes through");
});
