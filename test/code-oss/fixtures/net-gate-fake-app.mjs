// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A stand-in for a packaged desktop build, for test/code-oss/net-gate.test.mjs. Mode (first argument):
//   clean   stays up and opens nothing;  honour  opens the port named by a debugging flag;  listen  always opens a loopback port;
//   exit    exits at once;  family  stays up with a child in its process group;  orphan  starts such a child and exits at once.
// NET_GATE_FAKE_READY (a file path) receives a line {pid} once this process is fully set up (its listener, if any, is open).
// NET_GATE_FAKE_CHILD_RECORD (a file path) receives {pid, kid}: this process and that child.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import net from "node:net";

const mode = process.argv[2];
const profile = process.argv.find((a) => a.startsWith("--user-data-dir="));
// NET_GATE_FAKE_RECORD (a file path) receives one line per start: its pid and the private profile directory it was given.
if (process.env.NET_GATE_FAKE_RECORD && profile !== undefined) {
  const dir = profile.slice("--user-data-dir=".length).replace(/[\\/][^\\/]*$/, "");
  appendFileSync(process.env.NET_GATE_FAKE_RECORD, `${JSON.stringify({ pid: process.pid, profile: dir })}\n`);
}
if (mode === "family" || mode === "orphan") {
  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.NET_GATE_FAKE_CHILD_RECORD) appendFileSync(process.env.NET_GATE_FAKE_CHILD_RECORD, `${JSON.stringify({ pid: process.pid, kid: kid.pid })}\n`);
  if (mode === "orphan") setTimeout(() => process.exit(4), 300);
}
if (mode === "exit") process.exit(3);
const flag = process.argv.slice(3).find((a) => /^--(?:remote-debugging-port|inspect(?:-brk|-extensions)?)=\d+$/.test(a));
const ready = () => { if (process.env.NET_GATE_FAKE_READY) appendFileSync(process.env.NET_GATE_FAKE_READY, `${JSON.stringify({ pid: process.pid })}\n`); };
if (mode === "honour" && flag !== undefined) net.createServer().listen(Number(flag.split("=")[1]), "127.0.0.1", ready);
else if (mode === "listen") net.createServer().listen(0, "127.0.0.1", ready);
else ready();
setInterval(() => {}, 1000);
