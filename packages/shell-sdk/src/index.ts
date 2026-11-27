// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// @axis/shell-sdk: the module manifest, activation context and intents of the own shell (types and a tiny runtime).
// OS-1 holds the manifest type only; OS-7 adds the runtime.
export type { ModuleManifest } from "./manifest.js";

/** The package's API version; OS-7 raises it with the module host. */
export const SHELL_SDK_API_VERSION = 0;
