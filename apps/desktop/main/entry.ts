// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The bundle's entry (main.cjs). G-28 runs before any other module of main is initialised: main.js and everything it imports
// (the daemon host's modules among them) load only through the dynamic import below, after the check passed.
import { app } from "electron";
import { refuseDebugging } from "./g28.js";

if (!refuseDebugging({ argv: process.argv, env: process.env, packaged: app.isPackaged, platform: process.platform }, (code) => process.exit(code), (line) => process.stderr.write(`${line}\n`))) {
  import("./main.js").catch((error: unknown) => {
    process.stderr.write(`main failed to load: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
