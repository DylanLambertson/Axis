# Continuous integration

CI covers the cheap, deterministic layers on Linux and macOS. Full Code OSS builds are run manually, on a runner that is large enough (see below).

## Pull requests and pushes to `main` (`.github/workflows/ci.yml`)

| Check name | Runner | What it does |
|---|---|---|
| `Secret scan` | ubuntu-24.04 | gitleaks 8.30.1 over the full history; `git diff --check` against the PR base. |
| `Code OSS scripts (ubuntu-24.04)` | ubuntu-24.04 | shellcheck 0.11.0 on `scripts/code-oss/*.sh`, then `scripts/code-oss/test.sh` (offline, uses a fake upstream). |
| `Code OSS scripts (macos-15)` | macos-15 (arm64) | `test.sh` on `/bin/bash` 3.2. A PATH shim makes `#!/usr/bin/env bash` resolve to 3.2 for child scripts too, which catches bash 4+ constructs. See the cost note below. |
| `Extension matrix unit tests` | ubuntu-24.04 | Node from `code-oss/upstream.json` (`node`) through `actions/setup-node`; shellcheck on `test/extension-matrix/*.sh`; `node --check` on the probe; `node --test 'test/extension-matrix/tests/*.test.js'`. |
| `Axis packages` | ubuntu-24.04 | Node from `code-oss/upstream.json` through `actions/setup-node`; `npm ci --ignore-scripts`, then `npm run typecheck`, `npm run build` and `npm test` for the `packages/*` workspaces (`docs/packages.md`). Needs no Code OSS checkout. |
| `Workflow lint` | ubuntu-24.04 | actionlint 1.7.12, with the pinned shellcheck, over `.github/workflows/`. |

Rules for every workflow:

- Actions are pinned by full commit SHA, with a version comment.
- Downloaded tools are pinned and checked against their SHA-256. shellcheck is installed in one place, `.github/actions/install-shellcheck`.
- `permissions: contents: read`, `persist-credentials: false`, no repository secrets, and a timeout on every job.
- A new push to a PR cancels that PR's earlier run, whether it is running or queued. Each push to `main` gets its own concurrency group, keyed by commit SHA, so `main` runs are never cancelled or replaced by a newer push.

**Cost of the macOS job.** The repository is private and user-owned, so Actions minutes come from the account's included allowance, and macOS minutes count at about 10 times the Linux rate. `Code OSS scripts (macos-15)` runs on every PR and every push to `main`. It only runs `test.sh`, so it is short, but it still uses the most minutes of any job. If minutes get tight, move the macOS entry out of the `code-oss-scripts` matrix into a separate job or workflow triggered by `schedule` (nightly) and `workflow_dispatch`. Then remove `Code OSS scripts (macos-15)` from the required checks in the same change, or every PR will wait for a check that never reports.

`npm test` runs `scripts/test-all.mjs`, which runs every suite even after a failure and exits non-zero if any failed; `npm run gate` runs all pre-push checks (DEVELOPMENT.md section 8).

Reproduce locally (bash 3.2 on macOS; tools cached under `~/.cache/project-axis/tools/`):

```bash
shellcheck -x scripts/code-oss/*.sh test/extension-matrix/*.sh
/bin/bash scripts/code-oss/test.sh
node --test 'test/extension-matrix/tests/*.test.js'    # with Node 24.22.1
npm ci --ignore-scripts && npm run typecheck && npm test   # Axis packages, with Node 24.22.1
actionlint -shellcheck "$(command -v shellcheck)" -pyflakes=
```

## Why full builds are not in PR CI

`npm run compile` needs well over 8 GiB of RAM: upstream sets `--max-old-space-size=8192`, and the Linux compile was OOM-killed at 7.75 GiB (`docs/feasibility/code-oss-build.md` §7). Standard GitHub-hosted runners for private repositories have about 7–8 GB, so a full build cannot pass there. For now, Linux build validation runs locally in Docker with at least 12 GiB of memory, or through the manual workflow below.

## Manual full build (`.github/workflows/code-oss-build.yml`)

The workflow runs only on `workflow_dispatch`, never on PRs or pushes. It runs `fetch.sh`, `apply.sh`, `footprint.sh` and `build.sh`, then `check-artifacts` if the repository has one (M3 S1.3), and uploads `vendor/logs/` as an artifact.

- **Runner.** The required `runs-on` input has no default. Give the label of an **ephemeral** self-hosted runner: Linux x64 with at least 12 GiB of RAM. GitHub-hosted larger runners need an organization on Team or Enterprise Cloud, and this repository is owned by a user account, so they are not available. `npm ci` runs every dependency's install scripts, so never use a long-lived or shared machine. The job fails early on a runner that is not Linux x64 or has less than 12 GiB of RAM. Without a self-hosted runner, build locally in Docker with at least 12 GiB of memory (`docs/feasibility/code-oss-build.md` §7).
- **Self-hosted images** that already have the build packages can set `install-build-packages` to false (otherwise `sudo apt-get` is used).
- **Start it:** Actions tab → "Code OSS full build (manual)" → Run workflow, or `gh workflow run code-oss-build.yml -f runs-on=<label>`.

## Required status checks on `main`

Branch protection requires `Secret scan`. Once these jobs are on `main`, also require `Code OSS scripts (ubuntu-24.04)`, `Code OSS scripts (macos-15)`, `Extension matrix unit tests`, `Axis packages` and `Workflow lint`. A matrix job reports one check per matrix entry, named `<job name> (<matrix value>)`; the bare `Code OSS scripts` check no longer exists. If the matrix changes (for example, a new macOS image), update the required checks in the same PR.

**`Axis packages` should become a required check after this change merges.** Add it in the same step as the others, once its name is confirmed on a real run.

Plan for applying this after the jobs are on `main`:

1. Open a PR, or use the first push to `main`, and confirm the exact names and app on a real run: `gh api repos/DylanLambertson/Axis/commits/<sha>/check-runs --jq '.check_runs[] | [.name, .app.id] | @tsv'`. Every row should show app id 15368 (GitHub Actions).
2. Replace the required checks with all six contexts, each tied to GitHub Actions. Keep `strict` as it is now:

   ```bash
   gh api -X PATCH repos/DylanLambertson/Axis/branches/main/protection/required_status_checks --input - <<'JSON'
   {"strict": true, "checks": [
     {"context": "Secret scan", "app_id": 15368},
     {"context": "Code OSS scripts (ubuntu-24.04)", "app_id": 15368},
     {"context": "Code OSS scripts (macos-15)", "app_id": 15368},
     {"context": "Extension matrix unit tests", "app_id": 15368},
     {"context": "Axis packages", "app_id": 15368},
     {"context": "Workflow lint", "app_id": 15368}
   ]}
   JSON
   ```
