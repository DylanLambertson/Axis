// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * CFG-1 for `settings.get` (ticket X1c, `docs/design/main-answers.md` section 3.4): the value main answers comes from the policy,
 * application or user scope only, in that order, and is `null` when none of them sets it. The workspace, folder, in-memory and
 * default values of `IConfigurationService.inspect` are never read: a repository must not be able to choose the CLI a run
 * launches or whether hooks run, and the host applies its own default to `null`.
 */

/** The fields of upstream's `IConfigurationValue` that main may see. Only the first three are ever read. */
export interface SettingInspect {
  readonly policyValue?: unknown;
  readonly applicationValue?: unknown;
  readonly userValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
  readonly memoryValue?: unknown;
  readonly defaultValue?: unknown;
}

/** Policy, else application, else user, else `null`. */
export function userScopeValue(inspect: SettingInspect): unknown {
  for (const v of [inspect.policyValue, inspect.applicationValue, inspect.userValue]) if (v !== undefined) return v;
  return null;
}
