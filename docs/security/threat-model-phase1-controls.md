# Threat model: Phase 1 controls, gates, residual risks and register

- **Status:** Draft for review. Companion to `docs/security/threat-model-phase1.md` (the "model"), which holds the data-flow diagram and the threat tables (§1–§4). This file holds §5–§10. `docs/security/threat-model-phase0.md` is kept as history.
- **Date:** 2026-11-02.
- **Conventions:** as in the model. **Gate line** `1a/Ln` or `1b/Ln` means the n-th bullet of the "Gate (1a)" or "Gate (1b)" list in `docs/ROADMAP.md`, counted in order (listed in §5.1). **Design task** means a task id in `docs/design/axis-agent-shell.md` §8 (A, B or C). **G-n** is a gap numbered in the model or §6 below.

## 5. Control matrix: control to phase to gate

### 5.1 The ROADMAP gate lines, numbered

Lines are counted in the order the bullets appear in `docs/ROADMAP.md`. L1 to L12 (1a) and L1 to L12 (1b) are the original lines; the later lines were added by the decisions of §11.1 and the review (§11.3).

| Line | Gate (1a) | Line | Gate (1a), continued |
|---|---|---|---|
| 1a/L1 | PRODUCT scenarios 2–5 with an agent CLI; push to a local bare remote; stub `gh`; compare-URL fallback | 1a/L13 | Settings scope (CFG-1) |
| 1a/L2 | **PTY-5** environment test (CLI run and plain terminal) | 1a/L14 | GIT-SNAP-1 extensions; explicit `--git-dir`; push refusal on drift |
| 1a/L3 | **WT-2 (CLI side)** hook plus `core.hooksPath` flagged | 1a/L15 | GIT-ENV-1; hooks run in the pty process |
| 1a/L4 | **WT-3** highlighting for protected paths | 1a/L16 | Snapshot refs lifecycle and the disclosure text |
| 1a/L5 | **DMN-2** unregistered worktree path, symlink or `..` refused | 1a/L17 | Pty process (PTY-6, PTY-7), cwd spoof |
| 1a/L6 | Worktree inside a registered repo refused; dirty removal refused | 1a/L18 | Review and push: drift gate, refspec, compare URL, fixtures, protected hook paths |
| 1a/L7 | **DMN-5/DMN-6** audit with actor; tamper detected; no secret in logs | 1a/L19 | DMN-2 extras and Workspace Trust |
| 1a/L8 | **Tier-4 confirmation**; replay refused | 1a/L20 | Audit tail anchor, challenge TOCTOU, multi-step recovery |
| 1a/L9 | Untrusted repository opens its worktree in Restricted Mode | 1a/L21 | CLI drift scenarios; run-base diff authoritative |
| 1a/L10 | Kill during a CLI run recovers from the journal | 1a/L22 | Open VSX install test |
| 1a/L11 | Keyboard-only, all three view modes | 1a/L23 | Bridge validation 1 to 7, Trusted Types, UI copy |
| 1a/L12 | Threat model revised | 1a/L24 | Commit and push refused while a CLI run is active |
| | | 1a/L25 | Trust attestation by main (TRU-2) |
| | | 1a/L26 | Git argument injection (GIT-7) |
| | | 1a/L27 | Review and commit binding, push secret warning, file tree, dashboard strings, reveal path |
| | | 1a/L28 | External links (EL-5) |
| | | 1a/L29 | No reh-web listener (NET-1) |
| | | 1a/L30 | Typing after a view switch reaches only the destination's last focused element (IDE-1 c) |

| Line | Gate (1b) |
|---|---|
| 1b/L1 | PRODUCT scenarios 1 and 6 with the mock and the Anthropic API |
| 1b/L2 | **DMN-3** approval blocks; agent actor denied |
| 1b/L3 | **WT-1** `..`, absolute path, symlink refused |
| 1b/L4 | **WT-2 (broker side)** planted hook does not run; common-dir change fails closed |
| 1b/L5 | **WT-3** composer write to protected path needs approval |
| 1b/L6 | **PTY-4** timeout and output cap kill the process group |
| 1b/L7 | **DMN-5 (agents)** audit with approver identity and expiry |
| 1b/L8 | **PTY-2** broker child environment allow-list |
| 1b/L9 | **PRV-6** budget stop |
| 1b/L10 | **PRV-1** `basic_text` refused or needs consent |
| 1b/L11 | No credential in logs, renderer state, prompts, agent env |
| 1b/L12 | Kill during a composer run recovers |
| 1b/L13 | Snapshot secret scan (REF-1) |
| 1b/L14 | Composer drift scenarios 1 to 6 and 8 |
| 1b/L15 | Anthropic adapter hardening (ANT-1) |
| 1b/L16 | Hooks placement decision recorded |

### 5.2 Matrix

"Status": **Covered** (an adopted gate line tests the control as worded) or **Partial** (a gate line tests part of it). Every control below has a gate line. Gate lines are pass/fail tests, except 1b/L16, which is a recorded decision.

| Control | Threats | Phase | Design task | Gate line | Status |
|---|---|---|---|---|---|
| PTY-5 deny-list, last, `SSH_AUTH_SOCK` kept | PTY-5, EXT-6 | 1a | B10 | 1a/L2 | Covered (CLI run and plain terminal) |
| SI-ENV after deny-list, plain terminals only; no nonce in CLI runs | PTY-6 | 1a | B10 | 1a/L2, 1a/L17 | Covered |
| Axis pty process isolation, spawn only from daemon, attach only to issued ids; close-on-exec | PTY-7 | 1a | B9 | 1a/L17 | Covered |
| Splits open in worktree root; OSC 633 cwd spoof | PTY-3 | 1a | B10 | 1a/L17 | Covered |
| Settings scope: user, application or machine only (never workspace or folder) | CFG-1 | 1a | B10 | 1a/L13 | Covered |
| Window identity, frame URL, main-frame checks for daemon and pty ports | EL-3, PTY-7 | 1a | B1 | 1a/L23 | Covered (ADR 0003 criteria 1 to 7) |
| GIT-ENV-1 for daemon git calls | GIT-ENV-1 | 1a | B6 | 1a/L15 | Covered |
| GIT-SNAP-1 around CLI runs, before commit and push, on refresh | WT-2, GIT-SNAP-1 | 1a | B7, B10 | 1a/L3, 1a/L14, 1a/L18 | Covered (hooks, `core.hooksPath`, in-tree hook paths, `.git` file, `commondir`, filter, `core.sshCommand`, `url.*.insteadOf`) |
| Commit and push refused while a CLI run is active | GIT-SNAP-1, GIT-3 | 1a | B7, B8 | 1a/L24 | Covered |
| Commit drift gate; push refspec; compare URL host match | GIT-3, GIT-5 | 1a | B7, B8 | 1a/L1, 1a/L18 | Covered |
| Git argument and ref injection | GIT-7 | 1a | B6, B7, B8 | 1a/L26 | Covered |
| Commit binds the reviewed tree; push secret warning | REV-1, PSH-1 | 1a | B7 | 1a/L27 | Covered |
| File tree, preview, diff review, dashboard strings, reveal path | FT-1, IDE-1, DASH-1 | 1a | A3, A5, A6, B7 | 1a/L27 | Covered |
| Snapshot refs lifecycle; disclosure text | REF-1 | 1a | B11 | 1a/L16 | Covered |
| Snapshot secret scan | REF-1 | 1b | C-series | 1b/L13 | Covered |
| Run base per CLI run; run-base diff authoritative; CLI drift scenarios | DRF-2 to DRF-4 | 1a | B11 | 1a/L21 | Covered |
| Composer compare-and-swap, locks, HEAD-moved notices | DRF-1, DRF-5 | 1b | C5 | 1b/L14 | Covered |
| Protected-path highlighting, including hook directories | WT-3 | 1a | B7 | 1a/L4, 1a/L18 | Covered |
| Protected-path approval for composer | WT-3 | 1b | C2 | 1b/L5 | Covered |
| WT-1 path canonicalisation (composer) | WT-1 | 1b | C2 | 1b/L3 | Covered |
| DMN-2 registered-worktree rule, TOCTOU, normalisation | DMN-2 | 1a | B6 | 1a/L5, 1a/L6, 1a/L19 | Covered |
| Trust inheritance; main attests trust at run start | TRU-1, TRU-2 | 1a | A2, B6 | 1a/L9, 1a/L19, 1a/L25 | Covered |
| Challenges and native confirmation; altered request refused | APR-1, APR-2, EL-4 | 1a | B4 | 1a/L8, 1a/L20 | Covered |
| Agent approval policy and UI | DMN-3 | 1b | C2, C3 | 1b/L2 | Covered |
| Audit hash chain with tail anchor | DMN-5 | 1a | B2 | 1a/L7, 1a/L20 | Covered |
| Audit for agent approvals and tool calls | DMN-5 | 1b | C2 | 1b/L7 | Partial: tail anchor is tested in 1a only |
| Redaction by field sensitivity plus pattern scanner | DMN-6 | 1a, 1b | B2, C1 | 1a/L7, 1b/L11 | Partial: canary list should include the PTY-5 environment, snapshot refs and the audit DB |
| Journal-first state, restart recovery, multi-step operations | DMN-7 | 1a, 1b | B3 | 1a/L10, 1a/L20, 1b/L12 | Covered |
| Broker environment allow-list | PTY-2 | 1b | C2 | 1b/L8 | Covered |
| Broker timeouts, output caps, process-group kill | PTY-4 | 1b | C2 | 1b/L6 | Covered; CLI stop is B10 only |
| Vault backend check; no credential leakage | PRV-1, PRV-2 | 1b | C1 | 1b/L10, 1b/L11 | Covered |
| Budgets | PRV-6 | 1b | C4 | 1b/L9 | Covered |
| Anthropic adapter hardening | ANT-1 | 1b | C4 | 1b/L15 | Covered |
| Tool-argument validation | ANT-2 | 1b | C2 | 1b/L3 | Partial: paths only |
| UI disclosure; no "sandbox" in copy | CLI-1 to CLI-3 | 1a | B10 | 1a/L23 | Covered (string assertions) |
| Axis bundle under Trusted Types | EL-1 | 1a | A1, M3 | 1a/L23 | Covered |
| `openExternal` allow-list and confirmation | EL-5 | 1a | none | 1a/L28 | Covered |
| No reh-web listener | NET-1, DMN-4 | 1a | none | 1a/L29 | Covered |
| View switch routes focus and input to the destination only | IDE-1 (c) | 1a | A7 | 1a/L30 | Covered |
| Open VSX tampered refused; outcomes recorded | EXT-3 | M3 Stage 1b | M3 | 1a/L22 | Covered |
| Hooks placement decision after the vault | GIT-3 | 1b | none | 1b/L16 | Recorded decision, not a test |

## 6. Gate gaps

A gap is either a missing control (G-1 to G-13) or a missing ROADMAP gate line for a control the design already plans (G-14 to G-26). **Status after the owner decisions (§11.1):** the "Proposed gate line" columns in §6.1 and §6.2 are the pre-adoption wording; §6.3 and §5.2 give the adopted lines. G-1, G-4, G-5 and G-6 are closed by decision (the model's rows now carry the controls); G-9 and G-11 are accepted as stated; G-7 is split (1a documentation, 1b scanning); G-8 is closed by decision Q-2; G-13 is a gate. The proposed gate wording for G-3, G-10, G-12 to G-26 is now adopted in `docs/ROADMAP.md` as the gate lines named in the table below. "Closed" means the design must still implement and test it; the ROADMAP lines are the tracking.

### 6.1 Missing or under-specified controls

| Gap | Threat | Proposed fix | Proposed gate line |
|---|---|---|---|
| G-1 | CFG-1 | State the scope of `axis.cliAgents`, `axis.terminals.scrubEnvironment`, `axis.git.runHooks`, `axis.worktrees.root` as user, application or machine scope (never workspace or folder); ignore workspace and folder values. | 1a: a repo `.vscode/settings.json` defining a CLI agent or disabling scrubbing has no effect |
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

### 6.3 Resolution after the owner decisions, and ROADMAP tracking

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
| Q-4 re-evaluation | Decision recorded (1b/L16) | 1b/L16 |
| Review items S2, S3, S7, S10 and the reh-web assertion | Gates added | 1a/L24 to 1a/L29 |

## 7. Honest residual risks

Each of these is accepted for Phase 1 on purpose. The wording is the wording the product should use in the UI and in docs.

1. **A CLI agent is not contained.** It runs with the user's privileges and credentials. It can push, read or write the local checkout and the home directory, plant hooks or config in the shared common dir, and reach the network. Axis **detects** common-dir changes (GIT-SNAP-1) and **reviews** worktree changes. It does not prevent the rest (CLI-1, R1, R22).
2. **A CLI can overwrite user changes, and Axis shows it but does not prevent it** (DRF-2). Recovery is the run base for 7 days. Attribution is by time window (DRF-3).
3. **Composer compare-and-swap has a one-hash, one-rename window** in which an outside writer's change can be lost (DRF-1); it is flagged and restorable.
4. **Changes outside the repository's Git directory are not detected:** global git config, `~/.ssh`, shell startup files, anything in the home directory. Only the shared common dir and the worktree are watched.
5. **Terminal I/O bypasses the daemon.** Keystrokes and CLI output do not pass through policy, audit or redaction. An extension or the renderer can answer a CLI's prompt (`sendText`, CLI-2). The audit log records the launch, not what the CLI did.
6. **Opt-out terminals and Phase 0 builds** carry `VSCODE_GIT_IPC_HANDLE` and `VSCODE_IPC_HOOK_CLI` (§4.7 of the model). Any process started there can ask the git extension for credentials. D-6 removes only the askpass variables.
7. **PTY-5 is a deny-list.** A new editor-injected variable that is not on the list reaches CLIs. The list is `VSCODE_*`, `ELECTRON_*`, `GIT_ASKPASS`, `SSH_ASKPASS*`, `GIT_EDITOR`, the git redirectors and config injectors (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_PREFIX`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, `GIT_CONFIG_PARAMETERS`), `AXIS_*` and extension collections, so new `VSCODE_*` names are covered by the prefix; a new non-prefixed name is not. `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS` and `GIT_SSH_COMMAND` pass through as the user's own environment.
8. **Renderer equals user** (A10). Trust writes (TRU-1), advisory locks (DRF-5), and the approval UI are renderer-side. Only the daemon's challenge model and main's native dialog (tiers 4–5) are anchored outside it. A compromised renderer can drive the pty data port and any user-path action that has no challenge.
9. **The audit hash chain is tamper-evident for edits, not tamper-proof** against a same-UID attacker (ADR 0003 D5), and truncation is undetected until G-11.
10. **Snapshot refs may hold secrets** from untracked, non-ignored files, as ordinary git objects in the shared common dir, readable by every workspace of the project (REF-1, DMN-8).
11. **Extensions are fully trusted** (A4). The Axis policy engine does not defend against a malicious extension; Open VSX signature behaviour is still unknown (EXT-3, G-13).
12. **Hooks for Axis commit and push run with the user's credentials** in the pty process context (not the daemon, decision Q-4), while the common dir matches the acknowledged baseline. They are user-controlled code. Re-evaluated in 1b when the vault ships (GIT-3).
13. **User paths bypass the Axis gate** (GIT-6, R32): a commit from the terminal or SCM view runs planted hooks without GIT-SNAP-1, and the user's local checkout shares the common dir.
14. **The OS sandbox is Phase 3.** Until then no process Axis starts is contained by the OS.

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
| New: CLI-1 to CLI-3, CFG-1, TRU-1, TRU-2, DRF-1 to DRF-5, APR-1, APR-2, GIT-7, REV-1, PSH-1, FT-1, IDE-1, DASH-1, NET-1 | none | **1a** (DRF-1 **1b**) | |
| New: ANT-1, ANT-2 | none | **1b** | |
| **Not in the ADR list, accepted (Q-5):** WEB-1 to WEB-6 | P1 | **P2** | Browser skeleton moved to Phase 2 (ADR 0004, ROADMAP) |
| **Not in the ADR list, decided:** EL-5 (`openExternal` confirmation) | P2 | **1a** (changed row, gate 1a/L28) | CLI output contains links (PTY-3 control 4) |
| **Not in the ADR list, decided (Q-7):** EXT-3 Open VSX test | P0/P1 | **1a gate line** (1a/L22), run in the M3 Stage 1b validation | Public open-vsx.org |

## 9. Updated risk register

Likelihood (L) and impact (I) on a 1–3 scale, score = L × I, as Phase 0 §6. Scores assume the planned controls as written, and note where closing a gap changes them. "Owner phase" is the phase that delivers the primary control. Phase 0 ids R1–R21 are kept; R22 onward are new.

| Rank | ID | Risk | Threats | L | I | Score | Owner phase |
|---|---|---|---|---|---|---|---|
| 1 | R1 | Agent commands run with the user's privileges; a worktree is not a sandbox. | CLI-1, PTY-1, PTY-4 | 3 | 3 | 9 | 1a disclosure and review; 1b broker; P3 OS sandbox |
| 2 | R22 | CLI agents are unbrokered and hold the user's credentials: push, local checkout, home directory, network. Detected only where Axis looks. | CLI-1, CLI-2, GIT-3 | 3 | 3 | 9 | 1a (disclosure, snapshot, review); P3 |
| 3 | R2 | Prompt injection from the repo or tool output causes exfiltration or persistence. Applies to composer and to CLIs. | WT-3, PRV-4, ANT-2, EL-1, PTY-3 | 3 | 3 | 9 | 1b (policy, protected paths); CLI: none beyond review |
| 4 | R7 | Shared common-dir persistence: planted hooks and config; in-tree `core.hooksPath`; worktree `.git` redirection; planted remote or credential helper before push. The extended GIT-SNAP-1, the explicit `--git-dir` and the push re-take only detect, and only gate Axis commit and push; a commit from the terminal or SCM view (R32) still runs planted hooks. **Kept at 9 until the gates (1a/L14, L18, L24) are implemented.** | WT-2, GIT-SNAP-1, GIT-3, GIT-4 | 3 | 3 | 9 | 1a (CLI snapshot); 1b (broker) |
| 5 | R23 | A CLI overwrites user or composer changes; attribution is by time window. | DRF-2, DRF-3, DRF-4 | 3 | 2 | 6 | 1a |
| 6 | R3 | Provider credentials exposed through renderer-reachable channels, environment, logs or Linux basic storage. | EXT-4, PRV-1, PRV-2, PTY-2, DMN-6 | 2 | 3 | 6 | 1b |
| 7 | R4 | Confused deputy into Axis services from extensions, webviews, a compromised renderer or an auxiliary window. | EXT-2, EL-2, EL-3, DMN-2 | 2 | 3 | 6 | 1a (ADR 0003) |
| 8 | R5 | Self-granted or forged approvals; challenge TOCTOU. | EL-4, DMN-3, APR-1, APR-2 | 2 | 3 | 6 | 1a (mechanism); 1b (agents) |
| 9 | R6 | Malicious or compromised Open VSX extension; signature semantics unknown. Public open-vsx.org in Phase 0/1 (Q-7); install test is now a 1a gate line (1a/L22). | EXT-1, EXT-3 | 2 | 3 | 6 | 1a gate; P4 allow-list |
| 10 | R8 | Upstream, Electron or Chromium patch lag. | EL-7, SC-6, SC-2 | 2 | 3 | 6 | P1 process |
| 11 | R9 | npm and build supply chain. | SC-1, SC-3, SC-5 | 2 | 3 | 6 | P1 CI; P6 |
| 12 | R11 | MCP stdio auto-start, tool poisoning. | MCP-1, MCP-2 | 3 | 2 | 6 | P4 |
| 13 | R10 | reh-web exposure: token readable by script, no TLS by default, weaker CSP. reh-web is still packaged; the Phase 0 score stands until gate 1a/L29 shows it is not started. | WEB-1 to WEB-5, NET-1 | 2 | 3 | 6 | P2 (browser skeleton), P5 gateway; 1a/L29 |
| 14 | R12 | Web webviews from a third-party CDN by fallback. Same condition as R10. | WEB-4, NET-1 | 3 | 2 | 6 | P2 (moved from P1); 1a/L29 |
| 15 | R32 | User paths bypass the Axis gate: a commit or push from the terminal, SCM view or git extension runs planted hooks and pushes without GIT-SNAP-1; the local checkout shares the common dir. | GIT-6, GIT-SNAP-1 | 3 | 2 | 6 | 1a (banner, disclosure); not preventable |
| 16 | R33 | Review is not bound to the commit; secrets pushed from a CLI-written file; git argument injection. | REV-1, PSH-1, GIT-7 | 2 | 3 | 6 | 1a |
| 17 | R25 | Hooks and credential helpers for **Axis-initiated** commit and push run with the user's credentials. Decision Q-4 moves them out of the daemon into the pty process context, which holds no secrets; re-evaluated in 1b when the vault ships. Hooks run by the user's own terminal or SCM view are R32, not this row. A CLI the user starts by hand in a terminal does not count as an active run, so it can still change hooks between the GIT-SNAP-1 re-take and git executing them: a residual risk, accepted with R32. | GIT-3 | 2 | 2 | 4 (was 6, for 1b vault exposure only: the pty process runs as the user with the user's credential environment, so 1a exposure is unchanged) | 1a; 1b re-evaluation |
| 18 | R26 | Snapshot refs hold secrets from untracked, non-ignored files; mirror push publishes them. 1a documents the exposure; 1b adds secret scanning of snapshot trees (decision Q-8). Target 2 once the 1b scan (1b/L13) ships. | REF-1, DMN-8 | 2 | 2 | 4 | 1a doc; 1b scan |
| 19 | R27 | Audit gaps: tail truncation; terminal I/O unaudited; redaction misses new sinks. | DMN-5, DMN-6 | 2 | 2 | 4 | 1a/1b (G-11) |
| 20 | R28 | Anthropic adapter: hostile or malformed stream, key in errors or redirects, oversized responses, prompts sent without clear consent. | ANT-1, PRV-4 | 2 | 2 | 4 | 1b |
| 21 | R31 | Journal inconsistencies after a kill mid-operation: orphan worktrees, stale locks, half-written refs. | DMN-7 | 2 | 2 | 4 | 1a (G-12) |
| 22 | R13 | Inherited unused privileged surfaces (agent host, MCP gateway, renderer-chosen utility modules). | DMN-4, MCP-4, SC-3 | 2 | 2 | 4 | P1 (ADR 0002 decision 6) |
| 23 | R14 | SSRF and egress through custom provider URLs and remote MCP. | PRV-5, MCP-3 | 2 | 2 | 4 | 1b if custom endpoints ship; P4 |
| 24 | R15 | `ELECTRON_RUN_AS_NODE` reuses Axis keychain and TCC grants. | PRV-3 | 2 | 2 | 4 | P6 (1b interim labelling) |
| 25 | R16 | Protocol-handler abuse through `openExternal`. | EL-5, EL-6, GIT-5 | 2 | 2 | 4 | 1a |
| 26 | R18 | Resource exhaustion and cost runaway. | PTY-4, PRV-6, DMN-7 | 2 | 2 | 4 | 1b; P3 |
| 27 | R19 | Cross-workspace leakage in daemon state or the index; snapshot refs of all workspaces of a project share one common dir and are readable by any workspace's CLI. | DMN-8, REF-1 | 2 | 2 | 4 | 1a / P4 |
| 28 | R21 | Terminal escape-sequence spoofing (now includes cwd steering of splits). | PTY-3 | 2 | 2 | 4 | 1a. Impact raised from 1: the Axis shell reads CLI output for status |
| 29 | R24 | Repo-supplied settings weaken Axis (CLI command, scrubbing off). Closed by decision Q-3: user, application or machine scope (never workspace or folder); workspace values ignored with a warning. Residual: implementation and test (1a/L13). | CFG-1 | 1 | 3 | 3 (was 6) | 1a |
| 30 | R29 | Workspace Trust inheritance wrong or stale; a CLI run under the user's account in an untrusted repository is arbitrary code. Mitigated by decision Q-2 and main's attestation (1a/L25). | TRU-1, TRU-2 | 1 | 3 | 3 | 1a |
| 31 | R30 | Pty-process or daemon fd leak into children; pty attach to a foreign terminal id. | PTY-7 | 1 | 3 | 3 | 1a |
| 32 | R20 | Unsigned update channel once enabled. | SC-4 | 1 | 3 | 3 | P6 |

R17 (audit and redaction gaps) is merged into R27. Scores of R6, R24, R25, R26 and R29 reflect the owner decisions of §11.1 (the rows say so). R7 stays at 9 and R10 and R12 at their Phase 0 scores until the gates they name are implemented: detection-only controls do not lower a score. The ranks are not re-sorted. Changes from the Phase 0 register: R1, R2, R5 (owner phase 1a), R7 (owner phase P3 to 1a), R10 and R12 (owner phase P2; scores unchanged), R19 (adds snapshot refs), R21 (impact), and the new R22 to R33. The table is sorted by score.

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
| CI (new rows) | GIT-7, REV-1, PSH-1 | A branch named `--upload-pack=x`, a remote using `ext::`; a file edited after review makes commit refuse; a planted key pattern in the pushed diff needs confirmation. |
| PT (new rows) | FT-1, IDE-1 | A symlink pointing outside the worktree is not read by the tree or preview; an Open-in-IDE request for `/etc/passwd` is refused. |
| PE (new rows) | TRU-2 | A run-start call with a forged renderer trust claim and no attestation from main is refused. |
| SSRF | ANT-1, GIT-5 | A redirect from the provider endpoint is not followed and the key is not sent to the target; a planted remote host is refused for compare URLs. |

## 11. Decisions and remaining doc-fix items

### 11.1 Decisions on the open questions (owner, 2026-11-02)

| Q | Decision | Effect |
|---|---|---|
| Q-1 | The design wins: CLI runs use the separate Axis pty utility process. | PTY-1 row updated; the ADR 0004 wording is a doc-fix item (§11.2). |
| Q-2 | No CLI or agent run in a worktree whose source repository is untrusted. Restricted Mode shows the workspace read-only with a "Trust to run" action. | TRU-2 row; closes G-8. |
| Q-3 | `axis.cliAgents`, `axis.terminals.scrubEnvironment`, `axis.git.runHooks`, `axis.worktrees.root`: user, application or machine scope (never workspace or folder); workspace and folder values ignored, with a warning. | CFG-1 closed; closes G-1. |
| Q-4 | Hooks for Axis-initiated commit and push run in the pty process context (no secrets), never in the daemon. `runHooks` stays on in 1a; re-evaluated in 1b when the vault ships. | GIT-3 row; R25. **Amendment 2026-11-04:** the daemon never runs commit hooks (commit is `commit-tree` plus a ref compare-and-swap); **NOT BUILT YET: today no commit hook runs; building the hook step is a named follow-up (ticket H9-hooks).** Today no commit hook runs. When built, with `runHooks` on, the host runs `pre-commit` and `commit-msg` in the pty process context; the sequence is all under the daemon's commit lock: first the CLI-run refusal and the GIT-SNAP-1 drift re-take, then the host runs `pre-commit` and `commit-msg` against a temporary index and scratch checkout of the reviewed tree (never the user's worktree or real index), then a freshness re-check, then `commit-tree` and the compare-and-swap. A hook that modifies files makes the commit refused with a hook-specific reason (the changes are discarded and the user is told to run the formatter and review again; Axis commits exactly the reviewed tree). A message rewritten by `commit-msg` is the one committed and is recorded in the audit event after the user is shown it. `post-commit` style hooks are not run in 1a. See ADR 0004 §4 and `docs/packages.md` "Commit hooks". |
| Q-5 | The WEB-* P1 to P2 retag is accepted. | §8. |
| Q-6 | Push re-takes GIT-SNAP-1 and refuses on unacknowledged drift. GIT-SNAP-1 also covers the worktree `.git` file, `commondir`, and any `core.hooksPath` target inside the worktree. | Closes G-4, G-5, G-6. |
| Q-7 | Phase 0 and 1 use public open-vsx.org. The install test runs in the M3 Stage 1b validation and is a gate. | EXT-3 row; 1a/L22. |
| Q-8 | 1a documents the snapshot exposure; 1b adds secret scanning of snapshots as a gate. | REF-1 row; 1b/L13. |

Also accepted: **G-9** (the run-base diff is authoritative) and **G-11**. G-11 is an **`@axis/audit` requirement**: the head hash and event count are persisted periodically, outside the chain, so tail truncation is detected.

### 11.2 Doc-fix items (done on the design and ADR branch)

- `docs/adr/0004-agent-first-workspace-shell.md`: implication 7 said CLI agents run in the "user-visible pty host"; it now says the Axis pty utility process (Q-1).
- `docs/design/axis-agent-shell.md` and `-policies.md` now say that the daemon orchestrates commit and push and that git (and its hooks) runs in the Axis pty process. They define how main attests trust on the run-start call (it reads the workbench trust store, or owns the state that decides runs). They record the refusal of commit and push while a CLI run is active, the reviewed-tree binding (REV-1), the argv rules (GIT-7), the settings scope (G-1), the GIT-SNAP-1 additions and the push re-take (G-4 to G-6), hooks in the pty process context (Q-4), the authoritative run-base diff (G-9), terminal id binding (G-2) and the explicit `--git-dir` rule (G-5).
- `docs/SECURITY.md` "Testing" needs no new category; DR and CFG are threat classes in the model only.

### 11.3 Review decisions (owner)

- **S2:** Axis commit and push are refused while a CLI run is active in that workspace (gate 1a/L24).
- **S3:** the main process owns the trust state that decides runs and attests it on the window-verified run-start call; the daemon requires the attestation, and a renderer claim alone is advisory under A10 (gate 1a/L25).
- **S4:** R7 stays at 9 until its gates are implemented; detection-only controls do not lower a score.
- **S5:** GIT-6 has R32, and DMN-8 is in R19 with the shared-refs note.
- **S6:** R10 and R12 return to their Phase 0 scores because reh-web is still packaged; gate 1a/L29.
- **S7:** rows GIT-7, REV-1, PSH-1, FT-1, IDE-1, DASH-1 and NET-1 added (model §4.9), gated by 1a/L26 to L29.
- **S8:** gate lines made pass/fail (1a/L2, L16, L22; 1b/L16 is a recorded decision).
- **S9:** the daemon orchestrates commit and push (lock, mutex, drift gate, journal); the git process, and its hooks, runs in the Axis pty process. The model and the design documents say so.
- **S10:** EL-5 is a changed row with gate 1a/L28.
