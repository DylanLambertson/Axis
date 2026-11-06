// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService } from "../src/index.js";
import { channelPair, pipeSpawn, settle, until } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

/**
 * PTY-7 child-fd test. The spawn function is the thing that decides what a child inherits, so this is a conformance test for it:
 * a shell spawned through the service inherits none of the parent's other descriptors (a stand-in for the daemon's SQLite,
 * sockets and log files). The parent's descriptors point at uniquely named files, and the test looks for those names among the
 * child's descriptors. It does not count descriptors: a shell may open some of its own (a script copy, saved redirections, high
 * numbers when the runner raises the descriptor limit), and those are not inherited. The shipped native binding runs the same test.
 */
test("PTY-7: a spawned shell sees only stdio, although the parent holds more descriptors", { skip: process.platform === "linux" ? false : "reads /proc/<pid>/fd (Linux only)" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-fds-"));
  const held = [openSync(join(dir, "held-one"), "w"), openSync(join(dir, "held-two"), "w")];
  const pair = channelPair();
  const svc = createPtyService({ spawn: pipeSpawn() });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  try {
    const h = await port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", 'read go; ls -l /proc/$$/fd; echo end'], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    const term = h.terminalId;
    const data = channelPair();
    svc.serveData(data.b, "c1");
    port.grant(h.terminalId, "c1");
    await settle();
    let out = "";
    data.a.onMessage((m) => void (out += (m as { chunk?: string }).chunk ?? ""));
    data.a.send({ t: "attach", term });
    await until(() => data.sent.b.length > 0);
    data.a.send({ t: "write", term, data: "go\n" });
    await until(() => out.includes("end"));
    const fds = new Map([...out.matchAll(/(\d+) -> (\S+)/g)].map((m) => [m[1] as string, m[2] as string]));
    for (const stdio of ["0", "1", "2"]) assert.ok(fds.has(stdio), `fd ${stdio} is the child's stdio`);
    assert.ok(fds.size >= 3);
    assert.deepEqual([...fds.values()].filter((target) => target.includes("axis-fds-") || target.includes("held-")), [], "no descriptor of the parent's reached the child");
  } finally {
    held.forEach(closeSync);
    rmSync(dir, { recursive: true, force: true });
    svc.dispose();
    port.dispose();
  }
});
