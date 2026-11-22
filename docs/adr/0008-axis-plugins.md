# ADR 0008: Axis plugins

- **Status:** Proposed. Becomes Accepted when the Phase 4a plugin gate lines pass (ticket PV-K5, validation criteria below). The owner decisions it records (extensibility D-1 to D-4 and D-12, product vision O-6) are decided; the engineering decisions it adds are decided and revisable.
- **Date:** 2026-11-22.
- **Decision owner:** Dylan Lambertson. The owner delegated every open decision to the project lead on 2026-11-21; the decisions are recorded in `docs/design/owner-decisions-2026-11-21.md` §1 (O-6) and §4, and the owner can reverse any of them there.
- **Depends on:** ADR 0002 (Code OSS integration strategy: shell-layer budget, criterion 2), ADR 0003 (bridge, principals, D1 handshake, D4 policy and approvals, D5 audit, D7 prohibited patterns), ADR 0006 (projects, the rail shows a destination only once its phase ships), ADR 0007 (messaging, M-8; in review), ADR 0010 (pages, the isolated view; in review, PR #571). All Proposed.
- **Amends:** ADR 0003: a fourth principal kind, `plugin:<id>`, attested by main per plugin view (section "Amendment to ADR 0003"). **Keeps** ADR 0003 D1.1 (the daemon opens no listener), D1.3 (the connect checks), D4's rule that only a `user` actor resolves an approval, and D7 (no new `contextBridge` global).
- **Related:** `docs/design/extensibility.md` ("the design": §2 to §4, §8 PLG-1 to PLG-9, §9 4a gate lines, §10), `docs/design/inter-agent-communication.md` (§4.1, §6.3, §6.6 source 6), `docs/design/product-vision-v2-tickets.md` (PV-K1 to PV-K5, PV-R6, PV-R8), `docs/security/threat-model-phase1.md` (EXT-1 to EXT-4, EL-3, EL-4, EL-5, DMN-2, DMN-3, CFG-1, NET-1, A10).
- **Detail:** this file holds the decisions. `docs/adr/0008-axis-plugins-code.md` maps each claim about built code to its anchor and records every divergence between the design, this ADR and the code.
- **Evidence tags:** **[V]** verified in the code on `origin/main` at `2d3909c` (file and symbol named); **[D]** decided here or in the design, not built; **[I]** inferred, not verified.

## Context

### Owner direction

On 2026-11-06 the owner asked for plugins: packages that add Axis surfaces (a page, a dashboard section, a side-panel tab, a task source, a message participant) without being IDE extensions (`product-vision-v2.md` §1). The design proposes how, after two security design reviews; on 2026-11-21 its open decisions were taken as the recommended defaults (owner decisions §4), and O-6 keeps every plugin out of Phases 1c to 3.

### What exists on main

Nothing of the plugin system is built. What exists, and constrains it:

- **Principals.** The daemon knows three actors, `user`, `daemon` and `agent:<id>` [V, `packages/daemon/src/types.ts` `ActorId`; `packages/daemon/src/identity.ts` `identitySchema`]. Main attests only `user` [V, `packages/daemon-host/src/main/attest-sign.ts` `MainIdentity`], and every policy row admits only `user` [V, `packages/daemon-host/src/policy/rule-types.ts` `RuleActor`, `userRule`].
- **The connect broker** gives a port only to a code window whose main frame is the workbench URL [V, `daemon-host/src/main/connect-broker.ts` `CONNECT_REFUSALS`: `not_code_window`, `bad_frame`, `not_main_frame`; overlay `axisMainPorts.ts` uses `getWindowByWebContents`]. A plugin view is not a code window, so it cannot obtain a port through `vscode:axisConnect` today.
- **Approvals** resolve only for `user`, in the policy rows and again in the handler [V, `policy/rules.ts` `axis.approvals/1.resolve`; `handlers/approvals.ts`, `identity.actor !== "user"` answers `E_NOT_FOUND`].
- **Plugins as message senders** are modelled but unreachable: the wire has a `plugin` principal and a plugin id format [V, `packages/protocol/src/messages-wire.ts` `pluginIdSchema`, `principalKey`], the send policy lets a plugin address only the user and never open a thread [V, `daemon-host/src/messages/policy.ts` `mayAddress`, `newThreadProject`], and no binding produces a plugin caller [V; ADR 0007 code map, "Plugin callers"].
- **Taint source 6** (`plugin_output`) is in the closed list [V, `packages/protocol/src/taint.ts` `TAINT_SOURCES`, `TAINT_SENDER_KINDS`]; nothing produces it.
- **Repository settings cannot enable things:** main reads the CLI and hooks settings from policy, application or user scope only [V, `daemon-host/src/main/settings-scope.ts` `userScopeValue`]. The same rule is decided for plugin enablement [D].
- **Not built:** the credential proxy and the vault's wiring (the `@axis/vault` package exists [V, `packages/vault/src/index.ts`]; its daemon wiring is composer ticket C6; the proxy is PV-N1 under ADR 0009); any `WebContentsView`, session partition or `webRequest` handler in the overlay [V: none under `code-oss/overlay`].

## Options

The shape (contracts only, tiers, a main-attested principal, signed curated list) was settled by the design and its reviews and is recorded below as decided. One question was still open and changes an earlier ADR: **how a plugin's calls reach the daemon with an identity the plugin cannot forge.**

| | Option | Main problem |
|---|---|---|
| A | Plugin UI inside the Agent view renderer; calls go over the user's connection with a `pluginId` field | Under ADR 0003 every renderer call is `user` (A10); the label would be renderer code, advisory only. A plugin bug or a host bug becomes a user call, which can resolve approvals (DMN-3) |
| B | Plugin view sends `vscode:axisConnect` like a window; the broker learns a second sender kind | Widens the most sensitive check in main (D1.3) to accept non-window senders, and the identity would rest on a renderer-initiated request |
| C | **Main creates each plugin view and, at creation, mints one connection bound to that view's `webContents` id, attested as `plugin:<id>`; the view never asks for one** | One more attestation shape in main and the daemon; a fixed port shim in the view |

## Decision

Adopt **Option C**, with the decisions below.

### 1. Plugins are not Code OSS extensions

- A Code OSS extension (VSIX from Open VSX, extension host, fully trusted, EXT-1) keeps its model unchanged. An Axis plugin is a separate package type with its own installer, store, process model and principal. A VSIX is never installed as a plugin and a plugin never runs in the extension host [D].
- A plugin reaches Axis **only** through daemon contracts as `plugin:<id>`: no Node, no Electron API, no `vs/*` service, no file system, no direct network (design §3.1) [D].
- The trust statement shown at install is the design's: "P0 and P1 plugins can act only through the permissions shown; P2 plugins run as you".

### 2. Execution tiers and phases (D-1, D-2, O-6)

| Tier | What runs | Phase |
|---|---|---|
| **P0 declarative** | Manifest only: links, task and page templates, dashboard sections that Axis builds from data queries the plugin is granted, settings | 4a, with the plugin system. **Not early** (D-1): pages and tasks ship natively in 2a (ADR 0010, PV-T1) |
| **P1 sandboxed UI** | Plugin HTML and script in its own sandboxed view (decision 5) | 4a |
| **P2 process** | A program the plugin starts | **Not before Phase 3** (D-2). Before the OS sandbox, an install that declares P2 is refused, signed or not |

- **MCP servers the user adds themselves** (Phase 4a, `ROADMAP.md`) are not plugins: they are disclosed as **running as the user**, with the user's file and network access, and never described as sandboxed (D-2). Node's permission model is not a containment boundary [I, Node documentation].
- Until 4a ships, no project shows a Plugins destination (ADR 0006, rail rule and O-6) [D].

### 3. The `plugin:<id>` principal (ADR 0003 change)

- **Form.** The actor is `plugin:<id>`, where `<id>` matches the existing `pluginIdSchema` (lower case, dot-separated words) **and is at most 64 characters**, so that the actor fits the identity's 64-character id rules like `agent:<id>` does. The wire schema allows ids up to 259 characters today; PV-K1 narrows it (code map, divergence 2) [D].
- **Minted by main, at view creation.** Main creates the plugin view (decision 5) and in the same step creates a channel, signs an identity for it and posts it to the daemon with the port, as for windows (ADR 0003 D1.4, the MAC of `attest-sign.ts`). The view never requests a connection; `vscode:axisConnect` from a plugin view stays refused as `not_code_window` [V for the refusal]. One connection per view; it is closed when the view is destroyed, reloaded or navigated (navigation is denied anyway), and a new view gets a new random `connectionId` [D].
- **Identity fields.** `actor` and `actorId` are both `plugin:<id>` (idempotency keys are scoped per plugin, never shared with the user); `clientKind` is a new value `plugin`; `windowId` is `p<n>`, a namespace no code window (`w<n>`, `windowIdOf`) and no web client (`WEB_WINDOW_ID`) uses, so window-scoped state (pending approvals, the trust registry's window subjects) never matches a plugin; `workspaceId` is the project the plugin is enabled in; `trusted` is copied from main's run-trust answer for that project (owner decisions §5) at minting and is never more than the hosting window's [D].
- **Fail closed in today's code.** Until PV-K1 lands, any such identity is refused by the daemon's identity schema (actor and `clientKind`) and by the policy (actor) [V, `identitySchema`, `RuleTablePolicy` `#decide`].
- **The user's connection never carries plugin calls**, so no host bug can turn a plugin call into a user call. There is no renderer-side broker in the trust path (design §3.7).
- **Web:** no plugins on the web client in v1; the web host attests only `user` with `WEB_WINDOW_ID` [V, `policy/rule-table-policy.ts` `WEB_WINDOW_ID`, `WEB_ALLOWED`].

### 4. Policy, approvals and audit

- **Rows.** Plugin access is a separate row table keyed by permission (decision 6): a `plugin:*` call is allowed only if the method is in a permission's method set, that permission is granted to this plugin for this project in the grant store, and the plugin is enabled. No row, no grant, a disabled plugin, a malformed identity or any throw is a denial (I2). A plugin row can raise a tier, never lower it. The coverage check gains the rule that every plugin-table method is also served and that no plugin row names an `axis.approvals/*`, vault, audit, policy, trust, settings, commit, push or worktree-removal method [D; the check exists, `policy/coverage.ts` `coverageProblems`].
- **The grant store** is written only by user-only calls (install, update, grant, revoke, enable, disable, uninstall) and lives in the journal, never in a repository or a renderer-writable setting [D].
- **Approvals (DMN-3 extended).** A plugin never resolves, withdraws or consumes an approval: there is no plugin row for any `axis.approvals/*` method, and the handler's `actor !== "user"` refusal already covers `plugin:*` [V for the handler]. A tier-3 or higher action a plugin requests is a challenge resolved by the user, with the plugin named as the requester in the challenge text, which comes from the daemon, not the plugin [D].
- **Audit.** Every plugin call is a normal `policy.decision` and `rpc.execute` event with actor `plugin:<id>`. `AuditActor` gains that form; messaging's interim rule of recording a plugin as `daemon` with its id in the payload is replaced then [V for the interim rule, `messages/audit.ts` `actorOf`; D for the change].

### 5. The P1 host (D-12)

One **sandboxed `WebContentsView` per plugin**, created and placed by main inside Axis layout regions, with no access to the Agent view's DOM [D, all items]:

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, its **own session partition** (`persist:` per plugin id, so storage is per plugin and cleared at uninstall), and permission request and check handlers that deny everything (camera, microphone, notifications, clipboard read, geolocation, media, HID, serial, USB, and anything added later: the handler is an allow-list of none).
- **Navigation and windows denied:** `will-navigate`, `will-frame-navigate` and `will-redirect` are prevented except for the plugin's own bundle URL; `setWindowOpenHandler` denies; downloads are cancelled; child frames are denied in main, including `about:blank` and `srcdoc`; workers get the same CSP.
- **WebRTC disabled for the view's session or process**, by a Chromium switch or a patch, not by deleting script globals (review 2, NS4). Which mechanism works at the pinned Electron is unknown [I]; PV-K3 measures it against ADR 0002 criterion 2. **If no mechanism within the budget passes the gate line, P1 does not ship and 4a ships P0 only** [D].
- **Backstop:** a `session.webRequest` handler on the partition cancels every request, HTTP or WebSocket, except to the plugin's bundle scheme.
- **Header CSP** set by the Axis protocol handler that serves the bundle (a meta tag can be removed): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'`, plus `X-DNS-Prefetch-Control: off`.
- **The served bytes are the checked bytes.** The protocol handler serves entries from the bundle whose SHA-256 it checked at this load, not files re-read after a check (decision 8) [D].
- **The port shim.** The only preload is a fixed Axis shim that receives the main-posted port and hands it to the page with one `window.postMessage` to the view's own origin, the upstream `acquirePort` pattern. It exposes **no `contextBridge` global** and no other API, so ADR 0003 D7 holds [D].
- **Same host type as the page view, one difference.** ADR 0010's isolated page view uses these host properties with **no bridge port** and `img-src` limited to the attachment scheme; a P1 plugin view has exactly one port, its attested plugin connection. PV-Q2 builds the host and PV-K3 reuses it (tickets doc) [D].

### 6. Permissions and dangerous combinations

- The permission set, its scopes and its "never grants" column are the design's §3.5 table, adopted as written: `agents.read`, `messages.send` (M-8: to the user and threads the user added the plugin to, never opening one), `tasks.read`/`tasks.write`, `pages.read`/`pages.write` (writes attributed to the plugin), `runs.start` (composer only, every start a user challenge showing the full prompt, the run tainted from its first call; never a CLI start), `files.read` (review containment; never WT-3 protected paths, gitignored files or the secret-path list), `net:<origin>` and `integration:<id>` [D].
- **`net:<origin>` and `integration:<id>` wait for ADR 0009** (PV-R6): their egress rules and the credential proxy are decided there and nothing of them is built. Until ADR 0009 is accepted, an install that requests either is refused [D].
- **No permission exists** for approvals, vault plaintext, audit writes, policy changes, Workspace Trust, settings in the CFG-1 set, push, commit or worktree removal.
- **Dangerous combinations** (review N7): the install and update dialogs flag in words any grant that lets data leave the machine. Any of `files.read`, `agents.read`, `pages.read`, `tasks.read` or a `messageParticipant` contribution together with any `net:<origin>` or a write-capable `integration:<id>` reads "can send your code or project data to <origin>".
- **Contribution points** are the design's closed v1 set (§3.4); `command` opens UI only and has no side effect (ADR 0003 D4, EXT-2).

### 7. Sources and signatures (D-3, D-4)

- **Sources:** a local file, or the Axis-curated list. **No public registry in v1.**
- **Curated list:** signed with a key **embedded in the app**; it carries a monotonic version and an expiry. Axis refuses a version lower than the last one it accepted (rollback), an expired list (freeze) and a list signed by an unknown key; the last accepted version is kept in the journal. The embedded key set supports rotation (a new key signed by the old one) and revocation, in the style of TUF root metadata; the exact metadata format is PV-K2's [I].
- **Publisher signatures:** a detached **Ed25519** signature over the manifest and the bundle hash. For a curated plugin the publisher key comes **from the signed list**, never from trust on first use, and a key change blocks the update.
- **Unsigned local files:** allowed for P0 and P1 only, with a warning naming the risk, and **hash pinning** (the bundle SHA-256 recorded at install). **Never for P2.** A local file signed by a key that is not in the current list is treated as unsigned.
- **Where the list is fetched from** is not decided: there is no Axis origin yet. Until one is decided (with its NET row and the ANT-1 request rules), only local-file installs exist [D].

### 8. Install, update, enable, extraction

- **User-only and main-confirmed.** Install, every update that changes anything in the diff below, every grant increase and enable are user-only calls, shown in a **main-built native dialog** that lists the tier, permissions in plain language, origins, contribution points and integrations, and the dangerous-combination lines. A renderer or a plugin cannot answer it (the EL-4 pattern of ADR 0003 D4 and of the run-trust prompt, owner decisions §5) [D].
- **Updates are never automatic.** The update diff covers **tier, permissions, origins, contribution points and integrations**; any increase in any of them is blocked until the user approves it; a decrease applies at once.
- **Integrity at every load:** the bundle SHA-256 recorded at install is checked at every load; a mismatch disables the plugin and tells the user.
- **Extraction** (PLG-9): refuses symlinks, hard links, absolute paths, `..` entries, and (engineering additions) entry names with NUL, backslash, a drive letter or a Windows reserved name, and two entries that differ only in letter case; caps entry count (2,000), per-file size (10 MiB) and total size (50 MiB), measured on the decompressed bytes as they stream; extracts into a fresh directory owned by Axis, never over an existing one.
- **Repositories cannot install or enable.** Plugin enablement and grants are user or application scope only (the CFG-1 rule); a repository file may only **recommend** a plugin, shown as a notice, and a repository setting that tries to enable one has no effect and shows a warning.

### 9. Plugin output is untrusted

Everywhere it lands: escaped in the UI, a **taint source** when delivered to a run (source 6, `plugin_output`; messages from a plugin are source 1 as today), attributed in tasks and pages. PV-K4 wires source 6 [D; the enum is V].

### 10. What a plugin can never do

Resolve or consume an approval; read a credential; write into a terminal; run in main or the daemon; register a contract; change any plugin's permissions; be enabled by a repository; open a message thread; start a CLI run.

## Owner decisions recorded here

| # | Decision | Taken | Section |
|---|---|---|---|
| O-6 | Plugins before Phase 3 | No; P0 and P1 in 4a, P2 only after the OS sandbox | 2 |
| D-1 | P0 early | No; pages and tasks native in 2a, the plugin system in 4a | 2 |
| D-2 | P2 before the OS sandbox | Not before Phase 3; user-added MCP servers disclosed as running as the user | 2 |
| D-3 | Plugin source | Local file and an Axis-curated list signed by an app-embedded key with rollback protection; no public registry | 7 |
| D-4 | Signature policy | Ed25519 publisher signatures for the curated list, keys from the list; unsigned local files for P0 and P1 only, with a warning and hash pinning; never P2 | 7 |
| D-12 | P1 host | One sandboxed `WebContentsView` per plugin, main-attested identity | 3, 5 |

## Amendment to ADR 0003

ADR 0003's decisions are not rewritten; where wording differs, this section governs.

1. **D4 actors.** `policy.evaluate`'s actor gains a fourth kind, `plugin:<id>` (decision 3). It is never `user`, and every D4 rule for non-user actors (cannot resolve approvals, cannot mint grants, I3) applies to it.
2. **D1 identity.** Besides window connections from `vscode:axisConnect`, main mints one connection per plugin view at the view's creation, signed like a window's, with `clientKind: plugin` and a `p<n>` window id. D1.3's checks are unchanged and still refuse a plugin view that sends `vscode:axisConnect`.
3. **D5 audit.** The record's `actor` may be `plugin:<id>`.
4. **D7 unchanged.** The plugin port shim adds no `contextBridge` global and no channel prefix.

## Consistency with other ADRs

- **ADR 0006:** plugins hang off the project; the rail gains Plugins only when 4a ships; no agent, plugin or message can create or change agents and groups. Consistent.
- **ADR 0007 (in review):** M-8 as decided there and here; a plugin cannot open a thread [V]; plugin messages are taint source 1. ADR 0007 records "no plugin binding exists"; PV-K1 builds it from the attested plugin connection, and the interim `daemon` audit actor for plugins changes to `plugin:<id>` (decision 4).
- **ADR 0010 (in review):** the same host type (D-12); the page view has no bridge port and the stricter `img-src`. Consistent; the shared host is built once (PV-Q2) and reused (PV-K3).
- **ADR 0009 (not written):** owns `net:<origin>`, `integration:<id>`, the credential proxy and egress (decision 6).

## Security implications

1. **New surface:** third-party script in a sandboxed view with one port; a new attested principal; an installer that parses untrusted archives; a signed-list verifier. Each is trust-boundary code with an independent review and mutation testing of its refusal paths before any PR (design §10).
2. **Residual:** a Chromium sandbox escape from the plugin view reaches the user's privileges, as for any renderer (threat model §4.1). A plugin with `files.read` and a `net:` origin can send code to that origin by design; the install dialog says so.
3. **P2 is not contained** and is refused until Phase 3 (PLG-6).
4. **Threat rows** PLG-1 to PLG-9 go into the threat model with PV-R8.

## Consequences

- **Positive:** plugins start from a small, daemon-enforced grant instead of the extension model's full trust; a host or plugin bug cannot become a user call; the page view and plugin host share one reviewed implementation.
- **Negative:** a second attestation shape in main and the daemon; an Electron-level WebRTC switch or patch that counts against the ADR 0002 budget; no remote list until an Axis origin is decided.

## Validation criteria

**Accept** this ADR when the design's §9 4a plugin lines pass (PV-K5), plus:

1. A plugin view sending `vscode:axisConnect` gets no port (`not_code_window`); a plugin connection whose identity names a `w<n>` or `web` window id, `clientKind` other than `plugin`, or an actor other than `plugin:<id>` is refused by the daemon.
2. `axis.approvals/1.resolve` and `pending` from a plugin connection are refused and audited with actor `plugin:<id>`.
3. A plugin call allowed by its grant is refused after the plugin is disabled or the grant revoked, within one request.
4. An install declaring P2, or requesting `net:` or `integration:` before ADR 0009 is accepted, is refused.
5. WebRTC from the view, an `about:blank` child frame and a worker, and TURN over TCP, reach no test server.
6. A bundle file changed on disk after install is not served; the plugin is disabled.

**Revisit** if the owner reverses any decision in the table above, if PV-K3 finds no WebRTC mechanism within budget (P0 only), or when the Phase 3 OS sandbox exists (P2).

## Rollback

Before 4a ships: revert this ADR; nothing depends on it. After: disabling every plugin (a user action) closes every plugin connection; removing the plugin rows leaves every plugin call denied by default.

## Tickets this unblocks

PV-K1 (principal), PV-K2 (manifest, install, list, extraction), PV-K3 (host), PV-K4 and PV-K5; PV-R6 (ADR 0009) and PV-R8 (threat model) follow it.
