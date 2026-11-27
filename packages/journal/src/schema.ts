// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { JOURNAL_V1_TO_V5 } from "./schema-v1-v5.js";
import { JOURNAL_V6_TO_V10 } from "./schema-v6-v10.js";
import { JOURNAL_V11 } from "./schema-v11.js";
import { AGENTS_MIGRATION } from "./schema-agents.js";
import { FORGE_PINS_MIGRATION } from "./schema-forge-pins.js";
import { PAGES_MIGRATION } from "./schema-pages.js";
import { TASKS_MIGRATION } from "./schema-tasks.js";
import { PLUGIN_GRANTS_MIGRATION } from "./schema-plugins.js";
import { PLUGIN_ISSUES_MIGRATION } from "./schema-plugin-issues.js";
import { CLI_ACK_MIGRATION } from "./schema-cli-ack.js";
import { TASKS_KEEP_USER_MIGRATION } from "./schema-tasks-keep.js";

/**
 * Journal schema, versioned in `axis_schema` under component `journal`.
 * Later migrations append to this list; they never edit an earlier entry.
 * `approvals` (docs/IMPLEMENTATION.md) arrives with the approval broker.
 */
export const JOURNAL_MIGRATIONS: readonly Migration[] = [
  ...JOURNAL_V1_TO_V5,
  ...JOURNAL_V6_TO_V10,
  JOURNAL_V11,
  AGENTS_MIGRATION,
  FORGE_PINS_MIGRATION,
  PAGES_MIGRATION,
  TASKS_MIGRATION,
  PLUGIN_GRANTS_MIGRATION,
  PLUGIN_ISSUES_MIGRATION,
  CLI_ACK_MIGRATION,
  TASKS_KEEP_USER_MIGRATION,
];

export const JOURNAL_SCHEMA_VERSION = JOURNAL_MIGRATIONS.length;
