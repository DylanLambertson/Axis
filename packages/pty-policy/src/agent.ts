// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The axis.cliAgents entry schema. A command is an argv array, never a shell string.
import { isAbsolute as posixAbs } from "node:path/posix";
import { isAbsolute as winAbs } from "node:path/win32";
import { z } from "zod";
import { classifyDeniedName } from "./names.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const noNul = (s: string): boolean => !s.includes("\0");
const SHELL_META = /[;&|<>$`"'*?{}!\u0000-\u001f\u007f]/;
const BARE = /^[A-Za-z0-9._+-]+$/;

/**
 * command[0]: a bare executable name resolved on PATH, or an absolute path (nvm, asdf and similar
 * installs). It comes only from the default, user, application or machine scope; workspace and folder scopes are
 * ignored. A relative path with a separator, shell metacharacters, control characters, '..' segments and an empty
 * value are rejected.
 */
export function isAcceptableExecutable(c: string): boolean {
  if (c.length === 0 || c.length > 1024 || SHELL_META.test(c)) return false;
  if (BARE.test(c)) return c !== "." && c !== "..";
  if (!posixAbs(c) && !winAbs(c)) return false;
  return !c.split(/[\\/]+/).includes("..");
}

const argSchema = z.string().max(1024).refine(noNul, "NUL is not allowed");

export const cliAgentSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "id must be lower-case letters, digits, '.', '_' or '-'"),
  label: z
    .string()
    .min(1)
    .max(80)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "control characters are not allowed"),
  /**
   * Fixed argv prefix. command[0] is a bare executable name resolved on PATH, or an absolute path
   * (see isAcceptableExecutable). The launched argv is [...command, ...args].
   */
  command: z
    .array(argSchema)
    .min(1)
    .max(16)
    .refine((c) => isAcceptableExecutable(c[0] ?? ""), "command[0] must be a bare executable name or an absolute path"),
  args: z.array(argSchema).max(64).default([]),
  /** Extra variables copied from the source environment. A denied name is rejected. */
  envPassthrough: z
    .array(z.string().regex(ENV_NAME))
    .max(64)
    .default([])
    .refine((names) => names.every((n) => classifyDeniedName(n) === undefined), "a PTY-5 denied variable cannot be passed through"),
  /** How to detect the CLI is installed. Run with the same argv rules; never a shell string. */
  detect: z.strictObject({ args: z.array(argSchema).max(8).default(["--version"]) }).optional(),
});

export type CliAgent = z.infer<typeof cliAgentSchema>;

export const cliAgentsSchema = z
  .array(cliAgentSchema)
  .max(32)
  .refine((a) => new Set(a.map((x) => x.id)).size === a.length, "agent ids must be unique");
