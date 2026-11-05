// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Test fixture: starts a long-lived grandchild in the same process group, records its pid, then hangs or exits.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, mode] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(child.pid));
if (mode === "exit") setTimeout(() => process.exit(0), 400);
else setInterval(() => {}, 1000);
