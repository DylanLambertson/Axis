# Threat model: Phase 1 controls, gates, residual risks and register

- **Status:** Draft for review. Companion to `docs/security/threat-model-phase1.md` (the "model"), which holds the data-flow diagram and the threat tables (§1–§4). This file holds §5–§10. `docs/security/threat-model-phase0.md` is kept as history.
- **Date:** 2026-11-02.
- **Conventions:** as in the model. **Gate line** `1a/Ln` or `1b/Ln` means the n-th bullet of the "Gate (1a)" or "Gate (1b)" list in `docs/ROADMAP.md`, counted in order (listed in §5.1). **Design task** means a task id in `docs/design/axis-agent-shell.md` §8 (A, B or C). **G-n** is a gap numbered in the model or §6 below.

## 5. Control matrix: control to phase to gate

### 5.1 The ROADMAP gate lines, numbered

| Line | Gate (1a) | Line | Gate (1b) |
|---|---|---|---|
| 1a/L1 | PRODUCT scenarios 2–5 with an agent CLI; push to a local bare remote; stub `gh` arguments; compare-URL fallback | 1b/L1 | PRODUCT scenarios 1 and 6 with the mock and the Anthropic API |
| 1a/L2 | **PTY-5** environment test | 1b/L2 | **DMN-3** approval blocks; agent actor denied |
| 1a/L3 | **WT-2 (CLI side)** hook plus `core.hooksPath` flagged | 1b/L3 | **WT-1** `..`, absolute path, symlink refused |
| 1a/L4 | **WT-3** highlighting for protected paths | 1b/L4 | **WT-2 (broker side)** planted hook does not run; common-dir change fails closed |
| 1a/L5 | **DMN-2** unregistered worktree path, symlink or `..` refused | 1b/L5 | **WT-3** composer write to protected path needs approval |
| 1a/L6 | Worktree inside a registered repo refused; dirty removal refused | 1b/L6 | **PTY-4** timeout and output cap kill the process group |
| 1a/L7 | **DMN-5/DMN-6** audit events with actor; hash-chain tamper detected; no secret in logs | 1b/L7 | **DMN-5 (agents)** audit with approver identity and expiry; tamper detected |
| 1a/L8 | **Tier-4 confirmation** native dialog; replay refused | 1b/L8 | **PTY-2** broker child environment allow-list |
| 1a/L9 | Untrusted repository opens its worktree in Restricted Mode | 1b/L9 | **PRV-6** budget stop before the next request |
| 1a/L10 | Kill during a CLI run recovers from the journal | 1b/L10 | **PRV-1** `basic_text` refused or needs consent |
| 1a/L11 | Keyboard-only, all three view modes | 1b/L11 | No credential in logs, renderer state, prompts, agent env |
| 1a/L12 | Threat model revised for the new phase order | 1b/L12 | Kill during a composer run recovers |

### 5.2 Matrix

"Status": **Covered** (a gate line tests the control), **Partial** (a gate line tests part of it), **Design test only** (a design task verification exists but no ROADMAP gate line), **No test** (neither). Every Partial, Design-test-only and No-test row is a gate gap listed in §6.

| Control | Threats | Phase | Design task | Gate line | Status |
|---|---|---|---|---|---|
| PTY-5 deny-list, last, `SSH_AUTH_SOCK` kept | PTY-5, EXT-6 | 1a | B10 | 1a/L2 | Covered |
| SI-ENV after deny-list, plain terminals only; no nonce in CLI runs | PTY-6 | 1a | B10 | none | Design test only (G-14) |
| Axis pty process isolation, spawn only from daemon, attach only to issued ids | PTY-7 | 1a | B9 | none | Design test only (G-14) |
| Close-on-exec on every daemon and pty-process fd | PTY-7 | 1a | B9 (child-fd test) | none | Design test only (G-14) |
| Splits open in worktree root; OSC 633 cwd spoof | PTY-3 | 1a | B10 | none | Design test only (G-26) |
| Security-relevant `axis.*` settings pinned to application or machine scope; workspace values ignored with a warning | CFG-1 | 1a | B10 (to add) | 1a/L13 (added) | Covered once adopted (G-1 closed by decision) |
| Window-identity, frame URL and main-frame checks for daemon and pty ports | EL-3, PTY-7 | 1a | B1 | none as a gate bullet (ROADMAP "Platform" names "validation criteria 1–7") | Design test only (G-20) |
| GIT-ENV-1 for every daemon git call except commit/push | GIT-ENV-1 | 1a | B6 (hook fixture) | none for 1a (1b/L4 covers broker-run git) | Design test only (G-15) |
| GIT-SNAP-1 around CLI runs, before commit, on refresh | WT-2, GIT-SNAP-1 | 1a | B7, B10 | 1a/L3 | Partial: gate tests `hooks/` and `core.hooksPath` only; `info/attributes` filter and `core.sshCommand` fixtures are B10 (G-16) |
| GIT-SNAP-1 extensions: in-tree `core.hooksPath` target, `.git` file and `commondir`, push re-take | GIT-SNAP-1, GIT-3, GIT-4 | 1a (decided Q-6) | B7, B8 (to extend) | 1a/L14 (added) | Covered once adopted (G-4, G-5, G-6 closed by decision) |
| Commit refused on unacknowledged common-dir drift | GIT-SNAP-1, GIT-3 | 1a | B7 | none | Design test only (G-17) |
| Push explicit refspec, never mirror; terminal fallback | GIT-3, REF-1 | 1a | B8 | 1a/L1 (push reaches a bare remote) | Partial (G-17) |
| Compare URL strict host match; `gh` under PTY-5 | GIT-5 | 1a | B8 | 1a/L1 | Partial: URL correctness tested, a planted non-GitHub remote is not (G-17) |
| Snapshot refs: ignored files excluded, 50 MiB cap, never pushed, retention; secret scan of snapshot trees | REF-1 | 1a; scan 1b | B11 | 1a/L16, 1b/L13 (added) | Covered once adopted (G-18, G-7) |
| Run base per CLI run; drift ledger; restore from run base | DRF-2, DRF-3, DRF-4 | 1a | B11 | 1a/L1 (scenario 4, indirectly) | Partial (G-9, G-19) |
| Composer compare-and-swap, advisory locks, HEAD-moved notices | DRF-1, DRF-5 | 1b | C5 | none | Design test only (G-19) |
| Protected-path highlighting | WT-3 | 1a | B7 | 1a/L4 | Covered (hook directories: G-3) |
| Protected-path approval for composer | WT-3 | 1b | C2 | 1b/L5 | Covered |
| WT-1 path canonicalisation (composer) | WT-1 | 1b | C2 | 1b/L3 | Covered |
| DMN-2 registered-worktree rule | DMN-2 | 1a | B6 | 1a/L5, 1a/L6 | Partial: TOCTOU, normalisation and a worktree path that is a symlink into the local checkout are not named (G-10) |
| Workspace Trust inheritance | TRU-1, TRU-2 | 1a | A2, B6 | 1a/L9 | Partial: re-derivation at mount, external worktrees, no trust on the worktree root, CLI run in a restricted worktree (G-8, G-23) |
| Challenges and native confirmation | APR-1, APR-2, EL-4 | 1a | B4 | 1a/L8 | Partial: no test that a changed request after approval is refused (G-24) |
| Agent approval policy and UI | DMN-3 | 1b | C2, C3 | 1b/L2 | Covered |
| Audit hash chain, user and daemon actions | DMN-5 | 1a | B2 | 1a/L7 | Partial: tail truncation not tested (G-11) |
| Audit for agent approvals and tool calls | DMN-5 | 1b | C2 | 1b/L7 | Partial (G-11) |
| Redaction by field sensitivity plus pattern scanner | DMN-6 | 1a, 1b | B2, C1 | 1a/L7, 1b/L11 | Partial: canary list should include the PTY-5 environment, snapshot refs and the audit DB |
| Journal-first state, restart recovery | DMN-7 | 1a, 1b | B3 | 1a/L10, 1b/L12 | Partial: only "kill during a run"; multi-step git operations not named (G-12) |
| Broker environment allow-list | PTY-2 | 1b | C2 | 1b/L8 | Covered |
| Broker timeouts, output caps, process-group kill | PTY-4 | 1b | C2 | 1b/L6 | Covered; CLI stop (SIGINT, SIGTERM, SIGKILL) is B10 only |
| Vault backend check; no credential leakage | PRV-1, PRV-2 | 1b | C1 | 1b/L10, 1b/L11 | Covered |
| Budgets | PRV-6 | 1b | C4 | 1b/L9 | Covered |
| Anthropic adapter hardening (origin binding, no redirect follow, byte and time caps, template errors) | ANT-1 | 1b | C4 | 1b/L1 (functional only) | No test (G-21) |
| Tool-argument validation | ANT-2 | 1b | C2 | 1b/L3 for paths only | Partial |
| UI disclosure: CLI "governed by the CLI's own permissions", "can push", never "sandbox" | CLI-1, CLI-2, CLI-3 | 1a | B10, UX owner | none | No test (G-22) |
| Axis React bundle under Trusted Types; `dangerouslySetInnerHTML` lint | EL-1 | 1a | A1 and M3 | none | No test (G-25) |
| Open VSX signed, unsigned, tampered install test (public open-vsx.org) | EXT-3 | M3 Stage 1b validation | M3 | 1a/L22 (added) | Covered once adopted (G-13) |

## 6. Gate gaps

A gap is either a missing control (G-1 to G-13) or a missing ROADMAP gate line for a control the design already plans (G-14 to G-26). **Status after the lead decisions (§11.1):** G-1, G-4, G-5 and G-6 are closed by decision (the model's rows now carry the controls); G-9 and G-11 are accepted as stated; G-7 is split (1a documentation, 1b scanning); G-8 is closed by decision Q-2; G-13 is a gate. The proposed gate wording for G-3, G-10, G-12 to G-26 is now adopted in `docs/ROADMAP.md` as the gate lines named in the table below. "Closed" means the design must still implement and test it; the ROADMAP lines are the tracking.

### 6.1 Missing or under-specified controls

| Gap | Threat | Proposed fix | Proposed gate line |
|---|---|---|---|
| G-1 | CFG-1 | State the scope of `axis.cliAgents`, `axis.terminals.scrubEnvironment`, `axis.git.runHooks`, `axis.worktrees.root` as application or machine scope; ignore workspace and folder values. | 1a: a repo `.vscode/settings.json` defining a CLI agent or disabling scrubbing has no effect |
| G-2 | PTY-7 | Terminal ids unguessable and bound to the issuing connection. | B9 test extended |
| G-3 | WT-3 | Add `.husky/`, `.githooks/`, `lefthook.yml`, `.pre-commit-config.yaml` to the protected-path list. | 1a/L4 extended |
| G-4 | GIT-SNAP-1, GIT-3 | Hash the contents of an effective `core.hooksPath` that lies inside a worktree, or refuse hooks while it does. | 1a: a CLI edit to an in-tree hook is flagged before Axis commit and the hook does not run unacknowledged |
| G-5 | GIT-4 | Explicit `--git-dir`/`--work-tree` from the journal on every daemon git call; add `worktrees/<name>/{gitdir,commondir}` and the worktree `.git` file to GIT-SNAP-1. | 1a: rewriting the worktree `.git` file makes daemon git refuse |
| G-6 | GIT-3 | Re-take GIT-SNAP-1 before Axis push; refuse on unacknowledged change (a planted `url.*.insteadOf`, `remote.*.pushurl` or `credential.helper` would otherwise redirect push). | 1a: push refused after a CLI changes a remote URL |
| G-7 | REF-1 | Warn on a mirror-style remote refspec; decide on a secret-pattern scan of the snapshot tree. | 1a: snapshot excludes ignored files, skips over-cap files, no ref is pushed by an Axis push |
| G-8 | TRU-2 | Decide CLI and composer runs in a worktree whose source repository is untrusted (Q-2). | 1a: the chosen behaviour is tested |
| G-9 | DRF-4 | Run-end and commit-time diff against the run base is authoritative; the watcher only feeds the live indicator. | B11 test: dropped watcher events do not hide a change |
| G-10 | DMN-2 | Add TOCTOU swap, macOS case and Unicode normalisation, and symlinked worktree root to the DMN-2 fixtures. | 1a/L5 extended |
| G-11 | DMN-5 | Anchor the chain head outside the table so tail truncation is detected. | 1a/L7 extended: deleting the last events is detected |
| G-12 | DMN-7 | Reconcile `git worktree list --porcelain` and `refs/axis/*` with the journal at start; test kill between steps of create, remove, commit, push, discard, restore. | 1a/L10 extended |
| G-13 | EXT-3 | Run the Open VSX install test and record the result. | A new 1a line, or a pre-gate M3 acceptance |

### 6.2 Controls with a design test but no gate line

| Gap | Control | Where tested now | Proposed gate line |
|---|---|---|---|
| G-14 | SI-ENV and no-nonce rule (PTY-6); pty-process isolation and close-on-exec (PTY-7) | B9 child-fd test; B10 | 1a/L2 extended: `VSCODE_NONCE` absent in a CLI run; a spawned shell sees only stdio and its pty; a spawn on the data channel is refused |
| G-15 | GIT-ENV-1 for daemon git calls | B6 hook fixture | 1a: a hook planted in `$GIT_COMMON_DIR/hooks` does not run during worktree create, status or remove |
| G-16 | GIT-SNAP-1 full set | B10 | 1a/L3 extended with an `info/attributes` filter and a `core.sshCommand` change |
| G-17 | Commit drift gate; push refspec; compare URL host match | B7, B8 | 1a/L1 extended |
| G-18 | Snapshot ref lifecycle | B11 | See G-7 |
| G-19 | Drift scenarios (policies §3.8 scenarios 1–9) | B11, C5 | 1b: scenarios 1–6 and 8 pass; 1a: scenarios 7 and 9 pass |
| G-20 | ADR 0003 validation criteria 1–7 (window identity, envelope limits, DMN-1, DMN-2) | B1 | A 1a gate bullet; ROADMAP names them only under "Platform" |
| G-21 | Anthropic adapter hardening | C4 (contract tests only) | 1b: a redirect response, an oversized event and an error body are handled without leaking the key or following the redirect |
| G-22 | UI disclosure copy | none | 1a: launch dialog and row label show the CLI-governance and "can push" text; a text search finds no "sandbox" or "secure" in Agent-view copy |
| G-23 | Trust details | A2 | 1a/L9 extended: re-derivation at mount; external worktree not trusted; worktree root never trusted |
| G-24 | Challenge TOCTOU | B4 | 1a/L8 extended: a request altered after approval is refused |
| G-25 | EL-1 Axis bundle under Trusted Types | M3 check (Phase 0 §5.1) | Smoke test that fails on a Trusted Types violation |
| G-26 | PTY-3 cwd spoof | B10 | 1a/L2 extended |

### 6.3 Resolution after the lead decisions, and ROADMAP tracking

New gate lines were appended to the Gate (1a) and Gate (1b) lists in `docs/ROADMAP.md`, after the existing lines so that 1a/L1 to L12 and 1b/L1 to L12 keep their numbers (§5.1).

| Gap | Status | ROADMAP line |
|---|---|---|
| G-1 | Closed by decision Q-3 | 1a/L13 |
| G-2, G-14, G-26 | Gate added | 1a/L17 |
| G-3, G-16, G-17 | Gate added | 1a/L18 |
| G-4, G-5, G-6 | Closed by decision Q-6 (controls in the model's GIT-SNAP-1 and GIT-4 rows) | 1a/L14 |
| G-15 and decision Q-4 | Gate added; hooks run in the pty process context | 1a/L15 |
| G-7, G-18 | 1a documentation and snapshot lifecycle; 1b secret scan (Q-8) | 1a/L16, 1b/L13 |
| G-8, G-10, G-23 | Closed by decision Q-2; DMN-2 and trust fixtures added | 1a/L19 |
| G-11, G-12, G-24 | G-11 accepted with a tail anchor (`@axis/audit` requirement); gates added | 1a/L20 |
| G-9, G-19 | G-9 accepted; 1a scenarios 7 and 9, 1b scenarios 1 to 6 and 8 | 1a/L21, 1b/L14 |
| G-13 | Gate added (Q-7) | 1a/L22 |
| G-20, G-22, G-25 | Gate added | 1a/L23 |
| G-21 | Gate added | 1b/L15 |
| Q-4 re-evaluation | Gate added | 1b/L16 |

## 7. Honest residual risks

Each of these is accepted for Phase 1 on purpose. The wording is the wording the product should use in the UI and in docs.

1. **A CLI agent is not contained.** It runs with the user's privileges and credentials. It can push, read or write the local checkout and the home directory, plant hooks or config in the shared common dir, and reach the network. Axis **detects** common-dir changes (GIT-SNAP-1) and **reviews** worktree changes. It does not prevent the rest (CLI-1, R1, R22).
2. **A CLI can overwrite user changes, and Axis shows it but does not prevent it** (DRF-2). Recovery is the run base for 7 days. Attribution is by time window (DRF-3).
3. **Composer compare-and-swap has a one-hash, one-rename window** in which an outside writer's change can be lost (DRF-1); it is flagged and restorable.
4. **Changes outside the repository's Git directory are not detected:** global git config, `~/.ssh`, shell startup files, anything in the home directory. Only the shared common dir and the worktree are watched.
5. **Terminal I/O bypasses the daemon.** Keystrokes and CLI output do not pass through policy, audit or redaction. An extension or the renderer can answer a CLI's prompt (`sendText`, CLI-2). The audit log records the launch, not what the CLI did.
6. **Opt-out terminals and Phase 0 builds** carry `VSCODE_GIT_IPC_HANDLE` and `VSCODE_IPC_HOOK_CLI` (§4.7 of the model). Any process started there can ask the git extension for credentials. D-6 removes only the askpass variables.
7. **PTY-5 is a deny-list.** A new editor-injected variable that is not on the list reaches CLIs. The list is `VSCODE_*`, `ELECTRON_*`, `GIT_ASKPASS`, `SSH_ASKPASS*`, `GIT_EDITOR` plus extension collections, so new `VSCODE_*` names are covered by the prefix; a new non-prefixed name is not.
8. **Renderer equals user** (A10). Trust writes (TRU-1), advisory locks (DRF-5), and the approval UI are renderer-side. Only the daemon's challenge model and main's native dialog (tiers 4–5) are anchored outside it. A compromised renderer can drive the pty data port and any user-path action that has no challenge.
9. **The audit hash chain is tamper-evident for edits, not tamper-proof** against a same-UID attacker (ADR 0003 D5), and truncation is undetected until G-11.
10. **Snapshot refs may hold secrets** from untracked, non-ignored files, as ordinary git objects in the shared common dir, readable by every workspace of the project (REF-1, DMN-8).
11. **Extensions are fully trusted** (A4). The Axis policy engine does not defend against a malicious extension; Open VSX signature behaviour is still unknown (EXT-3, G-13).
12. **Hooks for Axis commit and push run with the user's credentials** in the pty process context (not the daemon, decision Q-4), while the common dir matches the acknowledged baseline. They are user-controlled code. Re-evaluated in 1b when the vault ships (GIT-3).
13. **The OS sandbox is Phase 3.** Until then no process Axis starts is contained by the OS.

## 8. Re-tag list applied (ADR 0004 implication 7)

| Item | Phase 0 tag | Phase 1 tag | Note |
|---|---|---|---|
| A8 (agents run as the OS user) | Phase 2 | **Phase 1a** | CLI agents; composer in 1b |
| PTY-1 | accepted in Phases 1–2; agents not in the pty host | **1a**: CLI runs in the Axis pty process (design), accepted while renderer equals user | Wording conflict with ADR 0004 (Q-1) |
| PTY-2 | P2 | **1b** | Broker only |
| PTY-4 | P2/P3 | **1a** CLI stop; **1b** broker caps | |
| PTY-5 | none | **1a** (new) | |
| PTY-6, PTY-7 | none | **1a** (new): SI-ENV and nonce rule; Axis pty process and close-on-exec | ADR 0004 asks for the pty process and close-on-exec to be added |
| WT-1 | P2 | **1b**, composer only | Does not constrain CLI agents |
| WT-2 | P3 | **1a** CLI-side snapshot; **1b** broker side | |
| WT-3 | P2/P3 | **1a** highlight; **1b** approval | |
| WT-4 | P3 | **1a** | Worktree manager is Phase 1 |
| DMN-2 | P1 | **1a**: includes the registered-worktree rule | |
| DMN-3 | P2 | **1b**; mechanism in **1a** | Challenges built in 1a (B4) |
| DMN-5 | P2 | **1a** user and daemon actions; **1b** agents | |
| DMN-6, DMN-7 | P2 | **1a** | |
| DMN-8 | P2/P4 | **1a** | |
| EL-4 | P2 | **1a** native dialog; **1b** agent UI | |
| EXT-2 | P1–P2 | **1a** | New 1a actions must not be commands |
| EXT-4 | P2 | **1b** | Vault |
| PRV-1, PRV-2, PRV-4, PRV-6 | P2 | **1b** | |
| PRV-3 interim labelling | P2 | **1b** | Vault ships in 1b |
| PRV-5 | P2 | **1b**, only if custom endpoints ship | |
| New: GIT-ENV-1, GIT-SNAP-1, GIT-3 to GIT-6, REF-1 | none | **1a** (REF-1 secret scan **1b**) | |
| New: CLI-1 to CLI-3, CFG-1, TRU-1, TRU-2, DRF-1 to DRF-5, APR-1, APR-2 | none | **1a** (DRF-1 **1b**) | |
| New: ANT-1, ANT-2 | none | **1b** | |
| **Not in the ADR list, accepted (Q-5):** WEB-1 to WEB-6 | P1 | **P2** | Browser skeleton moved to Phase 2 (ADR 0004, ROADMAP) |
| **Proposed, not in the ADR list:** EL-5 (`openExternal` confirmation) | P2 | **1a** | CLI output contains links (PTY-3 control 4) |
| **Not in the ADR list, decided (Q-7):** EXT-3 Open VSX test | P0/P1 | **1a gate line** (1a/L22), run in the M3 Stage 1b validation | Public open-vsx.org |

## 9. Updated risk register

Likelihood (L) and impact (I) on a 1–3 scale, score = L × I, as Phase 0 §6. Scores assume the planned controls as written, and note where closing a gap changes them. "Owner phase" is the phase that delivers the primary control. Phase 0 ids R1–R21 are kept; R22 onward are new.

| Rank | ID | Risk | Threats | L | I | Score | Owner phase |
|---|---|---|---|---|---|---|---|
| 1 | R1 | Agent commands run with the user's privileges; a worktree is not a sandbox. | CLI-1, PTY-1, PTY-4 | 3 | 3 | 9 | 1a disclosure and review; 1b broker; P3 OS sandbox |
| 2 | R22 | CLI agents are unbrokered and hold the user's credentials: push, local checkout, home directory, network. Detected only where Axis looks. | CLI-1, CLI-2, GIT-3 | 3 | 3 | 9 | 1a (disclosure, snapshot, review); P3 |
| 3 | R2 | Prompt injection from the repo or tool output causes exfiltration or persistence. Applies to composer and to CLIs. | WT-3, PRV-4, ANT-2, EL-1, PTY-3 | 3 | 3 | 9 | 1b (policy, protected paths); CLI: none beyond review |
| 4 | R7 | Shared common-dir persistence: planted hooks and config; in-tree `core.hooksPath`; worktree `.git` redirection; planted remote or credential helper before push. Mitigated by the extended GIT-SNAP-1, explicit `--git-dir`, and the push re-take (decisions Q-6). Detection only: changes outside the Git directory are not seen. | WT-2, GIT-SNAP-1, GIT-3, GIT-4 | 2 | 3 | 6 (was 9) | 1a (CLI snapshot); 1b (broker) |
| 5 | R23 | A CLI overwrites user or composer changes; attribution is by time window. | DRF-2, DRF-3, DRF-4 | 3 | 2 | 6 | 1a |
| 6 | R3 | Provider credentials exposed through renderer-reachable channels, environment, logs or Linux basic storage. | EXT-4, PRV-1, PRV-2, PTY-2, DMN-6 | 2 | 3 | 6 | 1b |
| 7 | R4 | Confused deputy into Axis services from extensions, webviews, a compromised renderer or an auxiliary window. | EXT-2, EL-2, EL-3, DMN-2 | 2 | 3 | 6 | 1a (ADR 0003) |
| 8 | R5 | Self-granted or forged approvals; challenge TOCTOU. | EL-4, DMN-3, APR-1, APR-2 | 2 | 3 | 6 | 1a (mechanism); 1b (agents) |
| 9 | R6 | Malicious or compromised Open VSX extension; signature semantics unknown. Public open-vsx.org in Phase 0/1 (Q-7); install test is now a 1a gate line (1a/L22). | EXT-1, EXT-3 | 2 | 3 | 6 | 1a gate; P4 allow-list |
| 10 | R24 | Repo-supplied settings weaken Axis (CLI command, scrubbing off). Closed by decision Q-3: application or machine scope only, workspace values ignored with a warning. Residual: implementation and test (1a/L13). | CFG-1 | 1 | 3 | 3 (was 6) | 1a |
| 11 | R8 | Upstream, Electron or Chromium patch lag. | EL-7, SC-6, SC-2 | 2 | 3 | 6 | P1 process |
| 12 | R9 | npm and build supply chain. | SC-1, SC-3, SC-5 | 2 | 3 | 6 | P1 CI; P6 |
| 13 | R25 | Hooks and credential helpers for Axis commit and push run with the user's credentials. Decision Q-4 moves them out of the daemon into the pty process context, which holds no secrets; re-evaluated in 1b when the vault ships. | GIT-3 | 2 | 2 | 4 (was 6) | 1a; 1b re-evaluation |
| 14 | R11 | MCP stdio auto-start, tool poisoning. | MCP-1, MCP-2 | 3 | 2 | 6 | P4 |
| 15 | R26 | Snapshot refs hold secrets from untracked, non-ignored files; mirror push publishes them. 1a documents the exposure; 1b adds secret scanning of snapshot trees (decision Q-8). | REF-1, DMN-8 | 2 | 2 | 4 (2 once the 1b scan ships) | 1a doc; 1b scan |
| 16 | R27 | Audit gaps: tail truncation; terminal I/O unaudited; redaction misses new sinks. | DMN-5, DMN-6 | 2 | 2 | 4 | 1a/1b (G-11) |
| 17 | R28 | Anthropic adapter: hostile or malformed stream, key in errors or redirects, oversized responses, prompts sent without clear consent. | ANT-1, PRV-4 | 2 | 2 | 4 | 1b |
| 18 | R29 | Workspace Trust inheritance wrong or stale. Decision Q-2: no run in a worktree of an untrusted repository; trust re-derived at mount and at run start. | TRU-1, TRU-2 | 1 | 2 | 2 (was 4) | 1a |
| 19 | R30 | Pty-process or daemon fd leak into children; pty attach to a foreign terminal id. | PTY-7 | 1 | 3 | 3 | 1a |
| 20 | R31 | Journal inconsistencies after a kill mid-operation: orphan worktrees, stale locks, half-written refs. | DMN-7 | 2 | 2 | 4 | 1a (G-12) |
| 21 | R13 | Inherited unused privileged surfaces (agent host, MCP gateway, renderer-chosen utility modules). | DMN-4, MCP-4, SC-3 | 2 | 2 | 4 | P1 (ADR 0002 decision 6) |
| 22 | R14 | SSRF and egress through custom provider URLs and remote MCP. | PRV-5, MCP-3 | 2 | 2 | 4 | 1b if custom endpoints ship; P4 |
| 23 | R15 | `ELECTRON_RUN_AS_NODE` reuses Axis keychain and TCC grants. | PRV-3 | 2 | 2 | 4 | P6 (1b interim labelling) |
| 24 | R16 | Protocol-handler abuse through `openExternal`. | EL-5, EL-6, GIT-5 | 2 | 2 | 4 | 1a |
| 25 | R18 | Resource exhaustion and cost runaway. | PTY-4, PRV-6, DMN-7 | 2 | 2 | 4 | 1b; P3 |
| 26 | R10 | reh-web exposure: token readable by script, no TLS by default, weaker CSP. | WEB-1 to WEB-5 | 1 | 3 | 3 | P2 (browser skeleton), P5 gateway. Lowered from 6 because the web build is not exposed in Phase 1 |
| 27 | R12 | Web webviews from a third-party CDN by fallback. | WEB-4 | 2 | 2 | 4 | P2 (moved from P1) |
| 28 | R19 | Cross-workspace leakage in daemon state or index. | DMN-8 | 2 | 2 | 4 | 1a / P4 |
| 29 | R20 | Unsigned update channel once enabled. | SC-4 | 1 | 3 | 3 | P6 |
| 30 | R21 | Terminal escape-sequence spoofing (now includes cwd steering of splits). | PTY-3 | 2 | 2 | 4 | 1a. Impact raised from 1: the Axis shell reads CLI output for status |

R17 (audit and redaction gaps) is merged into R27. Scores of R6, R7, R24, R25, R26 and R29 reflect the lead decisions of §11.1 (the rows say so); the ranks are not re-sorted and the largest scores are unchanged. Changes from the Phase 0 register: R1, R2, R5 (owner phase 1a), R7 (likelihood 2 to 3 and owner phase P3 to 1a), R10, R12 (lowered or re-tagged because the web build moves to Phase 2), R21 (impact), and the new R22 to R31.

## 10. Test categories for the new controls

The categories are those of Phase 0 §7. Ideas for the rows the model adds:

| Category | New threats | Test ideas |
|---|---|---|
| SIT | PTY-7, EXT-3, CFG-1 | A shell spawned by the pty process lists open fds and sees only stdio and its pty; a spawn sent on the data channel is refused; a repo `.vscode/settings.json` that defines a CLI agent or disables scrubbing is ignored; Open VSX signed, unsigned and tampered installs. |
| CI | GIT-ENV-1, GIT-3, GIT-4, GIT-5, CFG-1 | Daemon git with a planted hook and a planted `core.fsmonitor`; a rewritten worktree `.git` file; a remote named `github.com.evil.example`; a CLI command that is not on `PATH`. |
| PE | PTY-7, TRU-1, APR-1, APR-2, EXT-2 | A foreign terminal id on the data channel; an altered request after approval; a test extension invoking every Axis command and `sendText` on a CLI terminal (expected: possible, and documented). |
| SR | PTY-5, PTY-6, REF-1, ANT-1 | Canary secrets: dump the CLI run environment, the audit DB, snapshot refs, logs, and the Anthropic request capture; assert `VSCODE_NONCE` absent in CLI runs; an error response body that echoes the key is not logged. |
| PI | CLI-3, PTY-3, ANT-2 | A CLI output stream that sets OSC 633 `Cwd=` and BEL; assert the split opens in the worktree root and status does not claim "waiting". |
| RC | DRF-1 to DRF-5, DMN-7, APR-1 | Policies §3.8 scenarios 1–9; dropped watcher events; kill between steps of create, remove, commit, push; concurrent challenge resolution. |
| PT | DMN-2 | A TOCTOU swap between resolve and use; a symlinked worktree root into the local checkout; case and normalisation variants on macOS. |
| SSRF | ANT-1, GIT-5 | A redirect from the provider endpoint is not followed and the key is not sent to the target; a planted remote host is refused for compare URLs. |

## 11. Decisions and remaining doc-fix items

### 11.1 Decisions on the open questions (lead, 2026-11-02)

| Q | Decision | Effect |
|---|---|---|
| Q-1 | The design wins: CLI runs use the separate Axis pty utility process. | PTY-1 row updated; the ADR 0004 wording is a doc-fix item (§11.2). |
| Q-2 | No CLI or agent run in a worktree whose source repository is untrusted. Restricted Mode shows the workspace read-only with a "Trust to run" action. | TRU-2 row; closes G-8. |
| Q-3 | `axis.cliAgents`, `axis.terminals.scrubEnvironment`, `axis.git.runHooks`, `axis.worktrees.root`: application or machine scope only; workspace and folder values ignored, with a warning. | CFG-1 closed; closes G-1. |
| Q-4 | Hooks for Axis-initiated commit and push run in the pty process context (no secrets), never in the daemon. `runHooks` stays on in 1a; re-evaluated in 1b when the vault ships. | GIT-3 row; R25. |
| Q-5 | The WEB-* P1 to P2 retag is accepted. | §8. |
| Q-6 | Push re-takes GIT-SNAP-1 and refuses on unacknowledged drift. GIT-SNAP-1 also covers the worktree `.git` file, `commondir`, and any `core.hooksPath` target inside the worktree. | Closes G-4, G-5, G-6. |
| Q-7 | Phase 0 and 1 use public open-vsx.org. The install test runs in the M3 Stage 1b validation and is a gate. | EXT-3 row; 1a/L22. |
| Q-8 | 1a documents the snapshot exposure; 1b adds secret scanning of snapshots as a gate. | REF-1 row; 1b/L13. |

Also accepted: **G-9** (the run-base diff is authoritative) and **G-11**. G-11 is an **`@axis/audit` requirement**: the head hash and event count are persisted periodically, outside the chain, so tail truncation is detected.

### 11.2 Doc-fix items, not made in this change

- `docs/adr/0004-agent-first-workspace-shell.md`: implication 7 says CLI agents run in the "user-visible pty host". Amend to the Axis pty utility process (Q-1).
- `docs/design/axis-agent-shell.md` and `-policies.md`: record the settings scope (G-1), the GIT-SNAP-1 additions and the push re-take (G-4 to G-6), hooks in the pty process context (Q-4), the authoritative run-base diff (G-9), terminal id binding (G-2), and the explicit `--git-dir` rule (G-5).
- `docs/SECURITY.md` "Testing" needs no new category; DR and CFG are threat classes in the model only.
