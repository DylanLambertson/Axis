# Extensibility: plugins, pages, tasks and third-party integrations

- **Status:** Proposed (design only; nothing is built). Proposed phases: pages and tasks 2a, plugins and integrations 4a (`product-vision-v2.md` §5). Revised after security design review 1 (items S6 to S10, N6, N7).
- **Date:** 2026-11-06 (owner direction of 2026-11-06). Verified against `origin/main` at `74cd12e`; E1 (`116ef22`) and P1d (`e52114f`) have merged since.
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
- **Registry:** public open-vsx.org in Phases 0 and 1 (owner decision Q-7) [V]. The proprietary marketplace is excluded (`licensing-and-marketplace.md`).
- **Signatures:** behaviour of Open VSX signature verification at the pin is **unknown and suspected inverted** (signed blocked, unsigned accepted); the signed, unsigned and tampered install test is an **open** 1a gate line (EXT-3, 1a/L22) [V]. The curated test set is pinned by SHA-256 and does not verify `.sigzip` signatures (`extension-compatibility.md` §4 item 7, decision D4) [V].
- **Updates:** `extensions.autoUpdate` off and `extensions.autoCheckUpdates` false, application scope (M3 Stage 1b, #68) [V].
- **Credentials:** the connection vault `@axis/vault` (#31) with the PRV-1 rule (consent or refusal on Linux `basic_text`); plaintext only in the daemon (PRV-2); credentials never go through `SecretStorage` (EXT-4) [V for the package; wiring is composer ticket C6, not built].
- **Outbound HTTP pattern:** the provider adapter (ANT-1): fixed `https` origin, redirects refused, byte and depth caps, timeouts, error text never echoing the key [V, the provider adapter package from #31].
- **No listener:** a desktop run has no loopback listener (NET-1, 1a gate line) [V as a gate line].
- **Phase 4 today:** MCP, provider SDK, "plugin contract tests" gate item (`ROADMAP.md`) [V].

Lesson carried over: the extension decisions accept a large residual (fully trusted third-party code) because IDE compatibility needs it. Axis plugins have no such compatibility constraint, so they can and should start from a much smaller trust grant.

## 3. Axis plugins

### 3.1 Principles

1. **Contracts only.** A plugin reaches Axis only through daemon contracts, as a principal `plugin:<id>` with its own policy rows. No Node, no Electron, no `vs/*` service, no file system, no direct network.
2. **Declared, granted, enforced in the daemon.** The manifest declares permissions; the user grants them at install; the daemon enforces them per call. Anything the renderer knows about permissions is advisory (assumption A10).
3. **No plugin is ever a user.** A plugin cannot resolve an approval (DMN-3 extended to `plugin:*`), cannot read vault plaintext, cannot start tier 3+ actions without a user challenge shown with the plugin named as requester.
4. **Plugin output is untrusted input** wherever it lands: in the UI (escaped), in an agent's context (a taint source, `inter-agent-communication.md` §6.6), in tasks and pages.

### 3.2 Execution tiers

| Tier | What runs | Containment | Proposed phase |
|---|---|---|---|
| **P0 declarative** | Manifest only: links, task templates, page templates, dashboard sections built by Axis from Axis data queries the plugin is allowed to make, settings | Nothing executes | 2a or 4a (owner decision D-1) |
| **P1 sandboxed UI** | Plugin HTML and script in its **own sandboxed process**, never inside the Agent view renderer (§3.3) | Process sandbox, deny-all permissions, navigation and WebRTC blocked, header CSP, identity attested by main; no Node; network only through the daemon (§7.3) | 4a |
| **P2 process** | A program the plugin starts (for example an MCP server) | **None.** It runs as the user, like a CLI agent; it can read and write anything the user can and reach the network | 4a with disclosure, or only inside the Phase 3 OS sandbox (decision D-2) |

Node's permission model is not a containment boundary against malicious code [I: per Node's own documentation; not re-verified here], so P2 must not be described as sandboxed until the Phase 3 OS sandbox exists.

### 3.3 The P1 host (review S8; to be fixed in ADR 0008)

CSP `connect-src 'none'` alone does **not** give "no network": a script can still navigate itself with data in the URL, open windows, post forms, use WebRTC (not governed by `connect-src`) or trigger DNS prefetch. And under ADR 0003 every renderer-originated call is the actor `user`, so plugin calls that ride the renderer's connection would be labelled `plugin:*` only by renderer code (advisory under A10). The host therefore is:

- **One sandboxed `WebContentsView` per plugin**, with `sandbox: true`, `contextIsolation`, no `nodeIntegration`, no preload beyond a fixed Axis port shim, its own **session partition**, and a permission request and check handler that denies everything (camera, microphone, notifications, clipboard read, geolocation, media, HID, serial, USB).
- **Navigation denied:** `will-navigate`, `will-frame-navigate` and `will-redirect` are prevented except for the plugin's own bundle URL; `setWindowOpenHandler` returns deny; downloads are cancelled. Child frames are denied in main, including `about:blank` and `srcdoc` frames, and plugin workers get the same CSP.
- **WebRTC off at the session or process level (review 2, NS4):** deleting script globals does not disable WebRTC (a child `about:blank` or `srcdoc` frame or a worker gets fresh constructors, and with `contextIsolation` a preload cannot delete main-world globals), and `disable_non_proxied_udp` still allows TCP and TURN-over-TCP. WebRTC is disabled for the plugin view's session or process by a Chromium switch or a patch [I: which one at the Electron version of the pin, measured against ADR 0002 criterion 2]. As a backstop, a `session.webRequest` handler cancels every request, HTTP or WebSocket, except to the plugin's bundle scheme.
- **CSP as a response header** from the Axis protocol handler that serves the bundle (a meta tag can be removed by the plugin): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'`, plus `X-DNS-Prefetch-Control: off`. Any inner frame is sandboxed without `allow-same-origin`.
- **Identity attested by main:** main mints one bridge connection per plugin view, bound to that view's `webContents` id, and the daemon's identity step maps it to `plugin:<id>`. The Agent view renderer's user connection never carries plugin calls, so a host bug cannot turn a plugin call into a user call. This is an ADR 0003 change (a new principal kind and its attestation) [V: actor ids today are `user`, `daemon` and `agent:*`, `packages/daemon/src/types.ts`].
- The view is shown inside Axis layout regions by main; it gets no access to the Agent view's DOM.

### 3.4 Contribution points

Closed set in v1, each with a schema: `page` (a plugin surface in the project nav), `dashboardSection` (rendered by Axis from declared data, or a P1 view with a fixed height budget), `sidePanelTab`, `taskProvider` (imports tasks from an integration, §6), `messageParticipant` (§3.7), `command` (opens UI only; side effects go over the bridge with a challenge, the EXT-2 rule), `settings`.

### 3.5 Permissions

Each permission is a named set of contract methods with a scope (project or Space). The manifest lists permissions; install shows them in plain language.

| Permission | Grants | Never grants |
|---|---|---|
| `agents.read` | list agents and groups, read run state and activity of the granted project | terminal output of CLI runs (the daemon never sees it), vault, file contents |
| `messages.send` | send to the user and to threads the user added the plugin to | messages to agents directly unless the user adds the plugin to that agent's thread; reads outside threads it participates in (`inter-agent-communication.md` §4.2) |
| `tasks.read` / `tasks.write` | read and edit tasks of the project | starting runs |
| `pages.read` / `pages.write` | read and edit pages; writes are attributed to the plugin | script in pages |
| `runs.start` | request a composer run start; **every start is a user challenge** showing the full prompt, and the run is tainted from its first call | CLI run start (never granted to a plugin in v1, matching plan Q16: a broker identity never gets `start`) |
| `files.read` | read files of a worktree through the review path's containment, bounded | writes; reads outside registered worktrees; **WT-3 protected paths, gitignored files and the secret-path list** of `inter-agent-communication.md` §2, matched on the canonical real path with case folding and Windows alias refusal as stated there (review S6, review 2 NS3) |
| `net:<origin>` | requests to one declared HTTPS origin through the daemon (§7.3) | other origins, redirects to other origins, private addresses, IP literals |
| `integration:<id>` | requests through a connected integration's credential proxy (§7.2) | the credential itself |

There is no permission for: approvals, vault plaintext, audit writes, policy changes, Workspace Trust, settings in the CFG-1 set, push, commit, worktree removal.

**Dangerous combinations (review N7).** Install and update dialogs flag, in words, any grant that lets data leave the machine: `files.read`, `agents.read`, `pages.read`, `tasks.read` or `messageParticipant` together with any `net:<origin>` or a write-capable `integration:<id>` reads "can send your code or project data to <origin>".

### 3.6 What a plugin can never do

Resolve or consume an approval; read a credential; inject input into a terminal; run in the main process or the daemon; register a protocol contract; change another plugin's permissions; be enabled by a repository file (plugin enablement is user or application scope, the CFG-1 rule).

### 3.7 How plugins call agents and the daemon

- Calls go plugin view → its main-minted plugin connection → daemon identity step (`plugin:<id>` from the attested connection) → policy rows for `plugin:*` → handler. There is no renderer-side broker in the trust path.
- **Calling an agent** means sending a message (`messages.send`) or requesting a composer run (`runs.start`, user-challenged, tainted). A plugin never gets a broker tool loop of its own.
- Audit: every plugin call is a normal `policy.decision` and `rpc.execute` event with the plugin id as actor.

## 4. Installation, signature and update policy

| Aspect | Code OSS extensions (decided) | Axis plugins (proposed) |
|---|---|---|
| Source | public open-vsx.org (Q-7) | **no public registry in v1**: install from a local file or from an Axis-curated list (decision D-3) |
| Integrity | SHA-256 pins for the curated test set; general installs rely on Open VSX behaviour, still untested (EXT-3) | bundle SHA-256 recorded at install and checked at every load; a mismatch disables the plugin |
| Signature | unknown at the pin; test is an open gate line | detached Ed25519 publisher signature over the manifest and bundle hash; for the curated list the publisher key comes from the signed list, never from trust on first use; a key change blocks the update (decision D-4) |
| Curated list integrity (review S9) | n/a | the list is signed with a key **embedded in the app**; it has a monotonic version and an expiry, and Axis refuses a version lower than the last one seen (rollback) and an expired list (freeze); the embedded key set supports rotation (a new key signed by the old) and revocation, in the style of TUF root metadata [I: exact metadata format for ADR 0008] |
| Updates | auto-update off | never automatic; the update diff covers **tier, permissions, origins, contribution points and integrations**, and any increase in any of them is blocked until the user approves it |
| Extraction | upstream VSIX handling | refuses symlinks, hard links, absolute paths and `..` entries; caps entry count (2,000), per-file size (10 MiB) and total size (50 MiB); extracts into a fresh directory owned by Axis |
| Unsigned local files | n/a | allowed only for P0 and P1, with a warning and hash pinning; **never for P2** |
| Trust statement | "extensions are fully trusted" | "P0 and P1 plugins can act only through the permissions shown; P2 plugins run as you" |
| Repository-supplied | Workspace recommendations exist upstream | a repository can never install or enable a plugin; it may only recommend, shown as a notice |

## 5. Pages

- **Format:** Markdown (CommonMark subset) in v1, no raw HTML, no script, no iframes, no remote images; links through the EL-5 rules (`http`, `https`, `mailto`; full URL shown for links from agent-authored content).
- **Rendering in an isolated frame (review S7).** The renderer is the user's client (A10): script there can call `axis.approvals/1.resolve` as the user, so an agent-authored page with a sanitizer bypass (mutation XSS, a crafted attachment) would let the agent approve its own request. Pages, and any rendered-Markdown view of message bodies, are therefore rendered in a sandboxed view with an opaque origin and **no bridge port**, under the header CSP of §3.3 with `img-src` limited to the attachment scheme. Inside it: the upstream Markdown renderer plus a pinned sanitizer, with Trusted Types enforced (`require-trusted-types-for 'script'`). The Agent view renderer only hosts the view.
- **Attachments:** raster images only (PNG, JPEG, GIF, WebP), checked by content sniffing, not by extension; SVG and other formats are refused (or rasterised by a later decision); attachments are served only from the attachment scheme, never opened as top-level documents.
- **Storage (decision D-5):** recommended in the Axis data directory per project, in the journal database or beside it, **not** in the repository. Reason: a page in the repository exists once per branch, so every agent worktree would have its own diverging copy. An **Export to repository** action writes a page as a file into a workspace, where it goes through normal diff review.
- **Agents and pages:** composer tool `read_page` (tier 0, a taint source when its current content contains text from any non-user revision not explicitly marked reviewed by the user, `inter-agent-communication.md` §6.6); `write_page` needs approval by default and is attributed to the agent; each non-user revision records the writing run's hop. CLI agents have no page access in 2a.
- **Versions:** every save keeps a version (bounded count); restore is a user action. Audit holds page id, version, actor, length and a keyed hash.

## 6. Tasks

- **Record:** `{ taskId, projectId, title (1..200), body (≤ 16,384 chars), status (open, in progress, blocked, done, cancelled), assignee (agent or group, optional), links (runs, workspaces, PRs, pages), source (user, agent, plugin, integration), revisions (author, hop), createdBy, timestamps }`.
- **Assignment does not start work.** "Assign to agent" stores the assignee. "Start" is a user action that shows the exact prompt sent to a composer run (or the text offered to copy for a CLI agent) before it is sent.
- **Start is not always the user's text (review S1).** If the title or body has any non-user revision, or the source is not `user`, the Start dialog marks the agent-written or imported parts, and the started run is tainted from its first call (IAC-T source 5).
- **Agents may create and update tasks** through broker tools (Axis state only, side-effecting under IAC-T, attributed and audited); they cannot assign tasks to other agents outside the messaging policy scope (`inter-agent-communication.md` §4.1).
- **Imported tasks** (from an integration's issue tracker) carry `source: integration` and are untrusted text.
- Phase 3's planner DAG will add dependencies between tasks; v1 has none.

## 7. Third-party integrations

### 7.1 Model

An integration is a typed connector (built in, or contributed by a plugin in 4a) with: a fixed set of HTTPS origins; an auth method; a closed set of operations with request and response schemas; and a scope (project or Space). Operations are read-only by default; each write operation is its own permission and tier.

### 7.2 Credentials and request composition (vault, PRV rules)

- Tokens live in `@axis/vault`; PRV-1 applies (consent or refusal on `basic_text`; the UI shows the backend).
- **Credential proxy:** the daemon performs every integration request and attaches the credential itself. No plugin, renderer, agent prompt, CLI environment or log ever sees it (PRV-2, DMN-6). Contract `axis.integrations/1.request { integrationId, operation, args }`; no raw URL, header, path or query from the caller.
- **Request composition (review S10).** Each operation fixes its HTTP method and a path template; each argument is a schema-typed value placed into one named segment or one declared query parameter, percent-encoded; values containing `/`, `?`, `#`, `%2e`-style or literal dot segments, or control characters are refused before encoding. There is no free-form query or body passthrough. The final URL is matched against the operation's URL pattern before the credential is attached; a mismatch is refused and audited.
- **Scopes (review N6).** Prefer the narrowest credential the service offers (fine-grained, read-only, expiring). Record the granted scopes at connect, show them, and **refuse a token whose granted scopes exceed the integration's declared scopes**.
- **OAuth:** connecting is a **user-only** policy row. The flow opens the system browser from main (EL-5 rules) with PKCE. For the device-code flow, the code and the verification host are shown in a **main-built** dialog (not plugin or renderer text), to limit device-code phishing. **Recommended:** device-code flow where the service supports it; otherwise a one-shot loopback listener bound to `127.0.0.1` on a random port, open only during the flow, with `state` checked, recorded as a NET-1 exception in ADR 0009 (decision D-7) [I: per-service support to verify].
- Revocation: disconnect deletes the vault entry and, where the service has an API for it, revokes the token.

### 7.3 Network egress

- All plugin and integration egress goes through the daemon; P1 views cannot reach the network (§3.3).
- Per-request checks (the ANT-1 and PRV-5 patterns): HTTPS only; origin in the declared and granted set; **IP-literal origins refused**; redirects not followed across origins (and never with the credential); DNS answers checked against private, loopback, link-local, metadata, IPv4-mapped IPv6 and NAT64 ranges, and the connection pinned to the checked address [I: implementation detail with Node `fetch` to verify]; **proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`) ignored** for these requests so the address check tests the real destination (a system-proxy option is a later decision); byte, time and depth caps on responses; response bodies validated by the operation schema; error text built from fixed strings.
- P2 processes are not covered: they reach the network as the user. Stated at install.

### 7.4 Inbound events

No inbound webhooks on the desktop: that would need a listener (NET-1) reachable from the internet. Integrations **poll** with backoff and the service's rate limits. Inbound events can come with cloud runners (Phase 5).

### 7.5 Integration data is untrusted

Issue bodies, PR comments, chat messages and monitoring alerts are attacker-reachable text. They are escaped in the UI, never auto-sent to an agent, and a taint source when the user passes them to one (IAC-T source 7).

## 8. Threats and controls

| ID | Threat | Control | Phase |
|---|---|---|---|
| PLG-1 | Malicious plugin script escapes to renderer privileges | Separate sandboxed view per plugin, deny-all permissions, header CSP, no renderer broker in the trust path; independent review of the host | 4a |
| PLG-2 | Plugin exceeds its grant, or its calls are taken as the user's | Main-minted connection per plugin view mapped to `plugin:<id>`; daemon policy rows per `plugin:*`; coverage check (the H6 pattern) | 4a |
| PLG-3 | Plugin uses an agent as a deputy | Plugins reach agents only through messages and user-challenged, tainted run starts; DMN-3 for `plugin:*` | 4a |
| PLG-4 | Tampered or swapped bundle; malicious update | SHA-256 at every load, publisher signature, update diff over tier, permissions, origins, contributions and integrations | 4a |
| PLG-5 | Repository enables a plugin or widens its grant | Enablement and grants are user or application scope (CFG-1 pattern) | 4a |
| PLG-6 | P2 plugin process acts as the user | Disclosure at install; not described as contained; only inside the Phase 3 sandbox if D-2 says so | 4a |
| PLG-7 | Exfiltration from a P1 view by navigation, window open, form post, WebRTC or DNS prefetch | Navigation and window open denied, WebRTC removed, `form-action 'none'`, prefetch off (§3.3) | 4a |
| PLG-8 | Curated list rollback, freeze or key substitution | App-embedded list key, monotonic version, expiry, rotation and revocation; no trust on first use for curated publishers | 4a |
| PLG-9 | Archive tricks at install (symlinks, `..`, zip bombs) | Extraction rules of §4 | 4a |
| PAG-1 | Script or tracking in a page (stored XSS, remote images) | Sanitised Markdown, no raw HTML, raster attachments only, EL-5 links | 2a |
| PAG-2 | Page content steers an agent | Taint source, write needs approval, hop carried on revisions | 2a |
| PAG-3 | Page script reaches the bridge and resolves the agent's own approval as the user | Isolated page view with no bridge port, header CSP, Trusted Types, no SVG (§5) | 2a |
| TSK-1 | Imported issue text becomes an agent instruction | Start is a user action showing the full prompt and source; the run is tainted | 2a / 4a |
| TSK-2 | An agent rewrites a task body so that the user's Start launders injected text past the taint rule | Revisions recorded; Start marks non-user text; the run is tainted from its first call (§6) | 2a |
| INT-1 | Credential leaves the daemon (logs, errors, plugin, prompt) | Credential proxy, redaction canaries, closed errors | 4a |
| INT-2 | SSRF or redirect to an internal or other origin with the credential | Origin allowlist, IP literals refused, proxy variables ignored, no cross-origin redirect, address checks incl. mapped and NAT64, pinning | 4a |
| INT-3 | Oversized or malformed responses (memory, parser) | Byte, depth and time caps; schema validation | 4a |
| INT-4 | OAuth redirect interception, CSRF or device-code phishing | Device flow preferred, user-only connect, main-built code dialog, PKCE and `state`, one-shot loopback only during the flow | 4a |
| INT-5 | Over-broad tokens | Narrowest scope offered, scopes shown, tokens with excess scopes refused | 4a |
| INT-6 | Path or query injection through operation arguments sends the credential to an undeclared endpoint | Fixed method and template, typed encoded segments, dot-segment and separator refusal, final URL pattern match (§7.2) | 4a |

## 9. Proposed gate lines (not added to `ROADMAP.md`)

- **2a (pages, tasks):**
  - a page with raw HTML, a script tag, an `onerror` attribute or a remote image renders inert; a `file:` link is refused;
  - a mutation-XSS corpus page rendered in the page view cannot reach the bridge (no port exists; a probe calling `axis.approvals/1.resolve` from the page view fails), and Trusted Types reports no violation in the Agent view renderer;
  - an SVG attachment, and a PNG-named file that sniffs as HTML, are refused;
  - a task imported or written by an agent is never sent to a run without the user's Start; Start of an agent-edited task taints the run; page and task writes by agents are audited with the agent id.
- **4a (plugins):**
  - a P1 plugin calling a method outside its grant is denied by the daemon; `axis.approvals/1.resolve` from a plugin connection is denied and audited as `plugin:<id>`;
  - a P1 plugin's `location` change to an external URL, `window.open`, a form post an `RTCPeerConnection` attempt from the view, from an `about:blank` child frame and from a worker, and a TURN-over-TCP candidate to the test server all fail, and no request reaches a test server;
  - a modified bundle is disabled at load; an update raising the tier, adding a contribution point, an origin or an integration is blocked until approved;
  - a curated list with a lower version, an expired list and a list signed by an unknown key are refused;
  - an archive with a symlink, a `..` entry or more than the entry cap is refused with nothing written outside the fresh directory;
  - a repository setting enabling a plugin has no effect and a warning is shown;
  - an install requesting `files.read` and `net:<origin>` shows the "can send your code to <origin>" line.
- **4a (integrations):**
  - the credential never appears in renderer state, plugin views, prompts, CLI environments or logs (canary);
  - a redirect to another origin is not followed and the credential is not sent;
  - a hostname resolving to a private, metadata, IPv4-mapped or NAT64 address, and an IP-literal origin, are refused; a set `HTTPS_PROXY` does not change where the request goes;
  - an argument of `../x`, `%2e%2e/x`, `1?a=b` or `1#x` is refused before any request; the final URL check refuses a template mismatch;
  - a token whose granted scopes exceed the declared ones is refused; connect from a non-user actor is denied;
  - an oversized response is cut and reported; no listener exists outside an active OAuth flow.

## 10. Review requirements

- The plugin view host and its main-side attestation, the `plugin:*` principal and policy rows, the curated-list verifier and extractor, the credential proxy and request composition, the OAuth flow and the page view are trust-boundary code: each goes to an independent security review before any PR, with mutation testing of the refusal paths (the existing process).
- Each new contract adds its policy rows and passes the coverage check; each new store is bounded; each error map is closed.
- The threat model gets a revision adding the PLG, PAG, TSK and INT rows (and the IAC rows) before the 2a and 4a gate reviews (tickets PV-R4, PV-R8).
- Built-in integrations are reviewed per service (scopes, redirect behaviour, response shapes, device-code support).

## 11. Open decisions for the owner

| # | Decision | Recommended default |
|---|---|---|
| D-1 | Ship P0 declarative plugins early (2a) | No; ship pages and tasks natively in 2a and the plugin system in 4a |
| D-2 | P2 process plugins before the OS sandbox | Not before Phase 3; MCP servers the user adds themselves are disclosed as running as the user |
| D-3 | Plugin source | Local file and an Axis-curated list signed by an app-embedded key with rollback protection; no public registry in v1 |
| D-4 | Signature policy | Ed25519 publisher signatures required for the curated list (keys from the signed list); unsigned local files allowed for P0 and P1 only, with a warning and hash pinning; never for P2 |
| D-5 | Page storage | Axis data directory per project, with Export to repository |
| D-6 | Page format | Markdown subset only in v1, rendered in the isolated page view |
| D-7 | OAuth redirect | Device-code flow with a main-built code dialog; one-shot loopback listener as a recorded NET-1 exception only when a service lacks it |
| D-8 | First integration | GitHub read-only through the user's `gh` (no token) for the 1c dashboard (ticket PV-D2); a token-based GitHub integration (ticket PV-N3) is built only if D-9 is reversed |
| D-9 | Reverse "Axis stores no forge credentials" (ADR 0004 decision 9 engineering addition) | Keep it until 4a; then allow a vault-held, read-only, fine-grained token behind the credential proxy |
| D-10 | Integrations that write (comment on a PR, move an issue) | Each write operation is a separate permission and a tier-3 challenge |
| D-11 | Inbound webhooks | Not on desktop; polling only |
| D-12 | P1 host process model | A separate sandboxed `WebContentsView` per plugin with a main-attested identity (§3.3) |
| D-13 | Page rendering | Isolated view without a bridge port; raster attachments only |
| D-14 | System proxy for integration traffic | Ignored in 4a; a proxy option needs its own design (the address check must then move to the proxy's resolution) |
