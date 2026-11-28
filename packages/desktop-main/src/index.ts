// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Electron main's pure hardening modules for the desktop app (ADR 0011 Decision 2, plan ticket OS-2). Electron is injected:
// nothing here imports it, so every module runs and is tested under plain Node. `apps/desktop/main` wires them (second PR).
export * from "./stable-ids.js";
export * from "./csp.js";
export * from "./app-scheme.js";
export * from "./window-registry.js";
export * from "./web-policy.js";
export * from "./web-request-filter.js";
export * from "./open-external.js";
export * from "./debug-flags.js";
export * from "./preload-contract.js";
export * from "./fork-options.js";
