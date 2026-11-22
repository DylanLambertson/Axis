# Plugin grants and the plugin policy (ticket PV-K1b)

- **Status:** built in PV-K1b (journal schema version 16, the policy's plugin branch). No contract or handler writes grants yet.
- **Date:** 2026-11-22. Decides the data and policy half of ADR 0008 decisions 4 and 6.

## 1. What is stored

- `plugin_enablement`: one row per plugin and project: enabled or not, a `generation` and a `revokes` count. A plugin starts disabled at generation 1. The row is never deleted (an uninstall is a disable plus every grant revoked), so the generation never starts over. The generation grows by exactly one on a disable or a revoke and at no other time (a trigger checks each step); OI-3 binds a plugin's challenges to it, so none survives either. At most 64 plugins per project.
- `plugin_grants`: one row per plugin, project and permission of the closed set `agents.read`, `messages.send`, `tasks.read`, `tasks.write`, `pages.read`, `pages.write`, `runs.start`, `files.read`. `net:` and `integration:` wait for ADR 0009's install rule. A grant needs the plugin's row; it may exist while the plugin is disabled (disabling keeps the grants, so enabling again needs no new grant dialog; the policy refuses while disabled). A grant never changes; revoking deletes it and bumps the generation in the same statement.
- Both tables refuse every insert verb on an existing key before any conflict clause, keep their keys fixed, check ids with the NUL-safe rules, and record `user` as the only writer.
- `journal.plugins` (`PluginGrantRecords`): `add`, `setEnabled`, `grant`, `revoke` take no actor: every write is the user's, and each appends a `journal.plugin.record` audit event with ids, a fixed field and the permission only. `state(pluginId, projectId)` is what the policy reads.

## 2. Who may write

Only the user. **PV-K1b adds no contract or handler for these writes**: the store is called by tests only. The contract methods PV-K2 adds for install, grant, revoke, enable and disable must be tier 4 (native confirmation, ADR 0003 D4) or main-owned (a dialog main draws), so neither a renderer nor a plugin can grant.

## 3. The plugin policy

- `PLUGIN_METHOD_SETS` (`daemon-host/src/policy/plugin-rules.ts`) is an allow-list: one closed set of served methods per permission, exactly ADR 0008 decision 6's table. Operations whose contract is not served yet (tasks) have an empty set.
- `RuleTablePolicy` decides a plugin connection in its own branch, never through the user rows, the web fence or a default. A call is allowed only when the method is in the set of a permission granted to this plugin in the project its connection is pinned to, and the plugin is enabled there. An unknown plugin, an ungranted method and a disabled plugin get the same refusal.
- Tier: the highest of the method's, the user row's and the set's (`axis.runs/1.start` is raised to 3). Anything that would reach 4 is refused: **a plugin cannot cause a native dialog in 4a**.
- Trust: the user row's mode applies (gated rows go through the project trust gate in the handler, PV-K1c); a recorded revoke of the view's window or of its host window refuses early.
- The deny list is a second fence: approvals, audit, providers, projects, worktrees, git, forge and events in whole; CLI run start and stop, run cancel and events, review completion, messaging Pause, Resume and settings, every agent and group write, and the user-only page operations. `checkPluginCoverage` fails the host's start when a set names an unserved, denied or tier-4 method; the policy also refuses a denied method at run time.
- Dangerous combinations (any read grant or the message-participant contribution with a `net:` origin; any integration with a `net:` origin) are data in `PLUGIN_DANGEROUS_COMBINATIONS` for PV-K2's dialogs, with no logic here.

### 3.1 Recorded points (review 1)

- **Tiers** follow ADR 0008 decision 6's table: page writes (`axis.pages/1.create`, `update`) are raised to 2, a run start to 3; every other set method's row already has the ADR's tier (a test compares each with the ADR table).
- A raw `UPDATE` of `plugin_enablement` can bump `revokes` and `generation` together without deleting a grant: harmless, it only invalidates more challenges; no writer does it.
- A plugin `axis.runs/1.start` the policy allows raises its tier-3 approval card before the closed handler refuses it. Acceptable: no plugin can resolve an approval (the deny list), and the card names the plugin once K1e opens the handler.

## 4. Handlers stay closed

Every handler still refuses any actor but the user, so a call the policy allows for a plugin ends `E_NOT_FOUND` at the handler and reaches no service (tested). Opening a handler to plugins, with `forcedScope` and the plugin quotas (OI-2, OI-4), is per-contract follow-up work.

**Hard requirements before any handler opens to plugins (K1e, K4):**

- `forcedScope` is applied first: the call is tied to the project the plugin's connection is pinned to, never to a project or workspace the request names.
- `axis.review/1.diff` takes `acknowledged`: a plugin must never acknowledge files for the commit gate. The plugin handler refuses the field (or strips it) before the service runs.
