// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-M7 slice 2 part 2, review 1 S1: a close that arrives while that endpoint's listener is still opening is not lost. Turning
// the user's switch off revokes every live endpoint at once, and a spawn the daemon minted just before may still be opening its
// listener in this process: the open then ends with no socket (the spawn is refused `endpoint_unavailable`), and a later open of
// another endpoint is unaffected.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEndpointHost } from "../src/index.js";
import { ManualClock, counterRandom } from "../testing/helpers.js";

const posix = process.platform !== "win32";
const skip = posix ? undefined : "Unix sockets: Windows has no messaging endpoint";
const uid = posix ? process.getuid?.() ?? -1 : -1;
const EP = `ep_${"A".repeat(43)}`;
const EP2 = `ep_${"B".repeat(43)}`;

function host(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "axep-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "d");
  const h = createEndpointHost({ dir, platform: process.platform, uid }, { send: () => true, clock: new ManualClock(), random: counterRandom() });
  t.after(() => h.closeAll());
  return { h, dir };
}
const sockets = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sock")) : []);

test("a close while the listener is opening: the open ends with no endpoint, and no socket is left", { skip }, async (t) => {
  const { h, dir } = host(t);
  const opening = h.open(EP);
  h.close(EP); // the daemon's endpoint-close, while the listen is still in flight
  assert.equal(await opening, undefined, "no endpoint: the spawn is refused");
  assert.deepEqual(sockets(dir), [], "the socket was closed and removed as soon as the listen finished");
  const other = await h.open(EP2);
  assert.ok(other !== undefined && existsSync(other), "another endpoint opens as before");
  const again = await h.open(EP);
  assert.ok(again !== undefined, "the remembered close was for that one open only");
});

test("a close after the open finished still closes as before", { skip }, async (t) => {
  const { h, dir } = host(t);
  const path = await h.open(EP);
  assert.ok(path !== undefined && existsSync(path));
  h.close(EP);
  assert.deepEqual(sockets(dir), []);
});
