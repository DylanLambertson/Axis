// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";

/**
 * Version 11: the run-trust record's binding (docs/design/project-registration-and-trust.md §3).
 * - `common_dir`: the canonical git common directory of the project (`realpath(<path>/.git)`), unique when set.
 * - `git_dir_id`: `<dev>:<ino>` of `<path>/.git`, so a `.git` removed and recreated at the same path is a different binding.
 * - `trust_changed_at`: when `trusted` last changed.
 * Both binding columns are set once: NULL to a value is allowed (a pre-v11 row is re-bound by the "Trust to run" dialog), any
 * other change is refused; `path` never changes. A row is trusted only with its binding (two triggers; safe on old rows,
 * which are all reset first). Every existing row loses its trust: no row was trusted through main's dialog,
 * because no writer existed before this version.
 */
export const JOURNAL_V11: Migration = {
  version: 11,
  sql: `
    ALTER TABLE projects ADD COLUMN common_dir TEXT CHECK (common_dir IS NULL OR (length(common_dir) BETWEEN 2 AND 4096
      AND instr(common_dir, char(0)) = 0));
    ALTER TABLE projects ADD COLUMN git_dir_id TEXT CHECK (git_dir_id IS NULL OR (length(git_dir_id) BETWEEN 3 AND 64
      AND git_dir_id GLOB '[0-9]*:[0-9]*' AND git_dir_id NOT GLOB '*[^0-9:]*' AND git_dir_id NOT GLOB '*:*:*'));
    ALTER TABLE projects ADD COLUMN trust_changed_at TEXT;
    UPDATE projects SET trusted = 0;
    CREATE UNIQUE INDEX projects_common_dir ON projects (common_dir) WHERE common_dir IS NOT NULL;
    CREATE TRIGGER projects_path_fixed BEFORE UPDATE OF path ON projects
      WHEN NEW.path IS NOT OLD.path
      BEGIN SELECT RAISE(ABORT, 'a project keeps its path'); END;
    CREATE TRIGGER projects_binding_once BEFORE UPDATE OF common_dir, git_dir_id ON projects
      WHEN (OLD.common_dir IS NOT NULL AND NEW.common_dir IS NOT OLD.common_dir)
        OR (OLD.git_dir_id IS NOT NULL AND NEW.git_dir_id IS NOT OLD.git_dir_id)
      BEGIN SELECT RAISE(ABORT, 'a project keeps its binding'); END;
    CREATE TRIGGER projects_trusted_bound_insert BEFORE INSERT ON projects
      WHEN NEW.trusted = 1 AND (NEW.common_dir IS NULL OR NEW.git_dir_id IS NULL)
      BEGIN SELECT RAISE(ABORT, 'a trusted project needs its binding'); END;
    CREATE TRIGGER projects_trusted_bound_update BEFORE UPDATE OF trusted, common_dir, git_dir_id ON projects
      WHEN NEW.trusted = 1 AND (NEW.common_dir IS NULL OR NEW.git_dir_id IS NULL)
      BEGIN SELECT RAISE(ABORT, 'a trusted project needs its binding'); END;
  `,
};
