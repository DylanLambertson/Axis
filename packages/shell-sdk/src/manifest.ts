// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The module manifest of the own shell (ADR 0011 Decision 3). OS-1 defines only its type. The runtime check of a
// manifest belongs to the module host (OS-7), which reads untrusted input once, as a snapshot of own data properties.

export interface ModuleManifest {
  /** A stable internal id, lower-case words joined by dots or hyphens (for example `axis.changes`). Never shown. */
  readonly id: string;
  /** The module's manifest format version. */
  readonly manifestVersion: 1;
}
