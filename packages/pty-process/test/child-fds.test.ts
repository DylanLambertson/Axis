// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { closeSync, openSync } from "node:fs";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService } from "../src/index.js";
import { channelPair, pipeSpawn, until } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

/**
 * PTY-7 child-fd test. The spawn function is the thing that decides what a child inherits, so this is a conformance test for it:
 * a shell spawned through the service sees only fds 0, 1 and 2 even while the parent holds other descriptors (a stand-in for the
 * daemon's SQLite, sockets and log files). The shipped native binding runs the same test.
 */
test("PTY-7: a spawned shell sees only stdio, although the parent holds more descriptors", { skip: process.platform === "linux" ? false : "reads /proc/<pid>/fd (Linux only)" }, async () => {
  const held = [openSync("/dev/null", "r"), openSync("/dev/null", "w")];
  const pair = channelPair();
  const svc = createPtyService({ spawn: pipeSpawn() });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  try {
    const h = await port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", 'read go; ls -l /proc/$$/fd; echo end'], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    const term = (pair.sent.b.find((m) => (m as { t: string }).t === "spawned") as { term: string }).term;
    const data = channelPair();
    svc.serveData(data.b);
    let out = "";
    data.a.onMessage((m) => void (out += (m as { chunk?: string }).chunk ?? ""));
    data.a.send({ t: "attach", term });
    await until(() => data.sent.b.length > 0);
    data.a.send({ t: "write", term, data: "go\n" });
    await until(() => out.includes("end"));
    const fds = [...out.matchAll(/(\d+) -> /g)].map((m) => m[1]).sort();
    assert.deepEqual(fds, ["0", "1", "2"]);
    void h;
  } finally {
    held.forEach(closeSync);
    svc.dispose();
    port.dispose();
  }
});
