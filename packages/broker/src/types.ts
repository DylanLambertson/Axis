// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Redactor } from "@axis/audit";

/** Risk tiers, lowest first. Compared by rank, never by number. */
export const TIERS = ["read", "write", "network", "destructive", "privileged"] as const;
export type Tier = (typeof TIERS)[number];

const RANK: ReadonlyMap<string, number> = new Map(TIERS.map((t, i) => [t, i]));

/** The tier, or undefined for anything that is not exactly one of the five names (numbers, NaN, objects, prototype keys). */
export function parseTier(value: unknown): Tier | undefined {
  return typeof value === "string" && RANK.has(value) ? (value as Tier) : undefined;
}
export function tierRank(tier: Tier): number {
  return RANK.get(tier) as number;
}
export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface RegisteredWorktree {
  readonly id: string;
  /** Canonical (realpath) root, recorded when the worktree manager registered it. */
  readonly root: string;
  /** The worktree's own git directory (outside `root` for a linked worktree). */
  readonly gitDir: string;
}

/** DMN-2: the only source of roots. Implemented by the worktree manager; faked in tests. */
export interface WorktreeRegistry {
  get(id: string): RegisteredWorktree | undefined;
  /** Canonical roots of registered repositories (the local checkouts). A worktree root may not be inside one. */
  repositoryRoots(): readonly string[];
}

export interface Clock {
  now(): number;
}

export type PathAccess = "read" | "write";
/** A path argument of a tool call, as the tool declares it. */
export interface ToolTarget {
  readonly path: string;
  readonly access: PathAccess;
}

export interface Dependencies {
  readonly platform?: NodeJS.Platform;
  readonly redactor?: Redactor;
}
