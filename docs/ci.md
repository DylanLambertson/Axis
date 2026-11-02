# Continuous integration

CI covers the cheap, deterministic layers on Linux and macOS. Full Code OSS builds are run manually, on a runner that is large enough (see below).

## Pull requests and pushes to `main` (`.github/workflows/ci.yml`)

| Check name | Runner | What it does |
|---|---|---|
| `Secret scan` | ubuntu-24.04 | gitleaks 8.30.1 over the full history; `git diff --check` against the PR base. |
| `Code OSS scripts (ubuntu-24.04)` | ubuntu-24.04 | shellcheck 0.11.0 on `scripts/code-oss/*.sh`, then `scripts/code-oss/test.sh` (offline, uses a fake upstream). |
| `Code OSS scripts (macos-15)` | macos-15 (arm64) | `test.sh` on `/bin/bash` 3.2. A PATH shim makes `#!/usr/bin/env bash` resolve to 3.2 for child scripts too, which catches bash 4+ constructs. |
| `Extension matrix unit tests` | ubuntu-24.04 | Node from `code-oss/upstream.json` (`node`) through `actions/setup-node`; shellcheck on `test/extension-matrix/*.sh`; `node --check` on the probe; `node --test 'test/extension-matrix/tests/*.test.js'`. |
| `Workflow lint` | ubuntu-24.04 | actionlint 1.7.12, with the pinned shellcheck, over `.github/workflows/`. |

Rules for every workflow:

- Actions are pinned by full commit SHA, with a version comment.
- Downloaded tools are pinned and checked against their SHA-256. shellcheck is installed in one place, `.github/actions/install-shellcheck`.
- `permissions: contents: read`, `persist-credentials: false`, no repository secrets, and a timeout on every job.
- A new push cancels the run still in progress for the same ref.

Reproduce locally (bash 3.2 on macOS; tools cached under `~/.cache/project-axis/tools/`):

```bash
shellcheck -x scripts/code-oss/*.sh test/extension-matrix/*.sh
/bin/bash scripts/code-oss/test.sh
node --test 'test/extension-matrix/tests/*.test.js'    # with Node 24.22.1
actionlint -shellcheck "$(command -v shellcheck)" -pyflakes=
```

## Why full builds are not in PR CI

`npm run compile` needs well over 8 GiB of RAM: upstream sets `--max-old-space-size=8192`, and the Linux compile was OOM-killed at 7.75 GiB (`docs/feasibility/code-oss-build.md` §7). Standard GitHub-hosted runners for private repositories have about 7–8 GB, so a full build cannot pass there. For now, Linux build validation runs locally in Docker with at least 12 GiB of memory, or through the manual workflow below.

## Manual full build (`.github/workflows/code-oss-build.yml`)

The workflow runs only on `workflow_dispatch`, never on PRs or pushes. It runs `fetch.sh`, `apply.sh`, `footprint.sh` and `build.sh`, then `check-artifacts` if the repository has one (M3 S1.3), and uploads `vendor/logs/` as an artifact.

- **Runner.** Set by the `runs-on` input; the default is `ubuntu-latest-16-cores`. That label exists only once a paid [larger runner](https://docs.github.com/en/actions/using-github-hosted-runners/using-larger-runners) with that name has been created for the account. Without one, the job waits in the queue and never starts. Alternatively, give the label of an **ephemeral** self-hosted Linux x64 runner. `npm ci` runs every dependency's install scripts, so never use a long-lived or shared machine. The job fails early on a runner that is not Linux x64 or has less than 12 GiB of RAM.
- **Self-hosted images** that already have the build packages can set `install-build-packages` to false (otherwise `sudo apt-get` is used).
- **Start it:** Actions tab → "Code OSS full build (manual)" → Run workflow, or `gh workflow run code-oss-build.yml -f runs-on=<label>`.

## Required status checks on `main`

Branch protection requires `Secret scan`. Once these jobs are on `main`, also require `Code OSS scripts (ubuntu-24.04)`, `Code OSS scripts (macos-15)`, `Extension matrix unit tests` and `Workflow lint`. A matrix job reports one check per matrix entry, named `<job name> (<matrix value>)`; the bare `Code OSS scripts` check no longer exists. If the matrix changes (for example, a new macOS image), update the required checks in the same PR.
