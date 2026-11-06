# Extensibility: plugins, pages, tasks and third-party integrations

- **Status:** Proposed (design only; nothing is built). Proposed phases: pages and tasks 2a, plugins and integrations 4a (`product-vision-v2.md` §5).
- **Date:** 2026-11-05. Verified against `origin/main` at `74cd12e`.
- **Depends on:** ADR 0003 (bridge, policy pipeline, principals, D4, D5), ADR 0004, `docs/security/threat-model-phase1.md` (EXT-1, EXT-3, EXT-4, PRV-1, PRV-2, PRV-4, PRV-5, ANT-1, ANT-2, EL-5, NET-1), `docs/feasibility/extension-compatibility.md`, `docs/PROVIDERS.md`, `inter-agent-communication.md`.
- **Evidence tags:** as in `product-vision-v2.md`.

## 1. Terms

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Code OSS extension** | A VSIX from Open VSX running in the extension host of IDE view | An Axis plugin. Extensions keep their current model (§2) |
| **Axis plugin** | A package that adds Axis surfaces (a page, a dashboard section, a side-panel tab, a task provider, a message participant) and calls Axis only through daemon contracts | A Code OSS extension; an MCP server |
| **Page** | A project document authored by the user or an agent, rendered in Agent view | A plugin page (a plugin's own UI surface, §3.3) |
| **Task** | A project work item, assignable to an agent or a group | A Code OSS task (`tasks.json`), which stays an IDE feature |
| **Integration** | A connection to a third-party service (forge, issue tracker, chat, monitoring) with a credential held by the vault | A provider connection (`PROVIDERS.md`), which stays separate |

## 2. What exists and was already decided

- **Code OSS extensions are fully trusted** and run with the user's privileges; the Axis policy engine does not defend against a malicious extension (EXT-1) [V, threat model §4.6].
- **Registry:** public open-vsx.org in Phases 0 and 1 (owner decision Q-7) [V]. The Microsoft Marketplace is excluded (`licensing-and-marketplace.md`).
- **Signatures:** behaviour of Open VSX signature verification at the pin is **unknown and suspected inverted** (signed blocked, unsigned accepted); the signed, unsigned and tampered install test is an **open** 1a gate line (EXT-3, 1a/L22) [V]. The curated test set is pinned by SHA-256 and does not verify `.sigzip` signatures (`extension-compatibility.md` §4 item 7, decision D4) [V].
- **Updates:** `extensions.autoUpdate` off and `extensions.autoCheckUpdates` false, application scope (M3 Stage 1b, #68) [V].
- **Credentials:** the connection vault `@axis/vault` (#31) with the PRV-1 rule (consent or refusal on Linux `basic_text`); plaintext only in the daemon (PRV-2); credentials never go through `SecretStorage` (EXT-4) [V for the package; wiring is composer ticket C6, not built].
- **Outbound HTTP pattern:** the Anthropic adapter (ANT-1): fixed `https` origin, redirects refused, byte and depth caps, timeouts, error text never echoing the key [V, `@axis/anthropic`].
- **No listener:** a desktop run has no loopback listener (NET-1, 1a gate line) [V as a gate line].
- **Phase 4 today:** MCP, provider SDK, "plugin contract tests" gate item (`ROADMAP.md`) [V].

Lesson carried over: the extension decisions accept a large residual (fully trusted third-party code) because IDE compatibility needs it. Axis plugins have no such compatibility constraint, so they can and should start from a much smaller trust grant.

## 3. Axis plugins

### 3.1 Principles

1. **Contracts only.** A plugin reaches Axis only through daemon contracts over the bridge, as a principal `plugin:<id>` with its own policy rows. No Node, no Electron, no `vs/*` service, no file system, no direct network.
2. **Declared, granted, enforced in the daemon.** The manifest declares permissions; the user grants them at install; the daemon enforces them per call. The renderer's view of permissions is advisory (assumption A10).
3. **No plugin is ever a user.** A plugin cannot resolve an approval (DMN-3 extended to `plugin:*`), cannot read vault plaintext, cannot start tier 3+ actions without a user challenge shown with the plugin named as requester.
4. **Plugin output is untrusted input** wherever it lands: in the UI (escaped), in an agent's context (labelled and tainting, `inter-agent-communication.md` §6.1), in tasks and pages.

### 3.2 Execution tiers

| Tier | What runs | Containment | Proposed phase |
|---|---|---|---|
| **P0 declarative** | Manifest only: links, task templates, page templates, dashboard sections built from Axis data queries the plugin is allowed to make, settings | Nothing executes | 2a or 4a (owner decision D-1) |
| **P1 sandboxed UI** | Plugin HTML and script inside a sandboxed frame with an opaque origin and a strict CSP (`default-src 'none'`, script only from the plugin bundle, `connect-src 'none'`), talking to an Axis-owned broker in the renderer over a message port; the broker forwards allowed calls to the bridge | Browser sandbox and CSP; no Node; no network except through the daemon (§7.3) [I: whether the upstream webview host gives exactly these properties at the pin must be verified; a dedicated Axis frame host may be needed] | 4a |
| **P2 process** | A program the plugin starts (for example an MCP server) | **None.** It runs as the user, like a CLI agent; it can read and write anything the user can and reach the network | 4a with disclosure, or only inside the Phase 3 OS sandbox (decision D-2) |

Node's permission model is not a containment boundary against malicious code [I: per Node's own documentation; not re-verified here], so P2 must not be described as sandboxed until the Phase 3 OS sandbox exists.

### 3.3 Contribution points

Closed set in v1, each with a schema: `page` (a plugin surface in the project nav), `dashboardSection` (rendered by Axis from declared data, or a P1 frame with a fixed height budget), `sidePanelTab`, `taskProvider` (imports tasks from an integration, §6), `messageParticipant` (§3.6), `command` (opens UI only; side effects go over the bridge with a challenge, the EXT-2 rule), `settings`.

### 3.4 Permissions

Each permission is a named set of contract methods with a scope (project or Space). The manifest lists permissions; install shows them in plain language; an update that adds a permission or an egress origin is blocked until the user approves the difference.

| Permission | Grants | Never grants |
|---|---|---|
| `agents.read` | list agents and groups, read run state and activity of the granted project | terminal output of CLI runs (the daemon never sees it), vault, file contents |
| `messages.send` | send to the user and to threads the user added the plugin to | messages to agents directly unless the user adds the plugin to that agent's thread |
| `tasks.read` / `tasks.write` | read and edit tasks of the project | starting runs |
| `pages.read` / `pages.write` | read and edit pages; writes are attributed to the plugin | script in pages |
| `runs.start` | request a composer run start; **every start is a user challenge** showing the full prompt | CLI run start (never granted to a plugin in v1, matching plan Q16: a broker identity never gets `start`) |
| `files.read` | read files of a worktree through the review path's containment, bounded | writes; reads outside registered worktrees |
| `net:<origin>` | requests to one declared HTTPS origin through the daemon (§7.3) | other origins, redirects to other origins, private addresses |
| `integration:<id>` | requests through a connected integration's credential proxy (§7.2) | the credential itself |

There is no permission for: approvals, vault plaintext, audit writes, policy changes, Workspace Trust, settings in the CFG-1 set, push, commit, worktree removal.

### 3.5 What a plugin can never do

Resolve or consume an approval; read a credential; inject input into a terminal; run in the main process or the daemon; register a protocol contract; change another plugin's permissions; be enabled by a repository file (plugin enablement is user or application scope, the CFG-1 rule).

### 3.6 How plugins call agents and the daemon

- Calls go plugin frame → renderer plugin broker (checks the call is in the plugin's declared set, adds nothing) → bridge with the connection's plugin identity → daemon identity step attaches `plugin:<id>` from the attested connection → policy rows for `plugin:*` → handler.
- **New in the daemon:** a `plugin` principal kind and policy rows. Today actor ids are `user`, `daemon` and `agent:*` [V, `packages/daemon/src/types.ts`]. This is an ADR 0003 change (new principal kind and how main attests it) and needs ADR 0008.
- **Calling an agent** means sending a message (`messages.send`) or requesting a composer run (`runs.start`, user-challenged). A plugin never gets a broker tool loop of its own.
- Audit: every plugin call is a normal `policy.decision` and `rpc.execute` event with the plugin id as actor.

## 4. Installation, signature and update policy

| Aspect | Code OSS extensions (decided) | Axis plugins (proposed) |
|---|---|---|
| Source | public open-vsx.org (Q-7) | **no public registry in v1**: install from a local file or from an Axis-curated list (decision D-3) |
| Integrity | SHA-256 pins for the curated test set; general installs rely on Open VSX behaviour, still untested (EXT-3) | bundle SHA-256 recorded at install and checked at every load; a mismatch disables the plugin |
| Signature | unknown at the pin; test is an open gate line | detached Ed25519 publisher signature over the manifest and bundle hash; key pinned at first install (trust on first use) or from the curated list; a key change blocks the update (decision D-4) |
| Updates | auto-update off | never automatic; permission or origin increases need approval |
| Trust statement | "extensions are fully trusted" | "P0 and P1 plugins can act only through the permissions shown; P2 plugins run as you" |
| Repository-supplied | Workspace recommendations exist upstream | a repository can never install or enable a plugin; it may only recommend, shown as a notice |

## 5. Pages

- **Format:** Markdown (CommonMark subset) in v1. Rendered by Axis to sanitised HTML with no raw HTML, no script, no iframes, no remote images (local attachments only), links through the EL-5 rules (`http`, `https`, `mailto`; full URL shown for links from agent-authored content). The Axis bundle's Trusted Types rule applies.
- **Storage (decision D-5):** recommended in the Axis data directory per project, in the journal database or beside it, **not** in the repository. Reason: a page in the repository exists once per branch, so every agent worktree would have its own diverging copy. An **Export to repository** action writes a page as a file into a workspace, where it goes through normal diff review.
- **Agents and pages:** composer tool `read_page` (tier 0); `write_page` needs approval by default and is attributed to the agent; CLI agents reach pages only through the messaging endpoint's read tool if granted, or not at all in 2a.
- **Versions:** every save keeps a version (bounded count); restore is a user action. Audit holds page id, version, actor, length and hash.
- **Page content is untrusted** when an agent reads it (labelled like a message; taints by the IAC-T rule when the last editor is not the user).

## 6. Tasks

- **Record:** `{ taskId, projectId, title (1..200), body (≤ 16,384 chars), status (open, in progress, blocked, done, cancelled), assignee (agent or group, optional), links (runs, workspaces, PRs, pages), source (user, agent, plugin, integration), createdBy, timestamps }`.
- **Assignment does not start work.** "Assign to agent" stores the assignee. "Start" is a user action that shows the exact prompt sent to a composer run (or the text offered to copy for a CLI agent) before it is sent.
- **Agents may create and update tasks** through broker tools (Axis state only, tier 1), attributed to the agent and audited; they cannot assign tasks to other agents outside the messaging policy scope (same rules as `inter-agent-communication.md` §4).
- **Imported tasks** (from an integration's issue tracker) carry `source: integration` and are untrusted text: an issue body becomes a prompt only through the user's Start action, with the source shown.
- Phase 3's planner DAG will add dependencies between tasks; v1 has none.

## 7. Third-party integrations

### 7.1 Model

An integration is a typed connector (built in, or contributed by a plugin in 4a) with: a fixed set of HTTPS origins; an auth method; a closed set of operations with request and response schemas; and a scope (project or Space). Operations are read-only by default; each write operation is its own permission and tier.

### 7.2 Credentials (vault, PRV rules)

- Tokens live in `@axis/vault`; PRV-1 applies (consent or refusal on `basic_text`; the UI shows the backend).
- **Credential proxy:** the daemon performs every integration request and attaches the credential itself. No plugin, renderer, agent prompt, CLI environment or log ever sees it (PRV-2, DMN-6). Contract `axis.integrations/1.request { integrationId, operation, args }`; no raw URL, header or path from the caller.
- Prefer the narrowest credential the service offers (fine-grained, read-only, expiring). Record scopes at connect and show them.
- **OAuth:** the flow opens the system browser from main (EL-5 rules) with PKCE. The redirect needs a receiver: a loopback redirect means a short-lived listener, which conflicts with the NET-1 "no listener" gate line; the device-code flow needs none. **Recommended:** device-code flow where the service supports it; otherwise a one-shot loopback listener bound to `127.0.0.1` on a random port, open only during the flow, with `state` checked, recorded as a NET-1 exception in ADR 0009 (decision D-7) [I: per-service support to verify].
- Revocation: disconnect deletes the vault entry and, where the service has an API for it, revokes the token.

### 7.3 Network egress

- All plugin and integration egress goes through the daemon; P1 frames have `connect-src 'none'`.
- Per-request checks (the ANT-1 and PRV-5 patterns): HTTPS only; origin in the declared and granted set; redirects not followed across origins (and never with the credential); DNS answers checked against private, loopback, link-local and metadata ranges, and the connection pinned to the checked address [I: implementation detail with Node `fetch` to verify]; byte, time and depth caps on responses; response bodies validated by the operation schema; error text built from fixed strings.
- P2 processes are not covered: they reach the network as the user. Stated at install.

### 7.4 Inbound events

No inbound webhooks on the desktop: that would need a listener (NET-1) reachable from the internet. Integrations **poll** with backoff and the service's rate limits. Inbound events can come with cloud runners (Phase 5).

### 7.5 Integration data is untrusted

Issue bodies, PR comments, chat messages and monitoring alerts are attacker-reachable text. They are escaped in the UI, never auto-sent to an agent, labelled and tainting when the user passes them to one.

## 8. Threats and controls

| ID | Threat | Control | Phase |
|---|---|---|---|
| PLG-1 | Malicious plugin script escapes its frame to renderer privileges | Opaque-origin sandboxed frame, strict CSP, Trusted Types in the host, message-port broker with a schema per call; independent review of the frame host | 4a |
| PLG-2 | Plugin exceeds its grant by calling contracts directly | Daemon policy rows per `plugin:*`, coverage check (the H6 pattern), identity from the attested connection, not from the renderer broker | 4a |
| PLG-3 | Plugin uses an agent as a deputy (asks it to push, read secrets) | Plugins reach agents only through messages (tainting) and user-challenged run starts; DMN-3 for `plugin:*` | 4a |
| PLG-4 | Tampered or swapped bundle; malicious update | SHA-256 at every load, publisher signature with pinned key, no auto-update, permission-diff approval | 4a |
| PLG-5 | Repository enables a plugin or widens its grant | Enablement and grants are user or application scope (CFG-1 pattern) | 4a |
| PLG-6 | P2 plugin process acts as the user | Disclosure at install; not described as contained; only inside the Phase 3 sandbox if D-2 says so | 4a |
| PAG-1 | Script or tracking in a page (stored XSS, remote images) | Sanitised Markdown, no raw HTML, local images only, EL-5 links | 2a |
| PAG-2 | Page content steers an agent | Labelled as untrusted, IAC-T taint, write needs approval | 2a |
| TSK-1 | Imported issue text becomes an agent instruction | Start is a user action showing the full prompt and source | 2a / 4a |
| INT-1 | Credential leaves the daemon (logs, errors, plugin, prompt) | Credential proxy, redaction canaries, closed errors | 4a |
| INT-2 | SSRF or redirect to an internal or other origin with the credential | Origin allowlist, no cross-origin redirect, address checks, pinning | 4a |
| INT-3 | Oversized or malformed responses (memory, parser) | Byte, depth and time caps; schema validation | 4a |
| INT-4 | OAuth redirect interception or CSRF | Device flow preferred; PKCE and `state`; one-shot loopback listener only during the flow | 4a |
| INT-5 | Over-broad tokens | Narrowest scope offered, scopes shown, read-only by default | 4a |

## 9. Proposed gate lines (not added to `ROADMAP.md`)

- **2a (pages, tasks):** a page with raw HTML, a script tag, an `onerror` attribute or a remote image renders inert; a `file:` link is refused; a task imported or written by an agent is never sent to a run without the user's Start; page and task writes by agents are audited with the agent id.
- **4a (plugins):** a P1 plugin calling a method outside its grant is denied by the daemon even when the renderer broker is bypassed; a plugin connection calling `axis.approvals/1.resolve` is denied; a modified bundle is disabled at load; an update adding an origin is blocked until approved; a repository setting enabling a plugin has no effect and a warning is shown.
- **4a (integrations):** the credential never appears in renderer state, plugin frames, prompts, CLI environments or logs (canary); a redirect to another origin is not followed and the credential is not sent; a hostname resolving to a private or metadata address is refused; an oversized response is cut and reported; no listener exists outside an active OAuth flow.

## 10. Review requirements

- The plugin frame host, the renderer plugin broker, the `plugin:*` principal and policy rows, the credential proxy, the OAuth flow and the page renderer are trust-boundary code: each goes to an independent security review before any PR, with mutation testing of the refusal paths (the existing process).
- Each new contract adds its policy rows and passes the coverage check; each new store is bounded; each error map is closed.
- The threat model gets a revision adding the PLG, PAG, TSK and INT rows (and IAC rows) before the 2a and 4a gate reviews.
- Built-in integrations are reviewed per service (scopes, redirect behaviour, response shapes).

## 11. Open decisions for the owner

| # | Decision | Recommended default |
|---|---|---|
| D-1 | Ship P0 declarative plugins early (2a) | No; ship pages and tasks natively in 2a and the plugin system in 4a |
| D-2 | P2 process plugins before the OS sandbox | Not before Phase 3; MCP servers the user adds themselves are disclosed as running as the user |
| D-3 | Plugin source | Local file and an Axis-curated list; no public registry in v1 |
| D-4 | Signature policy | Ed25519 publisher signatures required for the curated list; local-file installs allowed unsigned with a warning and hash pinning |
| D-5 | Page storage | Axis data directory per project, with Export to repository |
| D-6 | Page format | Markdown subset only in v1 |
| D-7 | OAuth redirect | Device-code flow; one-shot loopback listener as a recorded NET-1 exception only when a service lacks it |
| D-8 | First integration | GitHub read-only through the user's `gh` (no token) for the 1c dashboard; a token-based GitHub integration only if D-9 changes |
| D-9 | Reverse "Axis stores no forge credentials" (ADR 0004 decision 9 engineering addition) | Keep it until 4a; then allow a vault-held, read-only, fine-grained token behind the credential proxy |
| D-10 | Integrations that write (comment on a PR, move an issue) | Each write operation is a separate permission and a tier-3 challenge |
| D-11 | Inbound webhooks | Not on desktop; polling only |
