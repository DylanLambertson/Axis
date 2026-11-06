// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { MAX_MESSAGE_BYTES } from "@axis/protocol";
import { DEFAULT_WEB_LIMITS, isSerializedOrigin, parseWebHostConfig } from "../src/web/index.js";

const ok = { enabled: true, port: 0, allowedOrigins: ["http://127.0.0.1:5173"] };

const refused = (raw: unknown): void => {
  assert.throws(
    () => parseWebHostConfig(raw),
    (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT" && e.detail["reason"] === "web_config_invalid" && !/5173|0\.0\.0\.0|evil/.test(e.message),
    JSON.stringify(raw),
  );
};

test("web config: the defaults are loopback, four clients and the protocol frame maximum", () => {
  const c = parseWebHostConfig(ok);
  assert.equal(c.host, "127.0.0.1");
  assert.deepEqual(c.limits, DEFAULT_WEB_LIMITS);
  assert.equal(c.limits.maxClients, 4);
  assert.equal(c.limits.maxFrameBytes, MAX_MESSAGE_BYTES);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.limits) && Object.isFrozen(c.allowedOrigins));
  assert.equal(parseWebHostConfig({ ...ok, host: "::1", port: 41_000 }).host, "::1");
});

test("web config: it is opt-in only (no default, no disabled form, nothing but enabled: true)", () => {
  for (const raw of [undefined, null, {}, { ...ok, enabled: false }, { ...ok, enabled: "true" }, { ...ok, enabled: 1 }, (({ enabled: _e, ...rest }) => rest)(ok)]) refused(raw);
});

test("web config: only a loopback IP literal can be bound", () => {
  for (const host of ["0.0.0.0", "::", "localhost", "127.0.0.2", "192.168.1.10", "evil.example", "", "[::1]"]) refused({ ...ok, host });
});

test("web config: privileged and out-of-range ports are refused; 0 and 1024..65535 pass", () => {
  for (const port of [1, 80, 443, 1023, 65_536, -1, 1.5, "8080"]) refused({ ...ok, port });
  for (const port of [0, 1024, 65_535]) assert.equal(parseWebHostConfig({ ...ok, port }).port, port);
});

test("web config: origins are exact serialized http(s) origins, at least one, at most eight, no duplicates", () => {
  for (const allowedOrigins of [[], ["*"], ["null"], ["http://127.0.0.1:5173/"], ["http://127.0.0.1:5173/app"], ["http://user@127.0.0.1"], ["HTTP://127.0.0.1:5173"], ["http://127.0.0.1:80"], ["file:///x"], ["ws://127.0.0.1:1"], ["http://evil.example?x=1"], ["http://a.example", "http://a.example"], Array.from({ length: 9 }, (_, i) => `http://h${i}.example`)]) {
    refused({ ...ok, allowedOrigins });
  }
  assert.equal(isSerializedOrigin("https://app.example:8443"), true);
  assert.equal(isSerializedOrigin("https://app.example:443"), false, "a default port is not part of a serialized origin");
});

test("web config: unknown keys, hostile shapes and out-of-range limits are refused", () => {
  refused({ ...ok, token: "x" });
  refused({ ...ok, limits: { maxClients: 0 } });
  refused({ ...ok, limits: { maxClients: 17 } });
  refused({ ...ok, limits: { maxFrameBytes: MAX_MESSAGE_BYTES + 1 } });
  refused({ ...ok, limits: { maxOutboundBytes: 1 } });
  refused({ ...ok, limits: { maxChannelBacklog: 0 } });
  refused({ ...ok, limits: { other: 1 } });
  refused(JSON.parse('{"enabled":true,"port":0,"allowedOrigins":["http://127.0.0.1:5173"],"__proto__":{"x":1}}'));
  refused(new Proxy(ok, {}));
  const c = parseWebHostConfig({ ...ok, limits: { maxClients: 2, maxChannelBacklog: 8 } });
  assert.equal(c.limits.maxClients, 2);
  assert.equal(c.limits.maxChannelBacklog, 8);
  assert.equal(c.limits.maxOutboundBytes, DEFAULT_WEB_LIMITS.maxOutboundBytes);
});
