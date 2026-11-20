// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A stand-in for a packaged desktop build, for test/code-oss/net-gate.test.mjs. Mode (first argument):
//   clean   stays up and opens nothing;  honour  opens the port named by a debugging flag;  listen  always opens a loopback port;
//   exit    exits at once.
import net from "node:net";

const mode = process.argv[2];
if (mode === "exit") process.exit(3);
const flag = process.argv.slice(3).find((a) => /^--(?:remote-debugging-port|inspect(?:-brk|-extensions)?)=\d+$/.test(a));
if (mode === "honour" && flag !== undefined) net.createServer().listen(Number(flag.split("=")[1]), "127.0.0.1");
if (mode === "listen") net.createServer().listen(0, "127.0.0.1");
setInterval(() => {}, 1000);
