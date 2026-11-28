// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The CSP and the stable ids. Mutants each test kills:
//   C1 a directive loosened or dropped (the whole policy is pinned); C2 `'allow-duplicates'`, `*`, `'none'` or a bad character
//   accepted as a policy name; C3 a duplicate name accepted; C4 no names giving anything but `trusted-types 'none'`;
//   C5 a security header dropped; S1 the app name derived from anything but the fixed id, or equal to the data roots' `Axis`
//   on a case-insensitive file system; S2 a relative or NUL `appData` accepted; S3 the overlap check case-sensitive on macOS or
//   Windows, or blind to nesting either way; S4 a scheme privilege that bypasses the CSP, allows service workers or enables CORS;
//   S5 `isAppOrigin` accepting another host, scheme, credentials or a port.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_ORIGIN, APP_SCHEME_PRIVILEGES, APP_URL, CspError, INTERNAL_APP_NAME, appSchemeRegistration, buildCsp, isAppOrigin, securityHeaders,
  userDataDir, userDataOverlapsDataRoot,
} from "../src/index.js";

test("csp: the whole policy is pinned", () => {
  assert.equal(
    buildCsp({ trustedTypesPolicies: [] }),
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; " +
      "worker-src 'self'; child-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    "C1/C4",
  );
  assert.match(buildCsp({ trustedTypesPolicies: ["axis-shell", "editor#1"] }), /; trusted-types axis-shell editor#1$/);
});

test("csp: policy names are exact", () => {
  for (const bad of ["'allow-duplicates'", "*", "'none'", "a b", "a;b", "", "x".repeat(65), "a,b"]) {
    assert.throws(() => buildCsp({ trustedTypesPolicies: [bad] }), CspError, `C2: ${bad}`);
  }
  assert.throws(() => buildCsp({ trustedTypesPolicies: ["a", "a"] }), CspError, "C3");
  assert.throws(() => buildCsp({ trustedTypesPolicies: Array.from({ length: 17 }, (_, i) => `p${i}`) }), CspError);
  assert.throws(() => buildCsp({ trustedTypesPolicies: "a" as unknown as string[] }), CspError);
});

test("csp: every response's security headers", () => {
  assert.deepEqual(securityHeaders("X"), {
    "Content-Security-Policy": "X",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
  }, "C5");
});

test("stable ids: fixed values, never the brand", () => {
  assert.equal(APP_ORIGIN, "axis-app://shell");
  assert.equal(APP_URL, "axis-app://shell/index.html");
  assert.equal(INTERNAL_APP_NAME, "axis-shell", "S1");
  assert.notEqual(INTERNAL_APP_NAME.toLowerCase(), "axis", "S1: would be the data roots' directory on macOS");
  assert.deepEqual(appSchemeRegistration(), [{ scheme: "axis-app", privileges: APP_SCHEME_PRIVILEGES }]);
  assert.equal(APP_SCHEME_PRIVILEGES.bypassCSP, false, "S4");
  assert.equal(APP_SCHEME_PRIVILEGES.allowServiceWorkers, false, "S4");
  assert.equal(APP_SCHEME_PRIVILEGES.corsEnabled, false, "S4");
  assert.equal(APP_SCHEME_PRIVILEGES.standard && APP_SCHEME_PRIVILEGES.secure, true);
  assert.equal(Object.isFrozen(APP_SCHEME_PRIVILEGES), true);
});

test("stable ids: userData under appData, never overlapping the data roots", () => {
  assert.equal(userDataDir("/home/u/.config/", "linux"), "/home/u/.config/axis-shell");
  assert.equal(userDataDir("C:\\Users\\u\\AppData\\Roaming", "win32"), "C:\\Users\\u\\AppData\\Roaming\\axis-shell");
  for (const [p, os] of [["relative", "linux"], ["", "darwin"], ["/a\0b", "linux"], ["/unix", "win32"], ["C:rel", "win32"]] as const) {
    assert.throws(() => userDataDir(p, os), `S2: ${JSON.stringify(p)}`);
  }
  const mac = "/Users/u/Library/Application Support";
  assert.equal(userDataOverlapsDataRoot(`${mac}/axis`, `${mac}/Axis`, "darwin"), true, "S3: case-insensitive on macOS");
  assert.equal(userDataOverlapsDataRoot("C:\\X\\AXIS", "c:/x/axis", "win32"), true, "S3: case-insensitive on Windows");
  assert.equal(userDataOverlapsDataRoot("/a/Axis", "/a/axis", "linux"), false);
  assert.equal(userDataOverlapsDataRoot("/a/Axis/profile", "/a/Axis", "linux"), true, "S3: userData inside the base");
  assert.equal(userDataOverlapsDataRoot("/a", "/a/Axis", "linux"), true, "S3: the base inside userData");
  assert.equal(userDataOverlapsDataRoot("/a/Axis-shell", "/a/Axis", "linux"), false, "a shared prefix is not nesting");
  assert.equal(userDataOverlapsDataRoot(userDataDir(mac, "darwin"), `${mac}/Axis`, "darwin"), false, "S1: the real values do not overlap");
});

test("isAppOrigin", () => {
  for (const u of ["axis-app://shell", "axis-app://shell/", "axis-app://shell/index.html?x#y"]) assert.equal(isAppOrigin(u), true, u);
  for (const u of ["axis-app://other", "https://shell", "axis-app://u@shell", "axis-app://shell:1", "file:///", "", undefined, null, "nope"]) {
    assert.equal(isAppOrigin(u), false, `S5: ${String(u)}`);
  }
});
