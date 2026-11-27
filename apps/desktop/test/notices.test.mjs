// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, noticesFile, renderNotices, shippedPackages } from "../scripts/notices.mjs";

const lock = (packages) => ({ lockfileVersion: 3, packages: { "": { name: "root" }, ...packages } });

test("the committed THIRD-PARTY-NOTICES.txt is exactly what the lockfile and the installed packages give", () => {
  assert.equal(readFileSync(noticesFile, "utf8"), generate(), "run `npm run notices --workspace @axis/desktop`");
});

test("the committed notices carry every shipped pin, Chromium's licence file and Monaco's Apache-2.0 TypeScript", () => {
  const text = readFileSync(noticesFile, "utf8");
  for (const name of ["electron", "react", "react-dom", "monaco-editor", "@xterm/xterm"]) {
    assert.match(text, new RegExp(`^${name.replace(/[/.]/g, "\\$&")} \\d+\\.\\d+\\.\\d+ \\(`, "m"), name);
  }
  assert.match(text, /LICENSES\.chromium\.html/);
  assert.match(text, /typescript version \d/i);
  assert.doesNotMatch(text, /^esbuild \d/m, "a build tool is not shipped");
});

test("shippedPackages: production packages and the Electron runtime, never dev-only ones or workspace links", () => {
  const got = shippedPackages(
    lock({
      "node_modules/react": { version: "1.0.0", license: "MIT" },
      "node_modules/esbuild": { version: "2.0.0", dev: true },
      "node_modules/electron": { version: "3.0.0", dev: true, license: "MIT" },
      "node_modules/@axis/ui": { resolved: "packages/ui", link: true },
      "packages/ui": { version: "0.0.0" },
      "node_modules/@axis/x": { version: "0.0.0" },
      "node_modules/a/node_modules/b": { version: "4.0.0" },
      "node_modules/@s/c": { version: "5.0.0", license: "ISC" },
    }),
  );
  assert.deepEqual(got, [
    { path: "node_modules/@s/c", name: "@s/c", version: "5.0.0", license: "ISC" },
    { path: "node_modules/a/node_modules/b", name: "b", version: "4.0.0", license: "UNKNOWN" },
    { path: "node_modules/electron", name: "electron", version: "3.0.0", license: "MIT" },
    { path: "node_modules/react", name: "react", version: "1.0.0", license: "MIT" },
  ]);
  assert.throws(() => shippedPackages({ lockfileVersion: 2, packages: {} }), /lockfile version 3/);
  assert.throws(() => shippedPackages(lock({ "node_modules/x": {} })), /no version/);
});

const pkg = (name) => ({ path: `node_modules/${name}`, name, version: "1.0.0", license: "MIT" });

test("renderNotices: every licence and notice file, normalised, in name order; other files ignored", () => {
  const files = { "node_modules/a": ["README.md", "LICENSE-MPL", "LICENSE", "index.js", "NOTICE.txt", "licence.md"] };
  const text = renderNotices([pkg("a")], (p) => files[p], (p, f) => `${f} text \r\n`);
  assert.match(text, /^a 1\.0\.0 \(MIT\)$/m);
  const order = [...text.matchAll(/^--- (.+) ---$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["LICENSE", "LICENSE-MPL", "NOTICE.txt", "licence.md"]);
  assert.doesNotMatch(text, /README|index\.js|\r/);
  assert.match(text, /LICENSE text\n/);
});

test("renderNotices: fails closed on a package without a licence file and on Monaco without its TypeScript notice", () => {
  assert.throws(() => renderNotices([pkg("a")], () => ["README.md"], () => ""), /a@1\.0\.0: no licence file/);
  const monaco = pkg("monaco-editor");
  const apache = "Apache License\n                           Version 2.0, January 2004";
  assert.throws(() => renderNotices([monaco], () => ["LICENSE"], () => "MIT"), /monaco-editor@1\.0\.0: its notices do not match/);
  assert.throws(() => renderNotices([monaco], () => ["LICENSE"], () => apache), /typescript version/);
  const ok = renderNotices([monaco], () => ["ThirdPartyNotices.txt"], () => `%% typescript version 4.4.4\n${apache}`);
  assert.match(ok, /typescript version 4\.4\.4/);
});

test("renderNotices: only the Electron entry names the Chromium licence file", () => {
  const files = () => ["LICENSE"];
  assert.match(renderNotices([pkg("electron")], files, () => "MIT"), /LICENSES\.chromium\.html/);
  assert.doesNotMatch(renderNotices([pkg("react")], files, () => "MIT"), /chromium/i);
});
