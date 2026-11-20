// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A stand-in for a packaged desktop build, for test/code-oss/net-gate.test.mjs. Mode (first argument):
//   clean   stays up and opens nothing;  honour  opens the port named by a debugging flag;  listen  always opens a loopback port;
//   exit    exits at once.
import { appendFileSync } from "node:fs";
import net from "node:net";

const mode = process.argv[2];
const profile = process.argv.find((a) => a.startsWith("--user-data-dir="));
// NET_GATE_FAKE_RECORD (a file path) receives one line per start: its pid and the private profile directory it was given.
if (process.env.NET_GATE_FAKE_RECORD && profile !== undefined) {
  const dir = profile.slice("--user-data-dir=".length).replace(/[\\/][^\\/]*$/, "");
  appendFileSync(process.env.NET_GATE_FAKE_RECORD, `${JSON.stringify({ pid: process.pid, profile: dir })}\n`);
}
if (mode === "exit") process.exit(3);
const flag = process.argv.slice(3).find((a) => /^--(?:remote-debugging-port|inspect(?:-brk|-extensions)?)=\d+$/.test(a));
if (mode === "honour" && flag !== undefined) net.createServer().listen(Number(flag.split("=")[1]), "127.0.0.1");
if (mode === "listen") net.createServer().listen(0, "127.0.0.1");
setInterval(() => {}, 1000);
