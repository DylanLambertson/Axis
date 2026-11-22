# Threat model: Phase 4a revision, slice 1 (Axis plugins)

- **Status:** Draft for review (ticket PV-R8, slice 1: plugins). Slice 2 adds the integrations (INT-1 to INT-6) to this file once ADR 0009 (in review) is merged; nothing here covers the credential proxy, `net:<origin>`, `integration:<id>` or their dangerous combinations beyond noting that ADR 0008 refuses them at install until then. This file states nothing about ADR 0009's content.
- **Date:** 2026-11-22. **Code baseline:** `origin/main` at `0ca1c43` (ADR 0008 and the 2a revision merged).
- **Builds on:** `threat-model-phase1.md` and its companions (EXT-1 to EXT-4, EL-3 to EL-5, DMN-2, DMN-3, CFG-1, NET-1, A10, TB1 to TB13) and `threat-model-phase2a.md` (TB14 to TB18, IAC-T, the page view host, its decision O-6). Where this file and those disagree about a plugin surface, this file wins.
- **Sources:** ADR 0008 ("the ADR") and its code map, `docs/design/extensibility.md` §3, §4, §8, §9 ("the design"), ADR 0010 (the shared view host), ADR 0007 (M-8, taint source 6), `docs/design/project-registration-and-trust.md`.
- **Companion:** `threat-model-phase1-residual-register.md` §1.4 (RR-56 to RR-74).
- **Evidence tags:** as in `threat-model-phase2a.md`: **[M]** merged on main (file and symbol named, or the ADR 0008 code map row); **[D]** decided, nothing built; **[I]** inferred.
- **Decisions.** This file makes none of its own. The threats that needed one were decided by the project lead; section 7 records them.

## 1. What 4a plugins add

Nothing of the plugin system is built. What exists on main are **fences that refuse a plugin today**: the daemon's identity schema knows no `plugin` actor or `plugin` client kind, every policy row admits only `user`, the connect broker gives no port to anything but a code window's workbench frame, and the approvals handler refuses any actor but `user` [M, ADR 0008 code map §1]. 4a replaces "no plugin can exist" with "a plugin exists, with a main-attested identity, inside an allow-list". The fences above become the controls that must keep holding for everything outside the allow-list.

A P1 plugin is **third-party script with one daemon port**. Its threats are those of a hostile web page that also holds a narrow, attested API key: escaping its view, exceeding its grant, using an agent or the user as a deputy, and moving data out.

## 2. Actors

| Actor | Trust | Notes |
|---|---|---|
| Plugin `plugin:<id>`, tier P0 (manifest only) | Untrusted | Acts only through Axis-built queries it is granted |
| Plugin, tier P1 (sandboxed UI) | Untrusted | Script in its own view, one attested connection [D, ADR decisions 3, 5] |
| Plugin, tier P2 (process) | Refused | Not before Phase 3 (D-2); an install declaring P2 is refused [D] |
| Plugin publisher | Untrusted | Signs id, version, tier and bundle hash (Ed25519); trusted only through a key pinned in the curated list [D] |
| Curated-list signer | Axis release | Key embedded in the app; the list ships with the release and is never fetched in v1 [D] |
| Host window `w<n>` | User | The code window a plugin view sits in; its revokes reach the view (`hostWindowId`) [D] |
| User-added MCP server | Runs as the user | Not a plugin; disclosed as uncontained (D-2) |

The user, main, the daemon, the renderer (A10) and agents are as in the earlier files. 4a adds a **fourth principal kind** to ADR 0003 D4: `plugin:<id>`, never `user`.

## 3. Assets

| Asset | Where | Why it matters |
|---|---|---|
| The grant store (per plugin, per project: permissions, enabled) | journal [D] | Decides every plugin call; written only by user-only calls |
| Installed bundles and their recorded SHA-256 | Axis-owned directory [D] | Integrity at every load; the served bytes are the checked bytes |
| The embedded list key, the list, the last accepted list version | app release; version in the journal [D] | Rollback and key-substitution protection |
| Publisher keys | the signed list [D] | Bind a signature to a plugin, version and tier |
| Each plugin's session partition | `persist:` per plugin id [D] | Per-plugin storage, cleared at uninstall |
| Main's plugin and page view table, the `p<n>` counter | main memory [D] | Identity of every plugin connection; drop list for IPC |
| The attestation key per daemon generation | main and daemon [M, `main/attest-sign.ts`] | Signs plugin identities as it signs window identities |
| Everything a plugin's grant reaches | daemon contracts | Project data a plugin can read, and the run starts it can request |

## 4. Trust boundaries added

| ID | Boundary | Control |
|---|---|---|
| TB19 | **Plugin view to main.** A sandboxed `WebContentsView` with its own partition; main drops **every** IPC message whose sender is a plugin or page view, by `webContents` id, before upstream handlers, and audits the drop | ADR decisions 3, 5 [D]; where in Electron's dispatch the drop sits is unverified [I] |
| TB20 | **Plugin connection to the daemon.** Minted by main at view creation, attested as `plugin:<id>` with `clientKind: plugin`, `windowId` `p<n>` (never reused) and a fixed `hostWindowId`; the view never asks for one | ADR decision 3 [D]; until PV-K1 the daemon refuses any such identity [M, `daemon/src/identity.ts` `identitySchema`, `policy/rule-table-policy.ts`] |
| TB21 | **Plugin archive to the installer.** Every entry is checked against the extraction rules before any entry is read; caps on decompressed bytes; a fresh directory | ADR decision 8 [D] |
| TB22 | **Signed list and publisher signature to the verifier.** Embedded key, monotonic version, `notAfter`; domain-separated Ed25519 over the JCS manifest and the bundle hash | ADR decision 7 [D] |
| TB23 | **Plugin output to models and the UI.** Escaped in the UI; taint source 6 when delivered to a run; plugin messages are source 1 | ADR decision 9; IAC-T [M for the enum and the delivery sender kind, D for source 6] |

The P1 host is the same host type as the page view (TB17, ADR 0010) with one difference: one port. PV-Q2 builds it and PV-K3 reuses it.

## 5. Threats and controls

Gate lines are section 6's. State words as in `threat-model-phase2a.md`.

### 5.1 The design's rows (`extensibility.md` §8)

| ID | Threat | Control | State | Tickets | Gates |
|---|---|---|---|---|---|
| PLG-1 | Plugin script escapes to renderer privileges | A separate sandboxed view per plugin (`sandbox`, `contextIsolation`, no Node, own partition, deny-all permission handlers), no `contextBridge` global, a port shim posting to its own origin only, no renderer broker in the trust path | **Not built** [D]; the broker refuses a non-window sender today [M, `main/connect-broker.ts` `CONNECT_REFUSALS`] | PV-K3 (host from PV-Q2) | 4a/L8, L17, L22 |
| PLG-2 | A plugin exceeds its grant, or its calls are taken as the user's | Main-minted connection per view; a plugin allow-list of closed method sets per permission; a coverage deny list as a second fence; scope forced to the connection's project; same trust gate as the user row; the user's connection never carries plugin calls | **Not built** [D]; every row admits only `user` today [M, `policy/rule-types.ts` `userRule`] | PV-K1 | 4a/L1, L10, L18, L19, L21 |
| PLG-3 | A plugin uses an agent or the user as a deputy | No approval method for plugins (DMN-3, handler refuses non-user [M]); messages only into threads the user added it to, never opening one [M, `messages/policy.ts` `newThreadProject`]; `runs.start` composer only, initiator `plugin:<id>`, tainted (source 6) before the first model call, a tier-3 challenge showing the full prompt, project, workspace, mode, provider and model; no CLI start | **Partial:** the approval and thread fences [M]; the rest, the per-plugin bound on approval requests (OI-2) and cancelling a plugin's runs when it loses its grant (OI-3) [D] | PV-K1, PV-K4 | 4a/L1, L9, L21, L23, L24 |
| PLG-4 | A tampered or swapped bundle, or a malicious update | SHA-256 at every load, served from the checked buffers; publisher signature binding id, version and tier; no silent downgrade; an update diff over tier, permissions, origins, contributions and integrations, any increase blocked until the user approves in a main-built dialog | **Not built** [D] | PV-K2, PV-K3 | 4a/L3, L14, L16 |
| PLG-5 | A repository enables a plugin or widens its grant | Enablement and grants are user or application scope (CFG-1); a repository may only recommend | **Not built** for plugins [D]; the scope rule exists for CLI and hooks settings [M, `main/settings-scope.ts` `userScopeValue`] | PV-K2 | 4a/L6 |
| PLG-6 | A P2 plugin process acts as the user | P2 refused until Phase 3, signed or not; user-added MCP servers disclosed as running as the user | **Not built** [D] | PV-K2 | 4a/L11 |
| PLG-7 | Exfiltration from a P1 view by navigation, window open, form post, WebRTC, workers or DNS prefetch | Navigation and window open denied, child frames and workers denied, service workers refused, WebRTC off for the session or process (else P1 does not ship), `webRequest` backstop, header CSP with `connect-src 'none'`, `form-action 'none'`, prefetch off | **Not built** [D]; several Electron behaviours unverified [I]; if PV-K3 cannot show them, the runtime ships disabled (OI-1) | PV-K3 | 4a/L2, L13, L22 |
| PLG-8 | Curated list rollback or key substitution; a revoked key trusted forever | List shipped in the app, signed by an embedded key, monotonic version kept in the journal, `notAfter` (default 180 days); expiry refuses new curated installs and updates; a refused list is treated as absent | **Not built** [D] | PV-K2 | 4a/L4, L12 |
| PLG-9 | Archive tricks at install | The extraction rules checked before any entry is read: links, absolute and `..` paths, NUL, backslash, drive letters, reserved names, duplicates, normalisation and case collisions, length and depth limits, decompressed caps, a fresh directory | **Not built** [D] | PV-K2 | 4a/L5, L15 |

### 5.2 Rows added from ADR 0008

| ID | Threat | Control | State | Tickets | Gates |
|---|---|---|---|---|---|
| PLG-10 | **IPC from a plugin view reaches main.** A plugin view sends on a `vscode:` channel or any other channel; upstream's `validatedIpcMain` skips its checks for empty and `about:blank` URLs | Main drops every IPC message from a plugin or page view by sender `webContents` id, before upstream listeners, and audits the drop (bounded) | **Not built** [D]; placement unverified [I]; unshown means the runtime ships disabled (OI-1) | PV-K3 | 4a/L17, L22 |
| PLG-11 | **Identity confusion across windows and restarts.** A `p<n>` collides with a code window or web id, is reused, or keeps a revoked host window's state | `p<n>` from a counter in main, never reused; `hostWindowId` fixed at creation; closing the host window destroys its views; window-keyed state never persisted; ids namespaced first if the daemon ever outlives main | **Not built** [D] | PV-K1, PV-K3 | 4a/L8, L20 |
| PLG-12 | **A plugin keeps acting after trust or its grant is withdrawn** | T1 and T2 per project reach every principal; T3 asks about the host window; T4 checks `windowId` and `hostWindowId`; a disabled plugin or a revoked grant refuses the next call; untrust stops the project's runs, including plugin-requested ones | **Not built** [D]; the gate itself is trust design S1b [D] | PV-K1, trust design S1b | 4a/L10, L18, L24 |
| PLG-13 | **User-mediated exfiltration.** A plugin with read grants and no `net:` origin writes the data into a link in a page, a task or a message; the user's click sends it | EL-5 governs link opening (schemes, full URL for non-user content); the plugin is named as author. A plugin view gets **no clipboard write and no drag-out without a user gesture** (the view's permission handler denies by default; OI-5); a user who copies plugin-written text by hand and pastes it into a terminal is not stopped | Accepted residual [D]; Electron permission-handler behaviour [I] | PV-K3 | 4a/L22, L28 |
| PLG-14 | **Plugin-written text steers a model.** Pages and tasks a plugin writes (`pages.write`, `tasks.write`) and its messages reach composer runs | Plugin revisions are non-user revisions: a page read is source 4, a task the user starts is source 5 (`task_start`), a task read is source 8; plugin messages are source 1 when delivered and source 2 in a `read_messages` result; plugin output delivered to a run is source 6. IAC-T and its approval cap apply. Pages a plugin writes are shown only in the isolated page view under ADR 0010's rules (PAG-1, PAG-3; 2a/L41 to L43) | **Partial:** the source enum and plugin sender kind [M, `protocol/src/taint.ts`, `messages/delivery.ts`]; the producers [D] | PV-K4, PV-Q1, PV-T1, PV-M4 | 4a/L21; 2a/L11, L41 to L43 |
| PLG-15 | **Denial of service by a plugin.** A plugin floods page, task or message writes (journal growth) or daemon requests | The per-connection rate limiter of every daemon session [M, `packages/daemon/src/session.ts` `RateLimiter` in the `Session` constructor]; **per-plugin write quotas** (OI-4): page, task and message writes bounded per hour and in total stored bytes per plugin and project, modelled on the 2a per-sender message limits, refused with a closed reason; the 2a message limits apply to plugin messages as to any sender [M, `messages/limits.ts`] | **Partial:** session rate limit and message limits [M]; plugin write quotas [D] | PV-K1, PV-K4 | 4a/L25 |
| PLG-16 | **Supply chain past the signature.** A compromised curated-list signer key, or a correctly signed update that ships malicious code without asking for more permissions | The list key changes only with an app release; a compromised key affects new installs and updates only, and revocation reaches users only through an app update (RR-72). **No silent update** (OI-6): every update shows the user a main-built dialog with the plugin, old and new version, publisher and the permission diff (also when empty) and applies only after confirmation; the update cannot exceed the grants the user confirms | **Not built** [D] | PV-K2 | 4a/L26 |
| PLG-17 | **A plugin enumerates other plugins or windows** to target them or learn what the user runs | No method lists plugins, views or windows to a plugin (none is in any permission's method set; decision 6 of the ADR); the daemon connection sees only its own identity; IPC from the view is dropped (PLG-10) | **Not built** [D] | PV-K1 | 4a/L27 |

## 6. Gate lines, numbered

The 4a plugin gate is the design's §9 plugin lines plus ADR 0008's validation criteria. They are numbered once here as **4a/Ln**: L1 to L7 are the design's §9 plugin lines in order, L8 to L21 are ADR 0008's criteria 1 to 14. L22 to L28 test the decisions of section 7. Slice 2 appends the integration lines from L29. PV-K5 collects the evidence for all of them. **State:** every line is **Open**; none has a test on main.

| Line | Gate line (short; the source's wording wins) | Threats | Proved by |
|---|---|---|---|
| 4a/L1 | A P1 plugin calling a method outside its grant is denied by the daemon; `axis.approvals/1.resolve` from a plugin connection is denied and audited as `plugin:<id>` | PLG-2, PLG-3 | PV-K1 |
| 4a/L2 | A P1 view's navigation to an external URL, `window.open`, a form post and `RTCPeerConnection` (from the view, an `about:blank` child frame and a worker), and TURN over TCP, all fail, and no request reaches a test server | PLG-7 | PV-K3 |
| 4a/L3 | A modified bundle is disabled at load; an update raising the tier or adding a contribution point, an origin or an integration is blocked until approved | PLG-4 | PV-K2 |
| 4a/L4 | A curated list with a lower version, an expired list and a list signed by an unknown key are refused (as amended by ADR 0008: an expired or refused list blocks new curated installs and updates, installed plugins keep running with a warning) | PLG-8 | PV-K2 |
| 4a/L5 | An archive with a symlink, a `..` entry or more than the entry cap is refused with nothing written outside the fresh directory | PLG-9 | PV-K2 |
| 4a/L6 | A repository setting enabling a plugin has no effect and a warning is shown | PLG-5 | PV-K2 |
| 4a/L7 | An install requesting `files.read` and `net:<origin>` shows the "can send your code to <origin>" line | PLG-2, RR-57 | PV-K2, after ADR 0009 (in review) is accepted and `net:` can be granted (until then such an install is refused, L11); slice 2 may restate this line |
| 4a/L8 | A plugin view sending `vscode:axisConnect` gets no port; a plugin identity with a `w<n>` or `web` window id, another `clientKind` or another actor is refused | PLG-1, PLG-11 | PV-K1 |
| 4a/L9 | `axis.approvals/1.resolve` and `pending` from a plugin connection are refused and audited as `plugin:<id>` | PLG-3 | PV-K1 |
| 4a/L10 | A call allowed by a grant is refused after the plugin is disabled or the grant revoked, within one request | PLG-2, PLG-12 | PV-K1, PV-K2 |
| 4a/L11 | An install declaring P2, or requesting `net:` or `integration:` before ADR 0009 (in review) is accepted, is refused | PLG-6 | PV-K2 |
| 4a/L12 | Past `notAfter`, and with a list refused at start, curated installs and updates are refused, an installed curated plugin loads with a warning, an unsigned local P1 install is unchanged | PLG-8 | PV-K2 |
| 4a/L13 | WebRTC from the view, an `about:blank` child frame, a worker and a service worker (each of which must also fail to start), and TURN over TCP reach no test server | PLG-7 | PV-K3 |
| 4a/L14 | A bundle file changed after install, and a file swapped between the load's check and a request, are never served; the first disables the plugin | PLG-4 | PV-K2, PV-K3 |
| 4a/L15 | An archive with a NUL, a backslash, a drive letter, a reserved name, a case pair, a duplicate, an NFC and NFD pair, a 256-byte component, a 17-folder path, or a file past the decompressed cap is refused, nothing written outside | PLG-9 | PV-K2 |
| 4a/L16 | A signed update to a lower version is refused; a signature moved to another id, version or tier fails; a downgrade succeeds only through "Install an older version" | PLG-4 | PV-K2 |
| 4a/L17 | An unknown channel and a privileged upstream `vscode:` channel sent from a plugin view get no answer and no side effect; the drop is audited | PLG-1, PLG-10 | PV-K3 |
| 4a/L18 | After untrust or a lost binding a gated plugin call is refused while granted reads answer; a revoke for the host window refuses its views' gated calls; a plugin-requested run is stopped | PLG-12 | PV-K1, trust design S1b |
| 4a/L19 | The coverage test fails when a plugin row names a method outside its permission's set or on the deny list (each page and task exclusion included) | PLG-2 | PV-K1 |
| 4a/L20 | Closing the host window destroys its views and closes their connections; a new view never gets a used `p<n>` | PLG-11 | PV-K1, PV-K3 |
| 4a/L21 | A plugin-started run has initiator, `createdBy` and audit actor `plugin:<id>`, is tainted with `plugin_output` before its first model call, and its tier-3 challenge shows the full prompt, project, workspace, mode, provider and model; `axis.runs/1.list` naming another project's workspace is refused (scope forced to the connection's project) | PLG-3, PLG-14, PLG-2 | PV-K1, PV-K4 |
| 4a/L22 | **Release gate for the plugin runtime.** For the pinned Electron, PV-K3's evidence shows that main's IPC drop runs before upstream listeners, that service workers are refused, that the header CSP stops DNS prefetch and preconnect, and that the view's permission handler refuses clipboard writes and drag-out without a user gesture (OI-5; Electron behaviour [I]); if any one is not shown, the build ships with the plugin runtime disabled (no plugin loads, nothing else changes) (OI-1) | PLG-1, PLG-7, PLG-10, PLG-13 | PV-K3, PV-K5 |
| 4a/L23 | One plugin holds at most one pending tier-3 challenge and raises at most 6 approval requests an hour (approved or denied); past either, its `runs.start` is refused with a closed reason until the user re-enables it; the hour is rolling, re-enabling does not reset the count, and the count is stored with the grant and survives a daemon restart (OI-2) | PLG-3 | PV-K1, PV-K4 |
| 4a/L24 | Disabling or uninstalling a plugin, revoking its `runs.start`, or withdrawing its grant or the project's trust cancels every run the plugin started and every pending tier-3 challenge it raised; an approval that arrives afterwards is refused, because the challenge is bound to the grant's generation (OI-3) | PLG-3, PLG-12 | PV-K1, PV-K4 |
| 4a/L25 | A plugin's page, task and message writes past its hourly count or its total-bytes quota per project are refused with a closed reason; daemon requests past the session rate limit are refused (OI-4) | PLG-15 | PV-K1, PV-K4 |
| 4a/L26 | Every update, also one with an empty permission diff, shows the main-built dialog (plugin, old and new version, publisher, permission diff) and is applied only after the user confirms; without confirmation nothing changes (OI-6) | PLG-16 | PV-K2 |
| 4a/L27 | No method a plugin can call returns another plugin, view or window; probing each served method from a plugin connection shows none (OI-7, ADR decision 6) | PLG-17 | PV-K1 |
| 4a/L28 | A link in a plugin-written page, task or message opens only on a user click, in the system browser, with the full URL shown (EL-5); a clipboard write or drag-out from a plugin view without a user gesture fails | PLG-13 | PV-K3, PV-Q2 |

## 7. Decided items (OI-1 to OI-3 were open items; OI-4 to OI-7 came with review 1)

The project lead decided these on 2026-11-22 under the owner's delegation (`owner-decisions-2026-11-21.md`); each is conservative and reversible by a new row there. The ids are this file's own (not the owner decisions O-n or D-n, nor `threat-model-phase2a.md`'s O-n) and stay stable. Nothing here is built.

| # | Decided | Reflected in |
|---|---|---|
| OI-1 | **No weaker fallback.** If PV-K3 cannot show, at the pinned Electron, that main's IPC drop runs before upstream listeners, that service workers are refused, **and** that the header CSP stops DNS prefetch and preconnect, the plugin runtime ships **disabled** for that Electron pin: 4a plugins are off, nothing else changes. WebRTC keeps the ADR's own fallback (P0 only). PV-K3's evidence is a release gate. | PLG-1, PLG-7, PLG-10; gate 4a/L22; RR-62, RR-69 |
| OI-2 | **Approval requests per plugin are bounded.** At most **one** pending tier-3 challenge per plugin at a time and at most **6** approval requests in any rolling hour (approved or denied). Past either, the plugin's `runs.start` is refused with a closed reason until the user re-enables the plugin; re-enabling does not reset the count. The count is stored **with the grant** in the journal and survives a restart, by the same rule as the 2a approval cap. | PLG-3; gate 4a/L23; RR-66, RR-70 |
| OI-3 | **Runs follow their plugin.** Disabling or uninstalling a plugin, revoking its `runs.start`, or withdrawing its grant or the project's trust **cancels every run the plugin started** and **every pending tier-3 challenge it raised**, as untrust does (4a/L18); an approval arriving afterwards is refused because the challenge is bound to the grant's generation. | PLG-3, PLG-12; gate 4a/L24 |
| OI-4 | **Per-plugin write quotas.** A plugin's page, task and message writes are bounded per rolling hour and in total stored bytes per plugin and project, on the model of the 2a per-sender message limits; past either the write is refused with a closed reason. PV-K4 fixes the values, never looser than the 2a message limits. | PLG-15; gate 4a/L25; RR-71 |
| OI-5 | **No clipboard write or drag-out without a user gesture** from a plugin view: its permission handler denies them by default. Part of the L22 release-gate evidence. | PLG-13; gates 4a/L22, L28; RR-58, RR-74 |
| OI-6 | **No silent update.** Every update shows the user a main-built dialog (plugin, old and new version, publisher, the permission diff even when empty) and is applied only after confirmation. This is stricter than ADR 0008 decision 8, where a decrease applies at once: the ADR follows this row. | PLG-16; gate 4a/L26; RR-72, RR-73 |
| OI-7 | **No enumeration.** No plugin-callable method lists other plugins, views or windows; a plugin connection sees only its own identity. | PLG-17; gate 4a/L27 |

## 8. Pointer for 2a

`threat-model-phase2a.md` decision O-6 refuses every plugin caller in 2a. That refusal stays until PV-K1 lands. From 4a, plugin callers are governed by ADR 0008 and this file: the plugin principal (TB20), the allow-list rows (PLG-2) and M-8 for messages (PLG-3).
