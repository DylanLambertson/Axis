# ADR 0008: Axis plugins

- **Status:** Proposed. Becomes Accepted when the Phase 4a plugin gate lines pass (ticket PV-K5, validation criteria below). The owner decisions it records (extensibility D-1 to D-4 and D-12, product vision O-6) are decided; the engineering decisions it adds are decided and revisable.
- **Amended by:** ADR 0011 (Proposed, 2026-11-26): plugin views are placed in the own shell's layout regions instead of the Code OSS workbench.
- **Date:** 2026-11-22.
- **Decision owner:** Dylan Lambertson. The owner delegated every open decision to the project lead on 2026-11-21; the decisions are recorded in `docs/design/owner-decisions-2026-11-21.md` §1 (O-6) and §4, and the owner can reverse any of them there.
- **Depends on:** ADR 0002 (Code OSS integration strategy: shell-layer budget, criterion 2), ADR 0003 (bridge, principals, D1 handshake, D4 policy and approvals, D5 audit, D7 prohibited patterns), ADR 0006 (projects, the rail shows a destination only once its phase ships), ADR 0007 (messaging, M-8; merged, #573), ADR 0010 (pages, the isolated view; merged, #571). All Proposed.
- **Amends:** ADR 0003: a fourth principal kind, `plugin:<id>`, attested by main per plugin view (section "Amendment to ADR 0003"). **Keeps** ADR 0003 D1.1 (the daemon opens no listener), D1.3 (the connect checks), D4's rule that only a `user` actor resolves an approval, and D7 (no new `contextBridge` global).
- **Related:** `docs/design/extensibility.md` ("the design": §2 to §4, §8 PLG-1 to PLG-9, §9 4a gate lines, §10), `docs/design/inter-agent-communication.md` (§4.1, §6.3, §6.6 source 6), `docs/design/project-registration-and-trust.md` (§2, §5.4: the per-call project trust gate), `docs/design/product-vision-v2-tickets.md` (PV-K1 to PV-K5, PV-R6, PV-R8), `docs/security/threat-model-phase1.md` (EXT-1 to EXT-4, EL-3, EL-4, EL-5, DMN-2, DMN-3, CFG-1, NET-1, A10).
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

- **Form.** The actor is `plugin:<id>`, where `<id>` matches the existing `pluginIdSchema` (lower case, dot-separated words) **and is at most 64 characters**, so that the actor fits the identity's 64-character id rules like `agent:<id>` does. The cap is enforced **at install**, by manifest validation: a manifest whose id is longer is refused. `axis.messages/1` is **not** changed by this ADR: a plugin id reaches the wire only from main's attestation of an installed plugin, so it can never exceed the cap. Narrowing `pluginIdSchema` stays an option for PV-K1, only if it is needed (code map, divergence 2) [D].
- **Minted by main, at view creation.** Main creates the plugin view (decision 5) and in the same step creates a channel, signs an identity for it and posts it to the daemon with the port, as for windows (ADR 0003 D1.4, the MAC of `attest-sign.ts`). The view never requests a connection; `vscode:axisConnect` from a plugin view stays refused as `not_code_window` [V for the refusal]. One connection per view. **A reload is a new view:** main destroys the view and its port and closes the connection, then creates a new view with a new channel, a new port and a new random `connectionId`; a port, a connection id or an attestation is never reused, and navigation is denied anyway (decision 5). Destroying the view, disabling or uninstalling the plugin closes its connection the same way [D].
- **Main ignores every IPC message from a plugin view.** The shim needs no IPC (main hands it the port with `webContents.postMessage`), so main drops **every** message whose sender is a plugin view's (or a page view's) `webContents`, on every channel, `vscode:`-prefixed or not, before any upstream handler acts on it, and audits the drop (bounded: one event per view and channel, then a count). The check is by sender `webContents` id against main's table of plugin and page views, not by URL: upstream's `validatedIpcMain` checks the sender URL's authority but skips its checks for empty and `about:blank` URLs (ADR 0003 D1.3, `ipcMain.ts:119-121` [V at the upstream pin]), and the plugin scheme is never accepted as the workbench authority. Where in Electron's dispatch the drop can sit so that it runs before upstream's listeners is unverified [I]: it is on PV-K3's spike list, and the validation criterion below is the acceptance [D].
- **Identity fields.** `actor` and `actorId` are both `plugin:<id>` (idempotency keys are scoped per plugin, never shared with the user); `clientKind` is a new value `plugin`; `windowId` is `p<n>`, a namespace no code window (`w<n>`, `windowIdOf`) and no web client (`WEB_WINDOW_ID`) uses, so window-scoped state such as pending approvals never matches a plugin; a new field `hostWindowId` is the `w<n>` of the code window that hosts the view, so that window-keyed revokes reach the plugin (decision 4, trust). **`hostWindowId` is fixed when main creates the view**, inside the signed identity, and never changes: a plugin moved to another window is a new view with a new connection. `p<n>` comes from a counter in main and **is never reused**; **closing the host window destroys its plugin views** and closes their connections; `workspaceId` is the project the plugin is enabled in. `trusted` is informational only, as for every identity: policy no longer reads it (`project-registration-and-trust.md` §5.4) [D].
- **Ids across restarts.** Code window ids are Electron `BrowserWindow` ids (upstream `windowImpl.ts:808`, `this._id = this._win.id` [V at the upstream pin]), which increase within one main process and start again in a new one. The window-keyed state that `w<n>` and `p<n>` index (the `TrustRegistry`'s revokes, main's view table) is held **in memory** [V, `policy/trust-registry.ts` "Live trust, held in memory"], and the daemon is main's utility process with a per-generation attestation key, whose old ports close when it exits (`main-answers.md` §2) [V]. So an id cannot repeat inside one daemon's lifetime as long as the daemon does not outlive main, which is today's model (ADR 0003 open question 1) [I: that Electron ends a utility process when main exits is not re-verified here]. The ADR requires: window-keyed state is never persisted, and if a later decision lets the daemon outlive main, every window and plugin id must first be namespaced by a per-main-instance id [D].
- **Fail closed in today's code.** Until PV-K1 lands, any such identity is refused by the daemon's identity schema (actor and `clientKind`) and by the policy (actor) [V, `identitySchema`, `RuleTablePolicy` `#decide`].
- **The user's connection never carries plugin calls**, so no host bug can turn a plugin call into a user call. There is no renderer-side broker in the trust path (design §3.7).
- **Web:** no plugins on the web client in v1; the web host attests only `user` with `WEB_WINDOW_ID` [V, `policy/rule-table-policy.ts` `WEB_WINDOW_ID`, `WEB_ALLOWED`].

### 4. Policy, approvals and audit

- **Rows: an allow-list.** Plugin access is a separate row table that is an **allow-list** of closed method sets, one per permission of decision 6, fixed in code and listed in decision 6's table: a method that is in no set has no plugin row. A `plugin:*` call is allowed only if the method is in the set of a permission granted to this plugin for this project in the grant store, and the plugin is enabled. No row, no grant, a disabled plugin, a malformed identity or any throw is a denial (I2). A plugin row can raise a tier, never lower it [D].
- **The deny list is a second fence.** The coverage check (which exists, `policy/coverage.ts` `coverageProblems` [V]) fails the start if any plugin row is not served, names a method that is not in its permission's set, or names a method on the deny list: every `axis.approvals/*` method; vault, credential, audit, policy and settings methods; every Workspace Trust and project trust or registration path; `axis.git/1.commit` and `push`; **every worktree change** (`axis.worktrees/1.create`, `restoreFromRunBase`, `discard`, `finalise`, `remove`, `setUserEditing`); **every CLI run method that changes state** (`axis.cli-runs/1.start`, `stop`); **any terminal or pty input method** (none exists today); **agent and group writes** (`axis.agents/1` and `axis.agent-groups/1` writes, PV-G2; ADR 0006); **the user-only page actions** of ADR 0010 (export to repository, restore a version, mark a version reviewed, delete a page, add or remove an attachment); **task Start** (user-only, the full prompt shown, TSK-1); run cancel (`axis.runs/1.cancel`), the run event stream (`axis.runs/1.events`: it carries model output and tool previews), review completion (`axis.review/1.complete`), messaging Pause, Resume and settings writes. Project registration and trust are not protocol methods at all: they are control-channel messages from main (`projects.register`, `daemon-host/src/control/messages.ts` [V]), and `axis.projects/1` serves only `list` [V, `policy/rules.ts`], so no plugin can reach them. **Opening a message thread** is not a method but a `send` without a thread; the message service refuses it for a plugin [V, `messages/policy.ts` `newThreadProject`] [D for the fence].
- **Trust: the same gate as every principal.** Trust is checked per call on the **project**, by the merged trust design's `requireProjectTrust` (T1 the journal record, T2 the repository binding, T3 main's `trust.check`, T4 the registry revoke; `project-registration-and-trust.md` §2, §5.4; designed, not built). A plugin row takes **the same trust mode as the user row of its method at the time**: `axis.runs/1.start` is `registry` on main today [V, `policy/rules.ts`] and becomes `project` with the trust design's slice S1b, and a plugin row follows that change with the user row, and a gated plugin call goes through the same gate, `registerProjectGated` handler and `ProjectTrustTicket`, with the plugin connection's project. So a plugin acting on an untrusted project gets only the read surfaces its grants allow, nothing that needs trust. Which revokes reach a `p<n>` connection: **T1 and T2** are per project, so an untrust or a `binding_lost` applies to every principal of the project, every plugin connection included, from the next call; **T3** answers for a plugin call only while its host window is live in main's table and the project path is trusted; **T4** is checked for both the plugin's `windowId` and its attested `hostWindowId`, so a revoke recorded for the host window `w<n>` refuses its plugin views too. The gate's signature, `requireProjectTrust({ projectId, windowId, workspaceId?, signal })` in the trust design, therefore **gains `hostWindowId`** (T3 asks main about the host window, T4 checks both ids); that amendment to the trust design §5.4 is a PV-K1 item (code map, divergence 14). On untrust or `binding_lost` the daemon stops the project's live runs (§5.4), including any run a plugin requested [D].
- **The grant store** is written only by user-only calls (install, update, grant, revoke, enable, disable, uninstall) and lives in the journal, never in a repository or a renderer-writable setting [D].
- **Approvals (DMN-3 extended).** A plugin never resolves, withdraws or consumes an approval: there is no plugin row for any `axis.approvals/*` method, and the handler's `actor !== "user"` refusal already covers `plugin:*` [V for the handler]. A tier-3 or higher action a plugin requests is a challenge resolved by the user, with the plugin named as the requester in the challenge text, which comes from the daemon, not the plugin [D].
- **Audit.** Every plugin call is a normal `policy.decision` and `rpc.execute` event with actor `plugin:<id>`. `AuditActor` gains that form; messaging's interim rule of recording a plugin as `daemon` with its id in the payload is replaced then [V for the interim rule, `messages/audit.ts` `actorOf`; D for the change].

### 5. The P1 host (D-12)

One **sandboxed `WebContentsView` per plugin**, created and placed by main inside Axis layout regions, with no access to the Agent view's DOM [D, all items]:

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, its **own session partition** (`persist:` per plugin id, so storage is per plugin and cleared at uninstall), and permission request and check handlers that deny everything (camera, microphone, notifications, clipboard read, geolocation, media, HID, serial, USB, and anything added later: the handler is an allow-list of none).
- **Navigation and windows denied:** `will-navigate`, `will-frame-navigate` and `will-redirect` are prevented except for the plugin's own bundle URL; `setWindowOpenHandler` denies; downloads are cancelled; child frames are denied in main, including `about:blank` and `srcdoc`; no workers (`worker-src 'none'`), and **service workers are refused**: the plugin scheme is not registered with `allowServiceWorkers` [I: the effect at the pinned Electron is on PV-K3's spike list].
- **WebRTC disabled for the view's session or process**, by a Chromium switch or a patch, not by deleting script globals (review 2, NS4). Which mechanism works at the pinned Electron is unknown [I]; PV-K3 measures it against ADR 0002 criterion 2. **If no mechanism within the budget passes the gate line, P1 does not ship and 4a ships P0 only** [D].
- **Backstop:** a `session.webRequest` handler on the partition cancels every request, HTTP or WebSocket, except to the plugin's bundle scheme.
- **Header CSP** set by the Axis protocol handler that serves the bundle (a meta tag can be removed): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'`, plus `X-DNS-Prefetch-Control: off`. The header is load-bearing: DNS prefetch and preconnect hints may bypass the `webRequest` backstop [I: unverified Electron behaviour, on PV-K3's spike list].
- **The served bytes are the checked bytes.** At each load the bundle's files are read into memory **once**, hashed, compared with the recorded SHA-256, and served from those buffers; the protocol handler never re-reads a file from disk after the check, so a file swapped between check and serve is never served. The memory this holds is bounded by the 50 MiB total cap of decision 8 [D].
- **The port shim.** The only preload is a fixed Axis shim that receives the main-posted port and hands it to the page with one `window.postMessage` whose target origin is **the view's own bundle origin, never `*`**. That is where it differs from upstream's `acquirePort` preload, which posts with `'*'` (`src/vs/base/parts/sandbox/electron-browser/preload.ts:161` [V at the upstream pin `2c33b50`]); child frames are denied anyway, so all script in the view is the plugin's own. It exposes **no `contextBridge` global** and no other API, so ADR 0003 D7 holds [D].
- **Same host type as the page view, one difference.** ADR 0010's isolated page view uses these host properties with **no bridge port** and `img-src` limited to the attachment scheme; a P1 plugin view has exactly one port, its attested plugin connection. PV-Q2 builds the host and PV-K3 reuses it (tickets doc) [D].

### 6. Permissions and dangerous combinations

- The permission set, its scopes and its "never grants" column are the design's §3.5 table, adopted as written, with each permission's method set fixed below: `agents.read`, `messages.send` (M-8: to the user and threads the user added the plugin to, never opening one), `tasks.read`/`tasks.write`, `pages.read`/`pages.write` (writes attributed to the plugin), `runs.start` (composer only, every start a user challenge showing the full prompt, the run tainted from its first call; never a CLI start), `files.read` (review containment; never WT-3 protected paths, gitignored files or the secret-path list), `net:<origin>` and `integration:<id>` [D].
- **The method sets.** These are the only methods a plugin row can exist for. Tiers are the user row's tier where one exists; a plugin row may raise it, never lower it. Contracts not yet served (`axis.agents/1` PV-G2, `axis.tasks/1` PV-T1, `axis.pages/1` PV-Q1) are named by their operation; their tickets fix the method names, and a set may then hold **at most** these operations [D].

| Permission | Methods (all scoped to the granted project) | Tier | Excluded (user-only or never) |
|---|---|---|---|
| `agents.read` | `axis.agents/1` list, get (PV-G2); `axis.runs/1.list`, `get`; `axis.cli-runs/1.list`, `get` | 0 | every agent and group write; `axis.runs/1.events`; terminal output; run cancel and stop |
| `messages.send` | `axis.messages/1.send` (only into a thread the user added the plugin to, never opening one: ADR 0007 M-8), `threads`, `thread`, `read`, `markRead` (only threads it participates in) | 2, 0, 1, 1, 1 | `pause`, `resume`, `settings`, `updateSettings`; opening a thread; messages to agents outside such a thread |
| `tasks.read` | `axis.tasks/1` list, get (PV-T1) | 0 | none |
| `tasks.write` | `axis.tasks/1` create and update of task drafts, attributed `plugin:<id>` with the hop recorded | 2 | **Start** (user-only, TSK-1), assignment that starts work, delete |
| `pages.read` | `axis.pages/1` list, get of the current version and the version list (PV-Q1) | 0 | none |
| `pages.write` | `axis.pages/1` create a page, and add a **new version** (author `plugin:<id>`, hop recorded) | 2 | export to repository, restore, mark reviewed, delete, attachment add and remove (all user-only, ADR 0010) |
| `runs.start` | `axis.runs/1.start` (composer only), raised to a tier-3 user challenge under the three rules below | 3 | `axis.cli-runs/1.start`; `axis.runs/1.cancel` |
| `files.read` | `axis.review/1.content`, `diff` (review containment, the §3.5 path refusals) | 1 | `axis.review/1.complete`; every write |

- **Scope is forced, not trusted.** Every plugin handler takes the project from the attested connection: where a request's project or workspace is optional (for example `axis.runs/1.list`'s `workspaceId`), the plugin handler **forces** it to the connection's project, and a value naming another project is refused [D].
- **`runs.start` stays in 4a under three rules** (the plugin authors the prompt and chooses `workspaceId`, `mode`, `providerId` and `modelId` in `composerStartRequestSchema` [V, `packages/protocol/src/composer-runs.ts`]):
  1. **Initiator.** The started run's initiator, `createdBy` and audit actor are `plugin:<id>`, **never `user`**, so every later approval card and audit row of that run names the plugin.
  2. **Tainted before the first model call.** The run takes a taint receipt from source 6, `plugin_output` (the plugin-authored prompt), before its first model call, so it starts tainted and every side-effecting tool call needs approval (IAC-T).
  3. **The challenge shows everything that starts.** The tier-3 challenge, built by the daemon, shows the **full prompt** and the **project, workspace, mode, provider and model**, because they decide the cost and which credential is used; the user resolves it.
  If PV-K1 or PV-K4 finds that any of the three cannot hold, `runs.start` moves to **not in 4a** and the permission is refused at install [D].
- **`net:<origin>` and `integration:<id>` wait for ADR 0009** (PV-R6): their egress rules and the credential proxy are decided there and nothing of them is built. Until ADR 0009 is accepted, an install that requests either is refused [D].
- **No permission exists** for approvals, vault plaintext, audit writes, policy changes, Workspace Trust or project trust, settings in the CFG-1 set, push, commit, any worktree change, CLI run starts and stops, terminal input, or agent and group writes (the deny list of decision 4).
- **Dangerous combinations** (review N7): the install and update dialogs flag in words any grant that lets data leave the machine. Any of `files.read`, `agents.read`, `pages.read`, `tasks.read` or a `messageParticipant` contribution together with any `net:<origin>` or a write-capable `integration:<id>` reads "can send your code or project data to <origin>".
- **Contribution points** are the design's closed v1 set (§3.4); `command` opens UI only and has no side effect (ADR 0003 D4, EXT-2).

### 7. Sources and signatures (D-3, D-4)

- **Sources:** a local file, or the Axis-curated list. **No public registry in v1.**
- **Curated list: shipped inside the app release, never fetched.** v1 has **no network fetch of any curated list** (decided by the project lead on 2026-11-22 under the owner's delegation). The list is part of each app release, signed by a key **embedded in the app**, and carries a monotonic version and a `notAfter` date. At every start Axis verifies the signature and refuses a list signed by an unknown key and a version lower than the last one it accepted (rollback, for example after an app downgrade); the last accepted version is kept in the journal. The list, its keys, their rotation and their revocation change **only with app updates**. Each entry pins a plugin's id, version, tier, publisher key and bundle hash. The exact metadata format is PV-K2's [I]. **A network-fetched list needs its own ADR** (its origin, NET row, the ANT-1 request rules and freeze protection); revisit when a fetch origin is proposed.
- **Expiry bounds revocation, not freeze.** Nothing is fetched, so there is no freeze attack; but a revocation reaches an app only through an update, so without an expiry an old build would trust a compromised or revoked publisher key forever. `notAfter` is set at release time, by default **180 days after the release build** (a release-engineering parameter). Once it has passed, the list is expired and Axis **refuses new installs and updates of curated plugins** (fail closed; the UI says "this build's plugin list has expired: update Axis"). Curated plugins already installed keep running, with a warning, so **an app that is not updated never loses its curated plugins**: there is no remote kill and no surprise breakage. `notAfter` is checked against the **system clock**. A clock wound back only extends the expiry window; that residual is accepted, because the monotonic list version still blocks a list rollback, the signature and key checks still apply, and a same-user attacker who sets the clock is A10 anyway.
- **A list refused at start** (an unknown key, a bad signature or a version lower than the last accepted) is treated as **absent**: no new curated installs or updates, and installed curated plugins keep running with a warning, exactly as on expiry [D]. Unsigned local P0 and P1 files are unaffected: they have their own hash pin and warning [D].
- **Publisher signatures bind id, version and tier.** A detached **Ed25519** signature over a domain-separated message: the fixed prefix `axis.plugin.sig/1`, then the manifest canonicalised per **RFC 8785 (JCS)** (it holds the plugin id, version, tier, permissions, origins, contribution points and integrations), then the bundle hash. The **bundle hash** is the SHA-256 of a canonical listing of the bundle's files, sorted by normalised path, one record per file of path, size and the SHA-256 of its contents; it never depends on archive bytes, so compression, entry order or archive metadata cannot make two different hashes for one bundle, or one hash for two. Both forms are PV-K2 items. A signature can therefore not be moved to another plugin, version or tier. For a curated plugin the publisher key comes **from the signed list**, never from trust on first use, the list's pinned version and hash must match, and a key change blocks the update.
- **A plugin's version never goes down silently.** An update to a lower version than the installed one is refused, signed or not. A downgrade is only an explicit user action ("Install an older version") through the full install dialog with a warning [D].
- **Unsigned local files:** allowed for P0 and P1 only, with a warning naming the risk, and **hash pinning** (the bundle SHA-256 recorded at install). **Never for P2.** A local file signed by a key that is not in the current list is treated as unsigned. So after the list expires, a curated plugin can still be installed **as an unsigned local file**, but only for P0 and P1, with the warning and hash pin; that is intended, not a bypass.
- **Everything else is a local file:** the curated list names plugins, versions, hashes and publisher keys; the bundle itself is installed from a local file and checked against the list's entry. Axis makes no network request to install, update or verify a plugin [D].

### 8. Install, update, enable, extraction

- **User-only and main-confirmed.** Install, every update that changes anything in the diff below, every grant increase and enable are user-only calls, shown in a **main-built native dialog** that lists the tier, permissions in plain language, origins, contribution points and integrations, and the dangerous-combination lines. A renderer or a plugin cannot answer it (the EL-4 pattern of ADR 0003 D4 and of the run-trust prompt, owner decisions §5) [D].
- **Updates are never automatic.** The update diff covers **tier, permissions, origins, contribution points and integrations**; any increase in any of them is blocked until the user approves it; a decrease applies at once. *Amended 2026-11-22 (see "Amendment (2026-11-22, threat model 4a)" below): no update is applied without the user's confirmation.*
- **Integrity at every load:** the bundle SHA-256 recorded at install is checked at every load; a mismatch disables the plugin and tells the user.
- **Extraction** (PLG-9): the whole archive is checked against every rule below **before any entry is read, the manifest and the signature included**, so no entry is resolved by name while a duplicate or a colliding name could still shadow it. Refused: symlinks, hard links, absolute paths, `..` entries, and (engineering additions) entry names with NUL, backslash, a drive letter or a Windows reserved name; **exact duplicate names**; two names that collide after **Unicode normalisation and case folding** (names are compared NFC-normalised and case-folded, so an NFC and an NFD spelling of one name collide); a name component over 255 UTF-8 bytes, a path over 1,024 bytes or deeper than 16 folders. Caps: entry count (2,000), per-file size (10 MiB) and total size (50 MiB), measured on the decompressed bytes as they stream. Extraction goes into a fresh directory owned by Axis, never over an existing one.
- **Repositories cannot install or enable.** Plugin enablement and grants are user or application scope only (the CFG-1 rule); a repository file may only **recommend** a plugin, shown as a notice, and a repository setting that tries to enable one has no effect and shows a warning.

### 9. Plugin output is untrusted

Everywhere it lands: escaped in the UI, a **taint source** when delivered to a run (source 6, `plugin_output`; messages from a plugin are source 1 as today), attributed in tasks and pages. PV-K4 wires source 6 [D; the enum is V].

### 10. What a plugin can never do

Resolve or consume an approval; read a credential; write into a terminal; run in main or the daemon; register a contract; change any plugin's permissions; be enabled by a repository; open a message thread; start or stop a CLI run; change a worktree; create or change agents and groups; send IPC to main.

## Owner decisions recorded here

| # | Decision | Taken | Section |
|---|---|---|---|
| O-6 | Plugins before Phase 3 | No; P0 and P1 in 4a, P2 only after the OS sandbox | 2 |
| D-1 | P0 early | No; pages and tasks native in 2a, the plugin system in 4a | 2 |
| D-2 | P2 before the OS sandbox | Not before Phase 3; user-added MCP servers disclosed as running as the user | 2 |
| D-3 | Plugin source | Local file and an Axis-curated list signed by an app-embedded key with rollback protection; no public registry. **The list ships inside the app release and is never fetched in v1** (project lead, 2026-11-22) | 7 |
| D-4 | Signature policy | Ed25519 publisher signatures for the curated list, keys from the list; unsigned local files for P0 and P1 only, with a warning and hash pinning; never P2 | 7 |
| D-12 | P1 host | One sandboxed `WebContentsView` per plugin, main-attested identity | 3, 5 |

## Amendment to ADR 0003

ADR 0003's decisions are not rewritten; where wording differs, this section governs.

1. **D4 actors.** `policy.evaluate`'s actor gains a fourth kind, `plugin:<id>` (decision 3). It is never `user`, and every D4 rule for non-user actors (cannot resolve approvals, cannot mint grants, I3) applies to it.
2. **D1 identity.** Besides window connections from `vscode:axisConnect`, main mints one connection per plugin view at the view's creation, signed like a window's, with `clientKind: plugin`, a `p<n>` window id and the host's `hostWindowId`. D1.3's checks are unchanged and still refuse a plugin view that sends `vscode:axisConnect`; main ignores every other IPC message from a plugin view.
3. **D5 audit.** The record's `actor` may be `plugin:<id>`.
4. **D7 unchanged.** The plugin port shim adds no `contextBridge` global and no channel prefix.

## Amendment (2026-11-22, threat model 4a)

Decided by the project lead under the owner's delegation (`docs/security/threat-model-phase4a.md` §7, OI-6; `owner-decisions-2026-11-21.md` §6a). Where wording differs, this section governs decision 8.

1. **Updates are never silent.** Every update, including one whose diff is empty or holds only decreases, is shown in the main-built dialog (plugin, old and new version, publisher, and the diff over tier, permissions, origins, contribution points and integrations, shown even when empty) and is applied only after the user confirms it. Without confirmation nothing changes.
2. **What changes from decision 8.** Before, a decrease applied at once with no dialog. Now a decrease applies at once **only through that dialog**: once the user confirms, it takes effect immediately, with no further step. An increase is approved in the same dialog, as before.
3. Gate line `threat-model-phase4a.md` 4a/L26 tests it; residual RR-73 (a signed update with malicious code inside its existing permissions) remains, because the dialog shows the version, publisher and permissions, not the code.

## Consistency with other ADRs

- **ADR 0006:** plugins hang off the project; the rail gains Plugins only when 4a ships; no agent, plugin or message can create or change agents and groups. Consistent.
- **ADR 0007 (merged, #573):** M-8 as decided there and here; a plugin cannot open a thread [V]; plugin messages are taint source 1. ADR 0007 records "no plugin binding exists"; PV-K1 builds it from the attested plugin connection, and the interim `daemon` audit actor for plugins changes to `plugin:<id>` (decision 4).
- **ADR 0010 (merged, #571):** the same host type (D-12); the page view has no bridge port and the stricter `img-src`. Consistent; the shared host is built once (PV-Q2) and reused (PV-K3).
- **ADR 0009 (not written):** owns `net:<origin>`, `integration:<id>`, the credential proxy and egress (decision 6).

## Security implications

1. **New surface:** third-party script in a sandboxed view with one port; a new attested principal; an installer that parses untrusted archives; a signed-list verifier. Each is trust-boundary code with an independent review and mutation testing of its refusal paths before any PR (design §10).
2. **Residual:** a Chromium sandbox escape from the plugin view reaches the user's privileges, as for any renderer (threat model §4.1). A plugin with `files.read` and a `net:` origin can send code to that origin by design; the install dialog says so.
3. **Residual, accepted for P1: user-mediated exfiltration.** A plugin with read grants and **no** `net:` origin can still place data in the surfaces it may write (a link in a page or a task, a message to the user); if the user later clicks or opens it, the data leaves through that link. EL-5 governs link opening (allowed schemes, the full URL shown for links from non-user content), and the plugin is named as the author; Axis does not stop a user's click.
4. **P2 is not contained** and is refused until Phase 3 (PLG-6).
5. **Threat rows** PLG-1 to PLG-9 go into the threat model with PV-R8.

## Consequences

- **Positive:** plugins start from a small, daemon-enforced grant instead of the extension model's full trust; a host or plugin bug cannot become a user call; the page view and plugin host share one reviewed implementation.
- **Negative:** a second attestation shape in main and the daemon; an Electron-level WebRTC switch or patch that counts against the ADR 0002 budget; the curated list changes only with an app release.

## Validation criteria

**Accept** this ADR when the design's §9 4a plugin lines pass (PV-K5), plus:

1. A plugin view sending `vscode:axisConnect` gets no port (`not_code_window`); a plugin connection whose identity names a `w<n>` or `web` window id, `clientKind` other than `plugin`, or an actor other than `plugin:<id>` is refused by the daemon.
2. `axis.approvals/1.resolve` and `pending` from a plugin connection are refused and audited with actor `plugin:<id>`.
3. A plugin call allowed by its grant is refused after the plugin is disabled or the grant revoked, within one request.
4. An install declaring P2, or requesting `net:` or `integration:` before ADR 0009 is accepted, is refused.
5. With the system clock past the list's `notAfter`, and again with a list refused at start (unknown key, lower version), a curated install and a curated update are refused (with the "update Axis" message on expiry), an installed curated plugin still loads and shows a warning, and an unsigned local P1 install behaves as before.
6. WebRTC from the view and from an `about:blank` child frame, a worker or a service worker (each of which must also fail to start), and TURN over TCP, reach no test server.
7. A bundle file changed on disk after install, and a file swapped between the load's check and a request for it, are never served; the first disables the plugin.
8. An archive with each of: a NUL, a backslash, a drive letter, a Windows reserved name, two names differing only in case, an exact duplicate, an NFC and an NFD spelling of one name, a 256-byte name component, a path 17 folders deep, and a file past the decompressed cap is refused with nothing written outside the fresh directory.
9. A signed update to a lower version is refused; a signature moved to a manifest with another id, version or tier fails; a downgrade succeeds only through the user's "Install an older version" dialog.
10. An unknown channel and a privileged upstream `vscode:` channel sent from a plugin view get no answer and no side effect, and the drop is audited.
11. After the project is untrusted, or its binding is lost, a gated plugin call is refused while the plugin's granted reads still answer; a revoke recorded for the host window `w<n>` refuses its plugin view's gated calls; a run a plugin requested is stopped.
12. A coverage test fails when a plugin row names a method that is not in its permission's set, and when one names any method on the deny list (each page and task exclusion of decision 6 included).
13. Closing the host window destroys its plugin views and closes their connections; a new view never gets a `p<n>` used before in that main process.
14. A run started from a plugin connection has initiator, `createdBy` and audit actor `plugin:<id>` (never `user`), is tainted with source `plugin_output` before its first model call, and its tier-3 challenge shows the full prompt, project, workspace, mode, provider and model; `axis.runs/1.list` from a plugin connection naming another project's workspace is refused.

**Revisit** if the owner reverses any decision in the table above, if PV-K3 finds no WebRTC mechanism within budget (P0 only), or when the Phase 3 OS sandbox exists (P2).

## Rollback

Before 4a ships: revert this ADR; nothing depends on it. After: disabling every plugin (a user action) closes every plugin connection; removing the plugin rows leaves every plugin call denied by default.

## Tickets this unblocks

PV-K1 (principal), PV-K2 (manifest, install, list, extraction), PV-K3 (host), PV-K4 and PV-K5; PV-R6 (ADR 0009) and PV-R8 (threat model) follow it.

## Amendment (2026-11-22, ADR 0009)

ADR 0009 ("Integrations and the credential proxy") adds one dangerous combination to decision 6: any `integration:<id>` together with any `net:<origin>`, read-only integrations included, reads "can send data from <integration> to <origin>". Its section "Amendment to ADR 0008" governs where wording differs.

## Amendment (2026-11-22, how the main-built dialog is reached)

Decision 8's "user-only and main-confirmed" rule (install, every update that changes anything in the diff, every grant increase, enable) and item 1 of the threat model 4a amendment (every update, an empty diff included, owner decision OI-6) are **requirements on PV-K2**, not a mechanism that exists: no plugin contract is on main. Each of these actions MUST be either a protocol method at tier 4 or above (a daemon challenge plus `native.confirm` over the privileged port, ADR 0003 D4, the dialog's line built from daemon-derived fields, APR-2) or a main-owned control flow with its own dialog that main draws, as project registration and trust are (`docs/design/project-registration-and-trust.md` §4: not protocol methods, no tier). A tier 3 approval has no native dialog and never meets the rule. PV-K2 decides which, per action, and records it in its contract and here.
