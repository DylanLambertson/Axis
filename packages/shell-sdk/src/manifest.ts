// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The module manifest of the own shell (ADR 0011 Decision 3). OS-1 defines only the shape and its check; OS-7 adds
// the registry, lazy activation, the activation context and intents.

export interface ModuleManifest {
  /** A stable internal id, lower-case words joined by dots or hyphens (for example `axis.changes`). Never shown. */
  readonly id: string;
  /** The module's manifest format version. */
  readonly manifestVersion: 1;
}

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_ID_LENGTH = 64;

/** Problems with a manifest, empty when it is valid. Never throws, whatever the input. */
export function manifestProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["the manifest is not an object"];
  const m = value as Record<string, unknown>;
  const problems: string[] = [];
  const keys = Object.keys(m).filter((k) => k !== "id" && k !== "manifestVersion").sort();
  if (keys.length > 0) problems.push(`unknown fields: ${keys.join(", ")}`);
  if (typeof m.id !== "string" || m.id.length > MAX_ID_LENGTH || !MODULE_ID.test(m.id)) problems.push("id is not a module id");
  if (m.manifestVersion !== 1) problems.push("manifestVersion is not 1");
  return problems;
}

/** A checked, frozen manifest; throws with every problem when it is not valid. */
export function defineModule(value: unknown): ModuleManifest {
  const problems = manifestProblems(value);
  if (problems.length > 0) throw new TypeError(`invalid module manifest: ${problems.join("; ")}`);
  const m = value as ModuleManifest;
  return Object.freeze({ id: m.id, manifestVersion: m.manifestVersion });
}
